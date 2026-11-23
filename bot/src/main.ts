import { startBot } from './bot.js';
import { readConfig } from './config.js';
import { createLarry } from './larry.js';
import { ts3Connector } from './ts3.js';

// Logs go to stdout only; Docker keeps them.
const log = (line: string) => console.log(line);

let config;
try {
  config = readConfig(process.env);
} catch (error) {
  log(`teamspeak-bot can't start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const bot = startBot({
  connect: ts3Connector({
    host: config.queryHost,
    port: config.queryPort,
    user: config.queryUser,
    password: config.queryPassword,
    log,
  }),
  larry: createLarry({ url: config.larryUrl, secret: config.larrySecret }),
  log,
});
log(`teamspeak-bot started: ServerQuery at ${config.queryHost}:${config.queryPort}, larry at ${new URL(config.larryUrl).origin}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log(`teamspeak-bot stopping (${signal})`);
    void bot.stop().then(() => process.exit(0));
  });
}
