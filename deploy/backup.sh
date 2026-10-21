#!/usr/bin/env bash
# Writes the server's data to one archive, teamspeak-server.tar.gz, in the given folder.
# The server keeps running.
#
# Usage: bash backup.sh <empty output folder>
set -euo pipefail

out=${1:?usage: backup.sh <empty output folder>}
[ -d "$out" ] || { echo "Not a folder: $out" >&2; exit 1; }
# Docker needs an absolute path to mount the folder.
out=$(cd "$out" && pwd)

# Compose finds docker-compose.yml, and the data volume, from this script's folder.
cd "$(dirname "$0")"

# In a throwaway data-tools container: data volume at /var/ts3server, output folder at /out.
# OWNER is who ran this script.
docker compose run --rm --no-deps -T -v "$out:/out" -e OWNER="$(id -u):$(id -g)" \
  data-tools sh -s <<'EOF'
set -eu
data=/var/ts3server
work=$(mktemp -d)

# The database, by SQLite's online backup, then an integrity check of the copy.
# mode=ro fails on a missing database instead of creating an empty one.
python3 -c "
import sqlite3, sys
src = sqlite3.connect('file:$data/ts3server.sqlitedb?mode=ro', uri=True)
dst = sqlite3.connect('$work/ts3server.sqlitedb')
src.backup(dst)
result = dst.execute('PRAGMA integrity_check').fetchone()[0]
dst.close()
if result != 'ok':
    sys.exit('The copied database failed its integrity check: ' + result)
"

# The uploaded files, the SSH host key and the licence, kept with their owners and modes.
for item in files ssh_host_rsa_key licensekey.dat; do
  if [ -e "$data/$item" ]; then cp -a "$data/$item" "$work/"; fi
done

# One archive, written under a temporary name and renamed when complete, readable only by the caller.
tar czf /out/.teamspeak-server.tar.gz.partial -C "$work" .
chown "$OWNER" /out/.teamspeak-server.tar.gz.partial
chmod 600 /out/.teamspeak-server.tar.gz.partial
mv /out/.teamspeak-server.tar.gz.partial /out/teamspeak-server.tar.gz
EOF
