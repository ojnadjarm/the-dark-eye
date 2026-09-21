# The Dark Eye — Runbook

Ops truth for this laptop. Architecture and setup: `README.md`.

## Start / stop / logs

```bash
systemctl --user start|stop|restart dark-eye     # the body (overlay + voice + bridge)
systemctl --user status dark-eye
journalctl --user -u dark-eye -f                 # live log
journalctl --user -u dark-eye -n 50 --no-pager   # "bridge on", "eye up", "voice ready"
eye health                                       # {"ok":true,"brainListening":..,"micOpen":..,"held":..,"mode":..}
```

The unit is `body/dark-eye.service`, symlinked into `~/.config/systemd/user/`
by `bridge/install.sh` and enabled `WantedBy=graphical-session.target`, so the
Eye comes back on the screen after every login. `Restart=on-failure`, `RestartSec=5`:
a crash is back within ~10 s, a clean exit (a `systemctl --user stop`) is not.
After 5 failed starts in 5 min (`StartLimitBurst`) systemd gives up instead of
looping forever, and `OnFailure=dark-eye-failed.service` pushes the owner through
`~/agents/bin/notify-owner`. `boot-check.sh` also checks the unit is active.

### The process tree

Since E18 the unit runs **plain node**, and since E19 that is the only path — the
`DARK_EYE_RENDERER` / `DARK_EYE_AUDIO` flags and the Electron eye are gone:

```
dark-eye.service
└─ node body/src/main.js          bridge :8642, queue, intents, display.js, audio.js, gallery
   ├─ fork(src/voice.js)          sherpa-onnx: Kokoro TTS + Parakeet STT (respawn 3 s)
   │                              STT runs on **one** thread: same wall time as four, a tenth
   │                              of the CPU, which is what pays for the partials (E28)
   ├─ spawn(render/target/release/eye-render)   the eye, over the render socket (respawn 3 s)
   │                              one binary, two backends: **GPU (EGL/GL ES) by default**,
   │                              cairo whenever EGL/GL fails — see "GPU backend" below
   ├─ pw-cat -p …                 one per utterance, gone when silent
   ├─ pw-cat -r …                 only from `ptt on` to `ptt off`
   └─ node_modules/.bin/electron src/canvas-app   only while he is looking
```

`electron` is still a dependency of `body/package.json` for that last line and
nothing else: `src/canvas.js` resolves it at `body/node_modules/.bin/electron`
(`PLAN-LOWRES.md` §7.2 is the open decision to drop it for WebKitGTK).

### The render socket

`$XDG_RUNTIME_DIR/dark-eye/render.sock` (override: `DARK_EYE_RENDER_SOCK`). Node
listens, `eye-render` reconnects with a 200 ms → 2 s backoff. One JSON object per line.
One client at a time: a second connection is refused (`render socket: second eye-render refused`), never gets `session`, and does not replace the one already connected.

| Direction | Message | What |
|---|---|---|
| main → render | `session{active,color}` | the brain's name and caption colour |
| main → render | `speak{text,append,ms,who}` | a caption, decoding out of the katakana noise; sent by `audio.js` when that sentence's own audio starts, `append` joining it to the caption already on screen and `ms` pacing the reveal to the voice. `who` is whose words they are: absent or `eye` is the Eye's green, `owner` is his own transcript in the `heard` gold and does **not** put the Eye in its speaking state. A caption is never appended to across voices. His own caption is also sent **while he is still speaking** — see "The caption that grows as he speaks". |
| main → render | `speaking{ms}` | extend the speaking state by `ms` from now (main times the chunks; the eye never hears audio) |
| main → render | `status{id,state,label}` | an orbiter — `working` expires after 10 min, 12 at most; the body re-sends the live set every 4 min and on every `ready` (see "Orbiters") |
| main → render | `ptt{on}` | the mic rings |
| main → render | `heard{text}` | the gold `» heard` line — still parsed and drawn, but the body no longer sends it: since the owner's transcript became a `speak{who:"owner"}` caption the one-line marker was the same text twice |
| main → render | `display{on}` | `false` unmaps the window and arms no timer at all |
| main → render | `marks{items:[{color,kind}],mode}` | the row of small squares under the eye: one per held reply (`kind:"held"`, the brain's colour) and per visual he has not opened (`kind:"show"`, the Eye's green), five at most then a `+`; `mode:"async"` adds a hollow ring at the left — the row means *waiting to play*, not *quiet*. `mode` is the body's own word (`call` \| `async`), not his (`call` \| `notes`); anything else is read as `call`, so a bad value costs the ring and never the row. Sent on every change of the hold queue, the mode or the unopened visuals, and on every `ready`; a static draw, never the busy rate |
| render → main | `ready{x,y,w,h,output,backend}` | the window is up, where, and which backend drew it (`gpu` or `software`) |
| render → main | `outputs[{name,w,h,x,y}]` | on every RandR change — the only display list the body has |
| render → main | `stats{fps,msAvg,msMax}` | every 5 s, only with `DARK_EYE_STATS=1` |

**Rollback of E19**: there is none at runtime — nothing loads what it deleted. To get
the Electron eye back, check out the pre-E19 tree from the owner's git.

Healthy boot log, in order: `display on (…)` → `bridge on 127.0.0.1:8642` → `eye up at X,Y … (gpu)` →
`voice ready — 53 speakers @ 24000Hz, sid 17, asr true` (about 4 s after start;
the models load in the forked voice worker).

If `eye health` says nothing: the body is down — start the unit. If it answers
but there is no voice, look for `voice worker exited` lines (it respawns after
3 s on its own).

## Config — `~/.config/dark-eye/config.json` (mode 600)

| Key | Default | What |
|---|---|---|
| `secret` | generated | shared key, header `x-dark-eye-key`; every brain uses it |
| `port` | 8642 | bridge port, bound to `127.0.0.1` only |
| `voiceSid` | 17 | Kokoro speaker — the Eye's voice |
| `voiceSpeed` | 1.0 | TTS rate |
| `brain` / `brainColor` | `claude` / `#b04dff` | caption identity on the eye |
| `canvasZoom` | 1.5 | canvas scale on the screen |
| `remotePort` | *absent* | set it to 8644 to start the phone listener on `127.0.0.1`; absent = no remote |
| `voiceModelDir` | `kokoro-multi-lang-v1_0` | the Kokoro model directory under `body/models`, overridden by `DARK_EYE_VOICE_MODEL_DIR`. The int8 build `kokoro-int8-multi-lang-v1_0` is downloaded and sits beside it — same 53 speakers, 203 MB less resident, and **2.1× the latency** (EF05), which is why fp32 ships |

Restart the body after editing it.

Two things the voice worker reads from the environment, not from this file:

| Variable | Default | What |
|---|---|---|
| `DARK_EYE_VOICE_MODEL_DIR` | *unset* → `voiceModelDir` | overrides the Kokoro directory for one run |
| `DARK_EYE_VOICE_RSS_MAX_MB` | 1600 | the arena cap: over this **and** no speech, decode or mic for 10 min, the body kills the worker and the 3 s respawn path brings it back, logged `voice worker recycled at N MB`. Speech asked for meanwhile is queued, as after any crash. **0 disables it.** Checked every 5 min (EF05) |

## Security posture

- The bridge binds `127.0.0.1` only — nothing on Wi-Fi, LAN or Tailscale.
- Auth is a timing-safe compare and fail-closed: the server refuses to start
  without a secret; every route is behind the key.
- `eye.sh` hands the secret to curl through a file descriptor, never argv, so
  it never shows in `ps`; `curl -f` plus `die` makes a 401 or a dead body loud.
- Speech content is redacted from the log unless `DARK_EYE_DEBUG=1` is set.
- The eye is `eye-render`: no web engine, no network, one unix socket. The
  canvas window (Electron, on demand) keeps `contextIsolation` on,
  `nodeIntegration` off, `sandbox` on, `webSecurity` on, and renders his HTML
  in a frame with no network.
- Accepted residual: any process of this user can read `config.json` and
  therefore speak through the Eye. The machine is single-user by design.

## Hard-won facts (do not relearn these)

1. **The overlay must be an X11 window** — `eye-render` is an override-redirect
   ARGB window on `:0`, and the canvas runs `electron --ozone-platform=x11`.
   A native Wayland surface cannot be always-on-top, so an overlay is
   impossible. Mutter honours always-on-top, transparency and the X input
   shape (click-through) for XWayland surfaces only.
2. **AppArmor blocks Electron's sandbox helper.**
   `kernel.apparmor_restrict_unprivileged_userns=1` makes Electron fail at
   startup. The fix is the profile `/etc/apparmor.d/dark-eye-electron`
   (`flags=(unconfined) { userns, }` on the `electron` binary), reloaded with
   `apparmor_parser -r`. Never `--no-sandbox` — it disables the renderer jail.
   Only the canvas needs this now.
3. **A click-through surface never gets mouse-move events**, so a hover-to-arm
   interaction cannot work here: any click target must be armed by geometry.
4. **`node` is not on a systemd user unit's PATH** (nvm lives in
   `~/.nvm/versions/node/*/bin`). `ExecStart` sources `~/.nvm/nvm.sh` (never a
   pinned version) and exits 127 with a clear line if `node` is still missing.
   Do not write `$VAR` in `ExecStart`: systemd expands it from the unit
   environment.
5. **Electron moves itself into its own systemd scope**
   (`app-dark-eye-body-<pid>.scope`) a moment after start, which takes its
   stdout out of `journalctl --user -u dark-eye`. Irrelevant to the eye since
   E18 — the unit `exec`s node — but still true of `canvas-app`, and the reason
   `measure.sh` reads the app slice as well as the unit's cgroup.
6. **Electron forbids napi external buffers** — sherpa's `tts.generate` must be
   called with `enableExternalBuffer: false` or it throws. The voice worker is a
   plain `fork` child now, but the flag stays: it costs nothing and the failure
   was silent.
7. **Fonts are load-bearing**: the glyph rain needs a CJK mono face
   (`Noto Sans Mono CJK JP`) and the captions need `DejaVu Sans Mono`. Without
   them the eye renders as boxes.
8. STT returns nothing for clips under ~0.25 s.
9. **D12 — `vaInitialize failed: unknown libva error`** is gone from the body's
   log: it came from Electron's GPU process, and none is resident. The on-demand
   canvas still prints it once per open. Harmless, cosmetic.
10. **The dock path is dead by design** and was not ported to `eye-render`; the
    kept reference page `spec/eye-reference.html` still carries it.
11. **The display list comes from `eye-render`'s RandR outputs**, not from a
    toolkit: `outputs[]` on every `RRScreenChangeNotify`. The screen the eye lives on is the largest
    output, and it is also the canvas's work area. The `eye up at …` line logs
    where the window landed and on which output.

## Earbuds and push-to-talk — `RUNBOOK-earbuds.md`

The Sony WF-1000XM5 (E07), the AVRCP evdev node, the `mpris-proxy` conflict, the
push-to-talk sidecar (E08) and the SCO/HFP traps live in **`RUNBOOK-earbuds.md`**.

