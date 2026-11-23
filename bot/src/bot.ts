import { applyJob, describeError } from './jobs.js';
import { isRefused, type Larry } from './larry.js';
import type { ConnectQuery, QuerySession } from './serverquery.js';
import type { TsResult } from './teamspeak-shape.js';

/** The most jobs one pull asks for. */
export const PULL_MAX = 10;
/** How long the bot waits before pulling again when larry had no job. */
export const POLL_MS = 5_000;
export const HEARTBEAT_MS = 5 * 60_000;
/** Backoff, for ServerQuery and for larry alike: 1 second, doubling to 60. */
export const BACKOFF_FIRST_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

export type Log = (line: string) => void;

export interface Bot {
  /** Stops pulling, logs out of ServerQuery and resolves once nothing is left running. */
  stop(): Promise<void>;
}

class Backoff {
  private next = BACKOFF_FIRST_MS;
  take(): number {
    const delay = this.next;
    this.next = Math.min(delay * 2, BACKOFF_MAX_MS);
    return delay;
  }
  reset(): void {
    this.next = BACKOFF_FIRST_MS;
  }
}

/**
 * Starts teamspeak-bot: keeps one ServerQuery connection open, reconnecting with backoff when it is
 * lost or refused; pulls larry's jobs, applies them and reports each one; and sends a heartbeat every
 * 5 minutes. It never exits on its own: every failure is logged and tried again.
 */
