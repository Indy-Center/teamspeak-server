import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryError, type QuerySession } from '../src/serverquery.js';
import { COMMAND_TIMEOUT_MS, ts3Connector } from '../src/ts3.js';
import { FakeQueryServer, OK, type Answer } from './fake-query-server.js';

// ts3-nodejs-library against a local raw ServerQuery server: the adapter's commands and errors.

const UID = 'FakeUid/Alpha+AAAAAAAAAAAAA=';
const TWICE_UID = 'FakeUidTwice/TTTTTTTTTTTT=';

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
    case 'servergroupclientlist':
      if (args['sgid'] === '5') return ['error id=1281 msg=database\\sempty\\sresult\\sset'];
      return [
        `cldbid=41 client_nickname=Alpha client_unique_identifier=${UID.replace(/\//g, '\\/')}|cldbid=42 client_nickname=Bravo client_unique_identifier=FakeUidBravo\\/BBBBBBBBBBB=`,
        OK,
      ];
    case 'servergroupsbyclientid':
      return ['name=Member sgid=7 cldbid=41|name=Guest sgid=8 cldbid=41', OK];
    case 'clientlist':
      return [
        `clid=1 cid=1 client_database_id=41 client_nickname=Alpha\\sOne client_type=0 client_unique_identifier=${UID.replace(/\//g, '\\/')}|clid=2 cid=1 client_database_id=1 client_nickname=serveradmin client_type=1 client_unique_identifier=FakeQueryQQQQQQQQQQQQQQ=`,
        OK,
      ];
    case 'clientgetids':
      if (args['cluid'] === UID) return [`cluid=${UID.replace(/\//g, '\\/')} clid=1 name=Alpha\\sOne`, OK];
      if (args['cluid'] === TWICE_UID) return ['cluid=FakeUidTwice\\/TTTTTTTTTTTT= clid=3 name=Twice|cluid=FakeUidTwice\\/TTTTTTTTTTTT= clid=4 name=Twice', OK];
      // TeamSpeak's answer for a UID no client holds.
      return ['error id=1281 msg=database\\sempty\\sresult\\sset'];
    case 'servernotifyregister':
      return [OK];
    case 'sendtextmessage':
      return args['target'] === '1' && args['targetmode'] === '1' ? [OK] : ['error id=512 msg=invalid\\sclientID'];
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
      'servernotifyregister event=server',
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

  it('lists the members of a group, the groups of a client and the connected non-query clients', async () => {
    session = await connect();
    expect(await session.groupMembers(7)).toEqual([
      { uid: UID, databaseId: '41' },
      { uid: 'FakeUidBravo/BBBBBBBBBBB=', databaseId: '42' },
    ]);
    expect(await session.groupMembers(5)).toEqual([]);
    expect(await session.groupsOfClient('41')).toEqual([7, 8]);
    expect(await session.connectedUids()).toEqual([UID]);
  });

  it('subscribes to server events on connecting and reports entering clients, but not query clients', async () => {
    session = await connect();
    expect(server?.commands).toContain('servernotifyregister event=server');
    const entered: { uid: string; clientId: number; nickname: string }[] = [];
    session.onClientEnter((client) => entered.push(client));

    server?.notify('notifycliententerview cfid=0 ctid=1 reasonid=0 clid=2 client_unique_identifier=FakeQueryQQQQQQQQQQQQQQ=');
    server?.notify('notifycliententerview cfid=0 ctid=1 reasonid=0 clid=1 client_unique_identifier=x');
    await vi.waitFor(() => expect(entered).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(entered).toEqual([{ uid: UID, clientId: 1, nickname: 'Alpha One' }]);
  });

  it('finds the client IDs holding a UID, and none for a UID no client holds', async () => {
    session = await connect();
    expect(await session.clientIds(UID)).toEqual([1]);
    expect(server?.commands.at(-1)).toBe('clientgetids cluid=FakeUid\\/Alpha+AAAAAAAAAAAAA=');
    expect(await session.clientIds(TWICE_UID)).toEqual([3, 4]);
    expect(await session.clientIds('FakeUidGoneZZZZZZZZZZZZZZZ=')).toEqual([]);
  });

  it('sends a private text message to a client by its ID', async () => {
    session = await connect();
    await session.sendText(1, 'Hello there');
    expect(server?.commands.at(-1)).toBe('sendtextmessage target=1 targetmode=1 msg=Hello\\sthere');
    await expect(session.sendText(9, 'Hello')).rejects.toMatchObject({ id: '512' });
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
