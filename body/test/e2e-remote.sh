#!/usr/bin/env bash
# e2e-remote.sh — the phone loop with no phone. Needs the running service with
# `remotePort` in config.json; not part of `npm test`. It synthesises a sentence,
# uploads it to /remote/audio as raw Int16 PCM exactly as the page does, checks the
# transcript came back tagged `remote`, sends a reply with `eye speak --to remote`
# and reads it off /remote/poll. Loopback only, and it makes no sound: `pw-cat` is
# counted before and after.
#
# The live `VOICE [remote]:` assertion needs the ear free — `queue.take` hands a
# transcript to the first waiter, so a running `eye listen-loop` takes it first.
# With one already listening that step is skipped (its rendering is covered by
# eye-sh.test.js) and the body's own `remote audio:` line proves the tag instead.
set -euo pipefail

BODY=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONFIG="${DARK_EYE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/dark-eye/config.json}"
SID=${EYE_TEST_SID:-17}
NONCE=$(date +%s)
TEXT="This is the Dark Eye remote self test. No reply is needed."
REPLY_TEXT="Remote self test $NONCE acknowledged."

command -v ffmpeg >/dev/null || { echo "e2e-remote: ffmpeg is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "e2e-remote: jq is required" >&2; exit 1; }
[ -r "$CONFIG" ] || { echo "e2e-remote: config not readable: $CONFIG" >&2; exit 1; }

PORT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("remotePort") or "")' "$CONFIG")
[ -n "$PORT" ] || { echo "e2e-remote: no remotePort in $CONFIG — the remote listener is off" >&2; exit 1; }
BASE="http://127.0.0.1:$PORT"

TMP=$(mktemp -d); JAR="$TMP/jar"; WAV=""
cleanup() { rm -rf "$TMP"; [ -n "$WAV" ] && rm -f "$WAV"; return 0; }
trap cleanup EXIT

fail() { echo "e2e-remote: $*" >&2; exit 1; }
ok() { echo "ok — $*"; }

# the mouth must stay shut for the whole run
[ "$(pgrep -c pw-cat || true)" = 0 ] || fail "pw-cat is already running; this test must be silent"

# 1. login — the key rides a pipe, never argv
python3 -c 'import json,sys;print(json.dumps({"key":json.load(open(sys.argv[1]))["secret"]}))' "$CONFIG" |
  curl -sS -o /dev/null -w '%{http_code}' -c "$JAR" -X POST \
    -H 'Content-Type: application/json' --data-binary @- "$BASE/remote/login" |
  grep -qx 200 || fail "login refused"
grep -q '\bde\b' "$JAR" || fail "no session cookie was set"
ok "login → session cookie"

curl -sS -o /dev/null -w '%{http_code}' "$BASE/remote/poll?since=0" | grep -qx 401 ||
  fail "/remote/poll answered without the cookie"
ok "no cookie → 401"

# 2. a known sentence as the page would upload it: raw Int16 PCM, 16 kHz mono
WAV=$(node "$BODY/scripts/tts-test.js" "$SID" "$TEXT" | sed -n 's/^wrote: //p')
[ -r "$WAV" ] || fail "tts-test.js produced no wav"
ffmpeg -v error -i "$WAV" -f s16le -ac 1 -ar 16000 "$TMP/clip.pcm"
ok "clip: $(stat -c %s "$TMP/clip.pcm") bytes of Int16 PCM @16kHz"

BRAIN=$(eye health | jq -r .brainListening)

EAR=""
if [ "$BRAIN" = false ]; then
  eye listen 20000 > "$TMP/listen.txt" 2>&1 &
  EAR=$!
  sleep 0.5   # let the long-poll register before the transcript lands
fi

CURSOR=$(journalctl --user -u dark-eye -n 0 --show-cursor -o cat | sed -n 's/^-- cursor: //p')

TRANSCRIPT=$(curl -sS -b "$JAR" -H 'Content-Type: application/octet-stream' \
  --data-binary @"$TMP/clip.pcm" "$BASE/remote/audio" | jq -r '.transcript // empty')
[ -n "$TRANSCRIPT" ] || fail "the transcript came back empty"
ok "transcript: $TRANSCRIPT"

# the body's own line is the tag: this clip went in as `remote`, not as the mic
for _ in $(seq 20); do
  journalctl --user -u dark-eye --after-cursor "$CURSOR" -o cat --no-pager |
    grep -q 'remote audio: ' && break
  sleep 0.25
done
journalctl --user -u dark-eye --after-cursor "$CURSOR" -o cat --no-pager |
  grep -q 'remote audio: ' || fail "the body never logged the clip as remote"
ok "the body logged it as remote audio"

if [ -n "$EAR" ]; then
  wait "$EAR" || true
  grep -q '^VOICE \[remote\]: ' "$TMP/listen.txt" ||
    fail "eye listen did not print a VOICE [remote] line: $(cat "$TMP/listen.txt")"
  ok "eye listen → $(cat "$TMP/listen.txt")"
else
  echo "skip — another brain holds the ear; the VOICE [remote] line went to it"
fi

# 3. the reply travels the other way and touches no speaker
SINCE=$(curl -s -b "$JAR" -m 3 "$BASE/remote/poll?since=0" 2>/dev/null | jq -r '.seq // 0' 2>/dev/null || echo 0)
eye speak --to remote "$REPLY_TEXT" >/dev/null
REPLY=$(curl -sS -b "$JAR" -m 60 "$BASE/remote/poll?since=${SINCE:-0}")
echo "$REPLY" | jq -e --arg n "$NONCE" '.text | test($n)' >/dev/null ||
  fail "the reply never reached /remote/poll: $REPLY"
ok "reply on the phone channel: $(echo "$REPLY" | jq -r .text)"

AUDIO=$(echo "$REPLY" | jq -r .audio)
curl -sS -b "$JAR" -o "$TMP/reply.wav" "$BASE$AUDIO"
[ "$(head -c 4 "$TMP/reply.wav")" = RIFF ] || fail "$AUDIO is not a WAV"
[ "$(stat -c %s "$TMP/reply.wav")" -gt 44 ] || fail "$AUDIO carries no samples"
ok "$AUDIO — $(stat -c %s "$TMP/reply.wav") bytes of RIFF"

[ "$(pgrep -c pw-cat || true)" = 0 ] || fail "something played out loud"
ok "no sound: pw-cat count stayed 0"
echo "e2e-remote: the whole loop, no phone, no sound"
