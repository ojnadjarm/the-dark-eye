#!/usr/bin/env bash
# body-sandbox-guards.test.sh — the M02b guards on a stub node under a private
# XDG_RUNTIME_DIR: `down` needs a name, a colliding `up` poisons the eval'd env,
# the default name is unique. No body, no unit, no real pactl (the audio-default
# block stubs it; every other `up` passes `--audio none`, which loads nothing).
set -uo pipefail
SB=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/body/scripts/body-sandbox
TMP=$(mktemp -d); trap 'rm -rf "$TMP" /dev/shm/body-sandbox-fixture-$$' EXIT
export XDG_RUNTIME_DIR=$TMP/run XDG_CONFIG_HOME=$TMP/cfg
mkdir -p "$TMP/bin" "$XDG_RUNTIME_DIR"
printf '#!/bin/sh\necho "bridge on stub"\nexec sleep 60\n' > "$TMP/bin/node"; chmod +x "$TMP/bin/node"
export PATH=$TMP/bin:$PATH
# the offscreen offset is derived from RandR now, so the suite derives the same bound
# rather than pinning a constant: a window at the offset must miss every output.
xbound() { python3 -c '
import re, subprocess, sys
EYE_W, MARGIN = 340, 16
mons = []
for ln in subprocess.run(["xrandr", "--query"], capture_output=True, text=True).stdout.splitlines():
    if " connected" in ln:
        m = re.search(r"(\d+)x(\d+)\+(-?\d+)\+(-?\d+)", ln)
        if m:
            w, h, x, y = (int(v) for v in m.groups())
            if w and h:
                mons.append((x, w))
if not mons:
    sys.exit("no RandR output has a mode")
minx = min([x for x, _ in mons] + [0])
print(min(minx - (x + w) + MARGIN for x, w in mons))
'; }
bound_check() { local b; b=$(xbound) || return 1; [ "${1:-1}" -le "$b" ]; }

fails=0
ok()  { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fails=$((fails + 1)); }

echo "body-sandbox-guards.test.sh"

OUT=$("$SB" down 2>"$TMP/err"); RC=$?
[ "$RC" != 0 ] && grep -q -- '--name N or --all' "$TMP/err" && ok "down without a name refuses (rc $RC)" || bad "down without a name: rc $RC, '$(cat "$TMP/err")'"

A=$("$SB" up --eye off --audio none) || bad "first up failed"
B=$("$SB" up --eye off --audio none) || bad "second up failed"
NA=$(basename "$(dirname "$(dirname "$(dirname "$(sed -n 's/.*DARK_EYE_CONFIG=\([^ ]*\).*/\1/p' <<<"$A")")")")")
NB=$(basename "$(dirname "$(dirname "$(dirname "$(sed -n 's/.*DARK_EYE_CONFIG=\([^ ]*\).*/\1/p' <<<"$B")")")")")
case "$NA" in sb-[0-9]*) ok "default name $NA" ;; *) bad "default name '$NA' is not sb-<pid>" ;; esac
[ "$NA" != "$NB" ] && ok "two unnamed ups do not share a name ($NB)" || bad "both ups named $NA"

OUT=$("$SB" up --name "$NA" --eye off --audio none 2>"$TMP/err"); RC=$?
[ "$RC" != 0 ] && ok "up on an up name fails (rc $RC)" || bad "up on an up name returned $RC"
[ "$OUT" = "export DARK_EYE_CONFIG=/nonexistent; false" ] && ok "stdout poisons the env" || bad "stdout was '$OUT'"
( eval "$OUT" 2>/dev/null; [ "${DARK_EYE_CONFIG:-}" = /nonexistent ] ) && ok "eval'd config points nowhere" || bad "eval left DARK_EYE_CONFIG usable"

OUT=$("$SB" env 2>/dev/null); RC=$?
[ "$RC" != 0 ] && ok "env without --name refuses while two are up" || bad "env picked one of two: $OUT"

"$SB" down --name "$NA" >/dev/null 2>&1 && ok "down --name $NA" || bad "down --name $NA failed"
[ "$("$SB" env 2>/dev/null)" = "$B" ] && ok "env without --name finds the single survivor" || bad "env did not find $NB"
"$SB" down --all >/dev/null 2>&1 && ok "down --all" || bad "down --all failed"
[ -e "$XDG_RUNTIME_DIR/dark-eye/sandbox" ] && bad "sandbox root survived" || ok "no residue"

