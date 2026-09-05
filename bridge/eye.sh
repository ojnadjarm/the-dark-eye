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
  register <name> [--voice <sid>] [brief]  join the roster (hub assigns a color and
                                        a Kokoro voice; sid 0-52, 17 = the Eye's)
  introduce <name> <brief...>           set the one-line brief shown in the tray
  speak [--as <name>] <text...>         say it out loud (+ caption); --as = your
                                        session's own voice, else the Eye's
  listen <name> [timeoutMs]             one long-poll; prints "VOICE:/EVENT: ..." if any
  listen-loop <name>                    infinite poll; emits "VOICE: ..." lines
                                        (and "EVENT: ..." body events — channel-open
                                        when Oscar answers your held call,
                                        canvas-approved/rejected verdicts)
  show <name> <title> <file|-> [--ask]  put a visual on Oscar's canvas (html, image,
                                        or text file; '-' reads HTML from stdin).
                                        Never opens by itself — he gets a clickable
                                        mark by the eye and opens it when he wants.
                                        --ask = you need his approve/reject verdict;
                                        without it he just looks and dismisses
  status <id> <working|done|error> <label...>   orbiter around the eye
  attention <name> <on|off> [label...]  join/leave the hold queue for his attention
  active <name>                         route Oscar's voice to <name> (silent)
  cloak <on|off>                        hide from / show to screen recorders
  field shift <form>                    morph the field's shapeshifter
                                        (forms: eye figure hound ghost wave murmur)
  field board <waves|lissajous|bars|off>  summon the tableboard / release it (gold)
  field conjure <cube|torus|off>        conjure a wireframe / release it (gold)
  field dismiss                         everything conjured dissolves — gold
  field summon <name> <geo.json|->      summon ARBITRARY wireframe geometry:
                                        JSON {"v":[[x,y,z]...],"e":[[a,b]...]}
                                        (≤500 verts, ≤340 edges, WORLD coords)
                                        — up to 12 forms live at once
  field unsummon <name>                 release one summon (gold dissolve)
  field say <text...>                   the field page itself speaks (browser
                                        voice) + captions — no Eye needed
  field cap <text...>                   caption only (no browser voice) — for
                                        pairing with the Eye's Kokoro speak
  field tv <file|-> [title...]          the board becomes a TV: images
                                        (svg/png/jpg/webp ≤60KB) or VIDEO
                                        (.webm/.mp4 ≤30MB, uploaded + looped)
  field look <board|avatar|conjured|center> [dist]   glide HIS camera to frame
                                        something (his drag cancels instantly)
  field url                             print the field page address (open it
                                        yourself — the field never opens itself)
  NOTE: the Field is its OWN app (field/server.js on :8643, WSL) — not the
        Eye's body. Start it: cd ~/projects/the-dark-eye/field && node server.js
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

