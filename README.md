# The Dark Eye

A voice-first AI presence for this laptop: an ethereal cat-eye of Matrix glyphs
floating over the TV. Oscar opens his mic and talks; the Claude orchestrator
session hears him and answers out loud through a local voice. No cloud in the
loop — speech in and speech out both run on the CPU.

Design: `DESIGN.md` · Plans: `PLAN-UBUNTU.md`, `PLAN-LOWRES.md`, `PLAN-GPU.md` · Specs: `spec/` · Ops: `RUNBOOK.md`

## Architecture

```
earbuds tap ──BlueZ AVRCP uinput──► ptt-earbuds.py ──POST /bridge/mic──┐
keyboard (GNOME custom key) ──────► eye mic ───────────────────────────┤
                                                                       ▼
 TV HDMI-1 ◄── eye-render (Rust, XWayland) ◄── node body: bridge + voice worker
 speakers/buds ◄── Kokoro TTS      Parakeet STT ◄── mic (PipeWire, HFP autoswitch)
                                   bridge :8642 (127.0.0.1): speak listen mic status show
                                          ▲
                 tmux `claude` orchestrator ── /eye skill ── eye listen-loop / eye speak
```

- **Body** — plain node (`body/`): the HTTP bridge every brain talks to, the
  queue, the intents, `voice.js` as a forked child (sherpa-onnx: Parakeet TDT
  0.6B int8 in, Kokoro sid 17 out) and `pw-cat` children for speech and mic.
  The eye itself is `body/render` — `eye-render`, a Rust overlay on x11rb,
  under XWayland because a native Wayland surface cannot stay always-on-top.
  One binary, two backends: since G07 it draws on the Intel iGPU through EGL +
  GL ES (60 fps idle, 2.0 % of a core, 103 MB) and falls back to its own cairo
  software renderer — 30 fps, 3.3 %, 30 MB — whenever EGL or GL fails, at start
  or mid-run. `PLAN-GPU.md` is the design; `Environment=DARK_EYE_GPU=0` in a
  unit drop-in is the whole rollback (`RUNBOOK.md`, "GPU backend"). Electron is left only for the canvas, spawned on "show me".
- **Brain** — one, the always-on tmux `claude` orchestrator. It joins with the
  `/eye` skill: a persistent `eye listen-loop` monitor is its ear, `eye speak`
  is its mouth. Fleet agents may use `eye speak` / `eye status` for one-liners.
- **Bridge** — plain HTTP on `127.0.0.1:8642` behind a shared secret. Any
  curl-class client can possess the Eye; `bridge/eye.sh` (installed as `eye`)
  is the reference client.

## Quick start

```bash
systemctl --user start dark-eye     # the eye appears bottom-right on the TV
eye health                          # {"ok":true,...}
```

Then type `/eye` in a Claude session (or ask it to "connect to the eye"). It
arms its ear and Oscar can talk. `eye mic on` opens his mic (rings appear,
90 s failsafe), `eye mic off` sends what he said.

## Setup from scratch

1. **Toolchain** — Node 24 (nvm), `cd body && pnpm install`. Two runtime deps:
   `sherpa-onnx-node` and `electron` (the canvas only). The eye needs Rust:
   `cd body/render && cargo build --release`.
2. **Sandbox** — `kernel.apparmor_restrict_unprivileged_userns=1` breaks
   Electron's sandbox helper, so the canvas needs the AppArmor profile
   `/etc/apparmor.d/dark-eye-electron` (`flags=(unconfined) { userns, }`),
   never `--no-sandbox`.
3. **Models** (gitignored, from the sherpa-onnx releases) into `body/models/`:
   `kokoro-multi-lang-v1_0` and
   `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`. Voice check:
   `node body/scripts/tts-test.js 17 "hola"`.
4. **Fonts** — `fonts-noto-cjk` (glyph rain) and `fonts-dejavu` (captions).
5. **Install** — `bash bridge/install.sh`: `eye` on PATH, the `/eye` skill in
   `~/.claude/skills/eye/`, `dark-eye.service` enabled as a user unit.
6. **Config** auto-generates at `~/.config/dark-eye/config.json` (mode 600):
   `secret`, `port` (8642), `voiceSid` (17), `voiceSpeed`, `canvasZoom`.

## The bridge

Plain HTTP, header `x-dark-eye-key: <secret>`. `eye help` prints the client.

| Command | Endpoint | What |
|---|---|---|
| `eye speak <text> [--voice sid]` | `POST /bridge/speak` | say it out loud + caption |
| `eye listen [ms]` / `eye listen-loop` | `GET /bridge/listen` | long-poll his words as `VOICE:` / `EVENT:` lines |
| `eye mic [on\|off]` | `POST /bridge/mic` | open/close his mic (no arg = toggle) |
| `eye status <id> <state> <label>` | `POST /bridge/status` | an orbiter around the eye |
| `eye show <title> <file> [--ask]` | `POST /bridge/show` | put a visual on his canvas |
| `eye health` | `GET /bridge/health` | body up, ear armed, mic open |

## Repo layout

| Path | What |
|---|---|
| `body/` | the node body: `src/main.js`, `server.js`, `voice.js`, `audio.js`, `canvas/`, and `render/` (the Rust eye) |
| `bridge/` | `eye.sh` client, the `/eye` skill, `install.sh` |
| `soul/` | DarkSaddler persona (`SOUL.md`) |
| `spec/` | historical phase specs, and `eye-reference.html` — the Electron eye `render/` was ported from |
| `field/` | the standalone 3D field app (out of scope of the rewrite) |
| `RUNBOOK.md` | ops: start/stop, config, security, hard-won facts |

The first body was built for another OS and a different topology (a session
hub, a fast Agent SDK brain, a tray). All of it lives in git history at commit
`2ff62d1`.
