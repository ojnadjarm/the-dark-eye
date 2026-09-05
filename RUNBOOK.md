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
POST /bridge/speak     {"text","session"?}                  → Eye speaks it (Kokoro) + decode caption; "session"
                                                              = that brain's own registered voice, else Eye default
                                                              (sid 17; pool 11-19 auto-assigned, 17 reserved)
GET  /bridge/listen?timeoutMs=50000&session=deep            → long-poll; {"transcript": "..."|null} — or a body
                                                              event instead: {"transcript":null,"event":"channel-open"
                                                              |"canvas-approved"|"canvas-rejected","detail":"..."}
                                                              (session default "deep"; MCP listen defaults "fast")
POST /bridge/show      {"session","title","kind":"html|image|text","data"} → visual onto the canvas gallery
                                                              (images = data: URL in "data"; body cap ~32MB)
POST /bridge/status    {"id","state":"working|done|error","label"} → colored orbiter around the eye
POST /bridge/cloak     {"on": true|false}                   → hide/show from screen recorders
POST /bridge/attention {"session","on":true|false,"label"}  → eye tints/pulses in that session's color
POST /bridge/active    {"session": "deep"}                  → route Oscar's voice to that session (no announcement)
POST /bridge/register  {"name","color"?,"voice"?,"brief"?}  → join the roster; green refused; a name that is
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
  `powershell.exe -NoProfile -Command 'Stop-Process -Name electron -Force -ErrorAction SilentlyContinue; Start-Sleep 1; Set-Location C:\Users\Oscar\projects\the-dark-eye\body; Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "." -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\dark-eye-body.log" -RedirectStandardError "$env:TEMP\dark-eye-body.err.log"'`
  Boot self-test: set env `DARK_EYE_SAY="text"` → speaks at launch.
  Console (timestamped) lands in the redirect files — from WSL:
  `/mnt/c/Users/Oscar/AppData/Local/Temp/dark-eye-body.log`. NOTE: the
  powershell.exe call may not return once redirects are used (child holds
  the console) — run it in the background and poll the bridge instead.
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
8. **Every MCP tool defaults session to "fast"** — a brain that speaks
   without passing its name gets its words parked as FAST's held-words
   notification whenever fast isn't active ("who is talking through the
   other channel?" bug, 2026-08-11). Worse: a Claude Code MCP client can
   hold a STALE cached speak schema from before the `session` param
   existed, making it impossible to sign. `eye.sh speak --as <name>` is
   deterministic — deep brains should prefer the HTTP bridge for speech.
9. **Dock marks must sit inside the click-capture zone.** The eye window is
   click-through; capture armed only over the eye-corner zone (x>48,
   y>240), but call/show marks dock at the LEFT edge (x 12-40, stacking
   upward) — every notification mark was unclickable, clicks fell through
   to the window beneath. Fix: capture also arms within a 12px halo of any
   markRect (eye/index.html mousemove).

## Deaf channels (2026-08-11 eve)

A brain session (deep etc.) is only alive while its Claude Code process
runs — if that process exits/crashes/backgrounds, its listen-loop monitor
dies with it and the session goes deaf while the tray may still show it
for up to 90s. His words are NOT lost: they queue on the session's bus
and deliver when a listener returns. Shipped so silence can't lie to him:
`hub.isConnected(name)` + the Eye now SAYS "<name> is not listening —
I'm holding your words" when he voices into a dead channel (30s throttle;
legal — he spoke first); canvas chat/paste show a parked note; "switch
to <name>" announces deafness too. Recovery ritual: reopen the session,
`/eye` (or ask it to reconnect) re-arms the ear and the backlog flows in.
The always-on responder is the FAST brain (SDK daemon) — deep is
by-nature office-hours.