# --- restart keeps the state dir, up wipes it -------------------------------
OUT=$("$SB" restart 2>"$TMP/err"); RC=$?
[ "$RC" != 0 ] && grep -q -- '--name N' "$TMP/err" && ok "restart without a name refuses (rc $RC)" || bad "restart without a name: rc $RC, '$(cat "$TMP/err")'"
[ "$OUT" = "export DARK_EYE_CONFIG=/nonexistent; false" ] && ok "a failed restart poisons the env" || bad "failed restart said '$OUT'"
"$SB" restart --name never-up >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q "no sandbox 'never-up' is up" "$TMP/err" && ok "restart of a sandbox that is not up refuses" || bad "restart of a dead name: rc $RC"

R=$("$SB" up --name r1 --eye off --audio none) || bad "up --name r1 failed"
D=$XDG_RUNTIME_DIR/dark-eye/sandbox/r1
PID1=$(sed -n 's/.*BODY_PID=//p' <<<"$R")
CFG1=$(sha256sum "$D/xdg/dark-eye/config.json" | cut -d' ' -f1)
echo kept > "$D/state/marker"
R2=$("$SB" restart --name r1) || bad "restart --name r1 failed"
PID2=$(sed -n 's/.*BODY_PID=//p' <<<"$R2")
[ -n "$PID2" ] && [ "$PID2" != "$PID1" ] && ok "restart started a new body ($PID1 → $PID2)" || bad "restart pid '$PID2' (was $PID1)"
kill -0 "$PID1" 2>/dev/null && bad "the old body $PID1 is still up — two bodies" || ok "the old body is gone"
[ "$(cat "$D/state/marker" 2>/dev/null)" = kept ] && ok "restart kept the state dir" || bad "restart lost state/marker"
[ "$(sha256sum "$D/xdg/dark-eye/config.json" | cut -d' ' -f1)" = "$CFG1" ] && ok "same config, same port and secret" || bad "restart rewrote the config"
kill -9 "$PID2" 2>/dev/null; sleep 0.2      # `up` on the same name now starts from scratch
"$SB" up --name r1 --eye off --audio none >/dev/null || bad "up on a dead sandbox failed"
[ -e "$D/state/marker" ] && bad "up kept the state dir — the gap restart closes is gone" || ok "up wipes the state dir (that is why restart exists)"
"$SB" down --all >/dev/null 2>&1
[ -e "$XDG_RUNTIME_DIR/dark-eye/sandbox" ] && bad "sandbox root survived the restart block" || ok "no residue after the restart block"

# --- what restart launches is what it validates -----------------------------
edit_env() { # rewrite one entry of a sandbox's saved env by hand, as a reviewer would
  python3 - "$1" "$2" "$3" <<'EDIT'
import sys
p, k, v = sys.argv[1:4]
e = open(p, "rb").read().split(b"\0")
e = [k.encode() + b"=" + v.encode() if x.startswith(k.encode() + b"=") else x for x in e]
open(p, "wb").write(b"\0".join(e))
EDIT
}
G=$("$SB" up --name g1 --eye off --audio none) || bad "up --name g1 failed"
GP=$(sed -n 's/.*BODY_PID=//p' <<<"$G")
edit_env "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/body.env" DARK_EYE_RENDER_SOCK "$XDG_RUNTIME_DIR/dark-eye/render.sock"
OUT=$("$SB" restart --name g1 2>"$TMP/err"); RC=$?
[ "$RC" = 2 ] && grep -q 'is the live render.sock' "$TMP/err" && ok "restart refuses a body.env on the live render.sock (rc 2)" || bad "restart on a live-socket body.env: rc $RC, '$(cat "$TMP/err")'"
[ "$OUT" = "export DARK_EYE_CONFIG=/nonexistent; false" ] && ok "that refusal poisons the env" || bad "refusal said '$OUT'"
kill -0 "$GP" 2>/dev/null && ok "the running body is left up (validated before the kill)" || bad "a refused restart stopped the body $GP"

edit_env "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/body.env" DARK_EYE_RENDER_SOCK "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/render.sock"
FAKE_STATE=$TMP/fakehome/.local/state              # never the owner's real ~/.local/state
edit_env "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/body.env" XDG_STATE_HOME "$FAKE_STATE"
"$SB" restart --name g1 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q "XDG_STATE_HOME=$FAKE_STATE is outside" "$TMP/err" && ok "restart refuses a path outside the sandbox dir" || bad "restart on an outside path: rc $RC, '$(cat "$TMP/err")'"
kill -0 "$GP" 2>/dev/null && ok "and still leaves the body up" || bad "the outside-path refusal stopped the body"

