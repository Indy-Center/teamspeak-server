# teamspeak-server

The TeamSpeak 3 voice server for Indy Center, run from the official `teamspeak` image on the Vanderbilt VPS. Controllers connect to it with a TeamSpeak client; nothing calls it over HTTP.

[![Build and Deploy](https://github.com/Indy-Center/teamspeak-server/actions/workflows/build-and-deploy.yml/badge.svg)](https://github.com/Indy-Center/teamspeak-server/actions/workflows/build-and-deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Status: not production yet.** Production TeamSpeak still runs natively on the same VPS, as the `teamspeak` systemd service. This container runs beside it on test ports until it's proven, then takes over the real ports ([DEV-171](https://zidartcc.atlassian.net/browse/DEV-171)).

## Ports

| Purpose | Published on the VPS today | After cutover |
| ------- | -------------------------- | ------------- |
| Voice | `9988/udp` | `9987/udp` |
| File transfer (icons, avatars, channel files) | `30034/tcp` | `30033/tcp` |
| ServerQuery | `127.0.0.1:10012/tcp` | `127.0.0.1:10011/tcp` |

ServerQuery is published on the VPS's loopback address only and must never be reachable from outside.

This is the one app on the VPS that publishes ports on the host instead of going through Traefik. TeamSpeak is UDP voice plus its own TCP protocols, so Traefik has no TLS to terminate and no hostname to route on, and it would forward every client from its own address. TeamSpeak can't read a PROXY header, so IP bans and per-IP flood protection would treat all clients as one. The TeamSpeak DNS record stays DNS-only in Cloudflare for the same reason: Cloudflare's proxy doesn't carry these ports.

## Project layout

- `deploy/`: everything deployed to `/home/deploy/apps/teamspeak-server/` on the VPS, and nothing else.
  - `docker-compose.yml`: the TeamSpeak service, its published ports, the `ts3-data` volume and its own network.
  - `query_ip_allowlist.txt`: addresses exempt from ServerQuery flood limits: loopback and the compose network. It is mounted at `/etc/ts3server/`, outside the data directory, because the image's entrypoint changes the owner of everything under `/var/ts3server` and fails on a read-only file there.
  - `.env.example`: the runtime settings the deploy writes to `.env`. None yet.
  - `snapshot.sh`: copies a native TeamSpeak install's data into one tarball, while the server runs. Only needed until cutover.
- `scripts/restore.sh`: replaces the data volume with a snapshot tarball. The Restore workflow runs it on the VPS over SSH.
- `.github/workflows/ci.yml`: checks the compose file, pulls the image, starts the server on the runner to see it stay up, then snapshots it, wipes it and restores it.
- `.github/workflows/build-and-deploy.yml`: runs CI, then rsyncs `deploy/` to the VPS and runs `docker compose up -d` over SSH.
- `.github/workflows/restore.yml`: run by hand; loads a snapshot from `~/backups/teamspeak-server/` on the VPS into the server.

## Data

All server state lives in the `teamspeak-server_ts3-data` Docker volume, mounted at `/var/ts3server`: the SQLite database (identities, groups, permissions, channels, bans, the server's own identity), and `files/` (icons, avatars, channel files). The server is unlicensed, so there is no license key to carry. None of it is in this repository, and the repository is public, so none of it ever should be.

The volume is named after the repository. Renaming the repository starts the server on a new, empty volume.

## Loading production data

The container is filled from a snapshot of the native install at `/opt/teamspeak-server`. Docker on the VPS can't read `/opt`, so the snapshot is taken on the host and written under `/home/deploy`.

1. On the VPS, as root:

   ```bash
   bash /home/deploy/apps/teamspeak-server/snapshot.sh /opt/teamspeak-server /home/deploy/backups/teamspeak-server
   ```

   It prints the tarball's path. The server keeps running; the copy uses SQLite's online backup, so it includes changes that are still in the write-ahead log. It needs `sqlite3` on the host (`apt install sqlite3`).

2. Run **Actions → Restore → Run workflow** with the tarball's file name, and the repository name as confirmation.

Restore stops the server, empties the data volume, unpacks the snapshot and starts the server again. It fails if the server comes up on an empty database, which it detects by the server announcing a new privilege key. It wipes whatever the container held, so after cutover it is a disaster-recovery tool, not a routine one.

## Local development

```bash
docker compose -f deploy/docker-compose.yml up
```

This starts a fresh server with an empty database. The log prints a `serveradmin` password and a privilege key once; connect a TeamSpeak client to `localhost:9988` and paste the key to become server admin. `docker compose -f deploy/docker-compose.yml down -v` throws the server and its data away.

## Deployment

`build-and-deploy.yml` runs on every push to `main`, and by hand from **Actions → Build and Deploy → Run workflow**. It calls `ci.yml` first and only deploys if it passes, then checks the container is still up 15 seconds later. [Deploying to the VPS](https://tech.flyindycenter.com/patterns/vps-apps/) describes the pipeline.

A deploy that changes `deploy/docker-compose.yml` recreates the container, which disconnects everyone on the server for a few seconds. Merge those changes when the server is quiet. A deploy that changes nothing in `deploy/` leaves the container running.

The image is pinned by digest so a deploy never pulls a rebuilt tag and recreates the container by surprise. Upgrading TeamSpeak is a change to the image line: the tag and its digest together. The server upgrades its database on first start and can't go back to an older version, so take a copy of the data first.

The deploy uses the organization's `VANDERBILT_*` variables and secrets. An org admin adds this repository to all four before the first deploy.

## Disclaimer

We are not affiliated with the FAA or any aviation governing body. This software is for flight simulation use on the [VATSIM](https://www.vatsim.net) network.
