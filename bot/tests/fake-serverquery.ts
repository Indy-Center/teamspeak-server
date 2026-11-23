import { QUERY_ERRORS, QueryError, type ConnectQuery, type QuerySession } from '../src/serverquery.js';

type Client = { databaseId: string; groups: Set<number> };

/**
 * A fake TeamSpeak server behind ServerQuery. It answers the commands the bot uses with TeamSpeak's
 * own error ids, can refuse logins or be unreachable, and can drop its open connection.
 */
export class FakeTeamSpeak {
  private readonly clients = new Map<string, Client>();
  private open: FakeSession | null = null;
  /** Connection attempts, successful or not. */
  attempts = 0;
  /** Successful logins. */
  logins = 0;
  /** The next this-many connection attempts are refused at login. */
  refuseLogins = 0;
  /** While true, connection attempts fail as if the server isn't up. */
  unreachable = false;
  /** The next command fails with this error (once). */
  failNextCommand: QueryError | null = null;
  /** Every command run, in order, as `name args`. */
  readonly commands: string[] = [];

  addClient(uid: string, databaseId: string, groups: number[] = []): void {
    this.clients.set(uid, { databaseId, groups: new Set(groups) });
  }

  /** Marks a known client as connected now. */
  connectClient(uid: string): void {
    this.online.push({ uid, query: false });
  }

  /** A query client connected now (it has no database entry the sync cares about). */
  connectQueryClient(uid: string): void {
    this.online.push({ uid, query: true });
  }

  /** @internal */
  readonly online: { uid: string; query: boolean }[] = [];

  groupsOf(uid: string): number[] {
    return [...(this.clients.get(uid)?.groups ?? [])].sort((a, b) => a - b);
  }

  get connected(): boolean {
    return this.open !== null;
  }

  /** Closes the open connection from the server's side, as a restart or a network drop does. */
  dropConnection(): void {
    const session = this.open;
    this.open = null;
    session?.close();
  }

  readonly connect: ConnectQuery = async () => {
    this.attempts += 1;
    if (this.unreachable) throw new Error('connect ECONNREFUSED 172.30.10.10:10011');
    if (this.refuseLogins > 0) {
      this.refuseLogins -= 1;
      throw new QueryError('520', 'invalid loginname or password');
    }
    this.logins += 1;
    const session = new FakeSession(this);
    this.open = session;
    return session;
  };

  /** @internal Runs one command for a session. */
  run(session: FakeSession, command: string, action: () => void): void {
    if (session !== this.open) throw new Error('connection closed');
    this.commands.push(command);
    const failure = this.failNextCommand;
    if (failure) {
      this.failNextCommand = null;
      throw failure;
    }
    action();
  }

  /** @internal */
  client(uid: string): Client {
    const client = this.clients.get(uid);
    if (!client) throw new QueryError(QUERY_ERRORS.emptyResult, 'database empty result set');
    return client;
  }

  /** @internal */
  members(group: number): { uid: string; databaseId: string }[] {
    return [...this.clients].filter(([, client]) => client.groups.has(group)).map(([uid, client]) => ({ uid, databaseId: client.databaseId }));
  }

  /** @internal */
  byDatabaseId(databaseId: string): Client {
    for (const client of this.clients.values()) if (client.databaseId === databaseId) return client;
    throw new QueryError(QUERY_ERRORS.emptyResult, 'database empty result set');
  }

  /** @internal */
  closed(session: FakeSession): void {
    if (this.open === session) this.open = null;
  }
}

class FakeSession implements QuerySession {
  private listeners: (() => void)[] = [];
  private isClosed = false;

  constructor(private readonly server: FakeTeamSpeak) {}

  async databaseId(uid: string): Promise<string> {
    let id = '';
    this.server.run(this, `clientgetdbidfromuid ${uid}`, () => {
      id = this.server.client(uid).databaseId;
    });
    return id;
  }

  async addServerGroup(databaseId: string, group: number): Promise<void> {
    this.server.run(this, `servergroupaddclient ${group} ${databaseId}`, () => {
      const client = this.server.byDatabaseId(databaseId);
      if (client.groups.has(group)) throw new QueryError(QUERY_ERRORS.duplicateEntry, 'duplicate entry');
      client.groups.add(group);
    });
  }

  async removeServerGroup(databaseId: string, group: number): Promise<void> {
    this.server.run(this, `servergroupdelclient ${group} ${databaseId}`, () => {
      const client = this.server.byDatabaseId(databaseId);
      if (!client.groups.has(group)) throw new QueryError(QUERY_ERRORS.notInGroup, 'empty result set');
      client.groups.delete(group);
    });
  }

  async groupMembers(group: number): Promise<{ uid: string; databaseId: string }[]> {
    let members: { uid: string; databaseId: string }[] = [];
    this.server.run(this, `servergroupclientlist ${group}`, () => {
      members = this.server.members(group);
    });
    return members;
  }

  async groupsOfClient(databaseId: string): Promise<number[]> {
    let groups: number[] = [];
    this.server.run(this, `servergroupsbyclientid ${databaseId}`, () => {
      groups = [...this.server.byDatabaseId(databaseId).groups].sort((a, b) => a - b);
    });
    return groups;
  }

  async connectedUids(): Promise<string[]> {
    let uids: string[] = [];
    this.server.run(this, 'clientlist', () => {
      uids = this.server.online.filter((client) => !client.query).map((client) => client.uid);
    });
    return uids;
  }

  onClose(listener: () => void): void {
    this.listeners.push(listener);
  }

  async quit(): Promise<void> {
    this.server.closed(this);
    this.close();
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const listener of this.listeners) listener();
  }
}
