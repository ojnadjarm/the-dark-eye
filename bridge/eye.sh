#!/usr/bin/env bash
# eye.sh — bridge client for The Dark Eye (protocol: RUNBOOK.md).
# Lets any WSL shell or Claude session possess the Eye: register as a named
# brain, long-poll Oscar's voice, speak through the overlay. Gateway IP and
# secret are resolved automatically on every run — nothing to configure.
set -euo pipefail

CONFIG="${DARK_EYE_CONFIG:-/mnt/c/Users/Oscar/AppData/Roaming/dark-eye/config.json}"

die() { echo "eye.sh: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
usage: eye.sh <command> [args]

  sessions                              roster + who has Oscar's voice
  register <name> [brief]               join the roster (hub assigns a color)
  introduce <name> <brief...>           set the one-line brief shown in the tray
  speak <text...>                       the Eye says it out loud (+ caption)
  listen <name> [timeoutMs]             one long-poll; prints "VOICE:/EVENT: ..." if any
  listen-loop <name>                    infinite poll; emits "VOICE: ..." lines
                                        (and "EVENT: ..." body events — channel-open
                                        when Oscar answers your held call,
                                        canvas-approved/rejected verdicts)
  show <name> <title> <file|->          put a visual on Oscar's canvas (html, image,
                                        or text file; '-' reads HTML from stdin).
                                        Never opens by itself — he gets a pending
                                        mark by the eye and opens it when he wants
  status <id> <working|done|error> <label...>   orbiter around the eye
  attention <name> <on|off> [label...]  join/leave the hold queue for his attention
  active <name>                         route Oscar's voice to <name> (silent)
  cloak <on|off>                        hide from / show to screen recorders
EOF
  exit "${1:-0}"
}

[ -r "$CONFIG" ] || die "config not readable: $CONFIG (is Windows mounted?)"

SECRET=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['secret'])" "$CONFIG")
PORT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('port',8642))" "$CONFIG")
# WSL2 -> Windows host = default gateway, NOT resolv.conf (DNS tunneling lies)
GATEWAY=$(awk '$2=="00000000" {print $3; exit}' /proc/net/route \
  | sed 's/../& /g' \
  | awk '{printf "%d.%d.%d.%d", strtonum("0x"$4), strtonum("0x"$3), strtonum("0x"$2), strtonum("0x"$1)}')
BASE="http://$GATEWAY:$PORT"

api() { # api <METHOD> <path> [json-body] — secret rides a pipe, never argv (ps-safe)
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sf -m "${EYE_CURL_TIMEOUT:-15}" -X "$method" \
      -H @<(printf 'x-dark-eye-key: %s\n' "$SECRET") -H "Content-Type: application/json" \
      -d "$body" "$BASE$path" || die "no response from the Eye at $BASE (down? bad key?)"
  else
    curl -sf -m "${EYE_CURL_TIMEOUT:-15}" -X "$method" \
      -H @<(printf 'x-dark-eye-key: %s\n' "$SECRET") "$BASE$path" || die "no response from the Eye at $BASE (down? bad key?)"
  fi
}

checkname() { # session names match the hub's own sanitizer
  [[ "$1" =~ ^[a-z0-9-]{1,16}$ ]] || die "bad session name '$1' — lowercase letters, digits, dashes"
}

jbody() { # jbody key1,key2,... val1 val2 ...  (empty vals dropped; only "on" is boolean)
  python3 -c '
import json, sys
keys = sys.argv[1].split(",")
out = {}
for k, v in zip(keys, sys.argv[2:]):
    if v == "":
        continue
    out[k] = (v == "true") if k == "on" else v
print(json.dumps(out))' "$@"
}

extract_line() { # loop payload → one "VOICE: ..." or "EVENT: ..." line (or nothing)
  python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
t, e = d.get("transcript"), d.get("event")
if t:
    print("VOICE: " + t)
elif e:
    detail = d.get("detail") or ""
    print("EVENT: " + e + (" — " + detail if detail else ""))'
}

api_file() { # api_file <METHOD> <path> <json-file> — big bodies bypass argv limits
  local method=$1 path=$2 file=$3
  curl -sf -m "${EYE_CURL_TIMEOUT:-60}" -X "$method" \
    -H @<(printf 'x-dark-eye-key: %s\n' "$SECRET") -H "Content-Type: application/json" \
    --data-binary @"$file" "$BASE$path" || die "no response from the Eye at $BASE (down? bad key?)"
}

cmd=${1:-help}
shift || true

