import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBot, type Bot } from '../src/bot.js';
import { createLarry } from '../src/larry.js';
import { QueryError } from '../src/serverquery.js';
import { FakeLarry, LARRY_SECRET, LARRY_URL } from './fake-larry.js';
import { FakeTeamSpeak } from './fake-serverquery.js';

// Made-up identities: none of these is a real TeamSpeak client.
const UID = 'FakeUidAlphaAAAAAAAAAAAAAAA=';
const OTHER_UID = 'FakeUidBravoBBBBBBBBBBBBBBB=';

let larry: FakeLarry;
let teamspeak: FakeTeamSpeak;
let bot: Bot | undefined;
const logs: string[] = [];

function start(): Bot {
  bot = startBot({
    connect: teamspeak.connect,
    larry: createLarry({ url: LARRY_URL, secret: LARRY_SECRET, fetch: larry.fetch }),
    log: (line) => logs.push(line),
  });
  return bot;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-22T12:00:00Z') });
  larry = new FakeLarry();
  teamspeak = new FakeTeamSpeak();
  logs.length = 0;
});

afterEach(async () => {
  await bot?.stop();
  bot = undefined;
  vi.useRealTimers();
});

describe('set-groups', () => {
  it('adds and removes exactly the groups named, sends applied and acks the job', async () => {
    teamspeak.addClient(UID, '41', [7, 9, 12]);
    larry.enqueue({ jobId: 'job-1', type: 'set-groups', uid: UID, add: [10, 11], remove: [9] });
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(teamspeak.groupsOf(UID)).toEqual([7, 10, 11, 12]);
    expect(larry.results).toEqual([{ type: 'applied', jobId: 'job-1' }]);
    expect(larry.acked).toEqual(['job-1']);
    expect(larry.retried).toEqual([]);
    expect(larry.waiting).toEqual([]);
  });

  it('calls larry with its secret', async () => {
    start();
    await vi.advanceTimersByTimeAsync(100);
    expect(larry.requests.length).toBeGreaterThan(0);
    for (const request of larry.requests) expect(request.authorization).toBe(`Bearer ${LARRY_SECRET}`);
    expect(larry.requests[0]).toMatchObject({ path: '/teamspeak/jobs/pull', body: { max: 10 } });
  });

  it('counts a group the client already has, or no longer has, as done', async () => {
    teamspeak.addClient(UID, '41', [10]);
    larry.enqueue({ jobId: 'job-1', type: 'set-groups', uid: UID, add: [10, 11], remove: [9] });
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(teamspeak.groupsOf(UID)).toEqual([10, 11]);
    expect(larry.results).toEqual([{ type: 'applied', jobId: 'job-1' }]);
    expect(larry.acked).toEqual(['job-1']);
  });

  it('fails an unknown UID with "unknown uid" and acks it rather than retrying', async () => {
    larry.enqueue({ jobId: 'job-1', type: 'set-groups', uid: UID, add: [10], remove: [] });
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(larry.results).toEqual([{ type: 'failed', jobId: 'job-1', error: 'unknown uid' }]);
    expect(larry.acked).toEqual(['job-1']);
    expect(larry.retried).toEqual([]);
  });

  it('asks for a retry on a ServerQuery error, and sends failed with the error', async () => {
    teamspeak.addClient(UID, '41');
    teamspeak.failNextCommand = new QueryError('2568', 'insufficient client permissions');
    larry.enqueue({ jobId: 'job-1', type: 'set-groups', uid: UID, add: [10], remove: [] });
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(larry.retried).toEqual(['job-1']);
    expect(larry.acked).toEqual([]);
    expect(larry.results).toEqual([
      { type: 'failed', jobId: 'job-1', error: 'ServerQuery error 2568: insufficient client permissions' },
    ]);
  });

  it('applies each job of a pull on its own, acking some and retrying others in one call', async () => {
    teamspeak.addClient(UID, '41');
    teamspeak.addClient(OTHER_UID, '42');
    larry.enqueue(
      { jobId: 'job-1', type: 'set-groups', uid: UID, add: [10], remove: [] },
      { jobId: 'job-2', type: 'set-groups', uid: OTHER_UID, add: [11], remove: [] },
    );
    teamspeak.failNextCommand = new QueryError('2568', 'insufficient client permissions');
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(larry.retried).toEqual(['job-1']);
    expect(larry.acked).toEqual(['job-2']);
    expect(teamspeak.groupsOf(OTHER_UID)).toEqual([11]);
    expect(larry.requests.filter((request) => request.path === '/teamspeak/jobs/ack')).toEqual([
      expect.objectContaining({ body: { acks: ['job-2'], retries: ['job-1'] } }),
    ]);
  });

  it('waits 5 seconds before pulling again after a retry, so a failing job is not tried in a burst', async () => {
    teamspeak.addClient(UID, '41');
    larry.enqueue({ jobId: 'job-1', type: 'set-groups', uid: UID, add: [10], remove: [] });
    teamspeak.failNextCommand = new QueryError('2568', 'insufficient client permissions');
    start();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(larry.pullCount()).toBe(1);

    // The pull that gets the job back, then one straight after that finds nothing.
    await vi.advanceTimersByTimeAsync(100);
    expect(larry.pullCount()).toBe(3);
    expect(larry.acked).toEqual(['job-1']);
    expect(teamspeak.groupsOf(UID)).toEqual([10]);
  });

  it('asks for a retry of a job type it does not know', async () => {
    larry.enqueue({ jobId: 'job-1', type: 'some-later-type', uid: UID } as never);
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(larry.retried).toEqual(['job-1']);
    expect(larry.results).toEqual([{ type: 'failed', jobId: 'job-1', error: 'unknown job type: some-later-type' }]);
  });
});

