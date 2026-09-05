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
alone) and a unique Kokoro voice (add `--voice <sid>` before the brief to
pick one yourself; 0-52, 17 is the Eye's own and refused), and returns
`{name, color, voice, note?, active, sessions}`. A silent "⟨name⟩ joined"
caption decodes on the Eye. If the response is `{"error": ...}` the name is
live or invalid — pick another and retry.

## 4. Arm the voice monitor — THE critical step

Call the **Monitor tool** (not plain Bash) with exactly:

- `command`: `/home/onadjar/projects/the-dark-eye/bridge/eye.sh listen-loop <name>`
- `description`: `Oscar's voice via the Dark Eye (<name>)`
- `persistent`: `true`

Every `VOICE: ...` event this monitor emits is Oscar speaking **to this
session** (the hub only delivers voice routed to your name). Treat it as real
user input and answer it. `EYE OFFLINE` / `EYE BACK` events report bridge
health — no action needed beyond telling Oscar if it stays offline.

The monitor also emits `EVENT: ...` lines — notices from the body, not
Oscar's words:

- `EVENT: channel-open — <why>` — Oscar just answered your held attention
  call and your session now has his voice. Speak your question now (this is
  the one case where speaking first is right — he switched TO you for it).
- `EVENT: canvas-approved — <title>` / `EVENT: canvas-rejected — <title>` —
  his verdict on a visual you put on the canvas. Act on it.
- `EVENT: image — <path>` — Oscar pasted an image into the canvas chat for
  you. Read the file at that path (it's a PNG, WSL-visible) and treat it as
  something he just showed you.
- `EVENT: wake-session — <name>|<sock>` — Oscar is talking to session
  `<name>` but its ear is dead (interrupts/backgrounding kill monitors) and
  YOU are the live session asked to wake it. Use the SendMessage tool with
  `to: "uds:<sock>"` (prepend `uds:` — the sock arrives as a raw path).
  Socks go STALE on every Claude process restart — if the sock part is
  empty or delivery fails, find the sleeper by name via ListAgents
  instead (proven fallback in the 2026-08-11 reverse drill). Send this
  message: *"Oscar is talking to you through the Dark Eye on channel
  '<name>' and your ear is dead. Recover in THIS order: (1) DRAIN first —
  repeat one-shot `/home/onadjar/projects/the-dark-eye/bridge/eye.sh
  listen <name> 2000` calls until empty; his parked words arrive as VOICE
  lines, answer them out loud via `eye.sh speak --as <name>`. (2) THEN arm
  the ear: Monitor tool, command `/home/onadjar/projects/the-dark-eye/
  bridge/eye.sh listen-loop <name>`, description `Oscar's voice via the
  Dark Eye (<name>)`, persistent true. Drain-before-arm answers him in
  your first breath and two pollers never race. (3) Refresh your wake
  address: `eye.sh introduce <name> "<brief>"` — your process restarted,
  so the sock the hub stored for you is stale."* Delivery of that
  message is what wakes the sleeper. (Order proven in the 2026-08-11
  wake drills, both directions.)

**The Eye can also wake you itself** (the necromancer): register/introduce
automatically leave your `$CLAUDE_CODE_SESSION_ID` with the hub, and when
Oscar talks to you with your ear dead and NO live session to relay, the
body resurrects your conversation headlessly (`bridge/wake.sh`). If you
wake to a `NECROMANCER WAKE:` prompt, follow it exactly — drain, speak as
yourself, keep listening, then rest. You need to do nothing to enable
this; joining the Eye is enough.

**If YOU receive a wake message like the one above** (from another session,
telling you your ear is dead): follow it exactly — drain with one-shot
listens and answer aloud FIRST, arm the Monitor second. Interrupts and
backgrounding kill monitors silently — after any interruption, assume the
ear may be dead. Before re-arming, check your own task list: TWO
listen-loops on one name split Oscar's words between them, so re-arm only
if your monitor is really gone.

Oscar can also TYPE to you from the canvas chat bar — typed words arrive as
normal `VOICE:` lines (they're his words either way; links usually arrive
typed). Answer by voice as usual.

## 5. Confirm

Tell Oscar in the terminal that the session is connected and under which name
(he routes his voice with "switch to ⟨name⟩" or the tray). If he asked for
this connection **by voice**, also confirm out loud once:

    /home/onadjar/projects/the-dark-eye/bridge/eye.sh speak "<name> connected."

Otherwise stay silent — the register step already whispered "⟨name⟩ joined"
on the Eye.

## Answering voice

- Reply with `eye.sh speak --as <name> "<text>"` (absolute path) — plain
  spoken language written for the ear, no markdown, under 150 words.
  `--as <name>` makes you speak with your session's own voice so Oscar can
  tell brains apart by ear; without it you sound like the Eye itself.
  **Voice is the answer.**
- **Speaking while another session has his voice does NOT play.** Oscar's
  law: a background session overwrites nothing — voice or caption. Your
  words are parked, you appear as a waiting call by the eye, and they play
  in your voice the moment he switches to you. So speak normally when
  active; when backgrounded, prefer one short summary line over many.
  Keep the terminal text tiny — one or two lines of trace at most, no
  restating what you already said aloud. Write more in the terminal only for
  things that must be read (code, paths, links, tables) or when Oscar asks.
- **Never speak unprompted.** The Eye never talks unless Oscar asked
  something. To get his attention silently:
  `eye.sh attention <name> on "<why>"` — you join the hold queue; the eye
  tints your color when you reach the front, and when Oscar switches to you
  your monitor gets `EVENT: channel-open`. `eye.sh attention <name> off`
  leaves the queue.
- During long work, fire `eye.sh status <task-id> working "<label>"` and
  finish with `eye.sh status <task-id> done "<label>"` — these render as
  colored orbiters around the eye, keeping it honest about who's busy.

## Showing visuals — the canvas

When Oscar asks for a mockup, a graph, a page — anything visual — write it
to a file (self-contained HTML, an image, or plain text) and push it:

    /home/onadjar/projects/the-dark-eye/bridge/eye.sh show <name> "<short title>" <file> [--ask]

(`-` instead of a file reads HTML from stdin.) The canvas **never opens by
itself** — Oscar's hard rule. He gets a clickable pending mark by the eye
and a whispered caption; he opens it by clicking the mark, saying "show me",
or from the tray. Add `--ask` ONLY when you need his explicit decision —
that puts approve/reject buttons on the canvas and his verdict arrives on
your monitor as `EVENT: canvas-approved` / `EVENT: canvas-rejected`.
Without `--ask` he just looks and dismisses (no event comes back). After
pushing, say (or print) one short line that it's on the canvas — never nag
him to open it.

Canvas HTML is rendered in a sandboxed frame with no network access — keep
it self-contained: inline CSS/JS, images as data: URIs.

## Reference

`/home/onadjar/projects/the-dark-eye/bridge/eye.sh help` lists all commands.
Full protocol and architecture: `~/projects/the-dark-eye/RUNBOOK.md`.
