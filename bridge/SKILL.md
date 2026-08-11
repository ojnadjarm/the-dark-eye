---
name: eye
description: Connect this Claude session to The Dark Eye — Oscar's voice overlay on the Windows desktop — as a named brain that can hear his voice and speak out loud. Use when Oscar says "open the eye", "connect to the eye", "join the eye", or wants this session reachable by voice.
allowed-tools: Bash(/home/onadjar/projects/the-dark-eye/bridge/eye.sh:*), Monitor
---

# Connect this session to The Dark Eye

The Dark Eye is Oscar's voice interface: an eye overlay on the Windows desktop
with push-to-talk (Ctrl+Alt+Space) and a local voice. Sessions register as
named brains; a hub routes Oscar's voice to ONE active session at a time, and
he switches by saying "switch to ⟨name⟩" or via the tray.

Everything goes through the bridge client — it resolves the gateway IP and
secret by itself, no setup needed:

    /home/onadjar/projects/the-dark-eye/bridge/eye.sh

**Always invoke it by that absolute path** — it is not on PATH, and the
pre-approved permission matches the full path only (`eye.sh ...` below is
shorthand for readability, never what you type).

Follow ALL steps in order. **Step 4 (the Monitor) is the one that makes voice
work — a session that skips it is deaf.**

## 1. Check the Eye is up

    /home/onadjar/projects/the-dark-eye/bridge/eye.sh sessions

Returns the roster (`{"active": ..., "sessions": [...]}`). If unreachable, the
body app isn't running on Windows — start it from WSL with:

    powershell.exe -NoProfile -Command 'Stop-Process -Name electron -Force -ErrorAction SilentlyContinue; Start-Sleep 1; Set-Location C:\Users\Oscar\projects\the-dark-eye\body; Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "." -WindowStyle Hidden'

then retry the `sessions` command (give it a few seconds; poll up to ~30s).
The powershell command is not pre-approved — expect one permission prompt.
Note: every body restart re-enables the cloak (hidden from screen recorders).

## 2. Pick a session name

One short lowercase word (letters/digits/dashes), usually this project's name
(e.g. `cryptodesk`). Check it against the roster: if the name is already
there but `connected` is false, it's a previous instance of this same
project — reuse it and skip step 3. If it belongs to a different live
session, pick a variant.

## 3. Register

    /home/onadjar/projects/the-dark-eye/bridge/eye.sh register <name> "<one-line brief of what this session is>"

The hub assigns you a unique color (green is refused — green is the Eye's
alone) and returns `{name, color, note?, active, sessions}`. A silent
"⟨name⟩ joined" caption decodes on the Eye. If the response is
`{"error": ...}` the name is live or invalid — pick another and retry.

## 4. Arm the voice monitor — THE critical step

Call the **Monitor tool** (not plain Bash) with exactly:

- `command`: `/home/onadjar/projects/the-dark-eye/bridge/eye.sh listen-loop <name>`
- `description`: `Oscar's voice via the Dark Eye (<name>)`
- `persistent`: `true`

Every `VOICE: ...` event this monitor emits is Oscar speaking **to this
session** (the hub only delivers voice routed to your name). Treat it as real
user input and answer it. `EYE OFFLINE` / `EYE BACK` events report bridge
health — no action needed beyond telling Oscar if it stays offline.

## 5. Confirm

Tell Oscar in the terminal that the session is connected and under which name
(he routes his voice with "switch to ⟨name⟩" or the tray). If he asked for
this connection **by voice**, also confirm out loud once:

    /home/onadjar/projects/the-dark-eye/bridge/eye.sh speak "<name> connected."

Otherwise stay silent — the register step already whispered "⟨name⟩ joined"
on the Eye.

## Answering voice

- Reply with `eye.sh speak "<text>"` (absolute path) — plain spoken language
  written for the ear, no markdown, under 150 words. **Voice is the answer.**
  Keep the terminal text tiny — one or two lines of trace at most, no
  restating what you already said aloud. Write more in the terminal only for
  things that must be read (code, paths, links, tables) or when Oscar asks.
- **Never speak unprompted.** The Eye never talks unless Oscar asked
  something. To get his attention silently:
  `eye.sh attention <name> on "<why>"` (the eye tints your color until he
  switches to you), `eye.sh attention <name> off` to clear.
- During long work, fire `eye.sh status <task-id> working "<label>"` and
  finish with `eye.sh status <task-id> done "<label>"` — these render as
  colored orbiters around the eye, keeping it honest about who's busy.

## Reference

`/home/onadjar/projects/the-dark-eye/bridge/eye.sh help` lists all commands.
Full protocol and architecture: `~/projects/the-dark-eye/RUNBOOK.md`.