## Remote (the page — phone and desktop) — at `remotePort`

`remotePort: 8644` in `config.json` starts a second loopback listener beside the
bridge: the page (`body/src/remote-www/`) and `/remote/*`, nothing else. Absent =
no remote at all. The bridge on 8642 is never exposed; only 8644 is, and only over
Tailscale:

```bash
tailscale serve --bg --https=8644 http://127.0.0.1:8644   # once; Serve, never Funnel
tailscale serve status | grep 8644                        # "(tailnet only)"
```

**`https://moodle-lab.tail2ea32e.ts.net:8644/`** — the cert is Let's Encrypt via
Tailscale and renews itself; the first request after a new port may take ~10 s while
it is issued. Serve proxies from `tailscaled` to loopback, so no ufw rule and no new
bind: `ss -ltnp | grep 8644` must show **127.0.0.1 only**. `/bridge/*` is on 8642 and
simply does not exist on 8644 — from the tailnet it answers 401, never the bridge.

- **Starting from now.** `GET /remote/cursor` (cookie-gated) answers `{"seq": N, "boot": "…"}`
  — the newest reply in the ring, and the name of this life of the body — and `/remote/poll`
  with no `since` starts there, so a reloaded page waits for the next reply instead of replaying
  the 5-minute backlog.
- **A restart under an open page (M20).** The ring counts from 0 again, so every seq a page
  still holds names a reply that is gone: a ▶ pressed on one asked the body for *another*
  reply's words, which the page could not tie to the press, so nothing played and the press
  stayed live — that was the 2026-09-15 defect. `boot` is how the page knows. It keeps the id
  from its login and re-reads `/remote/cursor` **whenever it starts polling again** — the
  reconnect after a poll dies, and the resumption after the tab was in the background, which is
  the case his phone is in almost every time: a hidden tab leaves the poll loop *cleanly*, so
  nothing marks it offline and the first poll on his return would otherwise go out with the dead
  life's `since` and swallow every reply of the new one (M20-fix). Every `/remote/poll` answer
  carries the life that answered it in an `X-Eye-Boot` header, because a restart *between* two
  polls takes an idle socket and nothing else — the next poll simply succeeds against the new
  life, and under load that is what happened — so the page reads the header on every answer and
  re-reads the cursor when it changes; a page whose login read never answered holds no life at
  all and takes the first one it reads, from that life's cursor, instead of leaving restart
  detection off for as long as he keeps the page open. The cursor read is bounded (5 s): the
  poll loop is held while it is made (M21). A different `boot` means the
  transcript belongs to a dead body, so the stale ▶ are dropped — each line giving up its words, which are all that is left of it —
  and the status line says the Eye restarted. Anything the page
  can still play from its own queue keeps its glyph. **The answer that changed the life is read
  before the resync and processed like any other (M21-fix)**: the reply it carries is the one he
  is waiting for, and dropped there it never came back, because the new cursor is already past
  it. For the same reason a restart resumes from the **bottom** of the new life, not from its
  cursor head — what that life has already said and he has not heard is numbered below it. A
  mismatch that neither changes the life nor brings a reply (a cached or unanswered
  `/remote/cursor`) waits 1 s and doubles to 30 s: without that guard the page polled as fast as
  the radio allowed — 3699 polls in 25 s, measured — with the status line looking normal. Every
  JSON lane answers `Cache-Control: no-store`, because one cached cursor answer is a dead life's
  cursor. And `POST /remote/ack` carries the life its reply came from: a tray item kept across a
  restart acks a seq that names *another* reply here, and the body refuses it.
- **His voice takes the page's (M19).** The page has a barge-in of its own now, because the mic
  and the mouth share one audio context: **tapping the eye to talk stops the reply that is
  sounding** — and the one a stopped context left paused mid-word, which opening the mic used to
  resume out loud into it — before the mic opens, and **a reply that lands while a turn is open is
  never played into it** either. What is stopped is not acked: it goes back to the head of the
  tray with its ▶ **pressable again** (a glyph in the tray is by definition unheard — M20's
  idempotence guard used to leave the cut reply's ▶ dead and the reply unreachable, M20-fix; the
  press finds what is waiting there **by its line**, not by its seq, because a replay he asked for
  is played onto that line under a new one — keyed by seq it queued a second copy, M20-fix2) and
  the next press plays it **from the beginning**, the way the room drops the
  remainder of a reply he talks over (`hold.js` — "The mouth waits" below). The audible half was
  the lesser one — `getUserMedia` cancels most of it — and the real damage was silent: the
  resumed voice ran to its end while he was talking, which acked the reply and took its ▶,
  losing a reply he never heard.
  The cost of the fix is one re-listen. While the turn is open the tray is still counted in ▶ on
  the lines, but the status line stays his (*Tap again to send*) and the count comes back when the
  turn closes; an interrupted line also stops unscrambling — its words resolve and wait, instead
  of running out the dead buffer's clock as noise.
- **The Tailscale-only exception.** Everything else on this box listens on the LAN
  address *and* the tailnet; this one does not, by the owner's decision: the phone
  page is reachable over Tailscale and nowhere else, so a device on the house Wi-Fi
  with the key still cannot open it. If the tailnet ever grows past his own devices,
  the tightening step is an ACL `tag:phone → moodle-lab:8644`.
- **Revert.** `tailscale serve --https=8644 off`, drop `remotePort` from
  `config.json`, `systemctl --user restart dark-eye`. The `:8452` (Moodle) and
  `:8499` (netdata) Serve entries are separate — leave them alone.

- **The login.** Open the page, paste the body's `secret` once, press *enter*. The
  key is never stored: it lives in the field for one request and the session is an
  HttpOnly cookie, good for 30 days, and it survives a restart of the body: the
  sessions live in `~/.local/state/dark-eye/remote-sessions.json` (0600, one SHA-256
  of each token → its expiry, never the token itself) — to log every device out,
  delete that file and `systemctl --user restart dark-eye`. Five wrong keys in five
  minutes from one address and even the right key is refused until the window passes.
- **The gesture.** Tap the disc to start, tap it again to send — the earbuds'
  gesture, not a walkie-talkie's. While it records the disc is gold; the page records
  at whatever rate the phone's mic runs, resamples to 16 kHz in an `AudioWorklet` and
  streams raw Int16 PCM as it goes (10 MB cap, ~300 s). His words appear while he is
  still talking — see "The words that grow on the phone". His line lands gold, the
  Eye's violet. On a desktop the mouse works the same way, and
  so does the space bar, one press on and one press off. Nothing is lost if he never
  taps twice: 300 s on the clock stops and sends by itself, and so does a cancelled
  pointer or the mic track ending. The first tap
  is also what unlocks audio playback on iOS — and until something unlocks it, a reply
  that arrives cannot be played, so it carries a ▶ and the press on that glyph is itself
  the gesture that unlocks the context (see "Hearing a reply").
- **Hearing a reply (M12, M17, M20).** A ▶ glyph trails an Eye line **only while something of
  that reply is unheard**, lit in the active channel's colour — so it always reads as a full
  tray, never as anything held back. In **audio notes mode** the glyph *is* the line: a held
  reply arrives with no words at all, held exactly as a call-mode reply waiting for its voice is
  (M20 — the words on the page before he pressed anything were the second half of the
  2026-09-15 defect). What is waiting is the number of glyphs and the count beside them, and
  which channel it came from is their colour; the press starts the words and the voice together,
  the text resolving on the voice's own clock, which is what a live reply has always done. In
  call mode it is normally absent, because the reply plays as it lands; it appears there only when the page **could not** play it — an audio context still
  locked on a phone just opened, where decoding succeeded and nothing was heard (`offer()` is the
  one place that knows this, and is where the glyph is put) — and **every** reply queued behind
  that one is glyphed in the same breath, because the status count is literally the number of ▶
  on the page (`waiting()`): the count can only be true if the presence is complete. One press
  drains that whole queue, each line losing its glyph as it ends; in audio notes mode nothing is
  queued in advance, so there each line is released by its own press. If the context stops
  **mid-word** — the phone taking a call — no `onended` fires, so the paused reply puts its own ▶
  back and the press on it is what resumes it, and a reply that **arrives** while it is stopped
  joins the same tray with its own ▶ and its words shown, rather than being counted as "more
  waiting" behind a voice nothing is sounding. **A reply interrupted once it has started keeps
  the words it was given:** M20 hides a held reply's words until the press, but a reply he barges
  in on (M19) or a context stopped mid-word is past that point — `offer()` re-reveals it, glyph
  and all, so an interrupted line is never left blank or scrambling on a dead buffer's clock.
  A device that cannot open an audio context at all
  says "This device will not play sound" and the ▶ stays pressable for a second try, and the same
  device tapping to **talk** is told the audio will not open, not that the mic was refused.
  So "Ready" is never shown over a line on the page whose reply is unheard — and that is the whole
  claim: a reply spoken while the page was **closed** never appears at all (a cold open starts from
  the newest seq, see "Starting from now"), so there is no line, no ▶ and the status reads "Tap to
  talk". Those are released out loud by "talk to me", which is the design, not a hole in the count.
  The glyph goes the moment
  the reply plays to its end, and the press it answers takes the pressed line's glyph with it.
  While the reply's bytes are still on the ring the glyph plays those same bytes; for one that
  has none — spoken only in the room, or its audio dropped for the byte budget — it posts
  `POST /remote/replay {seq}` and the body answers with the voice it made at park time, or
  **says those words again to the page alone** — the room is never made to repeat itself. `replies.find(seq)` is
  the authority: a seq the ring no longer holds is a 400, and a second press inside a second
  **from the same device** is a 429 — the gap is that device's alone, and a press the ring
  refused never starts it. No new retention, no disk, no bigger ring.
  A replay carries `bypass` into the hold, so **audio notes mode does not swallow it** — this
  is how he hears a reply the mode deliberately did not speak, with the room still silent —
  while his own voice and the 1.5 s after it still hold it back. Since M15-fix a `bypass` item
  waits at the **head** of the queue, so a ▶ he pressed is heard **before** whatever is parked:
  he asked for that one, he gets that one now.
  **The voice is made when the reply is parked (T2, T2-fix).** In audio notes mode the reply is
  already written when it is parked, so its voice is synthesised **then** and the press streams
  bytes that exist: press → first sound measured **129–189 ms** for a 12/40/120-word reply
  (131/497/1481 kB of WAV, load 6.5) against 1.2–12.7 s when the press started the work — a
  **stub-voice** measurement: real byte volumes and the real ring, fetch, decode and playback in
  headless Chromium, but a sine tone where Kokoro's bytes would be. It is the same Kokoro run,
  moved earlier — about 3.4–4.6 core-seconds and 48 kB per spoken second, wasted only on a reply
  he never plays. **Every** parked reply's voice is made, not only the first: the mouth-idle check
  counts what the hold will actually say, and a reply parked for his ▶ is not that (T2-fix; before
  it, parked items blocked the queue, so everything after the first note waited and a 5 s
  re-check timer stayed armed for as long as they did). `eager.js` keeps **one** job in flight,
  submits it only while the mouth is idle, holds the queue while `loadavg[0] > 8`, and its one 5 s
  re-check timer exists only while a job is waiting — measured at 0.0 % of a core both with an
  empty queue and with **three replies parked** (T2-fix). Only the **active** channel's replies
  are made (a channel he is not on never reaches `say()`), the WAV lives on the ring item in
  memory and **never on disk**, and the bytes are bounded: the ring's 20 slots, 4 MB a reply (past
  that nothing is made and the press synthesises) and 12 MB in total, where the audio he has
  **already heard** goes first and then the **oldest unheard** — never the bytes a press is
  fetching right now, and a reply's words, its line and its ▶ always stay. A press republishes
  the bytes it played, so its copy is charged to the budget once, not twice. A press that lands
  *while* the job runs waits on that one run — never a second — and nothing is made eagerly at
  boot: the first press after a restart synthesises.

  **One press, one synthesis (M20).** The glyph goes `disabled` the moment its replay is asked
  for and stays down until those words come back, are refused, or fail to arrive inside
  `WANTED_TTL_MS` (60 s, when it comes back with a line saying so) — so pressing it again, however
  many times, asks the body for nothing more. The status line says *Saying that again* while it
  works. A press on a line whose reply is still in the page's own tray plays **what is waiting
  there** — found by the line, not by the seq (M20-fix2) — never a new synthesis. A press that
  is **refused** (the seq is off the ring) or that misses the TTL gives the line's words back as
  it returns the ▶ — they were hidden for a voice that never came (M20-fix) — and the body's own `REPLAY_GAP_MS` (1 s, per
  device) is not a refusal: two glyphs pressed inside that second get *One moment · ▶ again* and
  the press is **not** consumed, instead of the untrue "that reply cannot be said again".
  **What a replay costs:** a reply whose bytes are on the ring is replayed from them and costs
  nothing. A reply that has aged off the ring, or whose voice was never made, is said again from
  scratch — one more slot on the ring, pushing the oldest reply out sooner.
  It is **not** a second transcript line: the re-synthesised words are played and revealed on
  the line he pressed, because it is the same reply (M20; until then it landed as a new line,
  which is how five presses put five copies of one reply on his page).
  **One tie, and its two holes.** A replay comes back re-synthesised under a **new** seq, so the
  page ties it to the press by its **words** (`wanted` → `claim`, which answers *which press* those
  words are for, so the replay is played and shown on that line). Two consequences, both accepted,
  neither a code fault: an **unasked** reply whose words match a pending press consumes that press,
  so the real replay then lands as its own held reply with its ▶ — he hears the right words, once,
  at the right moment; and if one sentence of a synthesis errors, the replay's joined text is a
  **subset** of what was pressed for and is never claimed, so it lands with its own ▶ and the
  pressed line's glyph comes back at the TTL for another try.
