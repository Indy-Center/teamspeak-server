/**
 * The bot's view of one logged-in ServerQuery connection, on virtual server 1. ts3.ts implements it
 * with ts3-nodejs-library; the tests use a fake. Each call is one ServerQuery command, and a refused
 * command throws a QueryError carrying TeamSpeak's error id.
 */
export interface QuerySession {
  /** `clientgetdbidfromuid`: the client database ID of a UID. */
  databaseId(uid: string): Promise<string>;
  /** `servergroupaddclient`. */
  addServerGroup(databaseId: string, group: number): Promise<void>;
  /** `servergroupdelclient`. */
  removeServerGroup(databaseId: string, group: number): Promise<void>;
  /** `servergroupclientlist -names`: the clients holding a server group (none for an empty group). */
  groupMembers(group: number): Promise<{ uid: string; databaseId: string }[]>;
  /** `servergroupsbyclientid`: the IDs of every server group a client holds. */
  groupsOfClient(databaseId: string): Promise<number[]>;
  /** `clientlist -uid`: the UIDs connected now, query clients excluded. */
  connectedUids(): Promise<string[]>;
  /** Called once when the connection is lost, or closed by `quit`. */
  onClose(listener: () => void): void;
  /** Logs out and closes the connection. */
  quit(): Promise<void>;
}

/** Opens a connection, logs in and selects virtual server 1. Rejects if any step fails. */
export type ConnectQuery = () => Promise<QuerySession>;

/** A command TeamSpeak refused, with its error id (`error id=... msg=...`). */
export class QueryError extends Error {
  constructor(
    readonly id: string,
    message: string,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

/** TeamSpeak's error ids the bot acts on. */
export const QUERY_ERRORS = {
  /** `database empty result set`: `clientgetdbidfromuid` for a UID the server has never seen. */
  emptyResult: '1281',
  /** `duplicate entry`: `servergroupaddclient` for a client already in the group. */
  duplicateEntry: '2561',
  /** `empty result set` (permissions): `servergroupdelclient` for a client not in the group. */
  notInGroup: '2563',
} as const;

export function isQueryError(error: unknown, id: string): boolean {
  return error instanceof QueryError && error.id === id;
}
