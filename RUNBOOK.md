# The Dark Eye — Runbook & Live State

> The resurrection document. Everything needed to run, debug, and reconnect
> the system — written 2026-08-11, the day it came alive.

## What this is

Oscar's Jarvis: voice-first DarkSaddler as an ethereal cat-eye of glyphs on
the Windows desktop. He holds a key and talks; a Claude brain answers out
loud through a local voice. Full design: `DESIGN.md`, `spec/A-the-eye.md`
(FINAL v2), `spec/B-the-field.md` (the future Matrix world).

## Architecture (as running)

- **Body** (Windows, Electron 42): `body/` — the Eye overlay (transparent,
  always-on-top, click-through, bottom-right), voice worker
  (`src/voice.js`, Electron utilityProcess: Kokoro TTS + Parakeet STT via
  sherpa-onnx-node, all CPU), push-to-talk (uiohook-napi, **tap
  Ctrl+Alt+Space to open the mic, tap again to close/send**; listening
  rings = mic open; auto-closes after 90s), MCP server + HTTP bridge on
  **:8642**.
- **Brains** (BOTH can stay connected — the session hub routes Oscar's
  voice to ONE active session; he switches by saying **"switch to
  <name>"** / "cambia a <name>", intercepted by the body, never forwarded):
  1. **Fast brain** — `brain/` (WSL2, Claude Agent SDK, soul from
     `soul/SOUL.md`): `cd ~/projects/the-dark-eye/brain && pnpm start`.
     ~2s replies, uses Oscar's Claude Code login. Answers by calling
     `mcp__body__speak`; hears via MCP `listen` (session default **fast**,
     color cyan #4dd9ff).
  2. **Deep brain** — a Claude Code session possessing the Eye through the
     plain-HTTP bridge (see below). Slow (~5-15s), full project context.
     Bridge `listen` session default **deep** (color violet #b04dff).
  The tag under the eye (⟨ deep ⟩ / ⟨ fast ⟩) shows who has his voice.
  Sessions can request attention: the whole eye tints/pulses in their
  color until he switches to them or they clear it.

## The bridge (any curl-class brain can possess the Eye)

Secret: `"secret"` field of `C:\Users\Oscar\AppData\Roaming\dark-eye\config.json`
(from WSL: `/mnt/c/Users/Oscar/AppData/Roaming/dark-eye/config.json`).
Host from WSL: default gateway, currently `172.18.192.1` (read
`/proc/net/route`, NOT resolv.conf — DNS tunneling lies).

```
POST /bridge/speak     {"text": "..."}                      → Eye speaks it (Kokoro) + decode caption
GET  /bridge/listen?timeoutMs=50000&session=deep            → long-poll; {"transcript": "..."|null}
                                                              (session default "deep"; MCP listen defaults "fast")
POST /bridge/status    {"id","state":"working|done|error","label"} → colored orbiter around the eye
POST /bridge/cloak     {"on": true|false}                   → hide/show from screen recorders
POST /bridge/attention {"session","on":true|false,"label"}  → eye tints/pulses in that session's color
POST /bridge/active    {"session": "deep"}                  → route Oscar's voice to that session (no announcement)
POST /bridge/register  {"name","color":"#hex?","brief"?}    → join the roster; green refused; a name that is
                                                              live RIGHT NOW is refused (HTTP 200 {"error":...},
                                                              idle names are reusable); success returns
                                                              {name,color,note?,active,sessions}
POST /bridge/introduce {"session","brief":"one line"}       → silent caption + shown in tray next to the name
GET  /bridge/sessions                                       → {"active": "...", "sessions": [...]}
All with header: x-dark-eye-key: <secret>
```

Claude-session possession recipe: persistent Monitor running a
`/bridge/listen` long-poll loop (each transcript line = one wake event),
answer with curl to `/bridge/speak`, ping `/bridge/status` when doing real
work so the orbiters stay honest.

**Plug-and-play possession (2026-08-11):** `bridge/eye.sh` wraps the whole
protocol — gateway + secret auto-resolved every run, subcommands for every
bridge endpoint (`eye.sh help`). The user-scope skill **`/eye`** (source of
truth `bridge/SKILL.md`, installed to `~/.claude/skills/eye/` by
`bridge/install.sh`; setup guide in `README.md`) walks any
Claude session through the recipe: sessions → register → **Monitor with
`eye.sh listen-loop <name>`** (the step models kept skipping — a session
without it is deaf) → speak rules. Oscar types `/eye` or says "connect to
the eye" in any session and it joins the roster. The skill's frontmatter
pre-allows `Bash(eye.sh:*)` + Monitor, so no settings.json permission
edits are needed.

**Global MCP registration (2026-08-11):** the body is registered at USER
scope in Claude Code (`~/.claude.json`), server name `dark-eye` — every new
local session is born with tools `mcp__dark-eye__{register,listen,speak,
introduce,attention,agent_status}`. **Open session registry**: any number
of sessions; a new session calls `register` (name + optional color; both
unique, green-band hues refused, roster returned), then `listen` with its
own name. hub.reg seeds deep=#b04dff / fast=#4dd9ff; 10-color PALETTE,
hue-spread fallback when exhausted. Unregistered names that appear (routeTo,
attention) auto-join. MCP listen default is still "fast" — collides with
the SDK brain if a session skips register. If the WSL gateway IP
changes after a reboot, refresh with:
`claude mcp remove --scope user dark-eye && claude mcp add --scope user
--transport http dark-eye http://<gateway>:8642/mcp --header
"x-dark-eye-key: <secret>"` (gateway from /proc/net/route, secret from the
dark-eye config.json).

## Start / restart

- **Body** (from WSL):
  `powershell.exe -NoProfile -Command 'Stop-Process -Name electron -Force -ErrorAction SilentlyContinue; Start-Sleep 1; Set-Location C:\Users\Oscar\projects\the-dark-eye\body; Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "." -WindowStyle Hidden'`
  Boot self-test: set env `DARK_EYE_SAY="text"` → speaks at launch.
- **Fast brain**: `cd ~/projects/the-dark-eye/brain && pnpm start`
  (interactive terminal chat + voice loop; `pnpm start "text"` = one-shot).
- **Voice test without Electron**: `node body/scripts/tts-test.js [sid] ["text"]`
  (wavs land in body/scripts/).

## Config (`%APPDATA%\dark-eye\config.json`)

`secret` (auto-generated; the ONLY key present by default) · optional
overrides, absent unless hand-added: `port` (default 8642) · `voiceSid`
(default 17 = deep male; ear-test wavs: `body/scripts/test-sid11..19.wav`) ·
`voiceSpeed` (default 1.0).

## Security posture (QA + security audit round, 2026-08-11)

- Server binds the **vEthernet (WSL) adapter only** (auto-detected in
  server.js; falls back to 0.0.0.0 with a WARN log if no WSL adapter) —
  port 8642 is NOT on Wi-Fi/LAN adapters anymore.
- Auth: timing-safe compare, **fail-closed** (server refuses to start with
  an empty secret). All endpoints behind the key, incl. /mcp.
- `eye.sh` passes the secret to curl via fd (never argv → never in `ps`),
  validates session names/timeouts, `curl -f` + die so 401/down are loud.
- Remote cloak-OFF whispers "⟨ cloak off — visible to capture ⟩" on the Eye
  — no silent unmasking (tray toggle stays silent).
- Voice/speech content is redacted from body logs unless `DARK_EYE_DEBUG=1`.
- Renderer: explicit contextIsolation/sandbox/nodeIntegration:false/
  webSecurity, media permission only for the local file:// eye page.
- Known-accepted residuals: secret readable by any WSL process (DrvFs
  config.json) and duplicated in ~/.claude.json (mode 600); anyone with the
  secret can speak/reroute (scoped by the adapter binding); speak curl cap
  30s vs long TTS — watch only.

## Hard-won facts (do not relearn these)

1. **pnpm 11 on Windows silently skips postinstall scripts** — Electron's
   binary: run `node node_modules/electron/install.js` manually.
2. **Electron forbids napi external buffers** — sherpa `tts.generate` MUST
   get `enableExternalBuffer: false` or it throws "External buffers are not
   allowed".
3. Windows cmds from WSL: `powershell.exe -NoProfile -Command '...'` with
   `$env:Path = "C:\Program Files\nodejs;" + $env:Path` prefix; pnpm via
   `& "$env:APPDATA\npm\pnpm.cmd"` (.ps1 shims blocked by execution policy).
4. WSL→Windows host = default **gateway** IP (172.18.192.1), not nameserver.
5. DevTools breaks window transparency; window is non-resizable for the
   same reason. One Eye = several electron.exe processes (normal).
6. Renderer: `frame()` must start after ALL `let` declarations (TDZ).
7. STT sends nothing for clips < 0.25s; mic is muted-gain routed (no echo).

## Aesthetic law (Oscar's verdicts, shipped)

Flat 2D cat-eye (pointed corners, no volume wash, NO outer glow — it showed
the window rect), no blinking, gold iris + feline slit, captions decode
from katakana noise just above the eye (linger 7-22s), **green = the Eye
only; agents = rainbow orbiters outside it** (cyan/magenta/orange/violet/
yellow/pink; comet tails; gold burst on done).

## Current live state (2026-08-11, second checkpoint — pre context-reset)

- Body running latest build; cloak is ON (every restart re-enables it; tray
  has a cloak checkbox for filming).
- Deep-brain session (violet, "deep") connected via persistent Monitor +
  bridge; ACTIVE voice channel. Fast brain validated today (both connected
  simultaneously, he switched by voice, ~2s replies) but its terminal is
  currently closed — roster shows it silent.
- Mic: toggle Ctrl+Alt+Space ONLY (tray click removed by his order).
- Phase A core + improvement round DONE. Remaining: A3 Show channel
  (Snap/Paste/Drop + tray of glyph-cards), A4 the Call (ring/missed-call —
  attention tint is its silent half). Open tuning: breathing naturalness.
- Git: root commit 7246c07 (tag `phosphor-v1`) + checkpoint commit after it.

## Improvements shipped post-compaction (2026-08-11)

He named three; all built and live:
1. **Session selection** — named buses in a hub (main.js), voice-routed by
   "switch to <name>" (intercepted in `handleTranscript`, ≤8-word guard),
   ⟨ tag ⟩ under the eye, canned spoken confirmation from the body itself.
2. **Attention color** — eye lerps to the calling session's color with a
   slow pulse (rim/inner/slit/rings tint; iris stays gold, captions stay
   green); cleared on switch-to or `on:false`.
3. **Toggle mic** — tap to open, tap to send; 90s failsafe; rings while open.
4. **Tray icon** (by the Windows clock, `assets/tray.png` from
   `scripts/make-tray-icon.js`): right-click = session list with COLORED
   DOTS (`src/png.js` runtime PNGs: filled = a brain long-polling now or
   within 90s, hollow ring = silent), ⟨voice⟩ marks the active one, the
   session's brief shows next to its name; click to route silently. Plus
   mic toggle, cloak checkbox, quit. Left-click = toggle mic.
   NOTE: every body restart re-enables the cloak (createEye default).
5. **Iris = channel indicator** — the vertical-oval iris (21×34) wears the
   ACTIVE session's color (violet deep / cyan fast), easing on switch. The
   corner sigil and text tag are gone. Rest of the eye stays green, FROZEN —
   his words: "exactly how I want it, perfect."
6. **Introductions** — sessions self-describe via MCP `introduce` tool or
   `/bridge/introduce`; first listen from an unknown session whispers
   "⟨name⟩ connected". Whisper = caption decode with NO voice (the
   never-speaks-unprompted law holds).

## Eye visual upgrade (researched, awaiting his pick)

`spec/research-eye-visual.md` — full digest. Three directions, ranked:
1. **Phosphor Discipline** (low risk): DPR-scaled canvas, explicit Japanese
   font (Consolas has NO katakana — current glyphs are accidental fallback),
   glyph sprite atlas with baked brightness tiers + glow, 'lighter'
   compositing, traveling brightness waves, mutation-in-place.
2. **Afterimage** (med): destination-out trail buffer, simplex-noise motion,
   micro-saccades, luminance breathing, eased state transitions.
3. **Signal Bleed** (med-high, taste): masked bloom buffer, baked chromatic
   fringe, in-eye grain, row-parity scanlines. Do LAST, at half intensity.
Recommended order 1 → 2 → 3. He approved step-by-step implementation.
**Direction 1 SHIPPED 2026-08-11** (renderer rewritten): devicePixelRatio
backing store, half-width katakana in explicit "MS Gothic", startup sprite
atlas (5 tiers × baked glow, 2x supersampled, blit() preserves fillText
baseline semantics), illumination waves on the lid (makeWave/rimTier, ~1
in 5 hot), mutation-in-place with 160ms flash, slit tiers 2/3/4, eye body
renders to offscreen eyeBuf and attention tint is ONE hue-rotate filtered
composite (no per-glyph recoloring). Iris/orbiters/captions stay fillText.
He approved direction 1 after tuning (iris ring 0.62 alpha/12px — he wanted
it MORE visible; mutation rates quartered, no flash pops — "tickling"
annoyed him). **Snapshot: git commit 7246c07, tag `phosphor-v1`** (root
commit of the repo; .gitignore excludes node_modules, body/models, wavs).
**Direction 2 (Afterimage) SHIPPED 2026-08-11**: trailBuf phosphor memory
(destination-out decay 0.16, hard wipe 0.4 every 45 frames, feed 0.45,
ghost composited at 0.55 under crisp present), noise1() pseudo-1/f driving
luminance breathing (±9% @ ~0.1Hz) + wave speed, micro-saccades (gaze
fixations ±3px every 1-4s, ease 0.22, tremor) on iris+slit, `exc`
excitement scalar (~400ms ease) replacing all hard speaking/listening
ternaries. His verdict on 2: "good idea, can be more natural" → OPEN TUNING ITEM:
naturalness of breathing/saccades.
**Direction 3 (Signal Bleed) SHIPPED 2026-08-11, half intensity**:
quarter-res bloomBuf over the eye region ('lighter' @ 0.3 — cannot reach
window bounds by construction), chromatic fringe baked into the white-hot
atlas tier only (±0.7px red/blue), static scanlines clipped inside the
leaf path (destination-out 0.10 every 3rd row). Animated film grain
deliberately SKIPPED — would re-trigger his "tickling" complaint.
All three research directions now live. Awaiting whole-organism verdict.

## Still open

- Future: live-session watching (show his browsing while thinking aloud) —
  spec'd as later opt-in phase. Matrix field (Phase B) quality bar: "really
  really good."
- A3 Show channel, A4 the Call (ring/missed-call sounds — attention tint is
  the silent half of it).
