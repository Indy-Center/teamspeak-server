#!/usr/bin/env bash
# The backup recipe: writes one archive, teamspeak-server.tar.gz, into the folder it is given.
# It holds everything that makes this server itself, so restore.sh brings back the same server:
#   ts3server.sqlitedb  channels, groups, permissions, bans, users, and the server's identity
#   files/              uploaded icons, avatars and channel files
#   ssh_host_rsa_key    the SSH ServerQuery host key, if the server made one
#   licensekey.dat      the licence, if there is one (the server runs unlicensed today)
# The backup runner (docker-infrastructure) calls it nightly, then encrypts and uploads the file.
# The server keeps running throughout.
#
# Usage: bash backup.sh <empty output folder>
set -euo pipefail

out=${1:?usage: backup.sh <empty output folder>}
[ -d "$out" ] || { echo "Not a folder: $out" >&2; exit 1; }
# Docker needs an absolute path to mount the folder.
out=$(cd "$out" && pwd)

# Compose finds docker-compose.yml, and the data volume, from this script's folder.
cd "$(dirname "$0")"

# One throwaway data-tools container does the work: the data volume is at /var/ts3server, the
# output folder at /out. OWNER is who ran this script, so the archive ends up theirs, not root's.
docker compose run --rm --no-deps -T -v "$out:/out" -e OWNER="$(id -u):$(id -g)" \
  data-tools sh -s <<'EOF'
set -eu
data=/var/ts3server
work=$(mktemp -d)

# The database, copied with SQLite's online backup. The server keeps it in write-ahead-log mode,
# so most recent changes live in ts3server.sqlitedb-wal; copying the file alone would lose them.
# The online backup reads through SQLite, gets the database as it stands, and is safe while the
# server writes. mode=ro fails if the database is missing, rather than creating an empty one.
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

# One archive, written under a temporary name and renamed when complete, owned by the caller.
tar czf /out/.teamspeak-server.tar.gz.partial -C "$work" .
chown "$OWNER" /out/.teamspeak-server.tar.gz.partial
mv /out/.teamspeak-server.tar.gz.partial /out/teamspeak-server.tar.gz
EOF