- **The words that grow on the phone (R06).** The page does not wait for the tap to
  send: every second it posts what the worklet has handed it to
  `POST /remote/stream?utt=<id>&seq=<n>` (octet-stream, cookie-gated), and the second
  tap is `POST /remote/audio?utt=<id>` whose body is only the tail — an empty one
  means *finalize what you have*. The body feeds those blocks into **one partial ear
  per utterance** (`src/remote-ear.js` over `src/partials.js`, the same growing-window
  local-agreement ear the on-screen caption uses), and the words it settles ride back on the
  long-poll the page already holds open as `{seq, utt, partial}` items. The page grows
  one gold line, append-only, and the final transcript replaces that same line — never
  a second one. The screen is never engaged for a phone turn, and the local mic path is
  untouched.
  - **The final** is the ear's stitched transcript, with the empty-final fallback: what
    he watched appear is never thrown away. Measured on a 12.9 s clip: **0.76-0.91 s**,
    against 2.2 s for the same clip through the plain whole-clip route.
  - **What it costs.** The ear paces itself to 0.35 of a core exactly as the local one
    does (a decode that took `d` waits `d × (1/0.35 − 1)`); the 12.9 s clip above spent
    4.3 core-seconds of decode, 0.34 of a core. On the phone side it is **one upload a
    second while he talks** and no new polling loop at all — the partials ride the poll
    that is already open, so the radio wakes for words, not for a timer. A block that
    fails keeps its `seq` and goes again; the body appends by number, so a retry or an
    overtaking block never scrambles the clip.
  - **One utterance in flight** per body: a new `utt` closes the one before it, the
    buffer is freed on the final tap, and a stream nobody finalised is dropped after
    **2 minutes** idle. Past the cap the stream route answers 413 and the page stops
    and sends what it has. The cap is one constant, `MAX_SAMPLES` in
    `src/remote-ear.js` (5 M Int16 = 10 MB ≈ 300 s), and `remote.js` takes its
    `AUDIO_MAX` from it — the buffer doubles from 64 K samples, so a turn near the
    cap holds **33.5 MB** of Float32 in the body while it is live, with about
    **50 MB** transient for the moment the last grow copies the old buffer into the
    new one, and nothing after the tap.
  - `journalctl --user -u dark-eye` shows a `partial (Nms)` line per decode and then
    one `remote audio:` + `heard (Nms)` pair, as a mic turn does.
- **A turn survives a tab switch (M11).** The page no longer ends the turn when it
  goes hidden — that line was ours, not the browser's. While it records, the tab
  itself says `● listening` with a gold iris in the favicon, so a turn he walked away
  from is visible in the tab strip; both revert when the turn ends. The upload is
  counted off the worklet (one post per 32 blocks ≈ 1 s), never a `setInterval`, so
  background timer throttling cannot slow it, and the reply poll stays open while the
  tab is hidden, a turn is in flight or a reply is still coming. What each surface
  really does:

  | Surface | A hidden tab / a backgrounded app |
  |---|---|
  | Desktop Chrome, Firefox | keeps capturing; a live mic track is exempt from freezing |
  | A browser window merely covered (Linux) | never *was* hidden — no occlusion tracking on X11/Wayland |
  | Chrome Android | keeps capturing, with its own mic notification in the shade |
  | iPhone Safari | the platform **mutes** the track; the page says so and resumes on return |
  | The buds (`dark-eye-ptt`) | do not care at all — they never touch the page |

  On the iPhone's `mute` the page stops posting, keeps the same `utt` and shows *Mic
  paused by the phone*; `unmute` resumes on the same turn. A mute is given 90 s —
  `MUTE_MAX_MS = EAR_IDLE_MS - MUTE_GRACE_MS` on the page, 30 s inside the body's
  2-minute idle window — and then the turn ends with everything that was streamed and
  says so ("the mic stayed paused too long"; nothing the page shows him says *mute*). The two must never be equal: at 120 s the body would drop the buffer first
  and only the tail would be transcribed.
- **Keep visible (M11, desktop).** Where the browser has Document
  Picture-in-Picture (Chrome 116+; **not** the Firefox 154 on this machine, so the
  glyph does not appear there) one small glyph in the page's top-right corner moves the eye,
  its caption and the disc into a small
  always-on-top window, and the page's own animation frames move with them; it lights
  in the active channel's colour while that window is open, and closing it puts them
  back. The glyph itself stays in the tab — it is the handle on that window, not part of it. The mic, the worklet and the poll never move — they stay in the
  tab and do not care. Where the API is absent the button is simply not shown.
- **It is a plain web page.** Open it in the browser (on iOS, Safari); there is no
  PWA, no manifest and nothing to install — by his call (M11), the tab is enough.
- **The caption: two words, and nothing that reads as blocking (M17, was the chips, M04).**
  Under the eye, set like a caption of it rather than a control: **the channel** in its own
  colour, then **the mode** in his own words — `call` or `audio notes`. No pill, no border, no
  fill; the mode word is lit while it is audio notes and carries a **hairline underline** —
  the one quiet cue that it is his to tap, since it is the only setting he can change without
  his voice and `:hover` says nothing on a phone. Every ▶ keeps a 44 px touch target around
  its 22x18 picture. Nothing on the page claims to block
  anything: there is no mute glyph, no crossed speaker and no *mute*/*silenced*/*suppressed*
  in any label, title or status line (a test on the served page pins that, and pins the two
  mode words). The only remaining `mute` in the source is the phone's own
  `MediaStreamTrack` event and the internal clock named after it — his microphone, not the Eye's
  mouth.
  - **The channel word** — `POST /remote/active {brain}` (cookie-gated; the answer is the
    roster, 400 for an unknown name). With two channels the word **switches**; with three or
    more it blooms the roster upward out of the eye's glow as a plain list (`Escape` closes it).
    On a desktop `1`..`9` still pick one. The active channel's colour is the accent: the iris,
    the caption word and every ▶.
  - **The mode word** — `POST /remote/mode {mode}` with **his** word, `call` or `notes`;
    `GET /remote/mode` reads it. The body's own `async` is a **400** here, so the render
    socket's word can never come back through the page; `main.js` converts at the boundary
    (`onMode: toWire(setMode(fromWire(m)))`). One global setting of the Eye, never per channel:
    **a channel switch never moves it**, and the page posts nothing when the body pushes one.
  - **One lane for both.** The page reads the roster and the mode once at login
    (`GET /remote/brains`, `GET /remote/mode`); every later change — his voice, `eye mode`,
    `eye talk-to`, another phone — rides the long-poll already open as a
    `{seq, brains, active, mode}` item, so there is **no new polling loop**. `main.js` publishes
    it with `replies.brains({...roster, mode: toWire(mode.mode)})` from both `setActive` and
    `setMode`.
  - **In audio notes mode** a reply never plays on arrival; it lands with its ▶ and is not
    acked until he plays it, and the status line counts what is there (`3 waiting · ▶ to play`).
    In call mode a reply plays as it lands, exactly as before.
  - **A 401 ends the turn (M17).** A refused `/remote/stream` mid-flush used to disable the
    talk control while leaving the turn open, so after logging back in the disc did nothing
    until a reload. `locked()` now drops the turn like a timed-out pause does — the mic off,
    the tail discarded, the growing line removed — so his next tap opens a new one.
- **The `--to` rule.** `eye speak <text>` goes back to wherever he last spoke from,
  so a question asked from the phone is answered on the phone by itself. Force it
  with `--to remote` (phone only), `--to local` (the buds/screen) or `--to both`. A
  remote transcript reaches a brain as `VOICE [remote]: …`.
- **Long utterances arrive in pieces.** Claude Code's Monitor keeps at most 500
  chars of one stdout line and drops the rest as `...(truncated)` (measured
  2026-09-14: 500 intact, 550 cut). So `eye listen` / `eye listen-loop` print a
  transcript as lines of at most 300 chars split on words: the first `VOICE: …` /
  `VOICE [remote]: …`, the rest `VOICE (cont): …` / `VOICE [remote] (cont): …`,
  written in one go so the Monitor batches them (200 ms window) into one event.
  Override the width with `EYE_LINE_MAX=<n>`. A running `listen-loop` picks the
  change up only when re-armed (stop the Monitor, `/eye` again) — the unit is not
  involved. Test: `bash bridge/tests/listen-loop-split.test.sh` (stub bridge, no body).