case "$cmd" in
  sessions)
    api GET /bridge/sessions
    echo ;;
  register)
    name=${1:?usage: eye.sh register <name> [brief]}
    shift || true
    checkname "$name"
    api POST /bridge/register "$(jbody name,brief "$name" "${*:-}")"
    echo ;;
  introduce)
    name=${1:?usage: eye.sh introduce <name> <brief...>}
    shift
    [ $# -gt 0 ] || die "usage: eye.sh introduce <name> <brief...>"
    checkname "$name"
    api POST /bridge/introduce "$(jbody session,brief "$name" "$*")"
    echo ;;
  speak)
    [ $# -gt 0 ] || die "usage: eye.sh speak <text...>"
    EYE_CURL_TIMEOUT=30 api POST /bridge/speak "$(jbody text "$*")"
    echo ;;
  listen)
    name=${1:?usage: eye.sh listen <name> [timeoutMs]}
    t=${2:-50000}
    checkname "$name"
    [[ "$t" =~ ^[0-9]+$ ]] || die "timeoutMs must be a number, got '$t'"
    EYE_CURL_TIMEOUT=$(( t / 1000 + 10 )) api GET "/bridge/listen?timeoutMs=$t&session=$name" \
      | extract_line ;;
  listen-loop)
    name=${1:?usage: eye.sh listen-loop <name>}
    checkname "$name"
    state=up
    while true; do
      r=$(EYE_CURL_TIMEOUT=60 api GET "/bridge/listen?timeoutMs=50000&session=$name" 2>/dev/null || true)
      if [ -n "$r" ]; then
        [ "$state" = down ] && { echo "EYE BACK (bridge reachable again)"; state=up; }
        line=$(printf '%s' "$r" | extract_line)
        [ -n "$line" ] && echo "$line"
      else
        [ "$state" = up ] && { echo "EYE OFFLINE (bridge unreachable)"; state=down; }
        sleep 5
      fi
      sleep 0.2
    done ;;
  show)
    name=${1:?usage: eye.sh show <name> <title> <file|->}
    title=${2:?usage: eye.sh show <name> <title> <file|->}
    src=${3:?usage: eye.sh show <name> <title> <file|-> ('-' = HTML on stdin)}
    checkname "$name"
    [ "$src" = - ] || [ -r "$src" ] || die "cannot read: $src"
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    python3 - "$name" "$title" "$src" > "$tmp" <<'PYEOF' || die "could not package $src"
import base64, json, os, sys
name, title, src = sys.argv[1:4]
MAX = 24_000_000  # raw bytes; base64 stays under the body's 32MB gate
IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}
if src == "-":
    raw = sys.stdin.buffer.read()
    ext = ".html"
else:
    raw = open(src, "rb").read()
    ext = os.path.splitext(src)[1].lower()
if len(raw) > MAX:
    sys.exit(f"{src}: {len(raw)} bytes — too big, cap is {MAX}")
if ext in IMAGE_MIME:
    kind = "image"
    data = f"data:{IMAGE_MIME[ext]};base64," + base64.b64encode(raw).decode()
else:
    try:
        data = raw.decode("utf-8")
    except UnicodeDecodeError:
        sys.exit(f"{src}: binary data — only images ({', '.join(IMAGE_MIME)}) or utf-8 text")
    kind = "html" if ext in (".html", ".htm") else "text"
json.dump({"session": name, "title": title, "kind": kind, "data": data}, sys.stdout)
PYEOF
    api_file POST /bridge/show "$tmp"
    echo ;;
  status)
    id=${1:?usage: eye.sh status <id> <working|done|error> <label...>}
    st=${2:?usage: eye.sh status <id> <working|done|error> <label...>}
    shift 2
    api POST /bridge/status "$(jbody id,state,label "$id" "$st" "$*")"
    echo ;;
  attention)
    name=${1:?usage: eye.sh attention <name> <on|off> [label...]}
    on=${2:?usage: eye.sh attention <name> <on|off> [label...]}
    shift 2
    checkname "$name"
    api POST /bridge/attention "$(jbody session,on,label "$name" "$([ "$on" = on ] && echo true || echo false)" "${*:-}")"
    echo ;;
  active)
    name=${1:?usage: eye.sh active <name>}
    checkname "$name"
    api POST /bridge/active "$(jbody session "$name")"
    echo ;;
  cloak)
    on=${1:?usage: eye.sh cloak <on|off>}
    api POST /bridge/cloak "$(jbody on "$([ "$on" = on ] && echo true || echo false)")"
    echo ;;
  help|-h|--help)
    usage 0 ;;
  *)
    echo "eye.sh: unknown command: $cmd" >&2
    usage 1 ;;
esac
