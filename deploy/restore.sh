#!/usr/bin/env bash
# Puts a backup.sh archive back into the server, replacing everything in its data volume: stops
# the server, empties the volume, unpacks the archive into it, and starts the server again. Also
# loads the hand-made snapshots of the old native install, which have the same layout.
# It fails if the server comes up on a new, empty database instead of the archive's.
#
# Usage: bash restore.sh <archive>   (the decrypted teamspeak-server.tar.gz)
set -euo pipefail

file=${1:?usage: restore.sh <archive>}
[ -f "$file" ] || { echo "Not found: $file" >&2; exit 1; }
# Docker mounts the archive's folder, so it needs that folder's absolute path.
dir=$(cd "$(dirname "$file")" && pwd)
name=$(basename "$file")

# Compose finds docker-compose.yml, and the data volume, from this script's folder.
cd "$(dirname "$0")"

# Runs a shell script (on stdin) in a throwaway data-tools container, with the data volume at
# /var/ts3server and the archive at /backup/$name.
in_data_tools() {
  docker compose run --rm --no-deps -T -v "$dir:/backup:ro" -e NAME="$name" data-tools sh -s
}

# 1. Check the archive before touching the server: it unpacks, and holds a database that passes
#    SQLite's integrity check. A bad file stops here, with the server still running.
echo "Checking $name"
in_data_tools <<'EOF'
set -eu
check=$(mktemp -d)
tar xzf "/backup/$NAME" -C "$check"
[ -f "$check/ts3server.sqlitedb" ] || { echo "$NAME holds no ts3server.sqlitedb" >&2; exit 1; }
python3 -c "
import sqlite3, sys
result = sqlite3.connect('$check/ts3server.sqlitedb').execute('PRAGMA integrity_check').fetchone()[0]
if result != 'ok':
    sys.exit('The database in the archive failed its integrity check: ' + result)
"
EOF

# 2. Stop the server, so nothing writes to the volume while it is replaced.
docker compose stop teamspeak

# 3. Empty the volume and unpack the archive into it. The server runs as uid 9987, so give it
#    the files (its entrypoint does this too, on every start).
echo "Replacing the data volume with $name"
in_data_tools <<'EOF'
set -eu
find /var/ts3server -mindepth 1 -delete
tar xzf "/backup/$NAME" -C /var/ts3server
chown -R 9987:9987 /var/ts3server
EOF

# 4. Start the server, and wait up to three minutes for it to open ServerQuery, which it does
#    once the database is loaded and the virtual server is up.
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose up -d teamspeak
for _ in $(seq 90); do
  logs=$(docker compose logs --since "$started" teamspeak 2>&1)
  if [[ $logs == *"listening for query"* ]]; then break; fi
  sleep 2
done
if [[ $logs != *"listening for query"* ]]; then
  docker compose logs --tail 50 teamspeak
  echo "The server did not finish starting after the restore." >&2
  exit 1
fi

# 5. Check it is the restored server. A server that finds no database makes a new one and
#    announces a new admin privilege key; the restored one never does.
if [[ $logs == *"privilege key created"* ]]; then
  echo "The server made a new privilege key: it did not load the archive's database." >&2
  exit 1
fi
state=$(docker inspect -f '{{.State.Restarting}} {{.RestartCount}}' "$(docker compose ps -q teamspeak)")
if [ "$state" != "false 0" ]; then
  docker compose logs --tail 50 teamspeak
  echo "The server is restarting after the restore." >&2
  exit 1
fi
echo "Restored $name"
