#!/usr/bin/env bash
# Proves deploy/backup.sh and deploy/restore.sh round-trip a real server: start TeamSpeak,
# give it a channel and an uploaded folder, back up, wipe the volume, restore, and check the
# channel, the folder and the server's identity are back. Also checks a failed or interrupted
# restore leaves the server on its earlier data. CI runs it on every pull request.
#
# Usage: bash tests/backup-round-trip.sh
# Needs Docker, and ports 9987/udp, 30033 and 10011 free on this machine.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)

# The app folder, as on the VPS. Its name makes the volume teamspeak-server-test_ts3-data.
work=$(mktemp -d)
app=$work/teamspeak-server-test
cp -r "$repo/deploy" "$app"
cd "$app"

# ServerQuery's admin password. The image sets it on every start, so it works after a restore too.
password=round-trip-test
echo "TS3SERVER_SERVERADMIN_PASSWORD=$password" > .env

# Remove the test's containers, volume and files however the test ends.
cleanup() {
  cd "$app" && docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker compose logs --tail 30 teamspeak >&2 || true
  exit 1
}

# Sends ServerQuery commands to the server (one per argument) and prints its replies.
# ServerQuery escapes spaces as \s and slashes as \/, and ends lines with \n\r.
query() {
  local commands
  commands=$(printf '%s\n' "login serveradmin $password" "use sid=1" "$@" quit)
  exec 3<>/dev/tcp/127.0.0.1/10011
  printf '%s\n' "$commands" >&3
  timeout 20 cat <&3 | tr -d '\r'
  exec 3<&-
}

# Now, for wait_for_query.
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Waits up to three minutes, from the time given, for the server to load its query allowlist.
wait_for_query() {
  for _ in $(seq 90); do
    if [[ $(docker compose logs --since "$1" teamspeak 2>&1) == *"updated query_ip_allowlist"* ]]; then return 0; fi
    sleep 2
  done
  fail "the server never finished starting"
}

# Prints the server's identity: the unique identifier clients see, derived from its key pair.
identity() {
  query serverinfo | tr ' ' '\n' | sed -n 's/^virtualserver_unique_identifier=//p'
}

# Lists the channel's uploaded files and folders.
uploads() { query "ftgetfilelist cid=$cid cpw= path=\/"; }

# Checks the server holds the test's data: the channel, the folder and the first identity.
check_data() {
  [[ $(query channellist) == *'channel_name=Round\strip'* ]] || fail "$1: the channel is missing"
  [[ $(uploads) == *name=round-trip-folder* ]] || fail "$1: the uploaded folder is missing"
  local now_identity
  now_identity=$(identity)
  [ "$now_identity" = "$before" ] || fail "$1: the server's identity changed: $before became $now_identity"
}

# Runs a command in the data volume, with the server's data at /var/ts3server.
in_volume() { docker compose run --rm --no-deps -T data-tools sh -c "$1" </dev/null; }

# Fails if a restore left its working folders in the volume.
no_leftovers() {
  local left
  left=$(in_volume 'ls -A /var/ts3server | grep "^\.restore-" || true')
  [ -z "$left" ] || fail "$1: left in the volume: $left"
}

echo "--- Start a fresh server"
since=$(now)
docker compose up -d
wait_for_query "$since"
# restore.sh tells a server that lost its database by this message, so check it still exists.
[[ $(docker compose logs teamspeak 2>&1) == *"privilege key created"* ]] \
  || fail "a fresh server no longer logs 'privilege key created', which restore.sh relies on"

echo "--- Give it data: a channel, and a folder uploaded to that channel"
reply=$(query "channelcreate channel_name=Round\strip channel_flag_permanent=1")
cid=$(sed -n 's/^cid=\([0-9]*\).*/\1/p' <<<"$reply")
[ -n "$cid" ] || fail "could not create the channel: $reply"
query "ftcreatedir cid=$cid cpw= dirname=\/round-trip-folder" >/dev/null
[[ $(uploads) == *name=round-trip-folder* ]] || fail "could not create the folder: $(uploads)"
before=$(identity)
[ -n "$before" ] || fail "could not read the server's identity"

echo "--- Back up"
out=$work/out
mkdir "$out"
bash backup.sh "$out"
files=("$out"/*)
[ "${#files[@]}" -eq 1 ] && [ -f "${files[0]}" ] || fail "backup.sh must write exactly one file, wrote: ${files[*]}"
backup=${files[0]}
# The runner (and the deploy user) must be able to read and delete what the recipe wrote.
[ -O "$backup" ] || fail "the backup is not owned by the user who ran backup.sh"
# It holds the server's identity, so nobody else may read it.
[ "$(stat -c %a "$backup")" = 600 ] || fail "the backup's mode is $(stat -c %a "$backup"), not 600"

echo "--- A file with no database is refused, and the server keeps running"
bad=$work/bad.tar.gz
tar czf "$bad" -C "$work" out
if bash restore.sh "$bad"; then fail "restore.sh accepted a file with no database"; fi
[ -n "$(docker compose ps -q --status running teamspeak)" ] || fail "a refused restore stopped the server"
no_leftovers "after a refused restore"

echo "--- A restore the server starts empty from is undone"
# An empty file is a valid, empty SQLite database, so it passes the archive check, and the
# server makes a new one, with a new identity, when it starts.
mkdir "$work/empty"
: > "$work/empty/ts3server.sqlitedb"
tar czf "$work/empty.tar.gz" -C "$work/empty" .
since=$(now)
if bash restore.sh "$work/empty.tar.gz"; then fail "restore.sh accepted a server that started empty"; fi
wait_for_query "$since"
check_data "after an undone restore"
no_leftovers "after an undone restore"

echo "--- An interrupted restore is refused until --undo puts the earlier data back"
# What an interruption after the swap leaves: the data set aside, the archive's moved in.
docker compose stop teamspeak
in_volume 'cd /var/ts3server && mkdir .restore-old &&
  find . -mindepth 1 -maxdepth 1 ! -name ".restore-*" -exec mv {} .restore-old/ \; &&
  touch .restore-old/.complete .from-the-archive'
if bash restore.sh "$backup"; then fail "restore.sh ran over an interrupted restore"; fi
since=$(now)
bash restore.sh --undo
wait_for_query "$since"
check_data "after --undo"
no_leftovers "after --undo"
[ -z "$(in_volume 'ls -A /var/ts3server | grep -x .from-the-archive || true')" ] \
  || fail "--undo kept a file the interrupted restore had moved in"

echo "--- Wipe the server and its volume"
docker compose down -v
docker volume inspect teamspeak-server-test_ts3-data >/dev/null 2>&1 && fail "the volume was not removed"

echo "--- Restore"
since=$(now)
bash restore.sh "$backup"
wait_for_query "$since"

echo "--- Check the data came back"
check_data "after the restore"
no_leftovers "after the restore"

echo "PASS: channel, uploaded folder and identity ($before) survived backup and restore"