describe('admin groups', () => {
  it.each([
    ['add', { add: [10, 6], remove: [] }, 6],
    ['remove', { add: [10], remove: [27] }, 27],
    ['add of the query group', { add: [1], remove: [] }, 1],
  ])('refuses a set-groups job touching an admin group (%s), fails it and acks it', async (_name, change, group) => {
    teamspeak.addClient(UID, '41', [7]);
    larry.enqueue({ jobId: 'job-1', type: 'set-groups', uid: UID, ...change });
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(larry.results).toEqual([{ type: 'failed', jobId: 'job-1', error: `admin group ${group}` }]);
    expect(larry.acked).toEqual(['job-1']);
    expect(larry.retried).toEqual([]);
    expect(teamspeak.groupsOf(UID)).toEqual([7]);
    expect(teamspeak.commands).toEqual([]);
  });
});

describe('report-accounts', () => {
  const THIRD_UID = 'FakeUidCharlieCCCCCCCCCCCC=';
  const FOURTH_UID = 'FakeUidDeltaDDDDDDDDDDDDDD=';

  it('answers with the holders of the named groups, all their groups, and who is connected', async () => {
    teamspeak.addClient(UID, '41', [7, 12, 8]);
    teamspeak.addClient(OTHER_UID, '42', [12]);
    teamspeak.addClient(THIRD_UID, '43', [99]); // holds no named group
    teamspeak.addClient(FOURTH_UID, '44', [7, 12]); // holds two named groups: listed once
    teamspeak.connectClient(UID);
    teamspeak.connectClient(THIRD_UID);
    teamspeak.connectQueryClient('FakeQueryClientQQQQQQQQQQ=');
    larry.enqueue({ jobId: 'job-1', type: 'report-accounts', groups: [7, 12, 50] });
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(larry.results).toHaveLength(1);
    const [result] = larry.results;
    expect(result).toMatchObject({ type: 'accounts', connected: [UID, THIRD_UID] });
    const holders = result?.type === 'accounts' ? result.holders : [];
    expect(holders).toHaveLength(3);
    expect(holders).toEqual(
      expect.arrayContaining([
        { uid: UID, groups: [7, 8, 12] },
        { uid: OTHER_UID, groups: [12] },
        { uid: FOURTH_UID, groups: [7, 12] },
      ]),
    );
    expect(larry.acked).toEqual(['job-1']);
  });

  it('answers with no holders when nobody holds the groups', async () => {
    larry.enqueue({ jobId: 'job-1', type: 'report-accounts', groups: [7] });
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(larry.results).toEqual([{ type: 'accounts', holders: [], connected: [] }]);
    expect(larry.acked).toEqual(['job-1']);
  });

  it('asks for a retry when ServerQuery fails part-way', async () => {
    teamspeak.addClient(UID, '41', [7]);
    teamspeak.failNextCommand = new QueryError('2568', 'insufficient client permissions');
    larry.enqueue({ jobId: 'job-1', type: 'report-accounts', groups: [7] });
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(larry.retried).toEqual(['job-1']);
    expect(larry.results[0]).toMatchObject({ type: 'failed', jobId: 'job-1' });
  });
});