- Replies wait in memory, 20 at most: one he has **heard** for 5 minutes after it, one he has
  **not** until the ring pushes it out — the tray is his to come back to (T2; before it, a note
  older than five minutes answered his ▶ with "that reply cannot be said again"). `journalctl --user -u dark-eye` shows `remote on
  127.0.0.1:8644` at boot and one `reply <n> for the phone` line per utterance.
- **The whole loop with no phone**: `bash body/test/e2e-remote.sh` — synthesises a
  sentence, uploads it as the page's Int16 PCM, checks the transcript and the
  `remote audio:` tag, sends a reply with `eye speak --to remote` and reads it back
  off `/remote/poll`. Loopback only and silent (it fails if `pw-cat` ever runs). Its
  live `VOICE [remote]:` step needs the ear free — a running `eye listen-loop` takes
  the transcript first, so with one up that one step says `skip`.
  A run leaves the body's last source set to `remote`, as any phone turn does: an
  unaddressed `eye speak` goes to the phone until he next speaks into the mic. Say
  `eye speak --to local` if you need the buds before then.

## What it costs, and how to measure it

`body/scripts/measure.sh` prints the table below for the running body: CPU % per
process from `/proc/<pid>/stat` deltas, RSS + PSS from `smaps_rollup`, GPU render busy
and RC6 from sysfs, and the renderer's fps when `DARK_EYE_STATS=1` is set.

```bash
body/scripts/measure.sh --state idle --seconds 60            # print only
body/scripts/measure.sh --state idle --seconds 60 --append   # …and append to BASELINE.md
body/scripts/measure.sh --state speaking --allow-sound       # refuses without the flag
body/scripts/measure.sh --state mic --allow-sound            # states: idle speaking mic tvoff
```

It finds the body's pids from the unit's cgroup plus the app slice (fact 5);
`MEASURE_PIDS=<pid,…>` measures a body run by hand instead, and `MEASURE_PROC=<dir>`
points every read at a fixture (that is what `test/measure.test.js` does). `speaking`
and `mic` refuse to run without `--allow-sound` — the owner may be asleep.

The numbers below are the unit as it ships — the GPU backend, 60 fps idle
(`--state idle --seconds 60`, 2026-09-06 19:58, nobody talking, TV off, the tree carrying
EF05's recycler). The full history, including the software rows and the G06
software-vs-GPU table, is in `body/scripts/BASELINE.md`.

| Process | CPU % of one core | RSS MB | PSS MB |
|---|---|---|---|
| eye-render (gpu, 60 fps) | 2.2 | 108 | 51 |
| node body | 0.1 | 63 | 42 |
| voice worker (fresh) | 0.0 | 1373 | 1351 |
| **body total** | **2.2** | 1544 | 1444 |
| **body total (excl. voice worker)** | **2.2** | 171 | 93 |

The notes brain (M05b, `notes-brain.service`: `claude --name notes` + its `eye listen-loop`
Monitor, `--strict-mcp-config`), a 30 s sample after 5 min without words, 2026-09-14 23:57, in a
throwaway tmux on a fixture vault:

| Process | CPU % of one core | RSS MB | PSS MB |
|---|---|---|---|
| notes session (claude + listen-loop) | 0.57 | 261 | 202 |

First start of `notes-brain.service`: the owner (or the orchestrator) runs `tmux attach -t notes`,
accepts the trust dialog once (`~/agents/notes` is a new project directory), and types
"Start: arm the ear." — `ExecStartPost` types that line by itself on every later start.

Without `--strict-mcp-config` the session also carries the user's playwright-mcp server:
+106 MB RSS / +69 MB PSS for nothing the notes brain uses.

`gpu render busy 1.19 %`, `rc6 83 %`, `gt_act_freq 0 MHz`. The voice worker's 1373 MB is a
*fresh* worker: ORT's CPU arena only grows, so a day of turns used to take it to 1.7 GB and an
evening to 2.2–3.5 GB. `DARK_EYE_VOICE_RSS_MAX_MB` (above) now caps it at ≈1.6 GB by respawning
the worker in the quiet.

**The eye's real idle bill is not the eye.** The three processes the frame clock drives, one
60 s window each, TV off (EF02, `BASELINE.md`):

| At 60 fps idle | CPU % of one core |
|---|---|
| gnome-shell | **21.2** |
| Xwayland | 1.07 |
| eye-render | 2.04 |
| **together** | **24.3** |

Roughly 80 % of gnome-shell's share is the cost of *waking up* — every main-loop iteration walks
mutter's source list and asks the a11y D-Bus connection whether it has anything (43 % of the
process on its own, and that is the price of the agent desktop, since `pc tree` needs
`toolkit-accessibility`). Real compositing is ≈18 % of it. So the cost is per-iteration, not
per-pixel: it scales with the rate and with nothing else. Posting partial damage
(`DARK_EYE_SWAP_DAMAGE=1`, below) was measured and bought 0.36 points — noise.

`gpu render busy 1.15 %`, `rc6 83 %`, `gt_act_freq 0 MHz` at the 14:51 G07 window. The software backend at half
that rate cost 3.3 % of a core and 30 MB: the GPU buys 60 fps for less CPU and +73 MB of
Mesa. Against the Electron body's
**10.5 % / 866 MB** (excl. the voice worker) in `PLAN-LOWRES.md` §1: the frame loop is
the whole idle cost now. The memory that is left is inherent: the Parakeet + Kokoro
ONNX models in the voice worker (1.37 GB resident, down from 2.2 GB under Electron's
utility process).

### GPU backend — `DARK_EYE_GPU`

One binary, two backends (`PLAN-GPU.md`). Since G07 (2026-09-06) `eye-render` draws on the
iGPU through EGL + GL ES 3.2 by default and falls back to the cairo software renderer by
itself — at start if EGL/GL will not come up, and mid-run on a GL error or a context loss,
on the same window. Nothing was removed from the software path; it is the fallback forever.

Which backend is running:

```bash
journalctl --user -u dark-eye -n 200 --no-pager | grep -E 'EGL|backend |eye up at'
# [eye-render] EGL 1.5 · Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2) · OpenGL ES 3.2 …
# [eye-render] backend gpu          ← or `backend software`
# [body …] eye up at 1010,372 (340x380) on HDMI-1 (gpu)
```

The same word is the `backend` field of `ready` on the render socket. A start-time
fallback logs its reason first: `[eye-render] gpu: <why> — software renderer`.

**Rollback, one line** — the software renderer is the same binary, no rebuild:

```bash
systemctl --user edit dark-eye     # [Service] / Environment=DARK_EYE_GPU=0
systemctl --user restart dark-eye  # journal: no EGL line, `backend software`, 30 fps idle
```

`DARK_EYE_GPU=0` never the GPU, `1` always try it (and log why it could not), unset = the
built-in default (`GPU_DEFAULT` in `render/src/main.rs`, `true`). Remove the drop-in
(`systemctl --user revert dark-eye`) and restart to come back.

Fault injection, for checking the fallback still works (never set on the unit):

| Hook | What it does |
|---|---|
| `DARK_EYE_GPU_FAIL_AFTER=<frames>` | the GPU backend fails on that frame; the log shows the demotion and cairo takes over |
| `__EGL_VENDOR_LIBRARY_FILENAMES=/nonexistent` | EGL cannot initialise → software at start (`LIBEGL_DRIVERS_PATH` is ignored by Mesa/glvnd here — G01 deviation 1) |
| `DARK_EYE_GPU=1` on a `--no-default-features` build | `gpu: built without the gpu feature — software renderer` |

Parity between the two backends: `cd body/render && cargo test parity` — a surfaceless EGL
context, a seeded scene, per-region PSNR, PNGs and an amplified diff in
`DARK_EYE_PARITY_DIR` (default `target/parity/`). `LIBGL_ALWAYS_SOFTWARE=1` runs it on
llvmpipe. Thresholds and the measured table: `tickets-ubuntu/G04-gpu-parity-harness.md`.

### The idle frame rate — `DARK_EYE_IDLE_FPS`

Busy (speaking, mic open, a caption, a heard line, orbiters) is always 60 fps. Idle is
`DARK_EYE_IDLE_FPS`, 1-60 — anything else in the variable is ignored and the backend's
own default used: **60 on the GPU backend** (what ships since G07), **30 in software**,
where a frame costs 1.2 ms instead of 0.29 ms (measured: 2.0 % of a core at 60 fps on the
GPU, 6.7 % in software). A GPU
that fails at runtime falls back to cairo and to 30 with it, unless the variable is set —
`DARK_EYE_GPU_FAIL_AFTER=<frames>` makes the GPU backend fail on that frame on purpose,
the test hook that exercises the fallback (never set in the unit).
Set it on the unit with a drop-in
(`systemctl --user edit dark-eye`, `Environment=DARK_EYE_IDLE_FPS=…`); node passes its
environment to `eye-render`. Owner's call 2026-09-06: 8 fps looked choppy on the screen and
smoothness now outranks the ≤1 % idle target of `PLAN-LOWRES.md` §3.1.

| backend · idle fps | eye-render CPU % of a core | gpu render busy | rc6 | msAvg / msMax |
|---|---|---|---|---|
| software · 8 (E14) | 0.9 | 0.00 % | 98 % | 1.2 / 2.5 |
| software · 30 (E20) | 3.3 | 0.00 % | 92 % | 1.2 / 6.6 |
| software · 60 | 6.7 | 0.00 % | 81 %, GPU clocked to 600 MHz | 1.2 / 6.7 |
| **gpu · 60 (shipped)** | **2.0** | 1.15 % | 83 % | 0.24 / 5.2 |

In software a frame costs the same 1.2 ms whatever the rate, so the idle cost is rate ×
frame and 60 fps took 6.7 % of a core — past the 4 % the owner allowed, and the reason
the software path shipped at 30. The GPU frame is 0.29 ms, so the same 60 fps costs 2.0 %.
The fallback keeps the software default: a GPU that fails mid-run drops to cairo *and* to
30 fps, unless `DARK_EYE_IDLE_FPS` says otherwise.

**What a rate costs the whole desktop, not just the eye** (EF02, 2026-09-06, four batched unit
restarts, TV off, 60 s per row, GPU backend throughout):

| idle fps | gnome-shell | Xwayland | eye-render | the three together |
|---|---|---|---|---|
| **60 — shipped, the owner's standing choice** | **21.2 %** | **1.07 %** | **2.04 %** | **24.3 %** |
| 30 | 11.7 % | 0.58 % | 1.40 % | 13.6 % |
| 15 | 5.9 % | 0.33 % | 0.80 % | 7.0 % |
| 8 (the old default, already rejected — choppy on the screen) | 5.1 % | — | 0.9 % | — |

The line is `gnome-shell ≈ 2.6 % + 0.31 % per fps`: the compositor's cost is one main-loop
iteration times the rate, so halving the rate halves all three columns together and no change to
how the eye draws can move them. **Nothing here has been changed** — 60 fps stands because
smoothness on the screen outranks the idle budget, and the rate is the owner's decision alone. This
table exists so the decision can be revisited with numbers instead of a guess; ≤ 10 % for
gnome-shell needs ≈ 24 fps or less.