jbody() { # jbody key1,key2,... val1 val2 ...  (empty vals dropped; "on" boolean, "voice" int)
  python3 -c '
import json, sys
keys = sys.argv[1].split(",")
out = {}
for k, v in zip(keys, sys.argv[2:]):
    if v == "":
        continue
    out[k] = (v == "true") if k == "on" else (int(v) if k == "voice" else v)
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
    name=${1:?usage: eye.sh register <name> [--voice <sid>] [brief]}
    shift || true
    vid=""
    if [ "${1:-}" = --voice ]; then
      vid=${2:?usage: eye.sh register <name> --voice <sid> [brief]}
      [[ "$vid" =~ ^[0-9]+$ ]] || die "voice sid must be a number, got '$vid'"
      shift 2
    fi
    checkname "$name"
    # sock = this session's harness messaging address (a live session can WAKE
    # this one via SendMessage); sid = its Claude conversation id (the Eye's
    # necromancer resurrects it headlessly via wake.sh when no relay lives).
    # Both exported by Claude Code to Bash; empty outside Claude = dropped.
    api POST /bridge/register "$(jbody name,voice,brief,sock,sid "$name" "$vid" "${*:-}" "${CLAUDE_CODE_MESSAGING_SOCKET:-}" "${CLAUDE_CODE_SESSION_ID:-}")"
    echo ;;
  introduce)
    name=${1:?usage: eye.sh introduce <name> <brief...>}
    shift
    [ $# -gt 0 ] || die "usage: eye.sh introduce <name> <brief...>"
    checkname "$name"
    # introduce also refreshes the wake addresses — unlike register it has no
    # liveness guard, so a LIVE session can update its sock + mind anytime
    api POST /bridge/introduce "$(jbody session,brief,sock,sid "$name" "$*" "${CLAUDE_CODE_MESSAGING_SOCKET:-}" "${CLAUDE_CODE_SESSION_ID:-}")"
    echo ;;
  speak)
    as=""
    if [ "${1:-}" = --as ]; then
      as=${2:?usage: eye.sh speak --as <name> <text...>}
      checkname "$as"
      shift 2
    fi
    [ $# -gt 0 ] || die "usage: eye.sh speak [--as <name>] <text...>"
    EYE_CURL_TIMEOUT=30 api POST /bridge/speak "$(jbody text,session "$*" "$as")"
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
    # the loop is a session's ear — it must survive anything: connection
    # resets mid-restart, python hiccups, all of it. errexit off from here;
    # if it still dies, say what killed it so the monitor log shows a cause.
    set +e
    trap 'echo "LISTEN-LOOP DIED: rc=$? last=$BASH_COMMAND"' EXIT
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
    name=${1:?usage: eye.sh show <name> <title> <file|-> [--ask]}
    title=${2:?usage: eye.sh show <name> <title> <file|-> [--ask]}
    src=${3:?usage: eye.sh show <name> <title> <file|-> [--ask] ('-' = HTML on stdin)}
    ask=false
    [ "${4:-}" = --ask ] && ask=true
    checkname "$name"
    [ "$src" = - ] || [ -r "$src" ] || die "cannot read: $src"
    tmp=$(mktemp)
    trap 'rm -f "$tmp"' EXIT
    python3 - "$name" "$title" "$src" "$ask" > "$tmp" <<'PYEOF' || die "could not package $src"
import base64, json, os, sys
name, title, src, ask = sys.argv[1:5]
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
json.dump({"session": name, "title": title, "kind": kind, "data": data,
           "verdict": ask == "true"}, sys.stdout)
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
  field)
    # the Field is its OWN application (spec B §4): field/server.js in WSL on
    # :8643 with its own key — NOT the Eye's body. Both Windows browsers and
    # WSL shells reach it at localhost (WSL2 localhost forwarding).
    sub=${1:?usage: eye.sh field <shift|board|conjure|dismiss|url> [arg]}
    shift || true
    FIELD_BASE="http://localhost:${DARK_EYE_FIELD_PORT:-8643}"
    FIELD_KEY_FILE="${DARK_EYE_FIELD_KEY:-$HOME/projects/the-dark-eye/field/.key}"
    [ -r "$FIELD_KEY_FILE" ] || die "field key not readable: $FIELD_KEY_FILE (was the field app set up?)"
    FKEY=$(tr -d '[:space:]' < "$FIELD_KEY_FILE")
    [ -n "$FKEY" ] || die "field key file is empty: $FIELD_KEY_FILE"
    fop() { # fop <json> — POST one op to the field server, loud when it's down
      curl -sf -m "${EYE_CURL_TIMEOUT:-15}" -X POST \
        -H @<(printf 'x-field-key: %s\n' "$FKEY") -H "Content-Type: application/json" \
        -d "$1" "$FIELD_BASE/op" \
        || die "the field is not running — start it: cd ~/projects/the-dark-eye/field && node server.js"
    }
    case "$sub" in
      shift)
        form=${1:?usage: eye.sh field shift <eye|figure|hound|ghost|wave|murmur>}
        case "$form" in eye|figure|hound|ghost|wave|murmur) ;; *) die "unknown form '$form' — forms: eye figure hound ghost wave murmur" ;; esac
        fop "$(jbody op,form shift "$form")"
        echo ;;
      board)
        mode=${1:?usage: eye.sh field board <waves|lissajous|bars|off>}
        case "$mode" in waves|lissajous|bars|off) ;; *) die "unknown board mode '$mode' — modes: waves lissajous bars off" ;; esac
        fop "$(jbody op,mode board "$mode")"
        echo ;;
      conjure)
        shape=${1:?usage: eye.sh field conjure <cube|torus|off>}
        case "$shape" in cube|torus|off) ;; *) die "unknown shape '$shape' — shapes: cube torus off" ;; esac
        fop "$(jbody op,shape conjure "$shape")"
        echo ;;
      dismiss)
        fop '{"op":"dismiss"}'
        echo ;;
      summon)
        name=${1:?usage: eye.sh field summon <name> <geometry.json|->}
        src=${2:?usage: eye.sh field summon <name> <geometry.json or - for stdin>}
        # merge {"op","name"} into the geometry JSON safely (python for quoting)
        fop "$(cat -- "$src" | python3 -c 'import json,sys; g=json.load(sys.stdin); print(json.dumps({"op":"summon","name":sys.argv[1],"v":g["v"],"e":g["e"]}))' "$name")" || exit 1
        echo ;;
      unsummon)
        name=${1:?usage: eye.sh field unsummon <name>}
        fop "$(jbody op,name unsummon "$name")"
        echo ;;
      say)
        [ $# -gt 0 ] || die "usage: eye.sh field say <text...>"
        fop "$(jbody op,text say "$*")"
        echo ;;
      cap)
        # caption only, no browser TTS — pair with `eye.sh speak` (Kokoro),
        # his call 2026-08-23: "I like the voice in the Eye more"
        [ $# -gt 0 ] || die "usage: eye.sh field cap <text...>"
        fop "$(printf '%s' "$*" | python3 -c 'import json,sys;print(json.dumps({"op":"say","text":sys.stdin.read(),"quiet":True}))')"
        echo ;;
      tv)
        src=${1:?usage: eye.sh field tv <image or video file, - for svg stdin> [title...]}
        shift || true
        title="$*"
        case "$src" in
          *.webm|*.mp4)
            # HARD RULE (frozen-board night, 2026-08-23): Oscar's AMD hardware
            # video decoder wedges — any hw-decodable stream freezes on ONE
            # frame with every playback metric healthy. H.264 4:4:4 has no hw
            # decode path anywhere, so browsers software-decode it. Transcode
            # every board reel unless it already is 4:4:4.
            if command -v ffprobe >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then
              vfmt=$(ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of csv=p=0 "$src" 2>/dev/null || true)
              if [ -n "$vfmt" ] && [ "$vfmt" != "yuv444p" ]; then
                t444=$(mktemp --suffix=.mp4)
                if ffmpeg -y -loglevel error -i "$src" -an -c:v libx264 -pix_fmt yuv444p -profile:v high444 -crf 21 -movflags +faststart "$t444" 2>/dev/null; then
                  src=$t444
                else
                  rm -f "$t444"; echo "warn: 4:4:4 transcode failed, uploading as-is (may freeze on his GPU)" >&2
                fi
              fi
            fi
            vmime=video/webm; case "$src" in *.mp4) vmime=video/mp4 ;; esac
            up=$(curl -fsS --max-time 60 -X POST "$FIELD_BASE/media" \
              -H @<(printf 'x-field-key: %s\n' "$FKEY") -H "Content-Type: $vmime" \
              --data-binary @"$src") || die "media upload failed — is the field running?"
            murl=$(printf '%s' "$up" | python3 -c 'import json,sys;d=json.load(sys.stdin);u=d.get("url");print(u) if u else sys.exit(1)') || die "upload rejected: $up"
            [ -n "${t444:-}" ] && rm -f "$t444"
            fop "$(jbody op,media,title tv "$murl" "$title")"
            echo
            ;;
          *)
            mime=image/svg+xml
            case "$src" in *.png) mime=image/png ;; *.jpg|*.jpeg) mime=image/jpeg ;; *.webp) mime=image/webp ;; esac
            if [ "$src" = "-" ]; then b64=$(base64 -w0) || die "cannot read stdin"
            else b64=$(base64 -w0 -- "$src") || die "cannot read $src"; fi
            fop "$(jbody op,image,title tv "data:$mime;base64,$b64" "$title")"
            echo
            ;;
        esac ;;
      look)
        spot=${1:?usage: eye.sh field look <board|avatar|conjured|center> [dist]}
        case "$spot" in board|avatar|conjured|center) ;; *) die "unknown look target '$spot' — targets: board avatar conjured center" ;; esac
        if [ -n "${2:-}" ]; then case "$2" in ''|*[!0-9]*) die "dist must be a number" ;; esac; fop "{\"op\":\"look\",\"at\":\"$spot\",\"dist\":$2}"
        else fop "$(jbody op,at look "$spot")"; fi
        echo ;;
      url)
        # the law: the field never opens by itself — this only PRINTS the
        # address; Oscar (or a human hand) opens the tab
        echo "$FIELD_BASE/?key=$FKEY" ;;
      *)
        die "unknown field command: $sub (shift|board|conjure|dismiss|summon|unsummon|say|cap|tv|look|url)" ;;
    esac ;;
  help|-h|--help)
    usage 0 ;;
  *)
    echo "eye.sh: unknown command: $cmd" >&2
    usage 1 ;;
esac
