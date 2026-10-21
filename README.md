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
  - `docker-compose.yml`: the TeamSpeak service, its published ports, the `ts3-data` volume and its own network. Also `data-tools`, which never runs on its own: the backup scripts start it as a throwaway container to read and write the volume.
  - `backup.sh` and `restore.sh`: the backup recipe and its reverse (see [Backups](#backups)).
  - `query_ip_allowlist.txt`: addresses exempt from ServerQuery flood limits: loopback and the compose network. It is mounted at `/etc/ts3server/`, outside the data directory, because the image's entrypoint changes the owner of everything under `/var/ts3server` and fails on a read-only file there.
  - `.env.example`: the runtime settings the deploy writes to `.env`. None yet.
- `tests/backup-round-trip.sh`: proves a backup restores as the same server. CI runs it.
- `.github/workflows/ci.yml`: checks the compose file, pulls the images, starts the server on the runner to see it stay up, then runs the backup round trip.
- `.github/workflows/build-and-deploy.yml`: runs CI, then rsyncs `deploy/` to the VPS and runs `docker compose up -d` over SSH.

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

The server keeps running during a backup. The database is in write-ahead-log mode, so recent changes sit in a separate `-wal` file, and copying the database file alone would lose them. The script copies it with SQLite's online backup instead, which gets the database as it stands while the server writes, and checks the copy's integrity.

`deploy/restore.sh <archive>` puts a decrypted archive back. It replaces everything in the data volume:

1. checks that the archive unpacks and holds a database that passes SQLite's integrity check, and stops there if not, with the server still running;
2. stops the server, empties the volume and unpacks the archive into it;
3. starts the server, and fails if it made a new privilege key, which means it started on a new, empty database instead of the archive's.

Everyone on the server is disconnected while it restarts, and the legacy Discord sync bot needs a restart afterwards (see [Deployment](#deployment)). To recover the server from a backup, follow [Recover one app](https://tech.flyindycenter.com/operations/recover-one-app/). In short, on the VPS as `deploy`, `backups list teamspeak-server` shows the backups and `backups restore teamspeak-server <backup>` fetches, decrypts and restores one (the runner's helper commands, from docker-infrastructure).

To run the scripts by hand instead, as `deploy`, with the archive somewhere under `/home` (Docker on the VPS is a snap and can't read elsewhere). Keep it out of `~/backups/teamspeak-server/`: the runner empties that folder on every backup.

```bash
cd ~/apps/teamspeak-server
mkdir -p ~/teamspeak-before-restore
bash backup.sh ~/teamspeak-before-restore   # a copy of what is there now, in case
bash restore.sh /path/to/teamspeak-server.tar.gz
```

`restore.sh` also loads the snapshots taken of the old native install before the move to Docker: they have the same layout.

CI proves the round trip on every pull request (`tests/backup-round-trip.sh`): it starts a server, creates a channel and uploads a folder to it, backs up, deletes the volume, restores, and checks the channel, the folder and the server's identity are back. To run it yourself, with Docker on an x86 machine (the TeamSpeak image is x86 only) and ports 9987, 10011 and 30033 free:

```bash
bash tests/backup-round-trip.sh
```

## Local development

```bash
docker compose -f deploy/docker-compose.yml up
```

This starts a fresh server with an empty database. The log prints a `serveradmin` password and a privilege key once; connect a TeamSpeak client to `localhost` and paste the key to become server admin. `docker compose -f deploy/docker-compose.yml down -v` throws the server and its data away.

## Deployment

`build-and-deploy.yml` runs on every push to `main`, and by hand from **Actions → Build and Deploy → Run workflow**. It calls `ci.yml` first and only deploys if it passes, then checks the container is still up 15 seconds later. [Deploying to the VPS](https://tech.flyindycenter.com/patterns/vps-apps/) describes the pipeline.

A deploy that changes `deploy/docker-compose.yml` recreates the container, which disconnects everyone on the server for a few seconds. Merge those changes when the server is quiet. A deploy that changes nothing in `deploy/` leaves the container running.

The legacy Discord sync bot in `/opt/ts-disc-control` connects to ServerQuery on `127.0.0.1:10011` and never reconnects on its own. Restart it after any deploy that recreates the container.

The image is pinned by digest so a deploy never pulls a rebuilt tag and recreates the container by surprise. Upgrading TeamSpeak is a change to the image line: the tag and its digest together. The server upgrades its database on first start and can't go back to an older version, so take a backup first: `backups now teamspeak-server` on the VPS, as `deploy`.

The deploy uses the organization's `VANDERBILT_*` variables and secrets. An org admin adds this repository to all four before the first deploy.

## Disclaimer

We are not affiliated with the FAA or any aviation governing body. This software is for flight simulation use on the [VATSIM](https://www.vatsim.net) network.