### `DARK_EYE_SWAP_DAMAGE` — documented, and off

Unset (the default) the GPU backend posts every frame with `eglSwapBuffers`. Set to `1` it uses
`eglSwapBuffersWithDamageKHR` with the rect the frame actually changed — idle that is 280×160 of
the 340×380 window, 35 % of the area. The pixels are identical either way; the whole frame is
still drawn and the damage is a present hint. Mutter honours it (mutter 50.1 source, read in
EF02), and the extension is present on this XWayland EGL display — `[eye-render] swap damage: on`
in the journal when the flag is set.

Measured on the unit at 60 fps: gnome-shell **20.83 %** with the flag against **21.19 %** without,
i.e. **0.36 points**, inside the baseline's own window-to-window spread and nowhere near the
5-point bar EF02 set for keeping it. It is off, and it should stay off here — it is kept in the
binary because it is correct and free, and because a compositor billed per pixel rather than per
main-loop iteration would pay for it.

Every motion is time-based: `S` (1/60 s steps covered by the frame just drawn) scales
the rain, the iris drift, the gaze, the glow pulse and the trail decay, so the eye moves
at the same speed as `spec/eye-reference.html` at any rate. `S` is capped for a stall,
and the cap can never fall below one idle frame.

Startup, from the journal: `Started dark-eye.service` → `eye up at 1010,372` in
**0.31 s** on the GPU backend (0.34 s in software — EGL init adds ~40 ms, the atlas and
the shader compile are inside it); `voice ready` 3.5 s later (the models, unchanged) — speech asked for before
that is queued.

## TV off — when the eye stops drawing (E12)

`body/src/display.js` watches the TV and `main.js` sends `display{on}` down the render
socket. On `false` `eye-render` unmaps its window and arms **no timer at all** (it blocks
on the socket and the X connection): 0 CPU ticks over 20 s, measured — and the GPU
backend refuses to swap while the window is unmapped, so an `Expose` cannot restart it
either. The bridge, the
voice worker and `pw-cat` are untouched, so **speech still plays with the TV off** (the
buds are the speaker). On the way back the outputs are re-read, the window is re-placed
bottom-right and mapped again, within 1 s.

The ladder, in order, every 1 s:

1. **The renderer's RandR outputs** — zero outputs reported = off. Every `outputs`
   message (an `RRScreenChangeNotify`) polls the ladder immediately. The same list gives
   the canvas its work area.
2. **`/sys/class/drm/card1-HDMI-A-1/{status,dpms,enabled}`** — `disconnected`, not `On`,
   or `disabled` = off. This is the only rung that works on this machine.
3. **DDC/CI** — `ddcutil --bus 3 getvcp d6 --brief` every 10 s (the bus comes from
   `card1-HDMI-A-1/ddc -> ../../../i2c-3`): power mode ≠ 1, or no answer 3× while sysfs
   still says connected, = off. **Disabled by default here** — see below. Turn it on with
   `DARK_EYE_DDC=1`.

Hysteresis: off after **2 consecutive** off reads, on at the **first** on read. Every
transition logs the raw values:

```
[body 00:31:48.331] display on (displays=1, status=connected dpms=On enabled=enabled)
[body 00:32:42.863] display off (sysfs status=disconnected dpms=On enabled=enabled)
```

`journalctl --user -u dark-eye | grep 'display o'` is the whole history.

**ddcutil (2.2.5) is installed and its probe is off.** `ddcutil detect` reads the EDID
of the TV over `/dev/i2c-3` — `SAM SAMSUNG`, product `0x0900`, made 2011 — and then says
`This monitor does not support DDC/CI. (I2C slave address x37 is unresponsive.)`;
`getvcp d6` returns `VCP D6 ERR` (`ENXIO`) **while the TV is on**. A rung that never
answers cannot distinguish standby, so rung 3 stays off. `i2c-dev` is built into this
kernel (no `modules-load.d` entry needed) and the package's
`/usr/lib/udev/rules.d/60-ddcutil-i2c.rules` puts an ACL for the logged-in user on
`/dev/i2c-*`, so no group change and no re-login are needed.

Test hooks (neither is set in the unit): `DARK_EYE_DISPLAY_SYSFS=<dir>` points rung 2 at
a directory holding `status`/`dpms`/`enabled`, `DARK_EYE_DDCUTIL=<path>` swaps the binary.
A second body plus that fake dir is how the transition is exercised without touching the
real TV — and a second body is **`body-sandbox`**, never the recipe typed by hand (below).

**Nothing in the machine moves when this TV goes to standby (EF10, 2026-09-06).** Measured
with the set switched off at the remote, the eye still drawing:

| Signal | With the TV OFF | Verdict |
|---|---|---|
| `/sys/class/drm/card1-HDMI-A-1/{status,dpms,enabled}` | `connected` / `On` / `enabled` | rung 2 never fires |
| RandR outputs | HDMI-1 still listed | rung 1 never fires |
| DDC/CI `getvcp d6` | `ERR` (x37 unresponsive), on **and** off | rung 3 is useless, stays off |
| EDID | 256 bytes, readable | unchanged |
| `/proc/asound/card0/eld#2.4` (pin 0x6, the live HDMI pin) | `monitor_present 1`, `eld_valid 1`, `monitor_name SAMSUNG` | **an ELD rung would never fire either** |
| `HDMI/DP,pcm=3 Jack` (`amixer -c0`) | `on` | same |
| `journalctl -k` | no HDMI/ELD/hotplug event all day | nothing to react to |

The 2011 Samsung keeps HPD asserted in standby, so the kernel never re-senses the pin: the
DRM connector, the EDID **and** the audio ELD all keep saying "a monitor is here". The other
35 `eld#2.*` nodes read `monitor_present 0` because they are the unused pins — reading the
first one in the directory is what makes ELD look like a signal. **There is no rung 4**: a
rung that can only ever say "on" adds nothing to an off-detector, and one that guessed off
from a suspended audio sink would blank the eye while he is watching. Not built, by choice.

### His own switch — `eye tv off|on|auto` (EF10)

Since no rung can see the standby, the owner (or a brain, or his voice) says it:

```bash
eye tv off      # the eye goes dark now: display{on:false}, 0 render ticks, no timer
eye tv on       # forced awake, whatever the ladder thinks
eye tv auto     # back to the ladder alone — the default
eye tv          # {"ok":true,"mode":"off","on":false,"reason":"override off"}
```

- `POST /bridge/tv {mode}` / `GET /bridge/tv`; the mode is also in `eye health`
  (`"tv":"auto"`) and therefore in `agent-preflight`'s BRIDGE line.
- **Out loud**, through the body's own intents (`src/intents.js`, full-utterance match only):
  *"tv off" · "turn the tv off" · "the tv is off" · "apaga la tele" · "apaga la pantalla"* —
  and the same for on (*"tv on", "enciende la tele"*) and `auto` (*"tv auto"*). He can say it
  from the buds or the phone, since speech is untouched by a dark eye.
- **How it comes back.** `eye tv on` or `eye tv auto`; his voice; **or by itself** — while it
  is forced off the ladder keeps reading, and the first time the ladder itself sees off and
  then on again (a real unplug, a mode set, an output loss) the override steps aside and logs
  `display on (…, override off cleared by a real off→on)`. A forced `off` is never cleared by
  the ladder merely saying "on", which it does all night with the TV in standby.
- **It survives a restart**: `$XDG_RUNTIME_DIR/dark-eye/tv-override.json`
  (`DARK_EYE_TV_OVERRIDE_FILE`), written like `orbiters.json`, so a restarted body with the TV
  off does not light the eye. A reboot clears it (tmpfs) — which is the safe default.
- The switch is above the whole ladder and has no hysteresis: one call, one transition.
  Journal: `tv override: off` then `display off (override off)`.
- **What it buys** (EF10, two 60 s `scripts/sample.sh` windows either side of `eye tv off`,
  TV in standby, GPU backend, 60 fps): gnome-shell **21.93 → 0.18 %**,
  eye-render **0.00 %** of a core and **0 ticks** over the window (2.0 % at 60 fps), Xwayland **1.08 → 0.00 %**, the whole box 1.94 → 0.51 % of
  16 threads. Speech is untouched: the bridge, the voice worker, `pw-cat` and the phone
  listener on 8644 all keep running, so `eye speak --to remote` still works with the eye dark.

## A second body run by hand — `body-sandbox` (EF06)

`~/the-dark-eye/body/scripts/body-sandbox` → `~/.local/bin/body-sandbox`. It is the only
sanctioned way to run a second body or a bare `eye-render`. Typing the old recipe
(`XDG_CONFIG_HOME=<copy>`, `DARK_EYE_RENDER_SOCK=`, `node src/main.js`) is what made the
production eye flap and vanish on 2026-09-06 15:46 (E29): `net.createServer` accepts any
number of clients, so a hand-run renderer on the live socket simply takes the eye over.

```bash
eval "$(body-sandbox up --name t1 --eye offscreen --stats --audio null)"   # ~0.2 s
eye health                                # {"ok":true,...} — DARK_EYE_CONFIG points at the sandbox
MEASURE_PIDS=$MEASURE_PIDS bash ~/the-dark-eye/body/scripts/measure.sh --state idle --seconds 20
body-sandbox down --name t1                                       # ~0.15 s, exits 1 if anything survived
```

Everything the unit and a hand-run body used to share is redirected into
`$XDG_RUNTIME_DIR/dark-eye/sandbox/<name>/`:

| Shared thing | The sandbox's own |
|---|---|
| config (`main.js` `loadConfig`) | `xdg/dark-eye/config.json` — a copy of the live one with a fresh `secret`, the first free port from 8643 (8644 skipped) and **`remotePort` removed**: never a second tailnet listener |
| render socket (`render.js`) | `render.sock` (`DARK_EYE_RENDER_SOCK`) |
| orbiters (`orbiters.js`) | `orbiters.json` (`DARK_EYE_ORBIT_FILE`) — the live set is never replayed or rewritten |
| remote sessions (`remote.js`) | `state/` (`XDG_STATE_HOME`) |
| the TV override (`display.js`) | `tv-override.json` (`DARK_EYE_TV_OVERRIDE_FILE`) — an `eye tv off` inside a sandbox never reaches the owner's set |
| the eye | `--eye offscreen` = `eye-render --x-offset <derived>`, **computed from RandR at launch**, never a constant: `window.rs place()` draws at `largest.x + largest.w - 340 - 16 + offset`, so an offset calibrated for one output maps *inside* another — the old fixed `-1400` put the eye at **x = 164 on the 1920-wide laptop panel whenever the TV was off**, and an eye was drawn on his screen. `up` writes `min over outputs of (minx - (x + w) + 16)` minus one window width (one output 1920 wide → `-2244`, window at x = -680, right edge -340), and `check_env` accepts an offset between the floor `-32768` and that bound **recomputed now**. So the stored offset stays legal while the outputs stay as they were or lose one, and an output further right *lowers* the bound: plugging the TV back in (bound `-1904` → `-3270`) makes a stored `-2244` illegal and `restart` **refuses with a non-zero exit** — fail-closed, `down` and `up` again. The bound is derived inside the script from plain `xrandr` and is not readable or settable from the caller's environment. `--eye off` = no renderer at all |
| audio | **`--audio null` is the default**: a `module-null-sink` `eye_sandbox_<name>`, and the body's `pw-cat` gets `--target` on it (`DARK_EYE_SINK`) — never the owner's sink. **`--audio none` is the explicit opt-in and is NOT audio-isolated**: it writes no `DARK_EYE_SINK`, so the body speaks into the owner's default sink, out loud in his room (it was the default until 2026-09-15, and `up --name t1` + `eye speak` is how a sentence got spoken there). Pass it only when nothing can speak |
| killing | `body.pid`; `down` kills node by PID, then any surviving `eye-render` by PID, unloads the sink, removes the dir |

