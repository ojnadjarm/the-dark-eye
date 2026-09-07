# Phase A Spec — The Eye (v2)

*Historical (Windows-era, D9). Superseded by `PLAN-UBUNTU.md` and `PLAN-LOWRES.md`; the shipped look is `spec/eye-reference.html`, ported in `body/render`. Kept unrewritten.*

> The ethereal form. Navi's descendant, but not a notifier: the Eye IS the
> main agent. DarkSaddler, orchestrator, present on screen.

Status: **FINAL v2** — 2026-08-11. v1 decisions kept (D2, D3), D1 amended by
research, gaps filled (Show channel, stack, failure states) after a 3-agent
research pass (digests: voice/electron/SDK — see repo notes + sources below).

## 1. Identity

- The Eye is **DarkSaddler himself**, not a widget that displays him. One
  presence, one personality, one voice. Soul loaded from `soul/SOUL.md`.
- **Role: orchestrator.** The Eye dispatches subagents and reports. Oscar
  talks to *the Eye*, always; subagents report to the Eye, not to Oscar.

## 2. What the Eye CAN do

1. **Listen** — hold-to-talk: hold `Ctrl+Alt+Space` (configurable), speak,
   release. Local transcription in the body (Parakeet v3, English + Spanish
   auto-detected). *(v1 said `Ctrl+Space` — amended: Electron's
   globalShortcut swallows registered combos system-wide and has no key-up
   event, so plain Ctrl+Space would kill editor/IME completions everywhere.
   Hold-to-talk uses a low-level hook (uiohook-napi) that swallows nothing.)*
2. **Speak** — local TTS (Kokoro-82M; voice: `am_onyx` blended toward
   `am_fenrir` — deep, dry). Under 150 words unless asked to explain.
3. **See what he's shown** — the Show channel (§4). Never more, never less.
4. **Orchestrate** — brain #1 (Claude Agent SDK in WSL2) with its normal
   tools: read/edit files, run commands, work his repos, spawn subagents.
   That IS Phase A's "hands" — the WSL2 machine. (External services — mail,
   calendar — are Phase C.) Reports outcomes in plain speech: what works,
   what failed, cause and fix. Never reads code aloud.
5. **Signal visually** (§5) and **present** (§7, stretch).
6. **Remember the thread** — one long-lived session; survives restarts
   (SDK session resume); "where were we" answered on demand.

## 3. What the Eye CANNOT do (hard boundaries)

1. **No external actions without asking** (soul law, non-negotiable).
2. **No watching.** The Eye never captures screen, clipboard, or files on
   its own — every capture is Oscar's deliberate gesture (§4), confirmed
   visibly. (A "summon carries a snapshot" auto-context option may exist
   someday, opt-in, OFF by default. Research note: users consistently
   punish silent always-on capture and reward explicit bounded capture.)
3. **No mouse/keyboard control.** It orchestrates agents, not the desktop.
4. **No uninvited nagging.** No reminders, no check-ins. Silence is legal.
5. **No fabrication** — unsure means saying so.

## 4. The Show channel — "look at this"

Three gestures, one tray. He navigates PC or browser and shows the Eye
things; nothing is ever taken.

| Gesture | Default | What happens |
|---|---|---|
| **Snap** | `Ctrl+Alt+S` | Instant capture of the **active window** (identified via get-windows, grabbed via one-shot desktopCapturer — silent, no border, no prompt). Press again within 1s → **region mode**: frozen-frame overlay, drag a rectangle. |
| **Paste to the Eye** | `Ctrl+Alt+V` | Reads the clipboard *at that moment* (text, image, or copied files). No clipboard watching, ever — read-on-gesture only. |
| **Drop** | drag onto the knot | Files, images, dragged text selections. (Overlay flips out of click-through while a drag hovers it.) |

- **The tray:** shown items stack as small glyph-cards next to the knot
  (max 5, oldest drops off). Each shows a thumbnail — Oscar always sees
  exactly what the Eye got. Click a card to discard it.
- **Delivery:** tray contents ride along with his **next utterance** —
  "look at this, why is it failing?" is one natural motion. Sent items
  clear. (Wire: `listen()` returns transcript + attachments; images travel
  as MCP image content blocks — model sees them natively.)
- If he snaps and says nothing for 5 minutes, cards stay — the tray has no
  timer, like everything else about the Eye.

## 5. Expression language (visual states)

| State | Glyph-knot behavior |
|---|---|
| Idle | slow drift, dim green trickle |
| Listening (key held) | contracts, brightens, faint ring |
| Thinking | tight fast swirl |
| Working | one thin column per active subagent, green flow |
| Speaking | pulses synced to voice |
| Needs approval | red glitch-flicker, holds until addressed (the Call) |
| Done | single gold pulse, then idle |
| Didn't catch | brief grey shimmer (empty transcript — never voiced) |
| **Severed** | grey, dim, slow — brain unreachable; auto-reconnects |

Audio rule: voice + the Call ring only. No other sounds.

## 6. The Call (unchanged from v1)

The Eye NEVER speaks unprompted. It rings once + holds a red missed-call
state — forever if needed. Pick up = hold-to-talk key or click the knot.
Only approval-pending and awaited-failure may ring.

## 7. Present pane (stretch goal, seed of Phase D)

