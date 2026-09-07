---
name: eye
description: Give this session Oscar's voice — hear him through The Dark Eye (the eye overlay on the TV) and answer out loud. Use when he says "open the eye", "connect to the eye", "join the eye", or wants this session reachable by voice.
allowed-tools: Bash(eye:*), Bash(systemctl --user * dark-eye*), Bash(journalctl --user -u dark-eye*), Monitor
---

# The Dark Eye — his voice in this session

One body, one ear, one mouth. `eye` is on PATH (`~/.local/bin/eye`); `eye help`
lists every command. Both steps matter — step 2 is what makes voice work.

## 1. Is the body up

`eye health` prints `{"ok":true,...}`. If it does not answer, start it with
`systemctl --user start dark-eye` and retry for ~30 s (the voice worker boots
first). Logs: `journalctl --user -u dark-eye -n 50`.

## 2. Arm the ear — the critical step

Call the **Monitor tool** (not plain Bash) with exactly:

- `command`: `eye listen-loop`
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

- `eye speak "<text>"` — **voice is the answer.** Spoken language, no markdown,
  one or two short sentences (never over 150 words). Keep the terminal to a
  line or two; write there only what must be read (code, paths, links).
- **Never speak unprompted.** The Eye answers; it does not start conversations.
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