Verbs: `up [--name N] [--eye off|offscreen] [--gpu 0|1] [--stats] [--audio null|none]`,
`eye [--gpu 0|1] [--stats] [--seed N] [--seconds N] [--demo --busy | --dump PNG --scene S]`,
`restart --name N`, `env`, `status`, `logs [-f]`, `down --name N|--all`.

- `restart --name N` stops the sandbox body and starts it again on the **same dir, config, port
  and sink**, so everything the body persists survives — `mode.json`, `active.json`, `state/`.
  It is how a "this is read back on boot" check is run by hand: `eye mode notes`,
  `body-sandbox restart --name t1`, `eye mode` → still `notes`. `up` is the opposite: it wipes
  the dir, so the same sequence with `up` comes back `call`. `restart` needs `--name N` (no
  shared default), refuses with a non-zero exit if that sandbox is not up, and prints the new
  exports (`BODY_PID`/`MEASURE_PIDS` change) — eval it like `up`.
- `down` needs `--name N` or `--all`; `env`/`logs` need `--name` unless a single sandbox exists.
  An unnamed `up` gets `sb-<pid>`, never a shared name; `up` on a name already up fails and prints
  `export DARK_EYE_CONFIG=/nonexistent; false`, so an eval'd session cannot reach the live body.
  Guards test (stub node, no unit): `bash ~/the-dark-eye/bridge/tests/body-sandbox-guards.test.sh`.

- `body-sandbox eye` is a bare `eye-render` on a dead socket and is **always** the derived
  offscreen offset; no caller-supplied `--x-offset` is accepted. Its dead socket must be inside
  `$XDG_RUNTIME_DIR/dark-eye/sandbox` (the verb does `mkdir -p` and `rm -f` on it, and an ambient
  `DARK_EYE_RENDER_SOCK` pointing at a note **deleted that note**), and `--dump` takes an absolute
  `*.png` inside that root or `$TMPDIR`/`/tmp` only — never a path in his tree.
  Scenes the binary has: `caption`, `resolved`, `heard-caption`, `rings`, `agents` — **there is
  no `idle` scene**, despite older tickets.
- `up` and `eye` **exit 2** if the socket resolves to the live `render.sock`.
- `up` and `restart` validate the whole saved `body.env` before launching it: only the keys `up`
  itself writes are accepted (any other key is refused, not isolated), every path-shaped key must
  be **non-empty and absolute** and canonicalise (`readlink -m`, so a traversal through a missing
  component is caught) inside the sandbox dir, `DARK_EYE_SINK` must be that sandbox's own null sink
  and `DARK_EYE_RENDER_BIN`/`_ARGS` the offscreen pair. A refused `restart` leaves the running body up.
- **Present is not set.** Every consumer reads `$KEY || <the owner's live path>`, so an *empty*
  value is an absent one — and `readlink -m` resolves a relative value (`""` included) against the
  caller's cwd, so with cwd inside the sandbox dir (`cd <dir>/state` to read state or logs) an empty
  `XDG_CONFIG_HOME` used to pass containment and the body then read *and rewrote* his real
  `config.json`. Empty and relative are both refused now.
- The sandbox dir must **be** `$XDG_RUNTIME_DIR/dark-eye/sandbox/<name>`: `up` and `restart` refuse
  a `<name>` that resolves elsewhere, because a symlink there would move the whole sandbox — and
  containment with it — to the link's target.
- Known, not guarded: `check_env` → `start_body` is a time-of-check/time-of-use window. A component
  inside the dir swapped for a symlink after validation is not re-checked before the launch. And
  `real_sb` resolves **both** sides, so a symlinked `$ROOT` itself — or a symlinked
  `$XDG_RUNTIME_DIR/dark-eye` above it — still moves the whole sandbox tree (and containment with
  it) to the link's target; only a symlinked `$ROOT/<name>` is caught. Two more:
  `window.rs place()` ends `(x as i16, y as i16)`, so an offset the check let through below
  `-32768` **wraps back onto a screen** (`-66000` → x = 1100 on the 1920-wide panel, an eye on
  his laptop) — that truncation is why `off_ok` has a floor, not only a bound, and the floor is
  the guard, not the renderer. And every containment claim here is relative to `$ROOT` =
  `$XDG_RUNTIME_DIR/dark-eye/sandbox` (and `--dump`'s `$TMPDIR`): a caller who sets
  `XDG_RUNTIME_DIR` or `TMPDIR` moves the tree the script confines things *to*, which is what
  the tests rely on and what a hostile caller would too. Three more:
  the offscreen claim holds at **validation time only** — `eye-render` re-places itself on
  `RRScreenChangeNotify` (`body/render/src/main.rs:394` → `win.replace_at(&outs, x_offset)`)
  with the stored offset, and `place()` measures from the *largest* output, so an output added
  to the left of the panel can bring a **running** body's window onto a screen with nothing
  re-checked (the TV at 1366x768 at x = -1366 with a stored -2244 leaves an 84 px strip on it;
  a 4K TV at x = -3840 becomes the largest output and the eye lands fully inside it) — take the
  sandbox down before changing outputs; the null sink is loaded into the **owner's live audio
  server** (`pactl load-module module-null-sink`) and unloaded by `down`, so a body killed
  without `down` leaves the module behind in his audio state; and `check_env` validates
  `body.env` only, never the sandbox's own `config.json`, so a `remotePort` re-added to the copy
  survives a `restart` and that body opens a second loopback listener — `up` always strips it,
  so the "no second tailnet listener" claim is `up`'s, not `restart`'s.
- The **set** is required, not only the value of whichever key is there: an absent key falls back
  to the owner's live tree (no `XDG_CONFIG_HOME` → his real `config.json`, real port, real secret,
  real `remotePort`; no `DARK_EYE_ORBIT_FILE`/`_ACTIVE_FILE`/`_QUIET_FILE`/`_MODE_FILE`/`_TV_OVERRIDE_FILE`
  → his live `$XDG_RUNTIME_DIR/dark-eye/*.json`; no renderer key → the real `eye-render` at its
  on-screen default). So all nine keys `up` writes must be present, plus exactly one renderer shape
  (one `--x-offset` inside the derived range `-32768`..bound, alone, or `/bin/sleep` with `infinity`), plus `DARK_EYE_SINK` whenever the
  sandbox loaded a null sink. `restart` backfills every key an older `body.env` predates before it
  validates — a sandbox from an earlier version still restarts — and confirms the pid it found is
  really that sandbox's body before it writes anything.
- Sandbox processes carry `DARK_EYE_SANDBOX=<name>`; `sentinel-runaway` rule 3 tells them from a
  hijack and still reaps one older than 2 h. `body-sandbox down` is the normal exit.
- The sandbox uses the **live display** with the offscreen offset, not a private `Xvfb`:
  `eye-render` is an xcb + EGL client and on an `Xvfb` it would fall back to the software
  backend, so a sandbox would no longer measure or draw what production does. (The `Xvfb :99`
  on this box belongs to the `moodle-shared-selenium-1` container — leave it alone.)
- Test: `bash ~/the-dark-eye/body/test/body-sandbox.test.sh` (also run by
  `bash ~/agents/bin/tests/run.sh`) — up, isolation of all four paths, live `render.sock`
  inode+mtime unchanged, no new `eye up` in the unit's journal, the voice on the null sink, then
  `down` with no residue. ~15 s, no sound, no pixels. The offscreen check is **geometric and never
  skipped** (it used to be skipped whenever the TV was off — the one condition in which `-1400`
  was on his screen): the window rect at the body's own offset is intersected against every
  RandR output that has a mode, and so is every position actually mapped — the renderer's own
  `[eye-render] window … at x,y` line plus anything `pc win list` shows for this body (mutter
  does not list an override-redirect window, so the log line is the one that sees it).

## `agent-preflight` — the first command of every Dark-Eye session (EF06)

`~/agents/bin/agent-preflight [--brief]`, 0.08–0.16 s, six headings:

```
UNIT      active/running pid 3599383 NRestarts=0 backend gpu
          [body 19:56:34.828] eye up at 1010,372 (340x380) on HDMI-1 (gpu)
BRIDGE    {"ok":true,"brainListening":true,"micOpen":false}
TREE      67 dirty file(s) in /home/oscar-nadjar/the-dark-eye — DO NOT RESTART: ...
HAND-RUN  none
ORBITERS  {"ok":true,"orbiters":[...]}
CHANNEL   20h · sink alsa_output...hdmi-stereo · bluez sinks 0 · pipewire log.level 2
```

It **exits 1 when the tree is dirty or a hand-run body is live** — both mean *do not restart the
unit*. A hand-run body is any `eye-render` / `node .../body/...` outside the `dark-eye.service`
cgroup; one carrying `DARK_EYE_SANDBOX` is listed separately as a sandbox, not a hijack.
Without `--brief` it also prints the three rules (kill by PID · never restart without the
orchestrator · the live socket, orbiters and remote sessions are off limits) and the three
commands above.

## Brains — named buses, one active (M01)

`body/src/brains.js`. A brain is a name (`[a-z0-9-]{1,16}`) with its own listen bus, a
colour, a Kokoro voice and a heartbeat. `main` exists from boot (colour `brainColor`, voice
`voiceSid`, both from config); every other name is registered by its first `listen`. His words
go to the **active** brain's bus only; the others get nothing until he switches (each bus keeps
the last 200 items, as before).

| Route | What |
|---|---|
| `GET /bridge/listen?timeoutMs=&brain=<name>&voice=<sid>` | long-poll that brain's bus; no `brain` = `main`; `voice` is honoured on first registration if free and not 17 |
| `POST /bridge/speak {text, voice?, to?, brain?}` | no `brain` = `main`; the active brain is spoken now in its own voice; any other brain's text is **parked** (last 10) and the eye whispers `⟨ notes ⟩ 1 waiting` |
| `GET /bridge/brains` | `{active, brains:[{name,color,voice,connected,parked}]}` |
| `POST /bridge/brains/active {brain}` | the switch: parked words play at once, joined, in that brain's voice; answers the roster; unknown name → 400 |

- Colours come from the renderer's own orbiter palette (`render/src/orbit.rs` `AGENT_COLORS`),
  first free one; never green. Voices: 17 is the Eye's (`main`), the others take the next free
  of `11–16, 18, 19`.
