import { QueryProtocol, ResponseError, TeamSpeak } from 'ts3-nodejs-library';
import type { Log } from './bot.js';
import { QueryError, type ConnectQuery, type QuerySession } from './serverquery.js';

/** The virtual server the bot works on. */
const VIRTUAL_SERVER = '1';
/** How long connecting, or one command, may take before the connection is given up as broken. */
export const COMMAND_TIMEOUT_MS = 30_000;

/**
 * ServerQuery through ts3-nodejs-library, over the raw protocol. Each call to the returned function
 * opens a new connection; the bot does its own reconnecting, so the library's isn't used.
 */
export function ts3Connector(options: { host: string; port: number; user: string; password: string; log: Log }): ConnectQuery {
  return async () => {
    const teamspeak = new TeamSpeak({
      host: options.host,
      queryport: options.port,
      protocol: QueryProtocol.RAW,
      autoConnect: false,
      keepAlive: true,
    });
    teamspeak.on('flooding', () => options.log('ServerQuery: flood protection is slowing commands down'));
    try {
      await withTimeout(teamspeak, 'connecting', async () => {
        await teamspeak.connect();
        await teamspeak.login(options.user, options.password);
        await teamspeak.useBySid(VIRTUAL_SERVER);
      });
    } catch (error) {
      teamspeak.forceQuit();
      throw toQueryError(error);
    }
    // After connect() has removed its own listener, an `error` event with none would throw.
    teamspeak.on('error', (error) => options.log(`ServerQuery: ${error.message}`));
    return session(teamspeak);
  };
}

function session(teamspeak: TeamSpeak): QuerySession {
  let closed = false;
  // The library leaves a command pending for ever if the connection closes under it, so each command
  // also ends when the connection does.
  const lostConnection = new Promise<never>((_, reject) => {
    teamspeak.once('close', () => {
      closed = true;
      reject(new Error('ServerQuery connection closed'));
    });
  });
  lostConnection.catch(() => undefined);

  const run = async <T>(command: () => Promise<T>): Promise<T> => {
    if (closed) throw new Error('ServerQuery connection closed');
    try {
      return await withTimeout(teamspeak, 'command', () => Promise.race([command(), lostConnection]));
    } catch (error) {
      throw toQueryError(error);
    }
  };

  return {
    async databaseId(uid) {
      const { cldbid } = await run(() => teamspeak.clientGetDbidFromUid(uid));
      return cldbid;
    },
    async addServerGroup(databaseId, group) {
      await run(() => teamspeak.serverGroupAddClient(databaseId, String(group)));
    },
    async removeServerGroup(databaseId, group) {
      await run(() => teamspeak.serverGroupDelClient(databaseId, String(group)));
    },
    onClose(listener) {
      teamspeak.once('close', () => listener());
    },
    async quit() {
      // `quit` is sent only on an open connection, and the socket is closed after it either way.
      if (!closed) await run(() => teamspeak.quit()).catch(() => undefined);
      teamspeak.forceQuit();
    },
  };
}

/** Runs `work`, giving up after COMMAND_TIMEOUT_MS and closing the connection, which is then of no use. */
async function withTimeout<T>(teamspeak: TeamSpeak, what: string, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      teamspeak.forceQuit();
      reject(new Error(`ServerQuery ${what} timed out after ${COMMAND_TIMEOUT_MS / 1000} s`));
    }, COMMAND_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function toQueryError(error: unknown): unknown {
  return error instanceof ResponseError ? new QueryError(String(error.id), error.msg) : error;
}
