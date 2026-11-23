# teamspeak-server

The TeamSpeak 3 voice server for Indy Center, run from the official `teamspeak` image on the Vanderbilt VPS. Controllers connect to it with a TeamSpeak client; nothing calls it over HTTP.

[![Build and Deploy](https://github.com/Indy-Center/teamspeak-server/actions/workflows/build-and-deploy.yml/badge.svg)](https://github.com/Indy-Center/teamspeak-server/actions/workflows/build-and-deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

This is the production server. It replaced the native install at `/opt/teamspeak-server` (the `teamspeak` systemd service, now stopped and disabled) in [DEV-171](https://zidartcc.atlassian.net/browse/DEV-171).

## Ports

| Purpose | Published on the VPS |
| ------- | -------------------- |
| Voice | `9987/udp` |
| File transfer (icons, avatars, channel files) | `30033/tcp` |
| ServerQuery | `127.0.0.1:10011/tcp` |

ServerQuery is published on the VPS's loopback address only and must never be reachable from outside.

This is the one app on the VPS that publishes ports on the host instead of going through Traefik. TeamSpeak is UDP voice plus its own TCP protocols, so Traefik has no TLS to terminate and no hostname to route on, and it would forward every client from its own address. TeamSpeak can't read a PROXY header, so IP bans and per-IP flood protection would treat all clients as one. The TeamSpeak DNS record stays DNS-only in Cloudflare for the same reason: Cloudflare's proxy doesn't carry these ports.

## Project layout

- `deploy/`: everything deployed to `/home/deploy/apps/teamspeak-server/` on the VPS, and nothing else.
  - `docker-compose.yml`: the TeamSpeak service, its published ports, the `ts3-data` volume and its own network. Also `data-tools`, which never runs on its own: the backup scripts start it as a throwaway container to read and write the volume. The deploy pulls it, so it is on the VPS before the first backup. And `teamspeak-bot`, behind the `bot` profile (see [teamspeak-bot](#teamspeak-bot)).
  - `backup.sh` and `restore.sh`: the backup recipe and its reverse (see [Backups](#backups)).
  - `query_ip_allowlist.txt`: addresses exempt from ServerQuery flood limits: loopback and the compose network. It is mounted at `/etc/ts3server/`, outside the data directory, because the image's entrypoint changes the owner of everything under `/var/ts3server` and fails on a read-only file there.
  - `.env.example`: the runtime settings the deploy writes to `.env`: teamspeak-bot's four. Only the bot's service loads `.env`; TeamSpeak's names what it needs in the compose file, so the bot's secret and query password never reach the TeamSpeak container.
- `bot/`: teamspeak-bot, a Node 22 and TypeScript project with its own Dockerfile (see [teamspeak-bot](#teamspeak-bot)).
- `tests/backup-round-trip.sh`: proves a backup restores as the same server. CI runs it.
- `.github/workflows/ci.yml`: checks the compose file with and without the `bot` profile, pulls the images, starts the server on the runner to see it stay up (without the bot), then runs the backup round trip. A second job runs teamspeak-bot's typecheck, tests and build, and builds its image.
- `.github/workflows/build-and-deploy.yml`: runs CI, then on `main` builds and pushes teamspeak-bot's image, rsyncs `deploy/` to the VPS and runs `docker compose up -d` over SSH.

## Data

All server state lives in the `teamspeak-server_ts3-data` Docker volume, mounted at `/var/ts3server`: the SQLite database (identities, groups, permissions, channels, bans, the server's own identity), and `files/` (icons, avatars, channel files). The server is unlicensed, so there is no license key to carry. None of it is in this repository, and the repository is public, so none of it ever should be.

The volume is named after the repository. Renaming the repository starts the server on a new, empty volume.

## Backups

The server is backed up nightly by the VPS's backup runner, which encrypts each backup and stores it off the box. [docker-infrastructure](https://github.com/Indy-Center/docker-infrastructure#backups) owns the runner and the schedule. This repository ships the two scripts the runner's contract asks for.

`deploy/backup.sh <folder>` writes one archive, `teamspeak-server.tar.gz`, into the folder. It holds everything that makes this server itself, so a restore brings back the same server rather than a new one that clients warn about:

| In the archive | Holds |
| -------------- | ----- |
| `ts3server.sqlitedb` | Channels, groups, permissions, bans, users, and the server's identity (its key pair, which clients remember) |
| `files/` | Uploaded icons, avatars and channel files |
| `ssh_host_rsa_key` | The SSH ServerQuery host key, if the server has made one |
| `licensekey.dat` | The licence, if there is one |

The server keeps running during a backup. The database is in write-ahead-log mode, so recent changes sit in a separate `-wal` file, and copying the database file alone would lose them. The script copies it with SQLite's online backup instead, which gets the database as it stands while the server writes, and checks the copy's integrity. The TeamSpeak image has no `sqlite3`, so this runs in `data-tools`, a throwaway container from the official Python image, whose `sqlite3` module does the online backup. The archive is unencrypted until the runner encrypts it, and holds the server's identity, so it is readable only by whoever ran the script.

`deploy/restore.sh <archive>` puts a decrypted archive back, replacing the server's data:

1. with the server still running, unpacks the archive into a folder inside the data volume and checks its database passes SQLite's integrity check. A bad archive stops here and changes nothing;
2. stops the server, moves its data aside into `.restore-old` in the volume, and moves the archive's data in;
3. starts the server, and checks it loaded the archive's database. A server that finds no usable database makes a new one, with a new identity, and announces a new admin privilege key, so that message means the restore failed;
4. deletes the data it moved aside.

If anything fails or is interrupted after the server stops, `restore.sh` puts the earlier data back and starts the server on it, and says so. If even that fails, the earlier data stays in the volume at `/var/ts3server/.restore-old`, and a later `restore.sh` refuses to run until `bash restore.sh --undo` has put it back.

Everyone on the server is disconnected while it restarts, and the legacy Discord sync bot needs a restart afterwards (see [Deployment](#deployment)). A Recover one app runbook is coming to tech.flyindycenter.com; until then, see [Backups in docker-infrastructure](https://github.com/Indy-Center/docker-infrastructure#backups). In short, on the VPS as `deploy`, `backups list teamspeak-server` shows the backups and `backups restore teamspeak-server <backup>` fetches, decrypts and restores one.

To run the scripts by hand instead, as `deploy`, keep the archive under `/home/deploy` (today's VPS runs Docker as a snap, which can't read most paths outside `/home`) and out of `~/backups/teamspeak-server/`, which the runner empties on every backup:

```bash
cd ~/apps/teamspeak-server
mkdir -p -m 700 ~/teamspeak-before-restore
bash backup.sh ~/teamspeak-before-restore   # a copy of what is there now, in case
bash restore.sh /path/to/teamspeak-server.tar.gz
```

Delete `~/teamspeak-before-restore` once the restored server is checked: it holds the server's identity unencrypted.

The snapshots of the old native install, taken for the move to Docker, have the same layout, so `restore.sh` loads them too. They are in `~/backups/teamspeak-server/` on the VPS, which the runner deletes on its first backup of this server: move them out before this recipe is deployed (`mv ~/backups/teamspeak-server ~/teamspeak-migration-snapshots`), or delete them if they are no longer needed.

CI proves the round trip on every pull request (`tests/backup-round-trip.sh`): it starts a server, creates a channel and uploads a folder to it, backs up, deletes the volume, restores, and checks the channel, the folder and the server's identity are back. It also checks that a restore that fails after the stop, or was interrupted, leaves the server on its earlier data. The test waits for the server to log that it loaded its query allowlist before sending any ServerQuery command: ServerQuery opens before that, and commands sent in the gap count towards flood protection and get the machine banned. To run it yourself, with Docker on an x86 machine (the TeamSpeak image is x86 only) and ports 9987, 10011 and 30033 free:

```bash
bash tests/backup-round-trip.sh
```

## Local development

```bash
docker compose -f deploy/docker-compose.yml up
```

This starts a fresh server with an empty database. The log prints a `serveradmin` password and a privilege key once; connect a TeamSpeak client to `localhost` and paste the key to become server admin. `docker compose -f deploy/docker-compose.yml down -v` throws the server and its data away.

## teamspeak-bot

teamspeak-bot (`bot/`) carries out the role sync's TeamSpeak changes. It holds no logic about who gets what: larry's Worker decides, queues TeamSpeak jobs, and the bot pulls them, applies them over ServerQuery and reports back. It keeps nothing of its own, so it has no volume and nothing to back up.

**What it does:**

- Connects to ServerQuery at `teamspeak:10011` on the compose network (the query allowlist covers the subnet), logs in with its own ServerQuery account and selects virtual server 1.
- Calls larry's Worker at `LARRY_URL`, sending `Authorization: Bearer <LARRY_SECRET>` on each call:
  - `POST /teamspeak/jobs/pull` with `{ "max": 10 }`, answered `200 { "jobs": [...] }`. Each job is leased to the bot for 60 seconds.
  - `POST /teamspeak/results`, a list of results, answered `202`.
  - `POST /teamspeak/jobs/ack` with `{ "acks": [jobId], "retries": [jobId] }`, answered `204`, after the results. larry moves a job to its dead-letter table after 5 tries.
- Pulls again at once when jobs came back, every 5 seconds when none did, and 5 seconds after any retry (larry hands a retried job out again straight away).
- Sends `heartbeat` every 5 minutes.
- Subscribes to client-enter events on each ServerQuery connection, including every reconnection, and sends `client-connected` for each client that enters, query clients excluded. It never sends a message of its own accord: the text comes from larry's `send-text` job.
- Logs to stdout only. It logs job IDs and outcomes, never UIDs or settings' values.

**Jobs**, as JSON:

- `{ jobId, type: "set-groups", uid, add: number[], remove: number[] }`: adds the client with that unique ID to the server groups in `add` and takes it out of those in `remove`; other groups are left alone. A group the client already has, or no longer has, counts as done. Answered `applied` and acked. A UID the server doesn't know is answered `failed` with `error: "unknown uid"` and acked, since a retry can't help. Any other ServerQuery error is answered `failed` with the error, and retried.
  - A job whose `add` or `remove` names an admin group (1 Guest Server Query, 2 Admin Server Query, 6 Server Admin, 8 Guest, 27 the bot's own) is refused before any ServerQuery command: answered `failed` with `error: "admin group <id>"` and acked. The list is `ADMIN_GROUPS` in `bot/src/jobs.ts`, the same as larry's.
- `{ jobId, type: "report-accounts", groups: number[] }`: answered with one `accounts` result and acked. `holders` is every client in the client database holding at least one of `groups`, once each, with all its server groups; `connected` is the UIDs connected now, query clients excluded. A ServerQuery error is answered `failed` and retried.
- `{ jobId, type: "send-text", clientId, text }`: sends `text` to the client with that client ID (`clid`, from its `client-connected` result) as a private message. Answered `applied` and acked. A ServerQuery error (a client that has left, say) is answered `failed` and retried.
- A job type the bot doesn't know is answered `failed` (`unknown job type: <type>`) and retried.

**Results**, as JSON: `{ type: "applied", jobId }`, `{ type: "failed", jobId, error? }`, `{ type: "heartbeat", at }`, `{ type: "reconnected", at }`, `{ type: "accounts", holders: { uid, groups: number[] }[], connected: string[] }` and `{ type: "client-connected", uid, clientId, nickname }`, where `at` is an ISO 8601 time. The job and result shapes are in `bot/src/teamspeak-shape.ts`, a copy of indy-larry's `worker/src/teamspeak-shape.ts`: there is no shared package, so a change to one is made to the other.

**When things fail**, it retries rather than exiting, so a deploy never sees it restart:

- ServerQuery refused or unreachable, at start-up or later: tries again after 1 second, doubling to 60. After a lost connection it reconnects the same way, then sends `reconnected`, on which larry runs a full sync. A ServerQuery command with no answer for 30 seconds closes the connection and reconnects. No job is pulled while it is disconnected.
- larry unreachable, or answering anything but what the route promises: backs off the same way, keeping its ServerQuery connection. A job whose results or ack don't reach larry isn't acked, so larry hands it out again when its lease runs out. A `heartbeat`, `reconnected` or `client-connected` that doesn't reach larry is sent again until it does (only the latest heartbeat is kept).
- A missing setting stops it at start with a message naming the setting. That is the one case it exits.

`restore.sh` stops and starts only the `teamspeak` service, so the bot keeps running through a restore and reports `reconnected` once TeamSpeak is back.

**Settings**, in `.env` (`deploy/.env.example` lists them). The deploy writes them from teamspeak-server's GitHub settings, stripping `ENV_`:

| Setting | GitHub setting | What it is |
| ------- | -------------- | ---------- |
| `QUERY_USER` | variable `ENV_QUERY_USER` | The bot's own ServerQuery login: it can set server groups and send messages, and can't administer the server |
| `QUERY_PASSWORD` | secret `ENV_QUERY_PASSWORD` | That login's password |
| `LARRY_URL` | variable `ENV_LARRY_URL` | larry's Worker, e.g. `https://<worker>.workers.dev` |
| `LARRY_SECRET` | secret `ENV_LARRY_SECRET` | The secret larry's teamspeak-bot routes check: the same value as indy-larry's `ENV_TEAMSPEAK_BOT_SECRET` |

`QUERY_HOST` and `QUERY_PORT` are set in the compose file (`teamspeak` and `10011`).

**The `bot` profile.** The service only starts with `--profile bot`, which the deploy doesn't pass, and neither does CI. Until TeamSpeak moves to ALEXANDRIA, a push to `main` deploys to the droplet, and the bot must never run against the live server there; the move turns the profile on in the deploy.

**The image.** CI builds it on every pull request. On `main`, the deploy pushes it to `ghcr.io/indy-center/teamspeak-bot`, tagged `latest` and with the commit, and pins the deployed compose file to the commit's tag. The package is public, so the server pulls it without logging in.

**Working on it:**

```bash
cd bot
npm ci
npm run typecheck
npm test        # against a fake ServerQuery and a fake larry; no TeamSpeak needed
npm run build
```

**Against a local TeamSpeak** (on an x86 machine: the TeamSpeak image is x86 only):

1. Start the server: `docker compose -f deploy/docker-compose.yml up -d teamspeak`, and read the `serveradmin` password from `docker compose -f deploy/docker-compose.yml logs teamspeak`.
2. Run larry's Worker locally (`npx wrangler dev` in indy-larry's `worker/`, with `TEAMSPEAK_BOT_SECRET` in its `.dev.vars`), at an address the bot's container can reach, such as the host's own address.
3. Write `deploy/.env`, which git ignores: `QUERY_USER=serveradmin`, `QUERY_PASSWORD=<from the log>`, `LARRY_URL=<the Worker's address>` and `LARRY_SECRET=<the same secret>`.
4. `docker compose -f deploy/docker-compose.yml --profile bot up --build`. The bot logs `ServerQuery connected`, then each job it applies.

`docker compose -f deploy/docker-compose.yml --profile bot down -v` throws it all away, `deploy/.env` aside.

## Deployment

`build-and-deploy.yml` runs on every push to `main`, and by hand from **Actions → Build and Deploy → Run workflow**. It calls `ci.yml` first and only deploys if it passes, then checks the container is still up 15 seconds later. [Deploying to the VPS](https://tech.flyindycenter.com/patterns/vps-apps/) describes the pipeline.

A deploy that changes `deploy/docker-compose.yml` recreates the container, which disconnects everyone on the server for a few seconds. Merge those changes when the server is quiet. A deploy that changes nothing in `deploy/` leaves the container running.

The legacy Discord sync bot in `/opt/ts-disc-control` connects to ServerQuery on `127.0.0.1:10011` and never reconnects on its own. Restart it after any deploy that recreates the container.

The image is pinned by digest so a deploy never pulls a rebuilt tag and recreates the container by surprise. Upgrading TeamSpeak is a change to the image line: the tag and its digest together. The server upgrades its database on first start and can't go back to an older version, so take a backup first: `backups now teamspeak-server` on the VPS, as `deploy`.

The deploy uses the organization's `VANDERBILT_*` variables and secrets. An org admin adds this repository to all four before the first deploy.

## Disclaimer

We are not affiliated with the FAA or any aviation governing body. This software is for flight simulation use on the [VATSIM](https://www.vatsim.net) network.
