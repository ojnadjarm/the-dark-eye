#!/usr/bin/env bash
# wake.sh <session-name> <claude-session-id> — the Eye's necromancer arm.
# Spawned by the BODY (Windows → wsl.exe) when Oscar talks to a sleeping
# session and no live session can relay. Resurrects the session's mind as
# ONE headless turn: it drains his parked words, answers out loud, then
# keeps listening a while so the talk is real-time after the cold start.
#
# Approved by Oscar 2026-08-11 (manual permission grant + voice directive:
# "I should be able to just talk to you and you should wake up"). Cost
# honesty: a cold wake replays the session's transcript against his plan
# quota; the body throttles wakes to one per session per 120s.
# Log: ~/.dark-eye-wake.log (WSL side; the body logs the spawn on its side).
set -uo pipefail
name=${1:?usage: wake.sh <session-name> <claude-session-id>}
sid=${2:?usage: wake.sh <session-name> <claude-session-id>}
EYE=/home/onadjar/projects/the-dark-eye/bridge/eye.sh
CLAUDE=/home/onadjar/.local/bin/claude
LOG="$HOME/.dark-eye-wake.log"

{
  echo "[$(date -Is)] necromancer: waking '$name' (mind $sid)"
  "$CLAUDE" -p "NECROMANCER WAKE: Oscar is speaking to you through the Dark Eye on your channel '$name'. Your process is asleep, so the Eye resurrected you headlessly for this one turn. Do, in order: (1) DRAIN his parked words — repeat Bash one-shots of: $EYE listen $name 2000 — until empty. (2) Answer him OUT LOUD via: $EYE speak --as $name '<your words>' — spoken language, no markdown, under 120 words per reply. (3) Keep the conversation alive: loop one-shot listens of $EYE listen $name 30000 and answer each VOICE line aloud; after 3 consecutive empty listens go to (4): run $EYE introduce $name 'resting - wake me by talking to me' and end your turn. Do NOT start Monitors or background tasks — they die when this headless turn ends. Terminal output is not read by anyone; your voice IS the answer." \
    --resume "$sid" \
    --allowedTools "Bash($EYE:*)" \
    --output-format json
  echo "[$(date -Is)] necromancer: '$name' turn ended rc=$?"
} >>"$LOG" 2>&1