`present(kind, payload)`: DarkSaddler can dock a small holo-pane near the
knot — a text/markdown snippet, an image, a link card. Sticky until
dismissed (click). Voice monopoly unaffected; the pane is a visual aid, not
required reading. This is deliberately minimal — the full "agents demo
their work" vision lives in Phase D.

## 8. Architecture & stack (research-backed, 2026-08)

```
┌─ Windows ─ the body (Electron ~v42) ────────────┐     ┌─ WSL2 ─ the brain ────────────────┐
│ Eye overlay: small, transparent, frameless,     │     │ Claude Agent SDK (TypeScript)     │
│  alwaysOnTop('screen-saver'), non-resizable,    │ MCP │  streaming-input long session     │
│  contentProtection(true), click-through with    │◄───►│  systemPrompt: preset + SOUL.md   │
│  cursor-poll fallback                           │HTTP │  hooks Pre/PostToolUse →          │
│ Voice worker: sherpa-onnx addon —               │:8642│   agent_status() to the body      │
│  Parakeet-TDT-0.6B-v3 int8 (STT, EN+ES)         │     │  tools: WSL2 files/shell/repos +  │
│  Kokoro-82M (TTS, onyx∗fenrir blend)            │     │   subagents (Task)                │
│  Silero VAD (trim)                              │     └───────────────────────────────────┘
│ Input: uiohook-napi (hold-to-talk),             │      brain connects to body at the
│  get-windows (active window id)                 │      Windows host IP (WSL2 → Windows),
│ MCP server (streamable HTTP): listen, speak,    │      shared-secret header, LAN-only bind
│  ring, agent_status, present                    │
└─────────────────────────────────────────────────┘
```

- **Latency budget:** release key → STT ~0.3-0.6s → brain first tokens →
  TTS first audio ~0.3-0.6s ⇒ DarkSaddler starts speaking ≈ **under 2s**.
- **Only two native modules** (uiohook-napi, get-windows); voice is one
  sherpa-onnx addon in a worker — no Python runtime shipped.
- **Fallback STT** if Parakeet accuracy disappoints: whisper.cpp
  large-v3-turbo F16 on the 7800XT (lemonade-sdk prebuilt ROCm/Vulkan
  Windows binaries, gfx110X) as a local whisper-server. Avoid quantized
  models on Vulkan (known garbage-output bug); F16 only.
- **Voice lab (offline, later):** Chatterbox-Turbo (WSL2/ROCm) or Maya1
  ("design a voice from a description") to craft a bespoke DarkSaddler
  voice; Kokoro blend is the shipping voice.
- **Auth ⚠ (resolve in A1):** subscription OAuth for custom agents is
  restricted; there's a plan-credits path for personal Agent SDK use
  (support article "Use the Claude Agent SDK with Your Claude Plan") — try
  it first; fallback `ANTHROPIC_API_KEY` (pay-per-use, costs noted before
  enabling).
- SDK facts locked by research: images require streaming-input mode; MCP
  tool results can carry images (Show channel end-to-end confirmed); hooks
  fire for subagents (activity feed); session resume by id.

## 9. Failure states

- **Brain down:** severed state (§5); hold-to-talk gives a grey shimmer
  ("no one is listening" — visual only); body retries connection quietly.
- **Empty/garbled transcript:** grey shimmer, nothing sent, no voice.
- **Never talks over him:** speak() queues while the talk key is held.
- **Windows mic privacy toggle:** silent-track detection (known Electron
  quirk — mic block yields silence, not an error) → severed-style hint
  pointing at Settings → Privacy → Microphone.
- **DevTools note (dev only):** opening DevTools breaks window
  transparency — debug with a detached second window.

## 10. Config

`%APPDATA%/dark-eye/config.json`: hotkeys, mic/output device, voice blend,
monitor, knot position/opacity, brain URL + shared secret, autostart.
Body: electron-builder NSIS per-user install, launch-at-login `--hidden`,
tray icon, never quits on window close.

## 11. Decision log

- **D1 (amended v2):** hold-to-talk `Ctrl+Alt+Space` via low-level hook;
  `Ctrl+Space` rejected on research (system-wide swallow). Configurable.
- **D2:** voice monopoly — only DarkSaddler speaks. Unchanged.
- **D3:** the Call — never speaks first; ring + missed-call hold. Unchanged.
- **D4 (new):** Show channel is gesture-only, read-on-gesture, visible
  thumbnails; no watchers of any kind.

## 12. Build order (each slice usable on its own, done when done)

- **A1 — the brain speaks (text).** WSL2: SDK + soul; terminal chat proves
  auth, persona, session. *(No Windows work yet.)*
- **A2 — the voice loop.** Body skeleton: Eye knot overlay + MCP server +
  sherpa-onnx worker; hold-to-talk → DarkSaddler's voice. Jarvis is real.
- **A3 — the Show channel.** Snap + Paste + Drop + tray + attachments.
- **A4 — the Call + status.** ring(), missed-call state, agent_status
  flickers, severed handling; present() if the day is good.

## 13. Phase A is done when

Oscar holds the key, asks a question, and DarkSaddler answers aloud in
under ~2s; he snaps a browser window, says "what's wrong here?", and gets a
spoken answer about *that image*; a subagent runs a real task in WSL2 while
the knot shows a working column; an approval rings once, waits an hour
unanswered, and completes after a spoken "do it"; and the whole loop runs
through the body's MCP contract with the brain swappable in principle.
