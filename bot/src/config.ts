/** teamspeak-bot's settings, from its environment. */
export type Config = {
  /** ServerQuery's host and raw port: `teamspeak` and `10011` in the compose file. */
  queryHost: string;
  queryPort: number;
  /** The bot's own ServerQuery login. */
  queryUser: string;
  queryPassword: string;
  /** larry's Worker, e.g. `https://larry.example.workers.dev`, and the bearer secret its routes check. */
  larryUrl: string;
  larrySecret: string;
};

const REQUIRED = ['QUERY_HOST', 'QUERY_PORT', 'QUERY_USER', 'QUERY_PASSWORD', 'LARRY_URL', 'LARRY_SECRET'] as const;

/** Reads the settings, or throws naming every one that is missing or malformed (never a value). */
export function readConfig(env: Record<string, string | undefined>): Config {
  const problems = REQUIRED.filter((name) => !env[name]?.trim()).map((name) => `${name} is not set`);
  const port = Number(env.QUERY_PORT);
  if (env.QUERY_PORT?.trim() && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    problems.push('QUERY_PORT is not a port number');
  }
  if (env.LARRY_URL?.trim() && !URL.canParse(env.LARRY_URL.trim())) problems.push('LARRY_URL is not a URL');
  if (problems.length > 0) throw new Error(problems.join('; '));
  return {
    queryHost: env.QUERY_HOST!.trim(),
    queryPort: port,
    queryUser: env.QUERY_USER!,
    queryPassword: env.QUERY_PASSWORD!,
    larryUrl: env.LARRY_URL!.trim(),
    larrySecret: env.LARRY_SECRET!,
  };
}
