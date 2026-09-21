---
name: eye
description: Give this session Oscar's voice — hear him through The Dark Eye (the eye overlay on the screen) and answer out loud. Use when he says "open the eye", "connect to the eye", "join the eye", or wants this session reachable by voice.
allowed-tools: Bash(eye:*), Bash(systemctl --user * dark-eye*), Bash(journalctl --user -u dark-eye*), Monitor
---

# The Dark Eye — his voice in this session

One body, one ear, one mouth. `eye` is on PATH (`~/.local/bin/eye`); `eye help`
lists every command. Both steps matter — step 2 is what makes voice work.

## 0. Your name — which brain you are

Several Claude sessions can be brains at once; only one hears him. Pick your
name (`[a-z0-9-]{1,16}`; the orchestrator is `main`, the notes session is
`notes`; a session started with `claude --name <name>` uses the same word) and
`export EYE_BRAIN=<name>` before anything else — every `eye` command then
carries it (`--as <name>` does the same per call). No name = `main`.

## 1. Is the body up

`eye health` prints `{"ok":true,...}`. If it does not answer, start it with
`systemctl --user start dark-eye` and retry for ~30 s (the voice worker boots
first). Logs: `journalctl --user -u dark-eye -n 50`.

## 2. Arm the ear — the critical step

Call the **Monitor tool** (not plain Bash) with exactly:

- `command`: `eye listen-loop --as ${EYE_BRAIN:-main}`
- `description`: `Oscar's voice via the Dark Eye`
- `persistent`: `true`

Every `VOICE: ...` line it emits is Oscar speaking to you — real user input,
answer it. A `VOICE [remote]: ...` line means he is on the phone: keep the
answer short, and let `eye speak` pick the channel by itself (never pass `--to`). `EVENT: canvas-approved — <title>` / `EVENT: canvas-rejected —
<title>` are his verdicts on a visual you showed him; act on them.
`EYE OFFLINE` / `EYE BACK` are bridge health — mention it only if it stays off.

**After any interrupt, assume the Monitor died.** Check your task list; re-arm
it once if it is gone. Two listen-loops split his words between them.

Then say in the terminal, in one line, that the ear is armed. Stay silent out
loud unless he asked for this by voice.

## Answering

- `eye speak --as ${EYE_BRAIN:-main} "<text>"` — **voice is the answer.** Spoken
  language, no markdown, one or two short sentences (never over 150 words). Keep
  the terminal to a line or two; write there only what must be read (code, paths,
  links).
- **Never speak unprompted.** The Eye answers; it does not start conversations.
- If you are not the active brain your words are **parked** and he hears them
  the moment he switches to you — say it once, never repeat it.
- In **audio notes mode** (`eye health` says `"mode":"notes"`) your words are shown as
  text and wait for his `▶` or "talk to me", not spoken — do not repeat yourself. The
  other mode is **call**, where a reply plays as it arrives. The mode is the Eye's and
  applies to every channel; `eye mode [call|notes]` reads or sets it (`eye quiet on|off`
  is the old name of the same thing).
- `eye brains` shows the roster (active, connected, parked). `eye talk-to <name>`
  hands him over to another brain — only when he asked for it.
- The roster is **channels** — who hears him: `main`, `notes` (the channel that writes his
  Obsidian vault), and anything registered later. The two **modes** are a separate thing,
  above: "audio notes" is a mode, `notes` is a channel. Nobody starts a channel's session for him — if yours is down he
  is switched there anyway, told it is not listening, and his words wait on your bus until
  you long-poll.
- His notes, only when he asks: "remember my notes from yesterday" → `eye notes
  --since yesterday`, then answer from the text; "what did I say about the lamp"
  → `eye notes --grep lamp`. `eye notes` reads the vault; the notes brain writes it.
- Subagents put their own orbiter on the eye and take it off — the
  `SubagentStart`/`SubagentStop` hooks do it, never send those by hand.
  `eye status <id> working "<label>"` (and `... done`) is for a ticket or a long
  piece of work of your own; `eye status` lists what the body is holding.

## His mic

Until the earbud tap lands (E08) his mic is opened from here: `eye mic on`
opens it (rings appear, 90 s failsafe), `eye mic off` sends what he said, `eye
mic` toggles. His GNOME shortcut does the same thing.

## Showing him things

    eye show "<short title>" <file> [--ask]

Self-contained HTML (inline CSS/JS, images as `data:` URIs — the canvas frame
has no network), an image, or plain text; `-` reads HTML from stdin. The canvas
**never opens by itself** — he gets a mark by the eye and looks when he wants.
Add `--ask` only when you need his decision; the verdict comes back as an
`EVENT:` line on your Monitor. Say one short line that it is there; never nag.
