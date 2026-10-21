#!/usr/bin/env bash
# Proves deploy/backup.sh and deploy/restore.sh round-trip a real server: start TeamSpeak,
# give it a channel and an uploaded folder, back up, wipe the volume, restore, and check the
# channel, the folder and the server's identity are back. CI runs it on every pull request.
#
# Usage: bash tests/backup-round-trip.sh
# Needs Docker, and ports 9987/udp, 30033 and 10011 free on this machine.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)

# The app folder, laid out as on the VPS. Its name is the Compose project name, so the test's
# volume is teamspeak-server-test_ts3-data and never the real server's.
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

# Waits up to three minutes for the server to finish starting. ServerQuery opens before the
# server loads its allowlist, and commands sent in that gap count towards flood protection and
# get this machine banned, so wait for the allowlist line in the log, not for the port.
wait_for_query() {
  for _ in $(seq 90); do
    if [[ $(docker compose logs teamspeak 2>&1) == *"updated query_ip_allowlist"* ]]; then return 0; fi
    sleep 2
  done
  fail "the server never finished starting"
}

# Prints the server's identity: the unique identifier clients see, derived from its key pair.
identity() {
  query serverinfo | tr ' ' '\n' | sed -n 's/^virtualserver_unique_identifier=//p'
}

echo "--- Start a fresh server"
docker compose up -d
wait_for_query

echo "--- Give it data: a channel, and a folder uploaded to that channel"
reply=$(query "channelcreate channel_name=Round\strip channel_flag_permanent=1")
cid=$(sed -n 's/^cid=\([0-9]*\).*/\1/p' <<<"$reply")
[ -n "$cid" ] || fail "could not create the channel: $reply"
query "ftcreatedir cid=$cid cpw= dirname=\/round-trip-folder" >/dev/null
# Lists the channel's uploaded files and folders.
uploads() { query "ftgetfilelist cid=$cid cpw= path=\/"; }
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

echo "--- A file with no database is refused, and the server keeps running"
bad=$work/bad.tar.gz
tar czf "$bad" -C "$work" out
if bash restore.sh "$bad"; then fail "restore.sh accepted a file with no database"; fi
[ -n "$(docker compose ps -q --status running teamspeak)" ] || fail "a refused restore stopped the server"

echo "--- Wipe the server and its volume"
docker compose down -v
docker volume inspect teamspeak-server-test_ts3-data >/dev/null 2>&1 && fail "the volume was not removed"

echo "--- Restore"
bash restore.sh "$backup"
wait_for_query

echo "--- Check the data came back"
[[ $(query channellist) == *'channel_name=Round\strip'* ]] || fail "the channel is missing"
[[ $(uploads) == *name=round-trip-folder* ]] || fail "the uploaded folder is missing"
after=$(identity)
[ "$after" = "$before" ] || fail "the server's identity changed: $before became $after"

echo "PASS: channel, uploaded folder and identity ($after) survived backup and restore"
