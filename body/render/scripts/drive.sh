#!/usr/bin/env bash
# drive.sh — write the six message kinds to the render socket so the native
# eye can be shot beside the Electron one. Nothing here makes a sound: the
# caption comes from the renderer-side `speak` message, never from TTS.
#
#   drive.sh --serve caption      # be the socket: for a hand-run eye-render
#   drive.sh caption              # write to a running body's socket
#
# Scenes: caption, orbiters, listen, heard, busy, idle.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
serve=()
[[ ${1:-} == --serve ]] && { serve=(--serve); shift; }
scene=${1:-busy}
hold=${2:-40}

emit() {
  case "$scene" in
    caption)
      echo '{"type":"session","active":"claude","color":"#b04dff"}'
      sleep 1
      echo '{"type":"speak","text":"the eye keeps watch over the room and reports what it hears in a long steady sentence that has to wrap across several lines before it ends"}'
      echo '{"type":"speaking","ms":6000}'
      ;;
    orbiters)
      echo '{"type":"session","active":"claude","color":"#b04dff"}'
      sleep 1
      echo '{"type":"status","id":"a","state":"working","label":"reading"}'
      sleep 3
      echo '{"type":"status","id":"b","state":"working","label":"building"}'
      sleep 2
      echo '{"type":"status","id":"a","state":"done","label":"done"}'
      ;;
    listen)
      echo '{"type":"session","active":"claude","color":"#b04dff"}'
      sleep 1
      echo '{"type":"ptt","on":true}'
      ;;
    heard)
      echo '{"type":"session","active":"claude","color":"#b04dff"}'
      sleep 1
      echo '{"type":"ptt","on":true}'
      sleep 2
      echo '{"type":"ptt","on":false}'
      echo '{"type":"heard","text":"que estas haciendo"}'
      ;;
    busy)
      echo '{"type":"session","active":"claude","color":"#b04dff"}'
      echo '{"type":"ptt","on":true}'
      echo '{"type":"heard","text":"what is the eye doing right now"}'
      echo '{"type":"status","id":"a","state":"working","label":"one"}'
      echo '{"type":"status","id":"b","state":"working","label":"two"}'
      echo '{"type":"speaking","ms":60000}'
      echo '{"type":"speak","text":"the eye keeps watch over the room and reports what it hears in a long steady sentence that has to wrap across several lines before it ends, so that the caption, the orbiters, the rings and the heard line are all alive in the same frame"}'
      ;;
    idle)
      echo '{"type":"session","active":"claude","color":"#b04dff"}'
      ;;
    *)
      echo "unknown scene: $scene" >&2
      exit 2
      ;;
  esac
  sleep "$hold"
}

emit | python3 "$here/render-pipe.py" "${serve[@]}"