export function startBot(options: { connect: ConnectQuery; larry: Larry; log?: Log; now?: () => Date }): Bot {
  const { connect, larry } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const stopping = new AbortController();
  const timers = new Set<NodeJS.Timeout>();

  let session: QuerySession | null = null;
  let waiters: (() => void)[] = [];

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (stopping.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        timers.delete(timer);
        stopping.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timers.add(timer);
      stopping.signal.addEventListener('abort', done, { once: true });
    });
  }

  // ServerQuery: connect at start-up, and again whenever the connection is lost.

  async function keepConnected(lost: boolean): Promise<void> {
    const backoff = new Backoff();
    if (lost) await sleep(backoff.take());
    while (!stopping.signal.aborted) {
      try {
        const opened = await connect();
        if (stopping.signal.aborted) {
          await opened.quit().catch(() => undefined);
          return;
        }
        opened.onClose(() => {
          if (session !== opened) return;
          session = null;
          if (stopping.signal.aborted) return;
          log('ServerQuery connection lost; reconnecting');
          void keepConnected(true);
        });
        // Each connection is subscribed to client-enter events afresh, so they survive a reconnect.
        opened.onClientEnter((client) => report({ type: 'client-connected', ...client }));
        session = opened;
        log(lost ? 'ServerQuery reconnected' : 'ServerQuery connected');
        for (const wake of waiters) wake();
        waiters = [];
        if (lost) report({ type: 'reconnected', at: now().toISOString() });
        return;
      } catch (error) {
        const delay = backoff.take();
        log(`ServerQuery: could not connect (${describeError(error)}); trying again in ${delay / 1000} s`);
        await sleep(delay);
      }
    }
  }

  async function connected(): Promise<QuerySession | null> {
    while (!session && !stopping.signal.aborted) await new Promise<void>((resolve) => waiters.push(resolve));
    return session;
  }

  // larry's jobs: pull, apply, report each result, then ack or retry.

  async function jobLoop(): Promise<void> {
    const backoff = new Backoff();
    while (!stopping.signal.aborted) {
      const current = await connected();
      if (!current) return;

      let jobs;
      try {
        jobs = await larry.pull(PULL_MAX);
      } catch (error) {
        const delay = backoff.take();
        log(`larry: ${describeError(error)}; pulling again in ${delay / 1000} s`);
        await sleep(delay);
        continue;
      }
      backoff.reset();
      if (jobs.length === 0) {
        await sleep(POLL_MS);
        continue;
      }

      const outcomes = [];
      for (const job of jobs) {
        const outcome = await applyJob(current, job);
        const { result } = outcome;
        log(`job ${job.jobId}: ${result.type}${result.type === 'failed' ? ` (${result.error}), ${outcome.ack ? 'acked' : 'retrying'}` : ''}`);
        outcomes.push(outcome);
      }
      try {
        await larry.postResults(outcomes.map((outcome) => outcome.result));
        await larry.ack(
          outcomes.filter((outcome) => outcome.ack).map((outcome) => outcome.jobId),
          outcomes.filter((outcome) => !outcome.ack).map((outcome) => outcome.jobId),
        );
        // larry hands a retried job out again at once: wait a poll first, so its tries aren't spent in a burst.
        if (outcomes.some((outcome) => !outcome.ack)) await sleep(POLL_MS);
      } catch (error) {
        // Unacked, these jobs come back from larry once their lease runs out.
        const delay = backoff.take();
        log(`larry: ${describeError(error)}; ${jobs.length} job(s) left for their lease to bring back; pulling again in ${delay / 1000} s`);
        await sleep(delay);
      }
    }
  }

  // Results that answer no job (heartbeat, reconnected, client-connected): sent at once, and kept until
  // larry has them, or refuses one (400), which is dropped.

  let outbox: TsResult[] = [];
  let flushing = false;
  let flushRetry: NodeJS.Timeout | undefined;
  const outboxBackoff = new Backoff();

  function report(result: TsResult): void {
    // A heartbeat still waiting is replaced by the newer one.
    if (result.type === 'heartbeat') outbox = outbox.filter((waiting) => waiting.type !== 'heartbeat');
    outbox.push(result);
    void flush();
  }

  async function flush(): Promise<void> {
    if (flushing || flushRetry || stopping.signal.aborted || outbox.length === 0) return;
    flushing = true;
    const sending = [...outbox];
    let failure: unknown;
    try {
      await larry.postResults(sending);
      removeFromOutbox(sending);
    } catch (error) {
      if (!isRefused(error)) failure = error;
      else if (sending.length === 1) drop(sending[0]!, error);
      // larry refuses a whole body for one invalid result: find it, so the rest still get through.
      else failure = await postEach(sending);
    } finally {
      flushing = false;
    }
    if (failure === undefined) {
      outboxBackoff.reset();
      if (outbox.length > 0) void flush();
      return;
    }
    const delay = outboxBackoff.take();
    log(`larry: ${describeError(failure)}; sending ${outbox.map((result) => result.type).join(', ')} again in ${delay / 1000} s`);
    flushRetry = setTimeout(() => {
      flushRetry = undefined;
      void flush();
    }, delay);
  }

  /**
   * Posts `results` one at a time after larry refused them together, dropping (and logging) each one it
   * refuses on its own. Stops at any other failure, leaving the rest in the outbox, and returns it.
   */
  async function postEach(results: TsResult[]): Promise<unknown> {
    for (const result of results) {
      try {
        await larry.postResults([result]);
        removeFromOutbox([result]);
      } catch (error) {
        if (!isRefused(error)) return error;
        drop(result, error);
      }
    }
    return undefined;
  }

  function removeFromOutbox(results: TsResult[]): void {
    outbox = outbox.filter((waiting) => !results.includes(waiting));
  }

  function drop(result: TsResult, error: unknown): void {
    // The result itself isn't logged: it may hold a UID.
    log(`larry refused a ${result.type} result; dropped it (${describeError(error)})`);
    removeFromOutbox([result]);
  }

  const heartbeat = setInterval(() => report({ type: 'heartbeat', at: now().toISOString() }), HEARTBEAT_MS);

  void keepConnected(false);
  const jobs = jobLoop();

  return {
    async stop() {
      if (stopping.signal.aborted) return;
      stopping.abort();
      clearInterval(heartbeat);
      clearTimeout(flushRetry);
      for (const timer of timers) clearTimeout(timer);
      for (const wake of waiters) wake();
      waiters = [];
      await jobs;
      const open = session;
      session = null;
      await open?.quit().catch(() => undefined);
    },
  };
}
