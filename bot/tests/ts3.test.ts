import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryError, type QuerySession } from '../src/serverquery.js';
import { COMMAND_TIMEOUT_MS, ts3Connector } from '../src/ts3.js';
import { FakeQueryServer, OK, type Answer } from './fake-query-server.js';

// ts3-nodejs-library against a local raw ServerQuery server: the adapter's commands and errors.

const UID = 'FakeUid/Alpha+AAAAAAAAAAAAA=';

let server: FakeQueryServer | undefined;
let session: QuerySession | undefined;

const answer: Answer = (name, args, positional) => {
  switch (name) {
    case 'login':
      return positional[0] === 'fake-user' && positional[1] === 'fake-password'
        ? [OK]
        : ['error id=520 msg=invalid\\sloginname\\sor\\spassword'];
    case 'use':
      return positional[0] === '1' ? [OK] : ['error id=1024 msg=invalid\\sserverID'];
    case 'clientgetdbidfromuid':
      return args['cluid'] === UID
        ? [`cluid=${UID.replace(/\//g, '\\/')} cldbid=41`, OK]
        : ['error id=1281 msg=database\\sempty\\sresult\\sset'];
    case 'servergroupaddclient':
      // Group 99 never gets an answer, as on a connection that has stopped responding.
      if (args['sgid'] === '99') return [];
      return args['sgid'] === '10' ? ['error id=2561 msg=duplicate\\sentry'] : [OK];
    case 'servergroupdelclient':
      return [OK];
    default:
      return ['error id=256 msg=command\\snot\\sfound'];
  }
};

async function connect(options: { password?: string } = {}): Promise<QuerySession> {
  server = new FakeQueryServer(answer);
  const port = await server.listen();
  return ts3Connector({
    host: '127.0.0.1',
    port,
    user: 'fake-user',
    password: options.password ?? 'fake-password',
    log: () => undefined,
  })();
}

afterEach(async () => {
  await session?.quit();
  session = undefined;
  await server?.close();
  server = undefined;
});

describe('ts3Connector', () => {
  it('logs in and selects virtual server 1', async () => {
    session = await connect();
    expect(server?.commands.filter((command) => !command.startsWith('version'))).toEqual([
      'login fake-user fake-password',
      'use 1 -virtual',
    ]);
  });

  it('rejects a refused login with its ServerQuery error', async () => {
    const refused = connect({ password: 'wrong' });
    await expect(refused).rejects.toBeInstanceOf(QueryError);
    await expect(refused).rejects.toMatchObject({ id: '520', message: 'invalid loginname or password' });
  });

  it('finds a database ID, and gives error 1281 for a UID the server has not seen', async () => {
    session = await connect();
    expect(await session.databaseId(UID)).toBe('41');
    await expect(session.databaseId('FakeUidUnknownZZZZZZZZZZZZZ=')).rejects.toMatchObject({ id: '1281' });
  });

  it('sends group changes, passing TeamSpeak error ids on', async () => {
    session = await connect();
    await session.addServerGroup('41', 11);
    await session.removeServerGroup('41', 9);
    await expect(session.addServerGroup('41', 10)).rejects.toMatchObject({ id: '2561' });
    expect(server?.commands.slice(-3)).toEqual([
      'servergroupaddclient sgid=11 cldbid=41',
      'servergroupdelclient sgid=9 cldbid=41',
      'servergroupaddclient sgid=10 cldbid=41',
    ]);
  });

  it('tells the bot when the server closes the connection', async () => {
    session = await connect();
    const closed = new Promise<void>((resolve) => session?.onClose(resolve));
    server?.dropConnections();
    await closed;
  });

  it('ends a command left unanswered when the connection closes', async () => {
    session = await connect();
    const pending = session.addServerGroup('41', 99);
    await vi.waitFor(() => expect(server?.commands.at(-1)).toBe('servergroupaddclient sgid=99 cldbid=41'));
    server?.dropConnections();
    await expect(pending).rejects.toThrow('ServerQuery connection closed');
    await expect(session.addServerGroup('41', 11)).rejects.toThrow('ServerQuery connection closed');
  });

  it('gives up on a command after 30 seconds and closes the connection', async () => {
    session = await connect();
    const closed = new Promise<void>((resolve) => session?.onClose(resolve));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = session.addServerGroup('41', 99);
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
      await expect(pending).rejects.toThrow('ServerQuery command timed out after 30 s');
    } finally {
      vi.useRealTimers();
    }
    await closed;
  });
});