**Necromancer status (2026-08-11 close, be honest here):** wake.sh +
mind-storage BUILT (by the ghost session, his voice approval claimed in
wake.sh header) but NEVER FIRED in the live drill — no ~/.dark-eye-wake.log,
no "necromancer:" body-log line; Oscar revived deep by reopening the
terminal himself ("that part needs to be worked"). Debug leads for next
session, from the body log: (1) `eye.sh introduce <name>` sends the
CALLER's $CLAUDE_CODE_MESSAGING_SOCKET/session-id — introducing ANOTHER
session's name poisons its wake identity (19:41:27 ghost introduced
"deep"); introduce must refuse or the hub must verify. (2) A dead session
still counts isConnected for up to ~90s (in-flight 50s poll + lastSeen
window) — at 19:45:38 the body picked corpse-deep as relay for deaf-ghost
instead of necromancing ("wake requested: deep → ghost"); liveness needs
a stronger signal before choosing relay vs necromancer. (3) The
Windows→wsl.exe spawn path of wake.sh is entirely unproven. Wake throttle:
one per session per 120s.

**The switchboard (same eve):** a sleeping session CAN be woken — harness
message delivery resumes a backgrounded/interrupted session (proven:
Channels can't do this, direct UDS wire is undocumented, but a live
session's SendMessage does it cleanly). Wiring: `eye.sh register` now
sends the session's `$CLAUDE_CODE_MESSAGING_SOCKET` (raw path; harness
exports it to Bash) and the hub stores it per session. When Oscar's words
land on a deaf ACTIVE session and some other session is connected, the
body pushes `EVENT: wake-session — <name>|<sock>` to the first connected
session (usually deep) instead of only warning; that session SendMessages
`uds:<sock>` with re-arm instructions (SKILL.md has the exact contract,
both roles). Words never ride the relay — they stay parked on the
sleeper's bus (single source of truth, no duplicates); the wake message
only says "re-arm your ear". Edges: a session's OWN re-register is
refused while its monitor is live (the anti-steal guard), so deep
usually has no sock stored — fine, deep is the switchboard, not the
sleeper; if ALL sessions are deaf there is no relay and the Eye falls
back to the plain "not listening" warning.
PROVEN BOTH DIRECTIONS (2026-08-11 eve): dormant ghost woken by deep's
relay message and answered Oscar's parked words aloud; then Oscar
interrupted deep itself and ghost woke it back the same way. Lessons now
canonical in SKILL.md: drain-before-arm (one-shot listens, answer aloud,
THEN arm the loop — first-breath answers, no poller race) and socks go
STALE on every Claude process restart — wake falls back to ListAgents by
name; recovered sessions refresh their address via `eye.sh introduce`
(introduce always sends the current sock; register's liveness guard
doesn't apply to it).

**Tier 2 — the necromancer (2026-08-11, late eve; his directive "I should
be able to just talk to you and you should wake up", approved manually
after the auto-mode classifier rightly demanded a human decision):** when
NO live session can relay, the Eye wakes the sleeper ITSELF.
`register`/`introduce` also send `$CLAUDE_CODE_SESSION_ID`, stored as the
session's `mind`; body with no relay spawns `wsl.exe -e bridge/wake.sh
<name> <mind>` (detached), which runs `claude -p "<wake prompt>" --resume
<mind> --allowedTools "Bash(eye.sh:*)"` — ONE headless turn: drain parked
words via one-shot listens, answer aloud as itself, keep listening until
3 empty 30s polls, then `introduce <name> 'resting'` and end. CLI facts:
prompt MUST precede --resume (after it → "no deferred tool marker"
error); resume keeps the SAME session id (validated on a throwaway).
Wake log: WSL `~/.dark-eye-wake.log`. Throttles: 120s/session spawn gate
in body + 30s deaf-notice gate; while the headless turn polls, the
session reads connected so no double-wake. Cost honesty: each cold wake
replays the transcript against his plan quota. Known edge: resuming a
conversation whose interactive process is ALIVE but ear-dead may fork
weirdly — untested; the wake hierarchy prefers relay exactly to avoid
it. "switch to <sleeper>" also fires the wake immediately.

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

## Canvas + call waiting (2026-08-11, designed by his voice, shipped)

His two laws, verbatim intent: several agents wanting him must **queue**
("put them on wait until I change the channel"), and a visual must **never
interrupt his screen** ("I'm watching my video... it's going to be approved
manually").

1. **Call waiting** — `attention on` now joins an ordered hold queue
   (main.js `waiting`). The FRONT caller gets the shipped eye-tint look;
   everyone behind renders as square badges docked left of the eye
   (+ a "⟨name⟩ waiting" whisper on arrival). Switching to a held
   session (voice or tray) dequeues it, speaks the held reason, and pushes
   `{event:"channel-open",detail:why}` onto that session's bus so the agent
   knows to re-ask. Voice: "who's waiting" → spoken list of calls + canvas.
   **The mouth belongs to the active channel (his law: "wait, always"):**
   a background session's speak renders NOTHING — no voice, no caption. The
   words are parked (last 5 per session), the session auto-joins the hold
   queue ("words on hold"), and they play in ITS voice the moment he opens
   that channel. Per-session voices: registry assigns unique Kokoro sids
   (pool 11-19; 17 = the Eye's/deep's, refused to others; `--voice` to pick).
2. **The canvas** — a hidden frameless dark window (`src/canvas/`), cloaks
   with the Eye. Sessions push visuals: `eye.sh show <name> <title> <file|->`
   (html/image/text; images ride as data: URLs) or MCP tool `show` →
   gallery (max 12, oldest dropped, logged). NEVER opens by itself: pending
   items = framed dock marks + whisper. He opens with **"show me" / "open
   canvas"** (full-utterance match only, so dictation passes through) or
   tray "Canvas — N waiting". Approve / Reject buttons return
   `{event:"canvas-approved|rejected",detail:title}` to the owner's bus;
   Later/✕ just hides, items stay. One exception to manual-open: content
   from the ACTIVE session renders directly if the canvas is ALREADY
   visible (he's looking at it — not an interruption).
3. **Bus events** — buses now carry strings (transcripts) or event objects;
   bridge listen returns `{"event":...,"detail":...}`, MCP listen renders
   `[event: ...]`, `eye.sh` emits `EVENT:` lines (VOICE: unchanged).
   `bridge/SKILL.md` updated + reinstalled (channel-open = "speak your held
   question now"; canvas verdicts = act on them).
4. **The chat bar + image inbox** (his ask: type links, paste screenshots) —
   the canvas window carries a bottom input: typed text → active session's
   bus as a normal transcript (gold heard-echo on the eye); Ctrl+V with an
   image on the clipboard (read-on-gesture only, never watched) → PNG saved
   to repo `inbox/` (gitignored) → active session gets
   `{event:"image",detail:"/mnt/c/..."}` and Reads the file itself.
   "open canvas" now works with an empty gallery — the chat is reason enough.
5. **Per-session chat memory** (his ask, 2026-08-11: "the session keeps the
   text, not the voice") — every session has a persistent text log shown in
   the canvas middle when no visual is up, following the active channel.
   Recorded: his typed chat, pasted-image markers, his verdicts, and the
   session's written notifications (attention labels, introduce briefs,
   show titles). NEVER recorded: voice — transcripts and spoken replies
   stay out by design. Storage: `%APPDATA%\dark-eye\chat\<session>.jsonl`,
   append-only, last 500 entries loaded (file compacted on load). Delete a
   file to wipe that session's memory.

## Technical debt (parked by him, 2026-08-11)

- **The double-click ghost** — FOUR stacked causes, unpicked one per round
  via the timestamped body log (2026-08-11 eve):
  1. Dock marks sat outside the click-capture zone (hard-won fact 9) —
     notification clicks fell through entirely. FIXED (capture halo).
  2. `'click'` only synthesizes if mousedown AND mouseup both survive a
     capture flip — dock actions now fire on `'mousedown'` (button 0), so
     the first press counts. Boot also primes the input path once
     (ignoreMouseEvents off→on). FIXED — one click switches channels.
  3. The chat sigil was the dock's only TOGGLE, and the ghost had trained
     him to double-click — reflex second click shut what the first opened.
     Law extracted: every dock action must be idempotent. The sigil now
     only opens; closing is the ✕, "later", or "close canvas" by voice.
  4. The residue: with input healthy and openCanvas running on click one
     (log-proved), the CANVAS's first-ever .show() doesn't display — a
     hidden-born, never-painted window's first show drops on Windows
     (explains why lazy-creation also failed years... rounds ago). Fix:
     invisible opacity-0 show at boot forces the first composite, plus
     moveTop()+focus() on every present. CONFIRMED by him: one click,
     2026-08-11 eve. Ghost dead. (Renderer capture/mousedown debug lines
     can be trimmed whenever; they only reach the temp log.)

## Still open

- Future: live-session watching (show his browsing while thinking aloud) —
  spec'd as later opt-in phase. Matrix field (Phase B) quality bar: "really
  really good."
- A3 Show channel (Snap/Paste/Drop capture gestures — the Oscar→Eye
  direction; the canvas above is the Eye→Oscar direction), A4 the Call
  ring/missed-call sounds (the hold queue is now its silent half).

## The Field (standalone app)

**Forms:** eye · figure (Mage.glb, KayKit CC0, "Spellcasting" 0.8x) · hound
(Fox "Survey") · ghost · wave · **murmur** — deep's own avatar, built by deep
2026-08-19: parametric starling flock (per-particle orbits around a wandering
attractor, coherence pulse banks the cloud into ribbons; O(n), targets-based
so the stagger swoops it). `eye.sh field shift murmur`.

**Avatar brightness — HIS CONFIRMED VALUES (2026-08-19, two dim passes):**
shifter body alpha `0.10 + rand*0.10`, bright accents `0.35`. Bloom stays
0.55/0.4/0.32 (world glow untouched). Morph transitions confirmed loved —
do not "improve" the stagger without his ask.
 — spec B v4, shipped 2026-08-19

The Field is its OWN application at `field/` — the body carries ZERO field
code (his call after the MVP: "clean the Eye"). Real engine: three.js (real
pnpm dependency) with EffectComposer + UnrealBloomPass, fog, shader ground
grid, glyph-atlas point shader. Forms are TRUE 3D: real glTF meshes
surface-sampled (MeshSurfaceSampler, 9000 particles) into glyph bodies —
hound = Fox.glb (CC-BY 4.0, Khronos), figure = Mage.glb (CC0, KayKit
Adventurers — Oscar loved it live 2026-08-19;
attribution in `field/assets/LICENSES.md`); eye/ghost are procedural
volumes, wave is a live sheet. Survives orbiting from any angle
(screenshot-verified: fox reads side-on, top-down, 3/4).

- **Start** (WSL): `cd ~/projects/the-dark-eye/field && node server.js`
  (or `pnpm start`). Port **8643**, binds 127.0.0.1 only; Windows browsers
  reach it via WSL2 localhost forwarding. Stop: Ctrl+C / kill the node.
  Runs with or without the Eye — two clients of the same agents.
- **Auth**: own secret in `field/.key` (gitignored, not the Eye's). Page +
  SSE take `?key=`; `POST /op` takes header `x-field-key`. Timing-safe,
  fail-closed. `/vendor/*` (three from node_modules) and `/assets/*.glb`
  are served keyless ON PURPOSE: three's files import each other by
  relative path, which drops query strings — the trap that forced the MVP
  to vendor an ancient single-file build. Public library + CC models,
  loopback-only bind.
- **Open it**: `eye.sh field url` prints `http://localhost:8643/?key=...` —
  open it YOURSELF. The law holds: empty field = grid + rain + idle eye;
  nothing appears unasked; dissolve is always gold (lingers ~1.5s).
- **eye.sh verbs** (unchanged names, now pointed at :8643):
  `field shift <eye|figure|hound|ghost|wave>` ·
  `field board <waves|lissajous|bars|off>` · `field conjure <cube|torus|off>`
  · `field dismiss` · `field url`. Dies with a start hint when the server
  is down. Server validates too, HTTP 200 `{"error":...}` (register's
  pattern).
- **Protocol**: `GET /events` = SSE, snapshot-on-connect + live ops, 25s
  heartbeat, EventSource self-heals. `POST /op` `{"op":"shift|board|
  conjure|dismiss", ...}` ("verb" accepted as alias). State is in-memory —
  server restart = empty field, by design.
- **Debug hooks** on the page (for Playwright/drivers): `__cam(yaw,pitch,
  dist)` orbits deterministically, `__pause(true|false)` freezes the sim
  for still captures, `__ready` = both meshes loaded.
- **Scene-state probe** (2026-08-23): `await window.__SCENE_STATE__()` =
  the agent's proprioception — form/pendingForm, exact particle + accent
  counts, bbox, centroid, camera (pos/target/fov/distToForm/NDC = what the
  user sees), board/conjured, viewport, and MEASURED motion (96 particles
  tracked over a real ~320ms window → meanDrift/maxDrift; "is it moving"
  is a measurement, not a guess). Read-only, additive, zero visual change.
  Recipe for agents: navigate with key → screenshot (hide `body > *`
  except CANVAS first — the HUD prints form/board and leaks ground truth)
  → `evaluate(__SCENE_STATE__())`. Validated 2026-08-23 by two 3-subject
  blind tests (moving scene + `__pause(true)` frozen twin): vision-only
  14/20 and answered "animating? yes" to BOTH scenes (constant answer,
  zero information); state and vision+state 20/20, motion measured both
  times. Test 3 (broken deploy vs false spec, 4 planted defects): probe
  conditions caught 4/4 defects + passed both healthy items, zero false
  alarms (state-only even computed the frustum check from raw numbers);
  vision-only caught 3/4 but could not decide animation or counts at all
  — honest abstention, not false-pass, BECAUSE the prompt offered
  UNVERIFIABLE and penalized false-pass (forced yes/no had produced the
  confident wrong answer — always offer "cannot verify" in verification
  prompts). Full writeup: ~/assitents/research/visual-llms/probe-test/
  README.md. The
  grid minor cell = 60 world units; stating that in a prompt makes vision
  estimates roughly metric (Scaffold/3DAxisPrompt effect, reproduced).
- **Spatial reference** (2026-08-23, his call — "agents need their own
  camera, different from the user's, plus the user's view, plus real
  sizes/positions"). Three channels, all additive in index.html:
  (1) `__SCENE_STATE__().world` + `.landmarks` — the world atlas: wu
  units, +Y up, origin grid-center, cells 60/300, ground 4200, fog
  700→1800, rain r150-770, board pos (-178,96,-36) yaw 0.55 size
  ~218×126, conjured pos (168,64,-26).
  (2) `__AGENT_VIEW__({yaw,pitch,dist | pos, target, fov, w, h,
  overlay})` — the agent's OWN movable camera: offscreen render via the
  main renderer to a RenderTarget (user canvas untouched), returns
  {image: PNG dataURL, camera, size}; overlay (default on) draws
  XYZ axes, landmark dots ("avatar:figure", "board:waves"), and a pose
  footer INTO THE AGENT'S IMAGE ONLY. `preset:"top", span` = ortho map,
  north = -Z up the image — relations become 2D reading. NOTE: raw
  render = no bloom, darker than the user's view; fine for analysis.
  Driver trick to save the PNG without dumping base64 into context:
  stash dataURL in a window var, inject <img>, element-screenshot it,
  remove. Samples: ~/assitents/research/visual-llms/probe-test/
  agent-view-{perspective,top}.png.
  (3) the user's perspective = probe `camera` + page screenshot.
- **Field voice + free summons + board TV** (2026-08-23 night, his voice
  asks, all LIVE-tested with him at the desk):
  - `field summon <name> <geo.json|->` — ARBITRARY wireframe: JSON
    `{"v":[[x,y,z]…],"e":[[a,b]…]}` (≤500 v, ≤340 e, local to conjure
    anchor (168,64,-26)); registers into SHAPES client-side, rides the
    whole conjure pipeline (glyph riders, gold dissolve, snapshot
    rebuild). First summon: a DNA double helix generated on the fly.
  - `field say <text…>` — the field page ITSELF speaks (browser TTS,
    pitch 0.8) + captions. No Eye involved — the Field is its own app.
  - **"Wait, always" reaches the field** (his catch, live: "you are
    interrupting me"): while the mic is live, `say` TTS QUEUES and plays
    only after he finishes (flushed in micStop). Agent etiquette on top:
    ONE voice channel at a time (when he's in the field, the Eye is
    ears-only — no Kokoro), no scripted narration chains with sleeps
    that can land while he's talking; visuals first, one short say,
    then wait.
  - **field mic**: `voice ●` button in the bottom bar → browser speech
    recognition (en-US, one utterance per press) → `{op:"voice",text}`
    broadcast on SSE. Agents listen with a Monitor:
    `curl -sN "localhost:8643/events?key=…" | grep --line-buffered
    '"op":"voice"'`. Proven live — his first in-field sentence arrived
    mid-build. NOTE: Chrome's recognizer sends audio to Google — the one
    non-local piece; flag if he asks about privacy.
  - `field tv <image.svg|-> [title…]` — the board becomes a TV: any
    svg/png/jpg/webp as base64 data URL (≤60KB — SVG fits easily; the
    64KB server body cap is the real limit). Glyph modes and TV share
    the panel (mutually exclusive); dismiss clears both. First
    broadcast: a Sub-Saharan-Africa poverty chart hand-written as SVG,
    honestly labeled "from model memory — no live data feed yet".
  - **Multi-summon** (his ask, same night: "several things at once —
    build around all"): `state.summons` = named registry, up to 12 forms
    live, ≤1600 edges total, vertices in WORLD coordinates (the old
    single-slot anchor-local scheme is gone). Each summon = own group
    (wireframe + glyph riders, conjure aesthetics) with independent gold
    dissolve; `field unsummon <name>` releases one, dismiss releases
    all. HUD state line shows `summons N`.
  - **Ghost-fly** (his correction, live): W follows the full 3D look
    vector ("like a ghost — if I look at the bottom and press W I go
    there"), S reverse, A/D strafe, Shift sprint, floor clamp y≥4, NO
    Q/E (rejected), typing in the console never moves, his keys cancel
    look glides. Camera law upstream: autoRotate is DEAD.
  - **Video on the TV** (his ask: "if it's only images it doesn't make
    sense"): `POST /media` (key-gated, ≤30MB, video/webm|video/mp4,
    name = content hash) → served keyless from field/media/ (loopback
    rationale); `field tv <file.webm|.mp4> [title]` uploads then sends
    `{op:"tv", media:"/media/…"}`; page plays it as a THREE.VideoTexture
    over a muted looping <video> pinned into the DOM at 2px/α0.02 (since
    the 2026-08-23 freeze night — see the frozen-board autopsy below). First
    broadcast: an ffmpeg lavfi Mandelbrot zoom (ffmpeg 6.1 IS installed
    in WSL). Video stops + frees on replace/off/dismiss.
  - Server ops final: shift, board, conjure, dismiss, summon, unsummon,
    say, voice, tv, look. summons + tv ride the snapshot so late pages
    rebuild everything. Op replies are slim (names, no geometry).
  - GOTCHA (cost 3 restarts): `pkill -f "server.js"` inside a compound
    Bash call kills the command's own chain (exit 144) and `nohup …&`
    from dying shells is unreliable — start the field server as a
    harness background task (run_in_background) instead.
- **Living forms** (2026-08-19): hound/figure animate via an INVISIBLE
  SkinnedMesh — an AnimationMixer runs the .glb's own clip, and bind-pose
  surface samples (skin weights from the barycentric-dominant vertex) are
  bone-transformed every frame into the particles' TARGETS; the staggered
  lerp chases them, so the loved morph feel is untouched. Rigs may be
  MULTI-mesh: several SkinnedMeshes on one skeleton + rigid accessories
  riding bones via `attach` regex (hat, cape; `attachDamp` dims them —
  flat brims flare additively). Clips: Fox "Survey" @1.0x (idle
  sniff-around), Mage "Spellcasting" @0.8x damp 0.85 attachDamp 0.6 —
  replaced "Idle" @0.55x 2026-08-23, his call ("idle hard to see even for
  a Human"; probe measured it: Idle meanDrift 0.054 vs hound ~2.5 — the
  breathing clip was ~50× stiller than the fox; Spellcasting sustains
  maxDrift 2.7–3.3, a continuous arm-channel loop, no quiet phase; tune
  knobs live in the armModel call ~line 1220). Original Idle history:
  real standing idle, replaced CesiumMan's treadmill walk 2026-08-19,
  wand/staff/spellbook props excluded. New driver
  hook: `__formBBox()`. Eye (redesigned 2026-08-19) = glyph-woven
  sclera SPHERE + gaze-driven iris (fibers, counter-rotating rings, bright
  rim around a void slit pupil; saccade-then-hold wander) + REAL blink:
  two lid shells sweep over the ball (bright lash edge, covered geometry
  alpha-dimmed) + 3 precessing orbit rings + mote drift; hooks __blink /
  __gaze(y,p) / __gazeFree; eye update ≈0.32 ms/frame. Ghost = animated
  hem ripple + the old bob; wave already dynamic. CPU skinning ≈0.26 ms/frame for 9k pts; prefers-reduced-
  motion disables idle life.
- Gotchas: glyph atlas uses MS Gothic (Consolas has no katakana). Additive
  particles saturate white FAST — form readability lives in per-particle
  alpha/amp damping + bloom threshold 0.32/strength 0.55, tuned by
  screenshots; compact meshes (figure) need extra damp vs spread ones
  (fox). `/favicon.ico` 404s in console — harmless.
- **Body is field-free** (verified 2026-08-19): `/field*` returns 404 even
  with the header key, `body/vendor/` deleted, `body/src/field.js` gone,
  bridge + voice + canvas unharmed after restart.

## Etiquette additions (2026-08-23 night, his laws by field voice)

- **Acknowledge before acting:** on every voice request, the agent speaks
  ONE line first — what it heard + what it is about to do — and only then
  starts working. Composes with wait-always and one-mouth.
- **Live mic caption wraps:** `#caption` is a bounded paragraph now
  (max-width min(78vw, 940px), grows upward from bottom:74px); the live
  `⟨ you: … ⟩` caption shows the newest ~300 chars so a monologue's tail
  stays on screen. Was a single nowrap line running off both edges.
- **Space = mic toggle** (his ask, same night): space opens the mic /
  sends, same path as the voice button (which still works); guarded so
  typing in `#cmd` never toggles, `e.repeat` ignored, focused buttons
  blurred so space can't double-fire them. Header hint updated.

## Frozen-board autopsy (2026-08-23 night)

Symptom: board videos frozen on ONE frame on Oscar's Windows (Edge AND
Chrome) while every metric read healthy — `currentTime` advancing,
`readyState 4`, decoder producing frames, page rendering. WSL Chromium
played the same files fine. It had worked earlier while the Eye overlay
was open; first freeze came right after he closed it (an always-on-top
window overlapping the browser changes the DWM/overlay-plane path — the
strongest hint it was GPU presentation, not code).

Dead ends tried live (each partly real, none the kill): detached-video
pruning (fix kept: video pinned in DOM at 2px), stale cached page (fix
kept: `Cache-Control: no-cache` on `/`), autoplay refusal (fix kept:
tvKick retries), several field tabs shadowing each other (real mess —
close all, open one), Edge marking his in-use window `hidden:true` and
throttling rAF to ~8 fps (real, still unexplained, survived by design
below), AMD-driver panic (half right).

ROOT CAUSE (confirmed live by Oscar, 22:2x): his AMD card's HARDWARE
VIDEO DECODER wedged mid-evening (best theory: ~12 field tabs each
looping reels into it exhausted decode sessions). From then on EVERY
hw-decodable stream — in Edge AND Chrome, they share the D3D11/driver
path — froze on one frame; beats even showed `currentTime` stuck near 0
with `paused:false, ready:4`. WSL Chromium software-decodes, so the same
files played fine here — that asymmetry was the fog all night.

THE FIX (proven with a ticking-clock testsrc he watched count): encode
board reels as **H.264 High 4:4:4 (`-pix_fmt yuv444p -profile:v high444`)**
— no GPU anywhere hw-decodes 4:4:4, so browsers fall back to their
software decoder, immune to the wedged card. Shipped in three layers:
all four media/ files re-encoded in place (originals in that session's
scratchpad `media-orig/`), `eye.sh field tv` now auto-transcodes any
non-444 video before upload (ffprobe check + ffmpeg, warns and uploads
as-is only if transcode fails), and a reboot will likely heal the card
itself but nothing depends on it now.

Belt-and-braces kept in the page (shipped same night, useful anyway):
board texture is a CanvasTexture fed by `ctx.drawImage(video)` every rAF
(NOT THREE.VideoTexture — set `generateMipmaps=false, minFilter=Linear`
or the board goes blurry, his call) plus a 300 ms setInterval starvation
fallback that keeps drawing when rAF is throttled (timers survive
`hidden`, rAF doesn't) — worst case a slideshow, never a corpse. Beat now
reports `tv.draw` = ms since last board draw (server passthrough added;
needs a server restart to appear in `/beats`).

Cache trap discovered right after (his catch — pendulum still frozen):
`/media/*` is served `max-age=3600` and files are hash-NAMED, so the
browser treats them as immutable — NEVER rewrite a media file in place
under its old name (the re-encoded pendulum kept serving stale cached
broken-flavor bytes from his browser). New content → re-upload → the
server's content hash mints a new name → cache busted for free.

Final twist (his catch again — pendulum still dead after ALL of the
above): `fc54b73f` ("three pendulums") was BORN FROZEN — the generating
agent wrote the finished trail picture into all 720 frames, a 24 s film
of one image (frame-extract md5s proved it: two distinct stills total).
TWO independent freezes were entangled all night: the wedged hw decoder
(froze every real video) AND one content-static file (immune to every
player fix). Replacement: scratchpad `pendulums.py` → real RK4 double
pendulums piped raw into ffmpeg 4:4:4, live as `443432fb67501e57.mp4`.
LESSON: before debugging playback, frame-extract the FILE at several
timestamps and md5 — verify the film itself moves. And verify generated
media before showing it.

Debug rig that cracked it: `/beats` (per-page heartbeats), pushing an
ffmpeg `testsrc` clip as a known-good control, and position-WEIGHTED
pixel hashes — a plain pixel SUM is rotation-invariant, so a radar-sweep
video hashed "frozen" while it was actually spinning (cost one false
smoking-gun). Verify frames move with `s = s*31 + px` style hashes, never
sums. Media files themselves were innocent (all four probed: sane PTS,
normal B-frame reorder, distinct frames on disk).
