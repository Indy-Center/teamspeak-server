import type { TsJob, TsResult } from './teamspeak-shape.js';

/** larry's three teamspeak-bot routes, each called with `Authorization: Bearer <LARRY_SECRET>`. */
export interface Larry {
  /** `POST /teamspeak/jobs/pull` `{ max }` → `200 { jobs }`: up to `max` jobs, each leased for 60 seconds. */
  pull(max: number): Promise<TsJob[]>;
  /** `POST /teamspeak/jobs/ack` `{ acks, retries }` → `204`. */
  ack(acks: string[], retries: string[]): Promise<void>;
  /** `POST /teamspeak/results`, a list of results → `202`. */
  postResults(results: TsResult[]): Promise<void>;
}

/** larry couldn't be reached, or didn't answer as its route promises. */
export class LarryError extends Error {
  override name = 'LarryError';
}

export function createLarry(options: { url: string; secret: string; fetch?: typeof fetch }): Larry {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, '');

  async function post(path: string, body: unknown, expected: number): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new LarryError(`POST ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status !== expected) {
      await response.body?.cancel();
      throw new LarryError(`POST ${path} answered ${response.status}`);
    }
    return response;
  }

  return {
    async pull(max) {
      const response = await post('/teamspeak/jobs/pull', { max }, 200);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new LarryError('POST /teamspeak/jobs/pull answered with a body that is not JSON');
      }
      const jobs = (body as { jobs?: unknown } | null)?.jobs;
      if (!Array.isArray(jobs)) throw new LarryError('POST /teamspeak/jobs/pull answered without a jobs list');
      return jobs as TsJob[];
    },
    async ack(acks, retries) {
      await post('/teamspeak/jobs/ack', { acks, retries }, 204);
    },
    async postResults(results) {
      await post('/teamspeak/results', results, 202);
    },
  };
}