describe('send-text', () => {
  it('sends the text to the client as a private message, then applied and an ack', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    const clientId = teamspeak.enterClient(UID, 'Alpha');
    larry.results.length = 0;
    larry.enqueue({ jobId: 'job-1', type: 'send-text', clientId, text: 'Link: https://example.test/profile?ts=fake-token' });
    await vi.advanceTimersByTimeAsync(5_100);

    expect(teamspeak.messages).toEqual([{ clientId, text: 'Link: https://example.test/profile?ts=fake-token' }]);
    expect(larry.results).toEqual([{ type: 'applied', jobId: 'job-1' }]);
    expect(larry.acked).toEqual(['job-1']);
  });

  it('asks for a retry when TeamSpeak refuses the message', async () => {
    larry.enqueue({ jobId: 'job-1', type: 'send-text', clientId: 99, text: 'Hello' });
    start();
    await vi.advanceTimersByTimeAsync(100);

    expect(teamspeak.messages).toEqual([]);
    expect(larry.retried).toEqual(['job-1']);
    expect(larry.results[0]).toMatchObject({ type: 'failed', jobId: 'job-1', error: 'ServerQuery error 512: invalid clientID' });
  });
});

describe('polling', () => {
  it('pulls again at once after jobs came back, and every 5 seconds when none did', async () => {
    teamspeak.addClient(UID, '41');
    larry.enqueue({ jobId: 'job-1', type: 'set-groups', uid: UID, add: [10], remove: [] });
    start();
    await vi.advanceTimersByTimeAsync(100);
    // One pull that found the job, one straight after that found nothing.
    expect(larry.pullCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(4_800);
    expect(larry.pullCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(larry.pullCount()).toBe(3);

    larry.enqueue({ jobId: 'job-2', type: 'set-groups', uid: UID, add: [11], remove: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(teamspeak.groupsOf(UID)).toEqual([10, 11]);
  });
});

describe('larry unreachable', () => {
  it('backs off from 1 second doubling to 60, keeps its ServerQuery connection, and picks up again', async () => {
    larry.down = true;
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(teamspeak.connected).toBe(true);
    expect(larry.pullCount()).toBe(1);

    // Retries after 1, 2, 4, 8, 16, 32, 60, 60 seconds.
    const waits = [1, 2, 4, 8, 16, 32, 60, 60];
    for (const [index, seconds] of waits.entries()) {
      await vi.advanceTimersByTimeAsync(seconds * 1000 - 100);
      expect(larry.pullCount()).toBe(index + 1);
      await vi.advanceTimersByTimeAsync(100);
      expect(larry.pullCount()).toBe(index + 2);
    }
    expect(teamspeak.connected).toBe(true);
    expect(teamspeak.logins).toBe(1);

    teamspeak.addClient(UID, '41');
    larry.enqueue({ jobId: 'job-1', type: 'set-groups', uid: UID, add: [10], remove: [] });
    larry.down = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(larry.acked).toEqual(['job-1']);

    // Back to the 5-second poll once larry answers.
    const pulls = larry.pullCount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(larry.pullCount()).toBe(pulls + 1);
  });

  it('leaves a job whose ack does not reach larry for its lease to bring back', async () => {
    teamspeak.addClient(UID, '41');
    larry.enqueue({ jobId: 'job-1', type: 'set-groups', uid: UID, add: [10], remove: [] });
    const realFetch = larry.fetch;
    let failAcks = true;
    const larryClient = createLarry({
      url: LARRY_URL,
      secret: LARRY_SECRET,
      fetch: async (input, init) => {
        if (failAcks && String(input).endsWith('/jobs/ack')) throw new TypeError('fetch failed');
        return realFetch(input, init);
      },
    });
    bot = startBot({ connect: teamspeak.connect, larry: larryClient, log: (line) => logs.push(line) });
    await vi.advanceTimersByTimeAsync(100);
    expect(larry.acked).toEqual([]);
    expect(larry.waiting).toHaveLength(1);

    failAcks = false;
    larry.expireLeases();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(larry.acked).toEqual(['job-1']);
    expect(teamspeak.groupsOf(UID)).toEqual([10]);
  });
});
