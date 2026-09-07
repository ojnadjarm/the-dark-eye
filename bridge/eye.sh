#!/usr/bin/env bash
# eye.sh — the bridge client for The Dark Eye. Any shell or Claude session speaks
# through the Eye, hears Oscar, opens his mic and shows him things (RUNBOOK.md).
set -euo pipefail

die() { echo "eye: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
usage: eye <command> [args]

  speak <text...> [--voice <sid>] [--to local|remote|both]
                                    say it out loud (+ caption); sid = Kokoro voice;
                                    --to picks the channel, default = where he last spoke
  listen [timeoutMs]                one long-poll; prints "VOICE: ...", "VOICE [remote]: ..."
                                    or "EVENT: ..."
  listen-loop                       poll forever; also "EYE OFFLINE" / "EYE BACK"
  mic [on|off]                      open/close his mic (no argument = toggle)
  status <id> <working|done|error> <label...>   orbiter around the eye
  status                            list the orbiters the body is holding
  show <title> <file|-> [--ask]     put a visual on his canvas (html, image or text;
                                    '-' reads HTML from stdin). It never opens by itself:
                                    he gets a mark and looks when he wants. --ask = you
                                    need his approve/reject verdict
  tv [off|on|auto]                  his own switch over the TV watch: off keeps the eye
                                    dark (0 fps) until on/auto; no argument prints it
  health                            is the body up, is he listening, is the mic open,
                                    and the tv override
EOF
  exit "${1:-0}"
}

cmd=${1:-help}
shift || true
case "$cmd" in help|-h|--help) usage 0 ;; esac

CONFIG="${DARK_EYE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/dark-eye/config.json}"
[ -r "$CONFIG" ] || die "config not readable: $CONFIG (is the body installed?)"
SECRET=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["secret"])' "$CONFIG")
PORT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("port",8642))' "$CONFIG")
BASE="http://127.0.0.1:$PORT"

api() { # api <METHOD> <path> [json|@file] — secret rides a pipe, never argv (ps-safe)
  local method=$1 path=$2 body=${3:-} args=() out code
  case "$body" in "") ;; @*) args=(--data-binary "$body") ;; *) args=(-d "$body") ;; esac
  out=$(curl -s -m "${EYE_CURL_TIMEOUT:-15}" -w '\n%{http_code}' -X "$method" \
    -H @<(printf 'x-dark-eye-key: %s\n' "$SECRET") -H "Content-Type: application/json" \
    "${args[@]}" "$BASE$path") || die "no response from the Eye at $BASE (is the body up?)"
  code=${out##*$'\n'}; out=${out%$'\n'*}
  case "$code" in
    2??) printf '%s' "$out" ;;
    400) die "the Eye rejected it (400): ${out:-bad request}" ;;
    401) die "the Eye refused the key (401) — is $CONFIG the body's own?" ;;
    404|405) die "the Eye has no $method $path ($code)" ;;
    *) die "the Eye answered $code${out:+: $out}" ;;
  esac
}

jbody() { # jbody key1,key2,... val1 val2 ...  (empty values dropped, voice is an int)
  python3 -c '
import json, sys
keys = sys.argv[1].split(",")
out = {}
for k, v in zip(keys, sys.argv[2:]):
    if v == "":
        continue
    out[k] = int(v) if k == "voice" else v
print(json.dumps(out))' "$@"
}

extract_line() { # payload → one "VOICE: ..." or "EVENT: ..." line (or nothing)
  python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
t, e = d.get("transcript"), d.get("event")
if t:
    tag = " [remote]" if d.get("source") == "remote" else ""
    print("VOICE" + tag + ": " + t)
elif e:
    detail = d.get("detail") or ""
    print("EVENT: " + e + (" — " + detail if detail else ""))'
}

