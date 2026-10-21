#!/usr/bin/env bash
# Replaces the server's data with a backup.sh archive and starts the server on it.
# If anything fails after the server stops, puts the earlier data back and starts the server.
#
# Usage: bash restore.sh <archive>   (the decrypted teamspeak-server.tar.gz)
#        bash restore.sh --undo      (puts back the data an interrupted restore set aside)
set -euo pipefail

arg=${1:?usage: restore.sh <archive> | --undo}
if [ "$arg" != --undo ]; then
  [ -f "$arg" ] || { echo "Not found: $arg" >&2; exit 1; }
  # Absolute folder and file name of the archive, for Docker's mount.
  dir=$(cd "$(dirname "$arg")" && pwd)
  name=$(basename "$arg")
fi

# Compose finds docker-compose.yml, and the data volume, from this script's folder.
cd "$(dirname "$0")"

# Runs a script from stdin in a throwaway data-tools container (data volume at /var/ts3server).
data_tools() {
  docker compose run --rm --no-deps -T "$@" data-tools sh -s
}

# Folders inside the volume while a restore runs:
#   .restore-new      the unpacked archive
#   .restore-old      the data it replaces; .restore-old/.complete once all of it is there
#   .restore-discard  the replaced data, being deleted after a successful restore

# Puts .restore-old back as the server's data, removing anything moved in from the archive.
undo() {
  data_tools <<'EOF'
set -eu
cd /var/ts3server
[ -d .restore-old ] || exit 0
if [ -e .restore-old/.complete ]; then
  find . -mindepth 1 -maxdepth 1 ! -name '.restore-*' -exec rm -rf {} +
fi
find .restore-old -mindepth 1 -maxdepth 1 ! -name .complete -exec mv {} . \;
# find ignores a failed mv, so rmdir checks all of it moved: anything left stays in .restore-old.
rm -f .restore-old/.complete
rmdir .restore-old
rm -rf .restore-new
chown -R 9987:9987 .
EOF
}

# Starts the server and waits up to three minutes for ServerQuery. Leaves its log in $logs.
start_server() {
  local started
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  docker compose up -d teamspeak
  for _ in $(seq 90); do
    logs=$(docker compose logs --since "$started" teamspeak 2>&1)
    if [[ $logs == *"listening for query"* ]]; then return 0; fi
    sleep 2
  done
  docker compose logs --tail 50 teamspeak
  return 1
}

if [ "$arg" = --undo ]; then
  docker compose stop teamspeak
  undo
  start_server
  echo "Put back the data from before the interrupted restore."
  exit 0
fi

# 1. With the server still running: unpack the archive into .restore-new and check its database.
echo "Unpacking and checking $name"
data_tools -v "$dir:/backup:ro" -e NAME="$name" <<'EOF'
set -eu
cd /var/ts3server
if [ -d .restore-old ]; then
  echo "An earlier restore was interrupted. The data from before it is in the volume at" >&2
  echo "/var/ts3server/.restore-old. Check the server, then run: bash restore.sh --undo" >&2
  exit 1
fi
rm -rf .restore-new .restore-discard
trap 'rm -rf /var/ts3server/.restore-new' EXIT
mkdir .restore-new
tar xzf "/backup/$NAME" -C .restore-new
[ -f .restore-new/ts3server.sqlitedb ] || { echo "$NAME holds no ts3server.sqlitedb" >&2; exit 1; }
python3 -c "
import sqlite3, sys
result = sqlite3.connect('.restore-new/ts3server.sqlitedb').execute('PRAGMA integrity_check').fetchone()[0]
if result != 'ok':
    sys.exit('The database in the archive failed its integrity check: ' + result)
"
trap - EXIT
EOF

# From here on, any failure or interruption puts the earlier data back.
reason="it was interrupted or a step failed"
on_failure() {
  local status=$?
  trap - EXIT INT TERM
  echo "The restore failed: $reason. Putting back the data from before it." >&2
  docker compose stop teamspeak || true
  if undo && start_server; then
    echo "The server is running again on its data from before the restore." >&2
  else
    echo "Could not put the earlier data back. It is in the data volume at" >&2
    echo "/var/ts3server/.restore-old. To try again: bash restore.sh --undo" >&2
  fi
  exit $((status == 0 ? 1 : status))
}
trap on_failure EXIT
trap 'exit 130' INT TERM

# 2. Stop the server, set its data aside in .restore-old, and move the archive's in.
docker compose stop teamspeak
echo "Replacing the server's data with $name"
data_tools <<'EOF'
set -eu
cd /var/ts3server
mkdir .restore-old
find . -mindepth 1 -maxdepth 1 ! -name '.restore-*' -exec mv {} .restore-old/ \;
# find ignores a failed mv: only mark it complete once nothing of the old data is left outside,
# since undo deletes what is outside a complete .restore-old.
[ -z "$(find . -mindepth 1 -maxdepth 1 ! -name '.restore-*')" ]
touch .restore-old/.complete
find .restore-new -mindepth 1 -maxdepth 1 -exec mv {} . \;
rmdir .restore-new
chown -R 9987:9987 .
EOF

# 3. Start the server and check it loaded the archive's database.
reason="the server did not finish starting"
start_server
if [[ $logs == *"privilege key created"* ]]; then
  reason="the server made a new privilege key, so it started on a new, empty database with a new identity, not the archive's"
  exit 1
fi
state=$(docker inspect -f '{{.State.Restarting}} {{.RestartCount}}' "$(docker compose ps -q teamspeak)")
if [ "$state" != "false 0" ]; then
  reason="the server is restarting"
  exit 1
fi

# 4. Passed: delete the replaced data.
trap - EXIT INT TERM
data_tools <<'EOF' || echo "Restored, but could not delete /var/ts3server/.restore-discard; the next restore will." >&2
set -eu
cd /var/ts3server
mv .restore-old .restore-discard
rm -rf .restore-discard
EOF
echo "Restored $name"
