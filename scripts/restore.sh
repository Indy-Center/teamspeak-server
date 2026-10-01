#!/usr/bin/env bash
# Replaces the TeamSpeak data volume with a snapshot from ~/backups/<app>/. Runs on the VPS as deploy.
# Needs APP (the repo name) and FILE (the snapshot's file name).
set -euo pipefail

: "${APP:?}" "${FILE:?}"
snapshot=$HOME/backups/$APP/$FILE
if [ ! -f "$snapshot" ]; then
  echo "Not found: $snapshot" >&2
  ls -1 "$HOME/backups/$APP" >&2 || true
  exit 1
fi

cd "$HOME/apps/$APP"
docker compose stop teamspeak

# Empty the volume and unpack the snapshot into it.
docker compose run --rm --no-deps -T --entrypoint sh \
  -v "$HOME/backups/$APP:/backup:ro" -e FILE="$FILE" teamspeak -c '
    set -e
    find /var/ts3server -mindepth 1 -delete
    tar xzf "/backup/$FILE" -C /var/ts3server
    test -f /var/ts3server/ts3server.sqlitedb' </dev/null

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose up -d
sleep 15
docker compose ps

# Fail if any container is restarting or has restarted.
state=$(docker inspect -f '{{.State.Restarting}} {{.RestartCount}}' $(docker compose ps -aq))
if grep -qv '^false 0$' <<<"$state"; then
  docker compose logs --tail 50
  exit 1
fi

# Fail if the server started on an empty database instead of the snapshot's.
logs=$(docker compose logs --since "$started" teamspeak 2>&1)
if grep -qi 'privilege key created' <<<"$logs"; then
  echo "The server generated a new privilege key: it did not load the snapshot's database." >&2
  exit 1
fi
echo "Restored $FILE"