# a path whose components do not exist yet is canonicalised, not trusted raw
edit_env "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/body.env" XDG_STATE_HOME \
  "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/missing/../../../../../../../../../..$TMP/escape"
"$SB" restart --name g1 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q 'XDG_STATE_HOME=.* is outside' "$TMP/err" && ok "restart refuses a traversal through a missing component" || bad "traversal accepted: rc $RC, '$(cat "$TMP/err")'"
[ -e "$TMP/escape" ] && bad "the body materialised $TMP/escape outside the sandbox" || ok "nothing was created outside the sandbox"
kill -0 "$GP" 2>/dev/null && ok "and the body is still up after the traversal refusal" || bad "the traversal refusal stopped the body"

# the DARK_EYE_SANDBOX guard: the env must name the dir it sits in
edit_env "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/body.env" XDG_STATE_HOME "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/state"
edit_env "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/body.env" DARK_EYE_SANDBOX other
"$SB" restart --name g1 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q "DARK_EYE_SANDBOX='other', not 'g1'" "$TMP/err" && ok "restart refuses a body.env naming another sandbox" || bad "sandbox-name mismatch accepted: rc $RC, '$(cat "$TMP/err")'"
edit_env "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/body.env" DARK_EYE_SANDBOX g1

# only the keys `up` writes are launched: anything else is refused, not isolated
for pair in "DARK_EYE_SINK owners_real_sink" "DARK_EYE_RENDER_ARGS --x-offset -100" \
            "DARK_EYE_RENDER_BIN /bin/sh" "DARK_EYE_SAY /bin/true" "DARK_EYE_VOICE_MODEL_DIR /tmp"; do
  read -r EK EV <<<"$pair"
  cp "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/body.env" "$TMP/g1.env"
  printf '%s=%s\0' "$EK" "$EV" >> "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/body.env"
  "$SB" restart --name g1 >/dev/null 2>"$TMP/err"; RC=$?
  [ "$RC" != 0 ] && ok "restart refuses $EK=$EV" || bad "restart launched $EK=$EV (rc $RC)"
  cp "$TMP/g1.env" "$XDG_RUNTIME_DIR/dark-eye/sandbox/g1/body.env"
done
kill -0 "$GP" 2>/dev/null && ok "every allowlist refusal left the body up" || bad "an allowlist refusal stopped the body"
"$SB" down --name g1 >/dev/null 2>&1

# --- a pid is killed only while its own environ says it is this sandbox -----
bash -c 'sleep 300 & echo $! > "$1/foreign.child"; wait' _ "$TMP" & FOREIGN=$!
disown "$FOREIGN" 2>/dev/null || true               # with a child of its own: `kids` too
for _ in $(seq 50); do [ -s "$TMP/foreign.child" ] && break; sleep 0.1; done
FKID=$(cat "$TMP/foreign.child" 2>/dev/null)
K=$("$SB" up --name k1 --eye off --audio none) || bad "up --name k1 failed"
KP=$(sed -n 's/.*BODY_PID=//p' <<<"$K")
kill -9 "$KP" 2>/dev/null; sleep 0.2                  # the body is gone, its pid is recycled
echo "$FOREIGN" > "$XDG_RUNTIME_DIR/dark-eye/sandbox/k1/body.pid"
"$SB" down --name k1 >/dev/null 2>&1; RC=$?
[ "$RC" = 0 ] && ok "down on a recycled pid exits 0 (already gone)" || bad "down on a recycled pid exited $RC"
kill -0 "$FOREIGN" 2>/dev/null && ok "down left the unrelated pid $FOREIGN alone" || bad "down killed an unrelated process"
kill -0 "$FKID" 2>/dev/null && ok "down left its child $FKID alone" || bad "down killed an unrelated process's child"
K2=$("$SB" up --name k2 --eye off --audio none) || bad "up --name k2 failed"
KP2=$(sed -n 's/.*BODY_PID=//p' <<<"$K2")
kill -9 "$KP2" 2>/dev/null; sleep 0.2
echo "$FOREIGN" > "$XDG_RUNTIME_DIR/dark-eye/sandbox/k2/body.pid"
"$SB" restart --name k2 >/dev/null 2>&1
kill -0 "$FOREIGN" 2>/dev/null && ok "restart left the unrelated pid alone too" || bad "restart killed an unrelated process"
kill -0 "$FKID" 2>/dev/null && ok "restart left its child alone too" || bad "restart killed an unrelated process's child"
kill -9 "$FKID" "$FOREIGN" 2>/dev/null
"$SB" down --all >/dev/null 2>&1

