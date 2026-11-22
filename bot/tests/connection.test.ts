import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBot, type Bot } from '../src/bot.js';
import { createLarry } from '../src/larry.js';
import { FakeLarry, LARRY_SECRET, LARRY_URL } from './fake-larry.js';
import { FakeTeamSpeak } from './fake-serverquery.js';

const UID = 'FakeUidAlphaAAAAAAAAAAAAAAA=';

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

describe('a lost connection', () => {
  it('reconnects with backoff and sends reconnected', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(teamspeak.logins).toBe(1);

    teamspeak.unreachable = true;
    teamspeak.dropConnection();
    // Tries after 1, then 2, then 4 seconds.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(teamspeak.attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(teamspeak.attempts).toBe(3);
    teamspeak.unreachable = false;
    await vi.advanceTimersByTimeAsync(3_900);
    expect(teamspeak.attempts).toBe(3);
    expect(larry.results).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(teamspeak.attempts).toBe(4);
    expect(teamspeak.connected).toBe(true);
    expect(larry.results).toEqual([{ type: 'reconnected', at: '2026-11-22T12:00:07.000Z' }]);
  });

  it('applies jobs again once reconnected', async () => {
    teamspeak.addClient(UID, '41');
    start();
    await vi.advanceTimersByTimeAsync(0);
    teamspeak.dropConnection();
    larry.enqueue({ jobId: 'job-1', type: 'set-groups', uid: UID, add: [10], remove: [] });
    await vi.advanceTimersByTimeAsync(6_000);

    expect(teamspeak.groupsOf(UID)).toEqual([10]);
    expect(larry.acked).toEqual(['job-1']);
  });

  it('keeps reconnected until larry can take it', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    larry.down = true;
    teamspeak.dropConnection();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(teamspeak.connected).toBe(true);
    expect(larry.results).toEqual([]);

    larry.down = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(larry.results).toEqual([{ type: 'reconnected', at: '2026-11-22T12:00:01.000Z' }]);
  });
});

describe('start-up', () => {
  it('retries a refused login on the same backoff rather than exiting', async () => {
    teamspeak.refuseLogins = 3;
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(teamspeak.attempts).toBe(1);
    expect(logs[0]).toMatch(/could not connect \(ServerQuery error 520: invalid loginname or password\); trying again in 1 s/);

    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(teamspeak.attempts).toBe(4);
    expect(teamspeak.connected).toBe(true);
    // The first connection is not a reconnection.
    expect(larry.results).toEqual([]);
  });

  it('retries a server that is not up yet, capping the wait at 60 seconds', async () => {
    teamspeak.unreachable = true;
    start();
    await vi.advanceTimersByTimeAsync(0);
    // 1 + 2 + 4 + 8 + 16 + 32 + 60 + 60 seconds.
    await vi.advanceTimersByTimeAsync(183_000);
    expect(teamspeak.attempts).toBe(9);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(teamspeak.attempts).toBe(9);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(teamspeak.attempts).toBe(10);
  });

  it('pulls no job until ServerQuery is connected', async () => {
    teamspeak.unreachable = true;
    start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(larry.pullCount()).toBe(0);
  });
});

describe('heartbeat', () => {
  it('sends a heartbeat every 5 minutes', async () => {
    start();
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(larry.results).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(larry.results).toEqual([{ type: 'heartbeat', at: '2026-11-22T12:05:00.000Z' }]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(larry.results).toEqual([
      { type: 'heartbeat', at: '2026-11-22T12:05:00.000Z' },
      { type: 'heartbeat', at: '2026-11-22T12:10:00.000Z' },
    ]);
  });

  it('sends a heartbeat larry missed once it is back, keeping only the latest', async () => {
    start();
    larry.down = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    larry.down = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(larry.results).toEqual([{ type: 'heartbeat', at: '2026-11-22T12:10:00.000Z' }]);
  });
});

describe('stop', () => {
  it('logs out of ServerQuery and stops pulling', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    await bot?.stop();
    const pulls = larry.pullCount();
    expect(teamspeak.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(larry.pullCount()).toBe(pulls);
    expect(teamspeak.attempts).toBe(1);
  });
});
