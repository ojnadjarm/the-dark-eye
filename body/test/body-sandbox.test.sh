#!/usr/bin/env bash
# body-sandbox.test.sh — the sandbox is really isolated: the live render.sock is
# untouched, the body's four paths point inside the sandbox dir, its eye is off the
# TV, its voice goes to a null sink, and `down` leaves nothing behind.
# Needs the running unit. Not part of `npm test` (it starts a second body).
set -uo pipefail

BODY=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SB=$BODY/scripts/body-sandbox
RUN=${XDG_RUNTIME_DIR:-/tmp}/dark-eye
NAME=test$$
fails=0
skips=0
ok()   { echo "  ok   $*"; }
bad()  { echo "  FAIL $*"; fails=$((fails + 1)); }
skip() { echo "  SKIP $*"; skips=$((skips + 1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: expected '$3', got '$2'"; fi; }

cleanup() { "$SB" down --name "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "body-sandbox.test.sh"

# --- before -----------------------------------------------------------------
LIVE_SOCK_ID=$(stat -c '%i %Y' "$RUN/render.sock")
LIVE_ORB=$(sha256sum "$RUN/orbiters.json" 2>/dev/null | cut -d' ' -f1)
N_RENDER=$(pgrep -c eye-render)
N_NULL=$(pactl list modules short | grep -c null-sink)
CURSOR=$(journalctl --user -u dark-eye -n 0 --show-cursor -o cat | sed -n 's/^-- cursor: //p')

# --- up ---------------------------------------------------------------------
T0=$(date +%s.%N)
EXPORTS=$("$SB" up --name "$NAME" --eye offscreen --stats --audio null) || { bad "up failed"; exit 1; }
eval "$EXPORTS"
T_UP=$(echo "$(date +%s.%N) - $T0" | bc)
ok "up in ${T_UP}s"
D=$RUN/sandbox/$NAME

PORT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$DARK_EYE_CONFIG")
[ "$PORT" = 8642 ] && bad "the sandbox took the live port 8642" || ok "own port $PORT"
python3 -c 'import json,sys;sys.exit(0 if "remotePort" not in json.load(open(sys.argv[1])) else 1)' "$DARK_EYE_CONFIG" \
  && ok "no remotePort — no second tailnet listener" || bad "remotePort survived into the sandbox config"

H=$(DARK_EYE_CONFIG=$DARK_EYE_CONFIG eye health 2>/dev/null)
case "$H" in *'"ok":true'*) ok "eye health on $PORT: $H" ;; *) bad "eye health answered '$H'" ;; esac

# --- the four paths the body could have shared with the unit -----------------
envof() { tr '\0' '\n' < "/proc/$BODY_PID/environ" | sed -n "s/^$1=//p"; }
for v in DARK_EYE_RENDER_SOCK DARK_EYE_ORBIT_FILE XDG_CONFIG_HOME XDG_STATE_HOME; do
  val=$(envof "$v")
  case "$val" in "$D"/*) ok "$v inside the sandbox" ;; *) bad "$v = '$val' is outside $D" ;; esac
done
check "DARK_EYE_SANDBOX" "$(envof DARK_EYE_SANDBOX)" "$NAME"

# --- the live eye and the live orbiters were not touched --------------------
check "live render.sock inode+mtime" "$(stat -c '%i %Y' "$RUN/render.sock")" "$LIVE_SOCK_ID"
NEW_UP=$(journalctl --user -u dark-eye --after-cursor "$CURSOR" -o cat --no-pager | grep -c 'eye up')
check "new 'eye up' in the unit's journal" "$NEW_UP" "0"

# --- the sandbox eye is off the TV ------------------------------------------
# The compositor only lists the render window while the TV output is on; with `eye tv` off
# there is no window to place, so the assertion has nothing to read. Skipped, not dropped.
TV=$(eye tv 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("mode","?"))' 2>/dev/null)
if [ "$TV" != on ]; then
  skip "sandbox eye offscreen (TV is '${TV:-unknown}' — the compositor lists no render window)"
else
X=$(~/agents/bin/pc win list --json 2>/dev/null |
  python3 -c 'import json,sys
kids=set(open(f"/proc/{sys.argv[1]}/task/{sys.argv[1]}/children").read().split())
xs=[w["x"] for w in json.load(sys.stdin) if w["wm_class"]=="eye-render" and str(w["pid"]) in kids]
print(xs[0] if xs else "none")' "$BODY_PID")
if [ "$X" != none ] && [ "$X" -le -300 ] 2>/dev/null; then ok "sandbox eye at x=$X (offscreen)"
else bad "sandbox eye x='$X' — not offscreen (must be <= -300)"; fi
fi

# --- it speaks into its own null sink, never the owner's --------------------
SINK=$(envof DARK_EYE_SINK)
pactl list sinks short | grep -q "$SINK" && ok "null sink $SINK loaded" || bad "no null sink $SINK"
( for _ in $(seq 120); do
    for p in $(pgrep -x pw-cat 2>/dev/null); do tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null; echo; done
    sleep 0.1
  done ) > /tmp/pwcat.$NAME 2>/dev/null &
W=$!
DARK_EYE_CONFIG=$DARK_EYE_CONFIG EYE_CURL_TIMEOUT=60 eye speak "sandbox check" >/dev/null 2>&1
wait $W
if grep -q -- "--target $SINK" "/tmp/pwcat.$NAME"; then ok "the voice went to $SINK"
else bad "no pw-cat --target $SINK — the voice may have reached the owner's sink"; fi
grep -q "target ${SINK}\|--target $SINK" "/tmp/pwcat.$NAME" || true
rm -f "/tmp/pwcat.$NAME"

# --- the live socket is refused ---------------------------------------------
DARK_EYE_RENDER_SOCK=$RUN/render.sock "$SB" eye --seconds 1 >/dev/null 2>&1
check "eye on the live render.sock exits 2" "$?" "2"

# --- down leaves nothing ----------------------------------------------------
KIDS=$(pgrep -P "$BODY_PID" | tr '\n' ' ')
T0=$(date +%s.%N)
"$SB" down --name "$NAME"; RC=$?
T_DOWN=$(echo "$(date +%s.%N) - $T0" | bc)
check "down exit" "$RC" "0"
ok "down in ${T_DOWN}s"
kill -0 "$BODY_PID" 2>/dev/null && bad "body pid $BODY_PID survived" || ok "body pid gone"
for k in $KIDS; do kill -0 "$k" 2>/dev/null && bad "child $k survived"; done
[ -d "$D" ] && bad "sandbox dir $D survived" || ok "sandbox dir gone"
check "eye-render count" "$(pgrep -c eye-render)" "$N_RENDER"
check "null-sink modules" "$(pactl list modules short | grep -c null-sink)" "$N_NULL"
check "live render.sock inode+mtime after down" "$(stat -c '%i %Y' "$RUN/render.sock")" "$LIVE_SOCK_ID"
[ -n "$LIVE_ORB" ] && { python3 -c 'import json,sys
live=json.load(open(sys.argv[1]))
ids={o.get("id") for o in (live if isinstance(live,list) else live.get("orbiters",[]))}
sys.exit(0)' "$RUN/orbiters.json" 2>/dev/null && ok "live orbiters.json still parses"; }

# --- agent-preflight --------------------------------------------------------
T0=$(date +%s.%N)
OUT=$(~/agents/bin/agent-preflight 2>&1); T_PF=$(echo "$(date +%s.%N) - $T0" | bc)
awk -v t="$T_PF" 'BEGIN{exit !(t <= 0.5)}' && ok "agent-preflight in ${T_PF}s" || bad "agent-preflight took ${T_PF}s (> 0.5)"
for h in UNIT BRIDGE TREE HAND-RUN ORBITERS CHANNEL; do
  grep -q "^$h" <<<"$OUT" && ok "preflight has $h" || bad "preflight is missing $h"
done

echo
[ "$fails" = 0 ] && { echo "body-sandbox: all green${skips:+ ($skips skipped)}"; exit 0; }
echo "body-sandbox: $fails failure(s)${skips:+, $skips skipped}"; exit 1