# --- an ambient DARK_EYE_* never reaches the sandbox body -------------------
export DARK_EYE_SINK=owners_real_sink DARK_EYE_ORBIT_FILE=$XDG_RUNTIME_DIR/dark-eye/orbiters.json
E=$("$SB" up --name e1 --eye off --audio none) || bad "up --name e1 failed"
EP=$(sed -n 's/.*BODY_PID=//p' <<<"$E")
ENVOF=$(tr '\0' '\n' < "/proc/$EP/environ")
grep -q '^DARK_EYE_SINK=' <<<"$ENVOF" && bad "the ambient DARK_EYE_SINK reached the sandbox body" || ok "no ambient DARK_EYE_SINK in the body"
[ "$(sed -n 's/^DARK_EYE_ORBIT_FILE=//p' <<<"$ENVOF")" = "$XDG_RUNTIME_DIR/dark-eye/sandbox/e1/orbiters.json" ] && ok "DARK_EYE_ORBIT_FILE is the sandbox's, not the ambient one" || bad "DARK_EYE_ORBIT_FILE came from the environment"
unset DARK_EYE_SINK DARK_EYE_ORBIT_FILE
"$SB" down --all >/dev/null 2>&1

# --- the sandbox never reaches the owner's TV override ----------------------
T=$("$SB" up --name tv1 --eye off --audio none) || bad "up --name tv1 failed"
TP=$(sed -n 's/.*BODY_PID=//p' <<<"$T")
TVF=$(tr '\0' '\n' < "/proc/$TP/environ" | sed -n 's/^DARK_EYE_TV_OVERRIDE_FILE=//p')
[ "$TVF" = "$XDG_RUNTIME_DIR/dark-eye/sandbox/tv1/tv-override.json" ] && ok "DARK_EYE_TV_OVERRIDE_FILE is inside the sandbox" || bad "tv override is '$TVF', not the sandbox's"
python3 - "$XDG_RUNTIME_DIR/dark-eye/sandbox/tv1/body.env" <<'DEL'
import sys
p = sys.argv[1]
e = [x for x in open(p, "rb").read().split(b"\0") if x and not x.startswith(b"DARK_EYE_TV_OVERRIDE_FILE=")]
open(p, "wb").write(b"\0".join(e) + b"\0")
DEL
T2=$("$SB" restart --name tv1) || bad "restart --name tv1 failed"
TP2=$(sed -n 's/.*BODY_PID=//p' <<<"$T2")
TVF2=$(tr '\0' '\n' < "/proc/$TP2/environ" | sed -n 's/^DARK_EYE_TV_OVERRIDE_FILE=//p')
[ "$TVF2" = "$XDG_RUNTIME_DIR/dark-eye/sandbox/tv1/tv-override.json" ] && ok "a body.env without the key gets it back on restart" || bad "restarted body's tv override is '$TVF2'"
"$SB" down --all >/dev/null 2>&1
[ -e "$XDG_RUNTIME_DIR/dark-eye/sandbox" ] && bad "sandbox root survived the guard block" || ok "no residue after the guard block"

# --- the set, not just the members -----------------------------------------
# Bounding the keys that are there leaves the keys that are gone: each one falls back
# to the owner's live tree (his config.json, orbiters.json, TV override, state dir),
# and deleting a line is easier than editing one.
keep_env() { # leave only the listed keys in a sandbox's saved env
  local f=$1; shift
  python3 - "$f" "$@" <<'KEEP'
import sys
p, keys = sys.argv[1], [k.encode() for k in sys.argv[2:]]
e = [x for x in open(p, "rb").read().split(b"\0") if x and any(x.startswith(k + b"=") for k in keys)]
open(p, "wb").write(b"\0".join(e) + b"\0")
KEEP
}
del_env() { # drop one key from a sandbox's saved env
  python3 - "$1" "$2" <<'DEL1'
import sys
p, k = sys.argv[1], sys.argv[2].encode()
e = [x for x in open(p, "rb").read().split(b"\0") if x and not x.startswith(k + b"=")]
open(p, "wb").write(b"\0".join(e) + b"\0")
DEL1
}
envof() { tr '\0' '\n' < "/proc/$1/environ" | sed -n "s/^$2=//p"; }
REQ="XDG_CONFIG_HOME XDG_STATE_HOME DARK_EYE_RENDER_SOCK DARK_EYE_ORBIT_FILE DARK_EYE_ACTIVE_FILE
     DARK_EYE_QUIET_FILE DARK_EYE_MODE_FILE DARK_EYE_TV_OVERRIDE_FILE DARK_EYE_SANDBOX"