- `connected` = a listen pending, or one within 90 s. `/bridge/health` now carries
  `active` and its `brainListening` means **the active brain** is listening — "No one is
  listening" fires only when the brain he is talking to is deaf.
- The active name persists in `$XDG_RUNTIME_DIR/dark-eye/active.json` (`DARK_EYE_ACTIVE_FILE`;
  the sandbox gets its own); a reboot resets to `main`. Only a channel this body has comes back
  from that file — `createBrains({channels})` puts `notes` on the roster before the file is read,
  and any other name is logged and dropped to `main`, so a stale file can never leave him
  talking to a channel nobody listens on.
- `config.brain` is still only the caption identity the renderer is told at `ready`; the
  session colour on a switch is M03. The `eye --as`, voice and phone switches are M02–M04.
- Tests: `body/test/brains.test.js` (alone and behind the bridge), `server.test.js` (routes).

### The two modes, entered by voice (M13, re-aimed by M14)

The two modes are the **Eye's**, not two brains: **call** plays a reply as it arrives,
**audio notes** leaves it waiting for his `▶` (see "The two modes" below). The channel — who
hears him — is a separate thing (`main`, `notes`, anything registered later).
`body/src/intents.js` holds one alias table (`MODES`), phrases per mode and language —
`audio notes`, `audio note`, `notes mode`, `note mode`, `audionotes`, `notas de audio`,
`modo notas`, `modo de notas`; `call mode`, `back to call`, `normal mode`,
`modo llamada`, `modo de llamada` — plus the mis-hearings he gets (`audio nodes`,
`odio notes`, `audio no`, `audio notas`, `call mod`, `called mode`, `call more`).
A phrase from that table is a **mode** (`{kind:"mode", name:"call"|"async"}` — the body's own
word for it, see "The two modes" below), never a channel. Channel names keep their one-token shape; nothing in `brains.js` changed.

- **Where the phrase may sit:** the whole utterance, or the tail after filler only
  (`hey|hi|ok|okay|eye|dark eye|what's up|wake up|oye|hola|qué tal|vale`) and an optional
  `talk to|switch to|habla con|cambia a`. So "what's up audio notes" switches and
  "I want to write some audio notes about the plan" does not — a false switch sends a whole
  thought to the wrong brain, a missed one costs him a repeat.
- **What he hears:** entering audio notes mode is whispered `⟨ audio notes ⟩`; M15 adds the
  spoken confirmation, said before the silence starts.
- **"talk to me" / "háblame" is call mode**: the queue drains aloud and he is back in call
  (M09a's quiet-off, under its new name). "call mode" is the other way back.
- **A channel nobody listens on is entered anyway** (plan §1.7): he asked for it, so the
  switch happens, the Eye says "notes is not listening. I'm holding your words."
  ("... no está escuchando. Guardo tus palabras.") and his next thought waits on that bus
  instead of reaching the other brain. The body starts no session — start it by hand,
  `systemctl --user start notes-brain` (first start: §the notes brain). A voice switch,
  `eye talk-to notes` and the page's channel control all behave that way: they share
  `setActive`. **A mode word can never raise that notice** — a mode has no listener.
- **Near misses grow the list.** A tail one edit from a phrase but not on it stays words and
  logs `intents: near "audio nots" → async?`; read `journalctl --user -u dark-eye | grep near`
  after a week and add what he actually says.
- Tests: `body/test/intents.test.js` (every phrase, every filler, every mis-hearing, the
  refusals), `render-bridge.test.js` (the switch path and the deaf line).

## The mouth waits — no-interrupt hold and barge-in cut (M08)

`body/src/hold.js`, one gate in front of the voice worker; every `say` goes through it,
parked words and the Eye's own notices included (parked → say → hold → voice).

1. **Held, never dropped.** While his mic is open (buds or phone) or a phone utterance is in
   flight, and for **1500 ms after the mic closes**, speech is queued (≤ 20, oldest dropped with
   one log line) and then sent in order, each in its own brain's voice, `to` intact.
2. **The window runs from the mic close**, not from the transcript: the one timer exists only
   after a close and is re-armed if he opens again inside it. Between his turns nothing is armed.
3. **Barge-in cut.** Opening the mic (or the first block of a new phone utterance) while the
   Eye is speaking kills the live `pw-cat`, drops the rest of that utterance and whatever was
   queued behind it in the worker (`cancel`), and the eye gets `speaking{ms:0}`. The remainder
   is **dropped, not resumed**; the caption already on screen keeps what was said. A `--to
   remote` reply is the phone's own WAV and is not cut.

`eye health` carries `"held": N`. Tests: `body/test/hold.test.js`, `audio.test.js` (`cut`),
`voice.test.js` (`cancel`), `server.test.js`. A plain `eye speak` now waits by itself — the
old `eye-speak-idle` wrapper is gone.

## The two modes — call, and audio notes (M09a, M14)

**How** the exchange runs, for whichever channel is active and any channel he adds later:

| | **call** | **audio notes** |
|---|---|---|
| a reply on arrival | plays, and the page plays it | never: text now, the voice when he asks |
| the hold | `busy()` + the 1500 ms timer, drains by itself | `parked()`: no timer at all, however long it waits |
| the way out of the wait | — | `▶` per reply, or "talk to me" for all of it |

`body/src/mode.js`: one enum, `call` or `async`, the second gate on the hold above (`busy()` is
mic open or a phone utterance in flight, `parked()` is audio notes mode). Voice: **"audio
notes"** / "notas de audio" / the old **"quiet"** / "silencio" / "cállate" enter it (the eye
whispers `⟨ audio notes ⟩`); **"call mode"** / "modo llamada" / **"talk to me"** / "háblame"
leave it. CLI: `eye mode [call|notes]`; bridge: `GET/POST /bridge/mode {mode}`; `eye health`
carries `"mode": "call"|"notes"`. It is **global and survives a channel switch** — the mouth is
one resource, and a mode that changed under him is exactly the surprise the hold exists to remove.

**One word each for the channel and the mode.** The channel is `notes` (the one that writes his
vault); the mode is spoken "audio notes" and is `async` **inside the body only** — `mode.js`,
`intents.js` and `main.js` say `async`, and the bridge translates at its edge (`fromWire` /
`toWire` in `mode.js`), so every word he says, types or reads is unchanged: `eye mode
[call|notes]`, `eye quiet`, `health.mode`, the page. `intents.test.js` pins the pair in both
directions — "talk to notes" is the channel, "audio notes" is the mode.

**Quiet mode is not a second concept**: audio notes mode is how it is surfaced. `eye quiet
on|off|status` and `GET/POST /bridge/quiet {on}` stay as aliases (`on:true` ↔ `notes`) and
`health.quiet` stays beside `health.mode`, so nothing outside the repo breaks. An old
`quiet.json` with `{on:true}` is read once as `async` and then ignored; the file is left on disk.

1. **Queued, not dropped.** In audio notes mode every `say` sits in the hold (≤ 20, oldest
   dropped) and plays in order on "talk to me", each in its own channel's voice; with nothing
   waiting the Eye answers "here". The Eye's own confirmations (a switch, "who is listening")
   queue like the rest — the only thing it answers aloud is the mode he just asked for.
2. **The words still reach him at once**, as text, where the voice would have gone — and in
   audio notes mode to **both** channels, whichever one the turn came from: the on-screen caption
   (`speak{text}` with no audio) **and** a text-only reply `{seq, text}` on the page's poll
   lane, so a page he leaves open always holds the `▶` for everything the Eye has said. When
   the queue plays later, the caption and the page reply come again, with the voice.
   **On demand, and the mode holds:** the ▶ glyph on that text-only line (M12, "Remote" above)
   has the body say it again **to the page only** — a `bypass` item the hold does not park. The
   room stays silent and the rest of the queue keeps waiting.
3. **With no page open** it behaves exactly as quiet mode did: the on-screen caption is all he gets and
   "talk to me" is the only release — the overlay is click-through, there is no `▶` to press on
   the screen. The `▶` is what makes it *audio notes*.
4. **It persists**: `~/.local/state/dark-eye/mode.json` (`DARK_EYE_MODE_FILE`; the sandbox gets
   its own, `DARK_EYE_MODE_FILE`), 0600, tmp + rename, read once at start — a restart in audio
   notes mode logs `mode: async (kept)`. A missing or corrupt value is `call`; a file written
   before the mode had its own word (`{"mode":"notes"}`) is read as `async`.
5. **Idle**: nothing resident — one enum, one file read at start, and the hold arms no timer in
   audio notes mode (`parked()`). Queued items drain **local-only** — the page already got the
   text item, nothing reaches it twice. A `say` in the ~5 s before the voice worker is ready
   parks in `pendingSpeech` (max 10) and reaches the mode's path when it is.

Tests: `body/test/mode.test.js`, `hold.test.js`, `intents.test.js`, `server.test.js`,
`replies.test.js` (text-only item), `remote-replay.test.js` (▶ on a waiting reply, in a browser),
`eye-sh.test.js`.

## Orbiters — automatic, and they survive a restart (E31)

An orbiter is no longer something a session remembers to send. Two Claude Code
hooks in `~/.claude/settings.json` do it: `SubagentStart` → `orbit-hook start`,
`SubagentStop` → `orbit-hook stop` (`~/agents/bin/orbit-hook`, one python3 run,
~45 ms, exits 0 whatever happens — a dead Eye is a silent no-op). The hook's
stdin carries `agent_id` (the same string at start and stop, so the pair is
exact), `agent_type`, `session_id` and `transcript_path`; the orbiter's id is
`agent_id[:6]` and its label the `description` of the `Agent` call, read from
the last assistant message in the transcript (the hook input has no
description), falling back to `agent_type`.

The body owns the set (`body/src/orbiters.js`): `working` keeps an orbiter,
`done`/`error` drops it, and the set is persisted with its expiry timestamps to
`$XDG_RUNTIME_DIR/dark-eye/orbiters.json` (`DARK_EYE_ORBIT_FILE`). It is put
back on every renderer `ready` — a respawned or restarted renderer gets the
same rings, logged as `orbiters: N put back` — and re-sent every 4 min
(`DARK_EYE_ORBIT_REFRESH_MS`) so the renderer's own 10-min TTL never lapses.
What ends an orbiter is its `done`; `DARK_EYE_ORBIT_TTL_MS` (12 h) is only the
safety net for an agent whose session was killed. `eye status` with no argument
lists what the body holds (`GET /bridge/status`); a stale one goes with
`eye status <id> done`.

## Aesthetic law (Oscar's verdicts, shipped)

Flat 2D cat-eye (pointed corners, no volume wash, NO outer glow — it showed
the window rect), no blinking, gold iris + feline slit, captions decode
from katakana noise just above the eye (linger 7-22s), **green = the Eye
only; agents = rainbow orbiters outside it** (cyan/magenta/orange/violet/
yellow/pink; comet tails; gold burst on done).

Kept behaviours: the Eye never speaks unprompted; the canvas never opens by
itself (he says "show me" or clicks the mark); a visual pushed with `--ask`
comes back as `canvas-approved` / `canvas-rejected`.

