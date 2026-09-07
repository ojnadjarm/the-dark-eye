#!/usr/bin/env bash
# e2e-voice.sh — speak to the Eye without a human. Needs the running service and a
# listening brain (`eye health` → brainListening true); not part of `npm test`.
# It synthesises the sentence, feeds it through a PipeWire pipe source as if it were
# the mic, closes the mic, then prints what the body heard and the seconds until the
# brain's first audio chunk. The owner's default source is restored in the trap.
set -euo pipefail

TEXT=${1:?usage: e2e-voice.sh "<sentence>"}
SID=${EYE_TEST_SID:-17}
FIFO=/tmp/eyetest.fifo
BODY=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WAIT_S=${EYE_TEST_WAIT:-60}

command -v ffmpeg >/dev/null || { echo "e2e: ffmpeg is required" >&2; exit 1; }

PREV_SOURCE=$(pactl get-default-source)   # his real mic, whatever it is today
MODULE=""
cleanup() {
  eye mic off >/dev/null 2>&1 || true
  [ -n "$PREV_SOURCE" ] && pactl set-default-source "$PREV_SOURCE" >/dev/null 2>&1
  [ -n "$MODULE" ] && pactl unload-module "$MODULE" >/dev/null 2>&1
  rm -f "$FIFO"
  return 0
}
trap cleanup EXIT

rm -f "$FIFO"
MODULE=$(pactl load-module module-pipe-source source_name=eyetest \
  file="$FIFO" format=float32le rate=16000 channels=1)
pactl set-default-source eyetest >/dev/null

WAV=$(node "$BODY/scripts/tts-test.js" "$SID" "$TEXT" | sed -n 's/^wrote: //p')
[ -r "$WAV" ] || { echo "e2e: tts-test.js produced no wav" >&2; exit 1; }

CURSOR=$(journalctl --user -u dark-eye -n 0 --show-cursor -o cat | sed -n 's/^-- cursor: //p')

eye mic on >/dev/null
sleep 1                                   # getUserMedia and the capture graph
ffmpeg -v error -i "$WAV" -f f32le -ac 1 -ar 16000 - > "$FIFO"
sleep 1.5                                 # let the pipe buffer drain into the capture
eye mic off >/dev/null
T_CLOSE=$(date +%s.%N)

# the body's own log is the clock: what it heard, then the brain's first audio chunk
mapfile -t R < <(
python3 - "$CURSOR" "$WAIT_S" <<'PYEOF'
import json, subprocess, sys, time
cursor, wait_s = sys.argv[1], float(sys.argv[2])
heard_line = ""
heard_at = chunk_at = 0.0
deadline = time.time() + wait_s
while time.time() < deadline:
    out = subprocess.run(
        ["journalctl", "--user", "-u", "dark-eye", "--after-cursor", cursor,
         "-o", "json", "--no-pager"], capture_output=True, text=True).stdout
    for raw in out.splitlines():
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        msg, ts = e.get("MESSAGE", ""), int(e["__REALTIME_TIMESTAMP"]) / 1e6
        if not heard_at and "] heard (" in msg:
            heard_line, heard_at = msg.split("] ", 1)[1], ts
        elif heard_at and not chunk_at and "audio chunk seq=0" in msg:
            chunk_at = ts
    if heard_at and chunk_at:
        break
    time.sleep(0.5)
print("%.3f" % heard_at)
print("%.3f" % chunk_at)
print(heard_line or "(nothing heard)")
PYEOF
)
HEARD_AT=${R[0]} CHUNK_AT=${R[1]} HEARD_LINE=${R[2]}

fmt() { python3 -c 'import sys
a, b = float(sys.argv[1]), float(sys.argv[2])
print("n/a" if a == 0 else "%.2f" % (a - b))' "$1" "$2"; }

echo "heard: $HEARD_LINE"
echo "stt_s: $(fmt "$HEARD_AT" "$T_CLOSE")   (mic close -> transcript; text is redacted unless DARK_EYE_DEBUG=1)"
echo "reply_s: $(fmt "$CHUNK_AT" "$T_CLOSE")   (mic close -> brain's first audio chunk)"
[ "$CHUNK_AT" != "0.000" ]