S=$("$SB" up --name s1 --eye off --audio none) || bad "up --name s1 failed"
SD=$XDG_RUNTIME_DIR/dark-eye/sandbox/s1
# a body.env holding only the socket and the name: with XDG_CONFIG_HOME gone the body
# reads the owner's real config (real port, real secret, real remotePort)
keep_env "$SD/body.env" DARK_EYE_RENDER_SOCK DARK_EYE_SANDBOX DARK_EYE_RENDER_BIN DARK_EYE_RENDER_ARGS
SR=$("$SB" restart --name s1) || bad "restart on a stripped body.env failed"
SP=$(sed -n 's/.*BODY_PID=//p' <<<"$SR")
missing="" outside=""
for k in $REQ; do
  val=$(envof "$SP" "$k")
  if [ -z "$val" ]; then missing="$missing $k"
  elif [ "$k" = DARK_EYE_SANDBOX ]; then [ "$val" = s1 ] || outside="$outside $k"
  else case "$val" in "$SD"/*) ;; *) outside="$outside $k" ;; esac
  fi
done
[ -z "$missing" ] && ok "restart puts every absent key back" || bad "the restarted body has no$missing"
[ -z "$outside" ] && ok "and every backfilled key points inside the sandbox" || bad "backfilled outside the sandbox:$outside"

# with the backfill removed, the required-set check is what refuses that same body.env
NOBF=$TMP/body-sandbox-nobackfill
python3 - "$SB" "$NOBF" <<'STRIP'
import sys
s = open(sys.argv[1]).read()
a = s.index('  if [ -s "$d/body.env" ]; then')
b = s.index('  check_env "$d"', a)
open(sys.argv[2], "w").write(s[:a] + s[b:])
STRIP
chmod +x "$NOBF"
keep_env "$SD/body.env" DARK_EYE_RENDER_SOCK DARK_EYE_SANDBOX DARK_EYE_RENDER_BIN DARK_EYE_RENDER_ARGS
"$NOBF" restart --name s1 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q 'body.env has no XDG_CONFIG_HOME' "$TMP/err" && ok "the required-set check refuses a missing key" || bad "a missing key was accepted: rc $RC, '$(cat "$TMP/err")'"
kill -0 "$SP" 2>/dev/null && ok "and that refusal left the body up" || bad "the required-set refusal stopped the body"
SR=$("$SB" restart --name s1) || bad "restart could not rebuild the stripped env"
SP=$(sed -n 's/.*BODY_PID=//p' <<<"$SR")

# the renderer shape: with neither key main.js spawns the real eye-render on his screen
del_env "$SD/body.env" DARK_EYE_RENDER_BIN            # DARK_EYE_RENDER_ARGS=infinity alone
"$SB" restart --name s1 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q "eye-render would draw on the owner's screen" "$TMP/err" && ok "restart refuses RENDER_ARGS=infinity with no RENDER_BIN" || bad "half a renderer shape accepted: rc $RC, '$(cat "$TMP/err")'"
kill -0 "$SP" 2>/dev/null && ok "and the renderer-shape refusal left the body up" || bad "the renderer-shape refusal stopped the body"
del_env "$SD/body.env" DARK_EYE_RENDER_ARGS           # neither key: no version wrote that
SR=$("$SB" restart --name s1) || bad "restart with no renderer key failed"
SP=$(sed -n 's/.*BODY_PID=//p' <<<"$SR")
[ "$(envof "$SP" DARK_EYE_RENDER_BIN)" = /bin/sleep ] && [ "$(envof "$SP" DARK_EYE_RENDER_ARGS)" = infinity ] &&
  ok "no renderer key at all is backfilled to /bin/sleep infinity" ||
  bad "renderer backfill gave BIN='$(envof "$SP" DARK_EYE_RENDER_BIN)' ARGS='$(envof "$SP" DARK_EYE_RENDER_ARGS)'"

# a sandbox that loaded a null sink must point the body at it, key deleted or not
echo not-a-module > "$SD/sink.module"                 # what `--audio null` leaves (no pactl here)
"$SB" restart --name s1 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q 'has no DARK_EYE_SINK' "$TMP/err" && ok "a sandbox with a null sink refuses a body.env without DARK_EYE_SINK" || bad "a missing DARK_EYE_SINK was accepted: rc $RC, '$(cat "$TMP/err")'"
rm -f "$SD/sink.module"                               # never let `down` unload anything
"$SB" down --name s1 >/dev/null 2>&1

# `--eye offscreen` is the other legal shape: it passes both checks
O=$("$SB" up --name o1 --eye offscreen --audio none) || bad "up --eye offscreen failed the set checks"
OP=$(sed -n 's/.*BODY_PID=//p' <<<"$O")
OARG=$(envof "$OP" DARK_EYE_RENDER_ARGS)
if bound_check "${OARG#--x-offset }"; then ok "offscreen sandbox carries a derived offset ($OARG)"
else bad "offscreen args '$OARG' would map inside an output (bound $(xbound))"; fi
"$SB" restart --name o1 >/dev/null || bad "restart of an offscreen sandbox failed"
# the old hardcoded -1400 was calibrated for the 1366-wide TV: with the TV off it put the
# eye at x=164 on the laptop panel, and check_env must refuse it like any on-screen offset
if bound_check -1400; then ok "-1400 happens to be offscreen on the outputs up now (nothing to refuse)"
else
  edit_env "$XDG_RUNTIME_DIR/dark-eye/sandbox/o1/body.env" DARK_EYE_RENDER_ARGS "--x-offset -1400"
  "$SB" restart --name o1 >/dev/null 2>"$TMP/err"; RC=$?
  [ "$RC" != 0 ] && grep -q 'is not the offscreen offset' "$TMP/err" && ok "restart refuses the old hardcoded -1400 (on-screen here)" || bad "an on-screen offset was accepted: rc $RC, '$(cat "$TMP/err")'"
fi
# `place()` ends `(x as i16, y as i16)`: an offset below -32768 wraps back onto a screen
# (-66000 -> x 1100 on the 1920-wide panel), so off_ok has a floor as well as a bound
edit_env "$XDG_RUNTIME_DIR/dark-eye/sandbox/o1/body.env" DARK_EYE_RENDER_ARGS "--x-offset -66000"
"$SB" restart --name o1 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q 'is not the offscreen offset' "$TMP/err" && ok "restart refuses an offset the renderer truncates back on screen (-66000)" || bad "-66000 was accepted: rc $RC, '$(cat "$TMP/err")'"
"$SB" down --name o1 >/dev/null 2>&1

# the bound is derived inside the script from plain `xrandr`: a cached bound or an xrandr
# handed in through the caller's environment used to move it (OFF_BOUND=0 wrote -340 and a
# fake xrandr -335, both on the panel), so neither name is read any more
printf '#!/bin/sh\necho "eDP-1 connected primary 1366x768+0+0 (normal)"\n' > "$TMP/bin/fake-xrandr"
chmod +x "$TMP/bin/fake-xrandr"
export OFF_BOUND=0 DARK_EYE_XRANDR=$TMP/bin/fake-xrandr
O2=$("$SB" up --name o2 --eye offscreen --audio none) || bad "up --eye offscreen failed with a steered bound"
OARG2=$(envof "$(sed -n 's/.*BODY_PID=//p' <<<"$O2")" DARK_EYE_RENDER_ARGS)
if bound_check "${OARG2#--x-offset }"; then ok "the bound ignores the caller's environment ($OARG2)"
else bad "a steered bound moved the written offset to '$OARG2' (real bound $(xbound))"; fi
edit_env "$XDG_RUNTIME_DIR/dark-eye/sandbox/o2/body.env" DARK_EYE_RENDER_ARGS "--x-offset $(( $(xbound) + 1 ))"
"$SB" restart --name o2 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q 'is not the offscreen offset' "$TMP/err" && ok "and check_env still refuses an on-screen offset with both set" || bad "a steered bound let an on-screen offset through: rc $RC, '$(cat "$TMP/err")'"
unset OFF_BOUND DARK_EYE_XRANDR
rm -f "$TMP/bin/fake-xrandr"
"$SB" down --name o2 >/dev/null 2>&1

# --- the eye verb never creates or removes a path outside the sandbox root ---
# A reviewer pointed DARK_EYE_RENDER_SOCK at a fixture note and `rm -f "$dead"` deleted it;
# a nested value created three directories inside the fixture vault. Fixture only, never his.
FIXV=/dev/shm/body-sandbox-fixture-$$   # outside $TMP: /tmp is a legal --dump target
mkdir -p "$FIXV"; echo "a fixture note" > "$FIXV/note.md"
DARK_EYE_RENDER_SOCK=$FIXV/note.md "$SB" eye --seconds 1 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q "is outside $XDG_RUNTIME_DIR/dark-eye/sandbox" "$TMP/err" && ok "eye refuses a render sock outside the sandbox root" || bad "eye accepted a sock outside the root: rc $RC, '$(cat "$TMP/err")'"
[ -s "$FIXV/note.md" ] && ok "and the fixture note it pointed at is still there" || bad "the eye verb deleted $FIXV/note.md"
DARK_EYE_RENDER_SOCK=$FIXV/a/b/c/x.sock "$SB" eye --seconds 1 >/dev/null 2>&1
[ -d "$FIXV/a" ] && bad "the eye verb created directories inside the fixture vault" || ok "and created no directories there"
"$SB" eye --seconds 1 --dump "$FIXV/note.png" --scene rings >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q -- '--dump .* is outside' "$TMP/err" && ok "eye refuses --dump outside the sandbox root and the temp dir" || bad "--dump outside was accepted: rc $RC, '$(cat "$TMP/err")'"
[ -e "$FIXV/note.png" ] && bad "--dump wrote into the fixture vault" || ok "and wrote nothing there"
rm -rf "$FIXV"

# --- restart writes nothing before the pid is confirmed to be this sandbox's ----
sleep 300 & FP=$!
disown "$FP" 2>/dev/null || true               # its kill is not the suite's output
P=$("$SB" up --name p1 --eye off --audio none) || bad "up --name p1 failed"
PP=$(sed -n 's/.*BODY_PID=//p' <<<"$P")
kill -9 "$PP" 2>/dev/null; sleep 0.2                  # gone, and its pid recycled
PD=$XDG_RUNTIME_DIR/dark-eye/sandbox/p1
echo "$FP" > "$PD/body.pid"
del_env "$PD/body.env" DARK_EYE_MODE_FILE
BEFORE=$(sha256sum "$PD/body.env" | cut -d' ' -f1)
"$SB" restart --name p1 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q "is not the body of sandbox 'p1'" "$TMP/err" && ok "restart refuses a pid that is not this sandbox's body" || bad "restart on a foreign pid: rc $RC, '$(cat "$TMP/err")'"
[ "$(sha256sum "$PD/body.env" | cut -d' ' -f1)" = "$BEFORE" ] && ok "and wrote nothing into body.env first" || bad "restart rewrote body.env for a foreign pid"
kill -0 "$FP" 2>/dev/null && ok "the unrelated pid is still alive" || bad "restart killed the unrelated pid"
kill -9 "$FP" 2>/dev/null
"$SB" down --all >/dev/null 2>&1
[ -e "$XDG_RUNTIME_DIR/dark-eye/sandbox" ] && bad "sandbox root survived the set block" || ok "no residue after the set block"

# --- a required key can be PRESENT and empty, or relative -------------------
# `readlink -m` resolves a relative value against the caller's cwd, and "" is relative:
# with cwd anywhere inside the sandbox dir (`cd <dir>/state` to read state or logs) an
# empty XDG_CONFIG_HOME passed `inside`, and every consumer reads `$KEY || <live path>`,
# so the body then read — and rewrote — the owner's real config.json and TV override.
V=$("$SB" up --name v1 --eye off --audio none) || bad "up --name v1 failed"
VP=$(sed -n 's/.*BODY_PID=//p' <<<"$V")
VD=$XDG_RUNTIME_DIR/dark-eye/sandbox/v1
for EK in XDG_CONFIG_HOME DARK_EYE_TV_OVERRIDE_FILE DARK_EYE_MODE_FILE; do
  edit_env "$VD/body.env" "$EK" ""
  ( cd "$VD/state" && "$SB" restart --name v1 >/dev/null 2>"$TMP/err" ); RC=$?
  [ "$RC" != 0 ] && grep -q "body.env $EK is empty" "$TMP/err" && ok "restart refuses an empty $EK with cwd inside the sandbox" || bad "an empty $EK was accepted from inside the dir: rc $RC, '$(cat "$TMP/err")'"
  edit_env "$VD/body.env" "$EK" xdg
  ( cd "$VD" && "$SB" restart --name v1 >/dev/null 2>"$TMP/err" ); RC=$?
  [ "$RC" != 0 ] && grep -q "body.env $EK=xdg is not an absolute path" "$TMP/err" && ok "restart refuses a relative $EK" || bad "a relative $EK was accepted: rc $RC, '$(cat "$TMP/err")'"
  del_env "$VD/body.env" "$EK"                        # the backfill puts the canon value back
done
kill -0 "$VP" 2>/dev/null && ok "every empty/relative refusal left the body up" || bad "an empty-value refusal stopped the body"
V2=$("$SB" restart --name v1) || bad "restart could not rebuild the emptied env"
VP2=$(sed -n 's/.*BODY_PID=//p' <<<"$V2")
VBAD=""
for EK in XDG_CONFIG_HOME DARK_EYE_TV_OVERRIDE_FILE DARK_EYE_MODE_FILE; do
  case "$(envof "$VP2" "$EK")" in "$VD"/*) ;; *) VBAD="$VBAD $EK" ;; esac
done
[ -z "$VBAD" ] && ok "and the backfilled values are absolute and inside the sandbox" || bad "backfilled wrong:$VBAD"
"$SB" down --name v1 >/dev/null 2>&1

# --- the sandbox dir must BE $ROOT/<name>, not a symlink to somewhere else ---
# `inside` canonicalises the dir too, so a symlinked $ROOT/<name> moves containment
# with it and the whole sandbox lands wherever the link points.
mkdir -p "$TMP/elsewhere" "$XDG_RUNTIME_DIR/dark-eye/sandbox"
ln -s "$TMP/elsewhere" "$XDG_RUNTIME_DIR/dark-eye/sandbox/l1"
OUT=$("$SB" up --name l1 --eye off --audio none 2>"$TMP/err"); RC=$?
[ "$RC" != 0 ] && grep -q 'does not resolve to' "$TMP/err" && ok "up refuses a symlinked sandbox dir" || bad "up on a symlinked dir: rc $RC, '$(cat "$TMP/err")'"
[ "$OUT" = "export DARK_EYE_CONFIG=/nonexistent; false" ] && ok "and that refusal poisons the env" || bad "the symlink refusal said '$OUT'"
if [ -e "$TMP/elsewhere/body.env" ] || [ -e "$TMP/elsewhere/xdg" ]; then bad "up wrote into the symlink's target"; else ok "nothing was written through the symlink"; fi
"$SB" restart --name l1 >/dev/null 2>"$TMP/err"; RC=$?
[ "$RC" != 0 ] && grep -q 'does not resolve to' "$TMP/err" && ok "restart refuses a symlinked sandbox dir too" || bad "restart on a symlinked dir: rc $RC, '$(cat "$TMP/err")'"
rm -f "$XDG_RUNTIME_DIR/dark-eye/sandbox/l1"
rmdir "$XDG_RUNTIME_DIR/dark-eye/sandbox" 2>/dev/null || true

# --- the null sink is the DEFAULT; `none` is the opt-in that speaks aloud ----
# `--audio none` used to be the default, so `up --name t1` followed by `eye speak` put
# sound in the owner's room (2026-09-15). pactl is stubbed: never his real PipeWire.
cat > "$TMP/bin/pactl" <<'PACTL'
#!/bin/sh
case "$1" in load-module) echo sandbox-stub-module ;; esac
PACTL
chmod +x "$TMP/bin/pactl"
A=$("$SB" up --name a1 --eye off) || bad "up with no --audio failed"
AP=$(sed -n 's/.*BODY_PID=//p' <<<"$A")
[ "$(envof "$AP" DARK_EYE_SINK)" = eye_sandbox_a1 ] && ok "up with no --audio points the body at its own null sink" || bad "the default up gave DARK_EYE_SINK='$(envof "$AP" DARK_EYE_SINK)' — a default that speaks in the owner's room"
[ -s "$XDG_RUNTIME_DIR/dark-eye/sandbox/a1/sink.module" ] && ok "and loaded the sink module for it" || bad "the default up loaded no null sink"
"$SB" restart --name a1 >/dev/null 2>"$TMP/err" && ok "a default sandbox passes check_env on restart" || bad "restart of a default sandbox: '$(cat "$TMP/err")'"
"$SB" down --name a1 >/dev/null 2>&1
N=$("$SB" up --name n1 --eye off --audio none) || bad "up --audio none failed"
NP=$(sed -n 's/.*BODY_PID=//p' <<<"$N")
[ -z "$(envof "$NP" DARK_EYE_SINK)" ] && ok "--audio none is still the explicit opt-in (no DARK_EYE_SINK)" || bad "--audio none wrote DARK_EYE_SINK=$(envof "$NP" DARK_EYE_SINK)"
[ -e "$XDG_RUNTIME_DIR/dark-eye/sandbox/n1/sink.module" ] && bad "--audio none loaded a sink module" || ok "--audio none loads no module"
"$SB" down --all >/dev/null 2>&1
rm -f "$TMP/bin/pactl"
[ -e "$XDG_RUNTIME_DIR/dark-eye/sandbox" ] && bad "sandbox root survived the audio block" || ok "no residue after the audio block"

echo
[ "$fails" = 0 ] && { echo "body-sandbox-guards: all green"; exit 0; }
echo "body-sandbox-guards: $fails failure(s)"; exit 1
