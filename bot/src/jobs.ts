import { QUERY_ERRORS, QueryError, isQueryError, type QuerySession } from './serverquery.js';
import type { TsJob, TsResult } from './teamspeak-shape.js';

/** What happens to a job once it has been tried: acked (done for good) or retried, and its result. */
export type Outcome = { jobId: string; ack: boolean; result: TsResult };

/**
 * Applies one job over ServerQuery. Success acks it with `applied`. A UID TeamSpeak doesn't know is
 * acked as `failed: unknown uid`, since trying again can't help. Any other error asks larry for a
 * retry, with the error in a `failed` result.
 */
export async function applyJob(session: QuerySession, job: TsJob): Promise<Outcome> {
  const { jobId } = job;
  try {
    switch (job.type) {
      case 'set-groups':
        return (await setGroups(session, job)) ?? { jobId, ack: true, result: { type: 'applied', jobId } };
      default:
        return retry(jobId, `unknown job type: ${(job as { type: unknown }).type}`);
    }
  } catch (error) {
    return retry(jobId, describeError(error));
  }
}

async function setGroups(session: QuerySession, job: Extract<TsJob, { type: 'set-groups' }>): Promise<Outcome | undefined> {
  let databaseId: string;
  try {
    databaseId = await session.databaseId(job.uid);
  } catch (error) {
    if (isQueryError(error, QUERY_ERRORS.emptyResult)) {
      return { jobId: job.jobId, ack: true, result: { type: 'failed', jobId: job.jobId, error: 'unknown uid' } };
    }
    throw error;
  }
  // A group the client already has, or no longer has, is already as the job asks.
  for (const group of job.add) {
    await tolerate(session.addServerGroup(databaseId, group), QUERY_ERRORS.duplicateEntry);
  }
  for (const group of job.remove) {
    await tolerate(session.removeServerGroup(databaseId, group), QUERY_ERRORS.notInGroup);
  }
  return undefined;
}

async function tolerate(command: Promise<void>, errorId: string): Promise<void> {
  try {
    await command;
  } catch (error) {
    if (!isQueryError(error, errorId)) throw error;
  }
}

function retry(jobId: string, error: string): Outcome {
  return { jobId, ack: false, result: { type: 'failed', jobId, error } };
}

export function describeError(error: unknown): string {
  if (error instanceof QueryError) return `ServerQuery error ${error.id}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