## Voice loop end to end, and the latency

`bash body/test/e2e-voice.sh "what time is it"` talks to the Eye without a human:
it synthesises the sentence, feeds it through a `module-pipe-source` FIFO made the
default source (his real one restored in a trap), closes the mic and prints the
`heard` line plus the seconds to the first audio chunk. Three runs, 2026-09-06: mic
close → transcript 0.26 s; → **first audio chunk 9.2 s** mean (8.15-10.87), nearly
all of it the orchestrator's turn. **Recovery ritual: `/eye` again** — with no
Monitor the Eye says "No one is listening" once and holds his words for the ear.

### The caption that grows as he speaks (E28, rebuilt in E29b)

His words appear in gold **while he is talking**, not once when the mic closes.
`src/partials.js` is the partial ear, and since E29b it decodes the **growing
utterance**, not a chunk: every pass hands Parakeet the window from the anchor to
now, so each partial is read with its own context instead of alone. E28 decoded
each ~1.5 s slice by itself, which is what made the caption read like broken
subtitles ("Oi? Necessito qua revision. This is L plugin the mood.") — the owner's
verdict on 2026-09-06 was *"the transcript looks really not good"*.

**Local agreement.** A word reaches the caption only when two decodes in a row
agree on it (case and commas ignored — the recogniser flips those freely), and the
caption then only ever grows: `speak{who:"owner", append:true}` keeps the character
timings already laid out, so the line never re-noises. A hypothesis that
contradicts what is up is the one case that redraws, through `captionDelta`, with
`ms: 300` so it settles instead of retyping. Only the very first words go up
unconfirmed, so he does not wait two decodes to see anything.

**The anchor.** A word that ended more than 1.5 s ago has had all the right
context it will ever get: it is **frozen** — committed to the transcript — and the
anchor moves past it, so the window falls back to a couple of seconds instead of
growing without bound. The anchor keeps **0.8 s of already-frozen audio in front of
it as lead**; without it the recogniser drops the first words of a window that
starts cold, which is the single bug that cost whole phrases in the first cut.
Words inside the lead are dropped from the result by their timestamps, so nothing
is said twice.

**The cost is the cadence.** One decode at a time, and the next one waits
`d × (1/0.35 − 1)` after a decode that took `d`, so the ear averages **0.35 of a
core** whatever the window costs — a long window slows it down by itself. The
window is capped at 8 s, whatever the mic has.

**The transcript at mic close** is no longer a decode of the whole clip. The frozen
head is already decoded, so `finalize(samples)` only decodes from the anchor on and
stitches — and when the last window already reached the end through silence (he
stops talking before letting the key go), not even that: the hypothesis it already
has *is* the transcript, in **0.4 s**. A tail that comes back empty never throws the
transcript away; it falls back to the words he watched appear (production, 16:30:21
on 2026-09-06: `heard (4110ms): [0 chars]` on the old full-clip path).

Measured on the recogniser itself, replaying clips in real time through the real
voice worker (`before` = E28/E29, `after` = E29b; WER against the script the clips
were synthesised from):

| clip | first words | CPU while speaking | final after mic close | core-s / utterance | partial WER | final WER |
|---|---|---|---|---|---|---|
| 9.4 s en | 1.62 → 1.63 s | 0.11 → 0.30 | 1.26 → **0.38 s** | 2.33 → 3.15 | 96.7 → **20.0 %** | 3.3 → 3.3 % |
| 18.8 s en | 1.59 → 1.64 s | 0.13 → 0.31 | 3.05 → **2.69 s** | 5.57 → 8.56 | 62.7 → **52.5 %** | 1.7 → 1.7 % |
| 27.6 s en | 1.65 → 1.64 s | 0.15 → 0.31 | 4.61 → **1.50 s** | 8.74 → 10.17 | 59.6 → **31.9 %** | 1.1 → 6.4 % |
| 28.2 s en, 0.6 s before he releases | 1.64 → 1.70 s | 0.16 → 0.33 | 5.53 → **0.74 s** | 10.0 → 10.05 | 54.3 → **7.4 %** | 1.1 → 1.1 % |
| 35.4 s es/en | 1.74 → 1.63 s | 0.20 → 0.34 | 6.28 → **2.71 s** | 13.28 → 14.86 | 69.5 → **64.2 %** | 42.1 → 45.3 % |
| 36 s es/en, 0.6 s before he releases | 1.60 → 1.75 s | 0.20 → 0.33 | 8.50 → **0.39 s** | 15.56 → **12.33** | 67.4 → **46.3 %** | 50.5 → 41.1 % |

The partial text is what changed: the caption is now his sentences, lagging four to
six seconds behind him, instead of instant fragments. The final latency target
(~2 s for a 30 s utterance) is met whenever he pauses before releasing the key —
0.4-0.7 s, no decode at all — and is 1.5-2.7 s when the clip ends on his last word.
CPU per utterance is +9 to +54 % on a short one and **below** E28 on a long one,
because the whole-clip decode is gone.

Two side findings, both in the numbers above: Parakeet's **full-clip decode drops
whole sentences past ~20 s** (the 23 s and 35 s clips lost one and two sentences in
`before`), which is why the stitched transcript scores the same or better; and the
Spanish clips score badly in both columns because `kokoro-multi-lang-v1_0` only
carries `en` and `zh` lexicons, so its "Spanish" is mispronounced — they are a
stress case, not a Spanish WER.

**Kill switch**: `DARK_EYE_PARTIALS=0` in the unit environment leaves only the
caption at mic close (E27's behaviour) and the whole clip decoded in one pass, no
rebuild.

### Audio through PipeWire (E16)

Since E19 this is the only audio path — the `DARK_EYE_AUDIO` flag is gone. `src/audio.js` runs
one `pw-cat -p --raw --format f32 --rate <sampleRate> --channels 1 -` per utterance
(chunks written in order, stdin closed on `last`, the process exits when drained, a second
utterance waits behind the first — one mouth) and one `pw-cat -r --raw --format f32
--rate 16000 --channels 1 -` from `ptt on` to `ptt off` (SIGINT, concat, clips under
`MIN_MIC_SAMPLES` dropped, `mic captured N.Ns` logged). The mic has no `--target` and follows
the default source, which the PTT sidecar switches; **the voice picks its sink per utterance**
(E23, below). `main.js` sends `speaking{ms}` (the milliseconds still to play) down the render
socket as each chunk is handed over, so the eye no longer needs to hear the audio to know it
is speaking. **Cost**: `pw-cat` is 0.15 % of one core while speaking and *gone* when silent, against
the Electron audio service's 3.2-3.4 % of one core 24/7.

**Where the voice comes out (E23).** Owner's rule: *the voice goes to the output that is playing
at the moment*. At each utterance `audio.js` reads `pactl -f json list sink-inputs` + `list sinks`
(one look, cached 2 s, ~6 ms each) and takes the sink of the first uncorked stream that is neither
`pw-cat` (the Eye's own mouth) nor `speech-dispatcher` — a stream on a `RUNNING` sink first — else
`pactl get-default-sink`; the name goes to `pw-cat --target`. **By name, never by index**: the bluez
sink is a new node after every A2DP↔HFP switch. If `pactl` cannot be read the flag is left off and
`pw-cat` falls back to `auto`.

`pw-cat` also runs with `-P '{ state.restore-target = false, state.restore-props = false }'`. Cause of
E23: WirePlumber's `restore-stream` keys its memory on `media.role`, which `pw-cat` sets to `music`, so
**every** `pw-cat` on the machine shares one entry (`Output/Audio:media.role:Music` in
`~/.local/state/wireplumber/stream-properties`) — one `pactl move-sink-input` on a test stream sent
every later utterance to the TV, over the default sink, and a stray volume would ride along the same
way. An explicit `--target` already makes the restore hook skip (`state-stream.lua`, "#335"); the
`-P` opt-out also stops the store hooks writing that shared entry. Details in `~/agents/KB/quirks.md`.

Verified 2026-09-06: a silent stream tagged `Google Chrome` on the HDMI sink → the picker returned the
HDMI sink (the `speech-dispatcher-dummy` stream on the buds correctly ignored); with it gone → the
default (`bluez_output.AC_80_0A_27_65_6C.1`); and one live `POST /bridge/speak` landed its `pw-cat`
sink-input on the bluez sink, which went `RUNNING`.

**No echo cancellation any more** (owner decision, PLAN-LOWRES §7.3). Chromium's AEC came
free with `getUserMedia({echoCancellation: true})`; a raw `pw-cat` capture has none. It
rarely matters — push-to-talk means the Eye is almost never speaking while he is. The
fallback, if it ever does: load PipeWire's canceller
(`pactl load-module module-echo-cancel source_name=eyemic sink_name=eyeout`, or a
`wireplumber.conf.d` drop-in to make it permanent) and let the sidecar/default-source
ladder point at `eyemic`. Not built.

## Open items

- **E06** — the deaf path (no Monitor) is untested: it needs his live ear off.
- **E08** done — WF-1000XM5 push-to-talk works end to end (see `RUNBOOK-earbuds.md`);
  the bud power-cycle reconnect is the one untested path. **E09** — the sidecar already
  puts the buds in HFP while the mic is open; the answer on the buds and the latency
  are not measured.
- **E10** — the screen view: `canvasZoom` and "show me" / "close canvas" verified
  on HDMI-1.
- **E12** done — the display watch. Its `AudioContext` suspend went with the Electron
  renderer in E19; `pw-cat` has no idle stream to suspend. The open question is closed by
  EF10: with this TV in standby **no signal in the machine moves** (sysfs, RandR, DDC, EDID
  and the audio ELD all still say "monitor here"), so the ladder is joined by his own switch,
  `eye tv off|on|auto` — see "TV off" above.
- **E16** done — `audio.js` on `pw-cat`, now the only audio path.
  Verified against the real PipeWire without the owner: playback of a 30 s utterance into a
  null sink (default sink muted for the window) and capture from a `module-pipe-source`
  made default, both restored in a trap. Still needs him awake: the buds themselves (A2DP
  gapless speech, double-tap round trip on HFP) and `body/test/e2e-voice.sh` — it was not
  run because it speaks the brain's reply out loud and wakes the orchestrator's ear.
- **E18** done — the unit runs `node src/main.js`; the eye is `eye-render`, audio is
  `pw-cat`, Electron is resident nowhere. Not verified (owner asleep, buds in):
  speech and the mic through the new body — the 60 fps speaking/mic target of
  `PLAN-LOWRES.md` §3.3, `e2e-voice.sh`, and the double-tap round trip on the switched
  body. The next session with him awake should run those first.
- **E19** done — the Electron eye, its preload and the two flags are deleted; the page
  is parked as `spec/eye-reference.html`. **Phase C is not signed off until an
  independent pass runs `tickets-ubuntu/qa-phaseC.md`** — the items it lists as
  "needs the owner awake" are exactly the ones above.
- Not planned: voice verdicts, auto-`/eye` at boot, eye scaling, exposing the
  bridge over Tailscale.
- `field/` (the standalone 3D field) is untouched by the rewrite.
