import type { TsJob, TsResult } from '../src/teamspeak-shape.js';

export const LARRY_URL = 'https://larry.example.test';
export const LARRY_SECRET = 'test-secret-not-real';

type Held = { job: TsJob; leased: boolean; tries: number };

/**
 * A fake of larry's three teamspeak-bot routes, as a `fetch` stub. It keeps jobs as larry's store does
 * (a pulled job is leased until acked or retried) and records every request and result.
 */
export class FakeLarry {
  readonly results: TsResult[] = [];
  readonly requests: { path: string; authorization: string | null; body: unknown }[] = [];
  readonly acked: string[] = [];
  readonly retried: string[] = [];
  /** While true, every request fails as if larry can't be reached. */
  down = false;
  /** A result larry finds invalid: a results body holding one gets 400 and queues nothing, as larry's does. */
  refuses: (result: TsResult) => boolean = () => false;
  private held: Held[] = [];

  enqueue(...jobs: TsJob[]): void {
    for (const job of jobs) this.held.push({ job, leased: false, tries: 0 });
  }

  /** Jobs still held, leased or not. */
  get waiting(): TsJob[] {
    return this.held.map((held) => held.job);
  }

  /** Lets every leased job be pulled again, as a lease running out does. */
  expireLeases(): void {
    for (const held of this.held) held.leased = false;
  }

  pullCount(): number {
    return this.requests.filter((request) => request.path === '/teamspeak/jobs/pull').length;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? 'null')) as unknown;
    const authorization = new Headers(init?.headers).get('authorization');
    this.requests.push({ path: url.pathname, authorization, body });
    if (this.down) throw new TypeError('fetch failed');
    if (url.origin !== LARRY_URL || init?.method !== 'POST') return new Response(null, { status: 404 });
    if (authorization !== `Bearer ${LARRY_SECRET}`) return new Response(null, { status: 401 });

    switch (url.pathname) {
      case '/teamspeak/jobs/pull': {
        const max = (body as { max: number }).max;
        if (!Number.isInteger(max) || max < 1) return new Response(null, { status: 400 });
        const jobs = this.held.filter((held) => !held.leased).slice(0, Math.min(max, 10));
        for (const held of jobs) held.leased = true;
        return Response.json({ jobs: jobs.map((held) => held.job) });
      }
      case '/teamspeak/jobs/ack': {
        const { acks, retries } = body as { acks: string[]; retries: string[] };
        if (!Array.isArray(acks) || !Array.isArray(retries)) return new Response(null, { status: 400 });
        this.acked.push(...acks);
        this.retried.push(...retries);
        this.held = this.held.filter((held) => !acks.includes(held.job.jobId));
        for (const held of this.held) {
          if (retries.includes(held.job.jobId)) {
            held.leased = false;
            held.tries += 1;
          }
        }
        return new Response(null, { status: 204 });
      }
      case '/teamspeak/results': {
        const results = (Array.isArray(body) ? body : [body]) as TsResult[];
        if (results.some(this.refuses)) return new Response(null, { status: 400 });
        this.results.push(...results);
        return new Response(null, { status: 202 });
      }
      default:
        return new Response(null, { status: 404 });
    }
  };
}
