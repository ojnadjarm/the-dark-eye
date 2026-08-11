# The Dark Eye

A voice-first AI assistant that lives on the Windows desktop as an ethereal
cat-eye of Matrix glyphs. Oscar holds a key and talks; a Claude brain answers
out loud through a local voice. Any number of Claude sessions can connect as
named "brains" — a hub routes his voice to one of them at a time, switched by
voice or from the tray.

Design: `DESIGN.md` · Specs: `spec/` · Live ops + hard-won facts: `RUNBOOK.md`

## Architecture

```
┌─ Windows ────────────────────────────────┐   ┌─ WSL2 ──────────────────────┐
│ body/  (Electron)                        │   │ brain/  "fast" (~2s)        │
│  · Eye overlay (transparent, click-thru) │◄──┤  Claude Agent SDK + SOUL.md │
│  · TTS Kokoro + STT Parakeet (CPU)       │   │                             │
│  · push-to-talk: tap Ctrl+Alt+Space      │◄──┤ Claude Code sessions "deep",│
│  · session hub + tray roster             │   │  "cryptodesk", ... (~5-15s) │
│  · MCP server + HTTP bridge on :8642     │   │  via bridge/eye.sh + /eye   │
└──────────────────────────────────────────┘   └─────────────────────────────┘
```

- **Body** — the Eye itself: overlay, voice in/out, hotkeys, tray, and the
  server every brain talks to (MCP + plain-HTTP bridge, shared secret).
- **Brains** — anything that can speak the bridge protocol. The fast brain is
  a small Agent SDK loop; deep brains are full Claude Code sessions.
- **Hub** — open session registry (unique name + color per brain; green is
  reserved for the Eye). Voice routes to ONE active session; Oscar switches
  by saying "switch to ⟨name⟩" or from the tray.

## Quick start (everything already installed)

1. **Start the body** (from WSL):

   ```bash
   powershell.exe -NoProfile -Command 'Stop-Process -Name electron -Force -ErrorAction SilentlyContinue; Start-Sleep 1; Set-Location C:\Users\Oscar\projects\the-dark-eye\body; Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "." -WindowStyle Hidden'
   ```

   The Eye appears bottom-right. Note: every restart re-enables the cloak
   (hidden from screen recorders) — tray checkbox toggles it.

2. **Talk**: tap `Ctrl+Alt+Space` to open the mic (rings appear), tap again
   to send. 90s auto-close failsafe.

3. **Connect a Claude Code session** — type `/eye` in any session, or just
   ask it to "connect to the eye". It registers itself, arms its ear, and
   shows up in the tray. That's the whole procedure.

4. **Fast brain** (optional, terminal chat + ~2s voice replies):

   ```bash
   cd ~/projects/the-dark-eye/brain && pnpm start
   ```

## Setup from scratch

### Windows (the body)

1. Node 24 LTS + pnpm (user-level via `npm i -g pnpm`).
2. `cd body && pnpm install`, then run `node node_modules/electron/install.js`
   manually — **pnpm 11 on Windows silently skips postinstall scripts**, so
   Electron's binary never downloads on its own.
3. STT model: `body/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/`
   (encoder/decoder/joiner `.int8.onnx`, 16kHz). TTS (Kokoro multi-lang
   v1.0) is fetched by the voice worker; voice test:
   `node body/scripts/tts-test.js 17 "hello"`.
4. Config auto-generates at `%APPDATA%\dark-eye\config.json`: `secret`
   (shared key for all brains), `port` (8642), `voiceSid` (17 = the voice),
   `voiceSpeed`.

### WSL (the brains)

1. **The `/eye` skill** (plug-and-play for Claude Code sessions):

   ```bash
   bash bridge/install.sh
   ```

   Installs the skill to `~/.claude/skills/eye/` (user scope — every project
   sees it). The skill teaches a session the full join procedure: check the
   Eye is up → register a unique name → arm a persistent voice monitor with
   `bridge/eye.sh listen-loop <name>` → speaking rules. The skill source of
   truth is `bridge/SKILL.md`; re-run the installer after editing it.

2. **`bridge/eye.sh`** needs zero setup — it resolves the Windows host
   (default gateway from `/proc/net/route`) and the secret (from the config
   above) on every run. `bridge/eye.sh help` lists all commands; try
   `bridge/eye.sh sessions`.

3. **Optional — MCP tools**: register the body's MCP server at user scope so
   sessions also get native `mcp__dark-eye__*` tools:

   ```bash
   claude mcp add --scope user --transport http dark-eye \
     "http://$(awk '$2=="00000000" {print $3; exit}' /proc/net/route | sed 's/../& /g' | awk '{printf "%d.%d.%d.%d", strtonum("0x"$4), strtonum("0x"$3), strtonum("0x"$2), strtonum("0x"$1)}'):8642/mcp" \
     --header "x-dark-eye-key: <secret from config.json>"
   ```

   Re-run after a reboot if the WSL gateway IP changed (remove + add). The
   `/eye` skill does NOT depend on this — the bridge script covers everything.

## The bridge protocol

Plain HTTP on `:8642`, header `x-dark-eye-key: <secret>` — full endpoint
table in `RUNBOOK.md`. `bridge/eye.sh` wraps all of it:

```
eye.sh sessions                     roster + who has the voice
eye.sh register <name> [brief]      join (hub assigns a color)
eye.sh listen-loop <name>           emits "VOICE: ..." per utterance
eye.sh speak <text>                 the Eye says it out loud
eye.sh status <id> <state> <label>  orbiter around the eye
eye.sh attention <name> on|off      tint the eye in your color
```

## Repo layout

| Path      | What                                                        |
|-----------|-------------------------------------------------------------|
| `body/`   | Electron overlay: eye renderer, voice worker, hub, bridge   |
| `brain/`  | Fast brain: Claude Agent SDK loop, soul from `soul/SOUL.md` |
| `bridge/` | `eye.sh` client + `/eye` skill + installer                  |
| `soul/`   | DarkSaddler persona (`SOUL.md`)                             |
| `spec/`   | Phase specs: A the Eye (FINAL v2), B the Field              |
| `RUNBOOK.md` | Ops: restart recipes, bridge API, hard-won facts, state  |

## Troubleshooting

Everything painful is already written down — read the **Hard-won facts**
section of `RUNBOOK.md` first (pnpm postinstall skips, Electron napi buffer
rule, WSL→Windows gateway vs DNS, transparency gotchas, TDZ in the renderer).
