#!/usr/bin/env bash
# Snapshots a native TeamSpeak install into a tarball that scripts/restore.sh can load. Run as root.
# Usage: snapshot.sh <install dir> <output dir>
set -euo pipefail

src=${1:?usage: snapshot.sh <install dir> <output dir>}
out=${2:?usage: snapshot.sh <install dir> <output dir>}
db=$src/ts3server.sqlitedb

command -v sqlite3 >/dev/null || { echo "sqlite3 is not installed" >&2; exit 1; }
[ -f "$db" ] || { echo "No ts3server.sqlitedb in $src" >&2; exit 1; }

uid=$(stat -c %u "$db")
gid=$(stat -c %g "$db")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chown "$uid:$gid" "$work"

# Online backup as the database's owner; safe while the server is running.
setpriv --reuid="$uid" --regid="$gid" --clear-groups \
  sqlite3 "$db" ".backup '$work/ts3server.sqlitedb'"

if [ -d "$src/files" ]; then
  cp -a "$src/files" "$work/"
fi
if [ -f "$src/ssh_host_rsa_key" ]; then
  cp -a "$src/ssh_host_rsa_key" "$work/"
fi

if [ ! -d "$out" ]; then
  mkdir "$out"
  chown --reference="$(dirname "$out")" "$out"
fi
file=$out/$(basename "$out")-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
tar czf "$file" -C "$work" .
chown --reference="$out" "$file"
echo "$file"