case "$cmd" in
  speak)
    sid="" to="" text=()
    while [ $# -gt 0 ]; do
      if [ "$1" = --voice ]; then
        sid=${2:?usage: eye speak <text...> --voice <sid>}
        [[ "$sid" =~ ^[0-9]+$ ]] || die "voice sid must be a number, got '$sid'"
        shift 2
      elif [ "$1" = --to ]; then
        to=${2:?usage: eye speak <text...> --to local|remote|both}
        case "$to" in local|remote|both) ;; *) die "--to must be local, remote or both, got '$to'" ;; esac
        shift 2
      else text+=("$1"); shift; fi
    done
    [ ${#text[@]} -gt 0 ] || die "usage: eye speak <text...> [--voice <sid>] [--to local|remote|both]"
    EYE_CURL_TIMEOUT=30 api POST /bridge/speak "$(jbody text,voice,to "${text[*]}" "$sid" "$to")"
    echo ;;
  listen)
    t=${1:-50000}
    [[ "$t" =~ ^[0-9]+$ ]] || die "timeoutMs must be a number, got '$t'"
    EYE_CURL_TIMEOUT=$(( t / 1000 + 10 )) api GET "/bridge/listen?timeoutMs=$t" | extract_line ;;
  listen-loop)
    # a brain's ear: it must survive anything — resets mid-restart, python hiccups.
    set +e
    trap 'echo "LISTEN-LOOP DIED: rc=$? last=$BASH_COMMAND"' EXIT
    state=up
    while true; do
      r=$(EYE_CURL_TIMEOUT=60 api GET "/bridge/listen?timeoutMs=50000" 2>/dev/null || true)
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
  mic)
    case "${1:-toggle}" in
      toggle) b='{}' ;; on) b='{"on":true}' ;; off) b='{"on":false}' ;; *) die "usage: eye mic [on|off]" ;;
    esac
    api POST /bridge/mic "$b"
    echo ;;
  status)
    if [ $# -eq 0 ]; then api GET /bridge/status; echo; exit 0; fi
    id=${1:?usage: eye status <id> <working|done|error> <label...>}
    st=${2:?usage: eye status <id> <working|done|error> <label...>}
    shift 2
    case "$st" in working|done|error) ;; *) die "state must be working, done or error, got '$st'" ;; esac
    [ $# -gt 0 ] || die "usage: eye status <id> <working|done|error> <label...>"
    api POST /bridge/status "$(jbody id,state,label "$id" "$st" "$*")"
    echo ;;
  show)
    title=${1:?usage: eye show <title> <file|-> [--ask]}
    src=${2:?usage: eye show <title> <file|-> [--ask] ('-' = HTML on stdin)}
    ask=false
    [ "${3:-}" = --ask ] && ask=true
    [ "$src" = - ] || [ -r "$src" ] || die "cannot read: $src"
    # the packager's own stdin is the heredoc, so piped HTML lands in a file first
    stdin_file=""
    if [ "$src" = - ]; then stdin_file=$(mktemp --suffix=.html); cat > "$stdin_file"; src=$stdin_file; fi
    tmp=$(mktemp)
    trap 'rm -f "$tmp" ${stdin_file:+"$stdin_file"}' EXIT
    python3 - "$title" "$src" "$ask" > "$tmp" <<'PYEOF' || die "could not package $src"
import base64, json, os, sys
title, src, ask = sys.argv[1:4]
MAX = 24_000_000  # raw bytes; base64 stays under the body's 32MB gate
IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}
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
json.dump({"title": title, "kind": kind, "data": data, "verdict": ask == "true"}, sys.stdout)
PYEOF
    EYE_CURL_TIMEOUT=60 api POST /bridge/show "@$tmp"
    echo ;;
  tv)
    case "${1:-}" in
      "") api GET /bridge/tv ;;
      off|on|auto) api POST /bridge/tv "$(jbody mode "$1")" ;;
      *) die "usage: eye tv [off|on|auto]" ;;
    esac
    echo ;;
  health)
    api GET /bridge/health
    echo ;;
  *)
    echo "eye: unknown command: $cmd" >&2
    usage 1 ;;
esac
