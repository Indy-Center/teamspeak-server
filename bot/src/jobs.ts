import { QUERY_ERRORS, QueryError, isQueryError, type QuerySession } from './serverquery.js';
import type { TsJob, TsResult } from './teamspeak-shape.js';

/**
 * Server groups the sync never touches: 1 Guest Server Query, 2 Admin Server Query, 6 Server Admin,
 * 8 Guest (the default group) and 27 teamspeak-bot's own. The same list as indy-larry's `ADMIN_GROUPS`
 * (`worker/src/mapping.ts`), which refuses them in the mapping; this is the second guard.
 */
export const ADMIN_GROUPS: readonly number[] = [1, 2, 6, 8, 27];

/** What happens to a job once it has been tried: acked (done for good) or retried, and its result. */
export type Outcome = { jobId: string; ack: boolean; result: TsResult };

/**
 * Applies one job over ServerQuery. Success acks it with `applied`. A UID TeamSpeak doesn't know is
 * acked as `failed: unknown uid`, since trying again can't help, as is a `send-text` no client can
 * receive (`not connected`, `no uid`). Any other error asks larry for a
 * retry, with the error in a `failed` result.
 */
export async function applyJob(session: QuerySession, job: TsJob): Promise<Outcome> {
  const { jobId } = job;
  try {
    switch (job.type) {
      case 'set-groups':
        return (await setGroups(session, job)) ?? { jobId, ack: true, result: { type: 'applied', jobId } };
      case 'report-accounts':
        return { jobId, ack: true, result: await reportAccounts(session, job.groups) };
      case 'send-text':
        return await sendText(session, job);
      default:
        return retry(jobId, `unknown job type: ${(job as { type: unknown }).type}`);
    }
  } catch (error) {
    return retry(jobId, describeError(error));
  }
}

async function setGroups(session: QuerySession, job: Extract<TsJob, { type: 'set-groups' }>): Promise<Outcome | undefined> {
  // The sync never touches an admin group, whatever larry asks.
  const admin = [...job.add, ...job.remove].find((group) => ADMIN_GROUPS.includes(group));
  if (admin !== undefined) {
    return giveUp(job.jobId, `admin group ${admin}`);
  }
  let databaseId: string;
  try {
    databaseId = await session.databaseId(job.uid);
  } catch (error) {
    if (isQueryError(error, QUERY_ERRORS.emptyResult)) {
      return giveUp(job.jobId, 'unknown uid');
    }
    throw error;
  }
  // A group the client already has, or no longer has, is already as the job asks.
  for (const group of job.add) {
    await during(`adding group ${group}`, tolerate(session.addServerGroup(databaseId, group), QUERY_ERRORS.duplicateEntry));
  }
  for (const group of job.remove) {
    await during(`removing group ${group}`, tolerate(session.removeServerGroup(databaseId, group), QUERY_ERRORS.notInGroup));
  }
  return undefined;
}

/** A ServerQuery error from `command` says what the bot was doing, so the log names the group. */
async function during<T>(what: string, command: Promise<T>): Promise<T> {
  try {
    return await command;
  } catch (error) {
    if (error instanceof QueryError) throw new QueryError(error.id, error.message, error.failedPermid, what);
    throw error;
  }
}

/**
 * Messages every client holding the job's UID now, looked up just before sending. A UID no client holds
 * (the person has left) is acked as `failed: not connected`, and a job without a UID (the shape before
 * send-by-UID) as `failed: no uid`: trying again can't help either.
 */
async function sendText(session: QuerySession, job: Extract<TsJob, { type: 'send-text' }>): Promise<Outcome> {
  const { jobId } = job;
  if (typeof job.uid !== 'string' || job.uid === '') return giveUp(jobId, 'no uid');
  let sent = 0;
  for (const clientId of await session.clientIds(job.uid)) {
    // A client that left between the lookup and the message is skipped.
    if (await tolerate(session.sendText(clientId, job.text), QUERY_ERRORS.invalidClientId)) sent += 1;
  }
  if (sent === 0) return giveUp(jobId, 'not connected');
  return { jobId, ack: true, result: { type: 'applied', jobId } };
}

/** Every client holding one of `groups`, with all its groups, and who is connected now. */
async function reportAccounts(session: QuerySession, groups: number[]): Promise<TsResult> {
  const clients = new Map<string, string>(); // database ID -> UID
  for (const group of groups) {
    for (const member of await session.groupMembers(group)) clients.set(member.databaseId, member.uid);
  }
  const holders: { uid: string; groups: number[] }[] = [];
  for (const [databaseId, uid] of clients) {
    holders.push({ uid, groups: await session.groupsOfClient(databaseId) });
  }
  return { type: 'accounts', holders, connected: await session.connectedUids() };
}

/** Runs `command`, counting TeamSpeak's `errorId` as done. Resolves whether the command itself succeeded. */
async function tolerate(command: Promise<void>, errorId: string): Promise<boolean> {
  try {
    await command;
    return true;
  } catch (error) {
    if (!isQueryError(error, errorId)) throw error;
    return false;
  }
}

/** A `failed` job acked for good, since trying again can't help. */
function giveUp(jobId: string, error: string): Outcome {
  return { jobId, ack: true, result: { type: 'failed', jobId, error } };
}

function retry(jobId: string, error: string): Outcome {
  return { jobId, ack: false, result: { type: 'failed', jobId, error } };
}

export function describeError(error: unknown): string {
  if (error instanceof QueryError) {
    const permission = error.failedPermid === undefined ? '' : ` (failed_permid ${error.failedPermid})`;
    return `ServerQuery error ${error.id}: ${error.message}${permission}${error.during ? `, ${error.during}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
