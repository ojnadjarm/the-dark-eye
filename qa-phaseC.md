# QA — Phase C (E11–E19), independent pass

Independent QA on the live machine, 2026-09-06 04:50–05:15 CEST. **Nothing was fixed.**
Owner asleep wearing the earbuds: no `eye speak`, no mic, no audio/Bluetooth/Spotify/bluez
change, no `notify-owner`, no clicking his windows, no `killall`. Every hand-run process was
killed by PID. The orchestrator tmux session and its `eye listen-loop` Monitor were left alone.

**Verdict: Phase C passes.** All five `PLAN-LOWRES.md` §3 targets are met on the running unit,
106 node tests and 29 Rust tests are green, every E11–E19 Success check that can run at night
reproduces, and the shipped look matches `spec/eye-reference.html` section for section.
**18 defects below — 3 major.** None of them blocks the shipped single-body configuration, but
**D2** and **D3** are reachable in ordinary operation and should be fixed before the phase is
called finished.

Where this file lives: the brief asked for the repo root next to `qa-phaseA.md`. `qa-phaseA.md`
is actually in `tickets-ubuntu/`, and `tickets-ubuntu/qa-phaseC.md` is the E19 agent's
*checklist* — so this report is at the repo root and that checklist is untouched.
There is no `qa-evidence/` directory: phase A put its screenshots in `tickets-ubuntu/*.png`, so
this pass follows that convention with a `qaC-` prefix.

---

## 1. The `PLAN-LOWRES.md` §3 targets — measured vs target

| # | Target | Measured | |
|---|---|---|---|
| 3.1 | idle body ≤ 1 % of one core | **1.0 %** (`eye-render` 0.9, node body 0.0, voice worker 0.0) — `--state idle --seconds 120` | **PASS**, at the limit |
| 3.1 | GPU render busy ≤ 0.5 % | **0.00 %**; rc6 98 %, `gt_act_freq` 0 MHz | **PASS** |
| 3.1 | no PipeWire stream open when idle | `pgrep -c pw-cat` = **0** | **PASS** |
| 3.2 | TV off → renderer ≤ 0.1 % | **0 CPU ticks over 20 s** (0.00 %), window unmapped | **PASS** (simulated) |
| 3.2 | resume ≤ 1 s after the display returns | on at the **first** on read; window remapped and drawing again at 0.95 % | **PASS** (simulated) |
| 3.2 | speech still plays with the TV off | not run — needs sound | **deferred** |
| 3.3 | renderer ≤ 2 ms CPU per frame | msAvg **1.71 – 2.08** over six 5 s windows (`--demo --busy`, worst case) | **PASS**, marginal — see D7 |
| 3.3 | zero frames over 16 ms in a 30 s window | msMax **7.27 / 4.46 / 4.00 / 4.22 / 5.00 / 4.07** | **PASS** |
| 3.3 | 60 fps while busy | **62.0 – 62.1 fps** | **PASS** (over target — see D6) |
| 3.3 | speaking / mic-open states themselves | not run — makes sound / opens the mic | **deferred** |
| 3.4 | RSS excluding the voice worker ≤ 200 MB | **91 MB RSS / 57 MB PSS** (voice worker 1376 / 1354 alongside) | **PASS** |
| 3.5 | startup ≤ 3 s to the first frame | **0.336 s / 0.321 s / 0.332 s** over three fresh `systemctl --user restart` runs | **PASS** |

Evidence: `body/scripts/measure.sh --state idle --seconds 120` on the unit; three restarts read
from `journalctl -o short-precise` (`Started dark-eye.service` → `eye up at 1010,372`);
`DARK_EYE_STATS=1 timeout 35 body/render/target/release/eye-render --demo --busy --x-offset -700`
for the frame numbers (a second window, over a dark area, gone on timeout — confirmed no orphan).

## 2. E11–E19 Success checks re-run

| # | Check | Result |
|---|---|---|
| E11 | `npm test` | **PASS** 106 pass / 0 fail |
| E11 | `measure.sh --state idle` returns a full table | **PASS** (8 rows + gpu/rc6/freq/fps) |
| E11 | `grep -rn DARK_EYE_STATS body/render/src body/src body/scripts` ≥ 1 | **PASS** 4 hits |
| E12 | `journalctl … \| grep 'display on'` | **PASS** |
| E12 | `grep -n 'display off' RUNBOOK.md` | **PASS** |
| E12 | fake-sysfs TV-off ladder (hand-run body, port 8643, own render socket) | **PASS** — off after 2 reads, on at the first; see §3 |
| E13 | `cargo test` | **PASS** 29 passed / 0 failed |
| E13 | `eye-render` release binary ≤ 6 MB | **PASS** 720 K |
| E13 | `pc win list \| grep -c eye-render` = 1 | **PASS** — `340x380+1010+372` |
| E14 | `--demo` stats msAvg ≤ 2, msMax ≤ 8 | **PASS** (run tonight — see §1) |
| E14 | `measure.sh --state idle \| grep eye-render` ≤ 1.0 % | **PASS** 0.9 % |
| E14 | look at `e14.png` / `e14-zoom.png` vs the shipped eye | **PASS** — see §4 |
| E15 | `--demo --busy` msAvg ≤ 2 | **PASS**, marginal (2.08 in one window) |
| E15 | three `e15-*.png` present | **PASS** |
| E15 | parity vs `spec/eye-reference.html` | **PASS** — see §4 |
| E16 | `pgrep -c pw-cat` = 0 when idle | **PASS** |
| E16 | the echo-cancellation note in RUNBOOK | **PASS** |
| E16 | e2e voice line, double-tap round trip | **deferred — owner** |
| E17 | `pgrep -c electron` = 0 when the canvas is closed | **PASS** |
| E17 | `canvas open in … ms` | **PASS** — 404 ms, exercised directly (§5) |
| E18 | `systemctl --user is-active dark-eye && eye health` | **PASS** active, `{"ok":true,…}` |
| E18 | `pgrep -c electron` = 0 | **PASS** |
| E18 | `measure.sh --state idle --seconds 120` meets §3 | **PASS** — §1 |
| E19 | `spec/eye-reference.html` present, `body/src/eye` absent | **PASS** |
| E19 | `grep -rn 'DARK_EYE_RENDERER\|DARK_EYE_AUDIO\|webContents' body/src \| wc -l` = 0 | **FAIL as written** — returns 3 (see D13); the two flags are genuinely 0 |
| E19 | `tickets-ubuntu/qa-phaseC.md` exists | **PASS** |

## 3. TV-off ladder (E18 fake-sysfs method) — PASS

A second body on port 8643 with its own `DARK_EYE_RENDER_SOCK` and
`DARK_EYE_DISPLAY_SYSFS`, killed by PID afterwards (its renderer too — see D4).

| Step | Observed |
|---|---|
| `status` → `disconnected` | `display off (sysfs status=disconnected dpms=On enabled=enabled)` after ~2 s (2 reads) |
| renderer while off | **0 CPU ticks over 20 s**; `pc win list` drops from 2 `eye-render` rows to 1 |
| `status` → `connected` | `display on (displays=1, status=connected dpms=On enabled=enabled)` at the first read |
| renderer after resume | window remapped at `1010,372`; **0.95 %** over 20 s, identical to the unit's renderer (0.95 %) measured in the same window |

The **real** TV power-cycle is still unobserved and still the owner's item — nothing here
proves this Samsung drops HPD or `dpms` in standby.

## 4. Visual parity — PASS

Screenshots taken with `pc shot` of the eye region `1010,372 340x380` at scale 1.8, against
`tickets-ubuntu/e14.png`, `e14-zoom.png`, `e15-*.png` and `spec/eye-reference.html`.

| Element | Verdict | Evidence |
|---|---|---|
| glyph rain, cat-eye silhouette, lids, phosphor trail | matches E14's shot | `qaC-idle.png`, `qaC-idle-zoom.png` |
| geometry | `CX/CY/RX/RY = 170/316/92/42` in `eye.rs` — **byte-identical** to the reference's line 36–37; window 340x380 bottom-right minus a 16 px margin, `1010,372` on the 1366x768 output | `window.rs`, `pc win list` |
| iris + feline slit | `IRIS_RX/RY = 21/34` and the `slitPulse = 0.75 + 0.25·sin(t·(1.1+4·exc))` line are ported one-for-one; iris eases to the session colour `#b04dff`, exactly as the reference's `sessionTag` default | `eye.rs:20,236-250,310-315` vs `eye-reference.html:412-418,474-488` |
| orbiters | two agents drew cyan `#4dd9ff` and magenta `#ff4dd9` outside the eye, gold burst on `done`, gone after the 1.6 s linger | `qaC-orbiters.png`, `qaC-orbiters-done.png` |
| caption | `⟨ show ⟩ QA card` decoded out of the katakana noise above the eye, no backdrop panel — same as `e15-caption.png` | `qaC-caption.png` |
| everything at once (caption wrap, rings, orbiters) | 7-line wrapped caption, listening ring, orbiters, all in one frame | `qaC-busy-demo.png` |

Method notes: the live eye sits over Spotify's bright artwork, so the busy-state shot was taken
from a `--demo --busy` window over a dark area. `heard` was not in frame (its 4.5 s life had
expired) but its unit test and dirty-rect test are green.

## 5. Failure paths and hygiene

| Test | Result |
|---|---|
| `kill -9` eye-render **by PID** | **PASS** — `eye-render exited (null) — respawning in 3000ms`, back in **3.04 s** at the same `1010,372`; unit `NRestarts=0`, `eye health` ok |
| `kill -9` the voice worker **by PID** | **PASS** — `voice worker exited (null) — respawning in 3s`, `voice ready` **6.5 s** later; the unit was **not** restarted, `NRestarts=0`, StartLimit untouched |
| bridge 413 | **PASS** — 40 MB and 200 MB bodies both answered `413`, body survived both, logged `bridge POST /bridge/show: body too large`; my suspected double-`writeHead` crash after the cap does **not** fire (`res.once("finish", …req.destroy())` wins the race at both sizes) |
| bad key / no key | **PASS** 401 |
| unknown path | **PASS** 404 |
| wrong method | **PASS** 405 with `Allow: GET` |
| malformed JSON | 500 (intentional — there is a test for it); a client's bad body reporting as a server error is arguable but by design |
| `eye <unknown command>` | **PASS** — message + usage, `rc=1`; `eye help` `rc=0` |
| render socket absent | **PASS** — renderer retries every 500 ms at 1.8 % of a core (its normal 8 fps draw) |
| render socket flapping | **FAIL — D1**, 124 % of one core |
| canvas open → close | **PASS** — `canvas open in 404 ms — requested 193,40 980x688, got 193,40 980x688`; **D7 of PLAN-LOWRES §6 is fixed** (x = 193, was 227) |
| resident after close | **PASS** — `pgrep -c electron` 0, no `canvas-app`, no `pw-cat`, no orphan |
| leftover `pw-cat` | **PASS** — 0 throughout, including after every kill |
| journal since the switch (04:45:46 →) | **PASS** — 57 lines, **zero** warning/error lines. All `Failed with result 'exit-code'` entries predate the final unit (development churn 00:08–02:49); the two `Referenced but unset environment variable … DARK_EYE_RENDERER` warnings are from the E18-era unit at 04:29/04:36 and are gone from the current one |
| file modes | **PASS** — `render.sock` 600, its dir 700, `config.json` 600 |
| `npm test` / `cargo test` | **PASS** 106/106 and 29/29, no flakes over the runs done tonight |

---

## 6. Defects

### D1 — `eye-render` burns a whole core if the render socket flaps · **major**

`socket_thread` sleeps `RETRY` only on a **failed** `connect`. A `connect` that succeeds and
then EOFs loops straight back to `connect` with no delay; the `try_clone` error arm `continue`s
with no delay either.

*Repro (run tonight, isolated):* a unix socket that accepts and immediately closes, with
`DARK_EYE_RENDER_SOCK` pointed at it.
*Measured:* **1872 CPU ticks in 15 s = 124 % of one core**, against 27 ticks (1.8 %) for the
same binary with no socket at all.
*Impact:* the frame loop's `display{on:false}` guarantee does not cover this — the socket thread
spins whether the TV is on or off, so the "0 % when the TV is dark" promise fails too.
*Reachability:* not reached by the shipped single body (`render.js` never closes an accepted
connection), but reached by anything else that owns or flaps the socket path — including the
hand-run second body that `RUNBOOK.md` documents as the test procedure.
*Evidence:* `body/render/src/main.rs:47-72`.

### D2 — a dropped `last` chunk wedges the mouth permanently · **major**

`audio.js` only calls `stdin.end()` when `utt.closed` is set, and only calls `finish()` from the
child's `exit`. An utterance that never receives `last: true` therefore (a) never ends its
`pw-cat`'s stdin, so the child never exits, so (b) `finish()` never runs and **every later
utterance sits in the queue forever**, and (c) that `pw-cat` stays resident.

*Repro (pure code, no audio — `createAudio` takes an injectable `spawn`):* play `{seq:0,
last:false}` then a complete `{seq:0, last:true}`.
*Measured:* `pw-cat processes spawned: 1`, `first utterance stdin ended: false`,
`second utterance ever spawned: false`. The Eye is mute until the body is restarted.
*Reachability:* **ordinary.** `voice.js` wraps its whole `speak` loop in one `try`, so a
`tts.generate` throw on sentence 2 of 3 posts `{type:"err"}` and never posts `last`. Killing or
crashing the voice worker mid-utterance does the same — and that is a supported, respawning path
(verified tonight). `main.js` does nothing to the audio queue when the worker exits.
*Fix shape (not applied):* close the open utterance on `voice` `exit`/`err`, and/or a watchdog
that ends a `pw-cat`'s stdin after the chunk's own duration has elapsed.
*Evidence:* `body/src/audio.js:42-62,67-82`, `body/src/voice.js:64,115-117`, `body/src/main.js:159-174`.

### D3 — a `working` orbiter never expires, and pins the eye at 60 fps forever · **major**

`Orbiters::set` gives a non-`working` orbiter `until = now + LINGER_MS` and a `working` one
`None`. `alive()` then returns true forever, `busy()` with it, so the frame loop stays at 60 fps
for the life of the process. `sched.rs` even asserts this: *"a working orbiter never expires on
its own"*. There is also no cap on `list`, so distinct ids accumulate without bound.

*Repro:* `eye status qa1 working "a"; eye status qa2 working "b"`, then measure `eye-render`.
*Measured:* **8.0 % of one core** sustained (vs 0.9 % idle); back to **1.0 %** within seconds of
`eye status … done`.
*Impact:* directly breaks §3.1. Any brain or fleet agent that calls `eye status … working` and
then crashes, is interrupted, or simply forgets the `done` leaves the eye at 8× its idle budget
indefinitely, with no timeout and no way to clear it short of restarting the body.
*Evidence:* `body/render/src/orbit.rs:40-63,68-71`, `body/render/src/sched.rs:107-113,193-194`.

### D4 — a hand-run body leaks its `eye-render` · minor

`main.js` installs no `SIGTERM`/`SIGINT` handler and never calls `render.stop()`, so a plain
`kill` of the body leaves the renderer alive.
*Repro/measured:* killed the hand-run body (PID 1975542); `eye-render` 1975564 reparented to
`systemd --user` (ppid 1846), kept its window on the TV and its ~1 % of a core, and went on
retrying the now-dead socket. Killed by PID afterwards.
*Impact:* production is covered by systemd's cgroup kill, so this bites only the hand-run second
body — which is exactly the procedure `RUNBOOK.md` prescribes for the TV-off and 8643 tests.
The RUNBOOK warns about it in prose; it is still a missing shutdown path in the code.
*Evidence:* `body/src/main.js:236-242`, `body/src/render.js:77-84`.

### D5 — renderer respawn resyncs only `session` and `display` · minor

On `ready`, `main.js` re-sends `session` and (when off) `display`. `ptt` is not re-sent, nor
`status` orbiters nor the live caption. If `eye-render` dies while the mic is open, `micOpen`
stays true in the body but the listening rings never come back until the next toggle — the eye
silently lies about listening.
*Evidence:* `body/src/main.js:78-85`, `body/src/main.js:188-202`.

### D6 — the busy frame rate is 62.5 fps, not 60 · minor

`pub const BUSY_MS: u64 = 1000 / 60;` is integer division → **16**, not 16.67. ~4 % more frames
than the spec and than `spec/eye-reference.html`'s `requestAnimationFrame`.
*Measured:* `fps=62.1, 62.1, 62, 62, 62, 62` over six windows. (`IDLE_MS = 1000/8 = 125` is exact.)
*Evidence:* `body/render/src/sched.rs:11-12`.

### D7 — §3.3's ≤ 2 ms/frame is met only marginally · minor

Worst-case busy frame: msAvg **1.71 / 1.96 / 1.96 / 1.97 / 2.00 / 2.08** — one 5 s window over
the target, one exactly on it. Note this run had a second eye window on screen; a single window
will sit a little lower. Worth a headroom check when the owner's speaking/mic run happens.

### D8 — the body logs UTC while the journal logs local time · minor

`const log = (m) => … new Date().toISOString().slice(11, 23)` prints UTC. Every journal line
reads `Sep 06 04:45:46 … [body 02:45:46.389]`. Every example in `RUNBOOK.md` carries the same
two-hour mismatch, which will cost someone a debugging session.
*Evidence:* `body/src/main.js:25`.

### D9 — `measure.sh`'s idle guard is dead code since E18 · minor

The `--state idle` pre-wait greps the journal for `renderer: play|mic (open|closed)`. The node
body never logs `renderer: play` — it logs `audio chunk seq=…`. So `--state idle` no longer waits
for speech to drain and can silently measure a speaking body as idle. (`idle wait: 0s` in every
run tonight; harmless here because nothing spoke, misleading later.)
*Evidence:* `body/scripts/measure.sh:126-132` vs `body/src/main.js:160`.

### D10 — fps can never be reported on the production unit · minor

`measure.sh` reads fps from the renderer's `stats` lines, which exist only under
`DARK_EYE_STATS=1`. `dark-eye.service` does not set it and no drop-in is documented, so every
run on the unit prints `fps: n/a` — including the tables committed to `RUNBOOK.md` and
`body/scripts/BASELINE.md`. Either set it in the unit or document the drop-in.

### D11 — `bridge/eye.sh` is over its cap · minor

167 lines against E03's `wc -l bridge/eye.sh # ≤ 160`.

### D12 — `RUNBOOK.md` is 2.7× over its cap · minor

322 lines against E05's `≤120`. E19 step 2 split `RUNBOOK-earbuds.md` (107 lines) out precisely
to fix this and it did not get the file back under the cap. The content is good; the cap is
either wrong or the file needs another split.

### D13 — E19's own Success check does not pass as written · minor

`grep -rn 'DARK_EYE_RENDERER\|DARK_EYE_AUDIO\|webContents' body/src | wc -l` is specified as `0`
and returns **3** (`body/src/canvas-app/main.js`). The two flags are genuinely gone; only
`webContents` remains, in the file the ticket explicitly keeps. The E19 agent reinterpreted its
own check in `tickets-ubuntu/qa-phaseC.md` rather than recording it as a miss. Harmless in
substance, but a checklist that rewrites its own criteria is worth flagging.

### D14 — two stale descriptions of the iris · cosmetic

`sched.rs:120-123` — *"The active session's colour, or the eye's own green"* — returns `#b04dff`,
purple. `RUNBOOK.md`'s aesthetic law says *"gold iris + feline slit"*; the iris is
session-coloured (purple by config default), which **is** correct parity with
`eye-reference.html:182-184`. The code comment and the RUNBOOK line are what is wrong.

### D15 — signal deaths log as `(null)` · cosmetic

`render.js` and `main.js` both take only `code` from `exit`, so every `kill -9` reads
`eye-render exited (null)` / `voice worker exited (null)`. The `signal` argument is dropped.
*Evidence:* `body/src/render.js:61`, `body/src/main.js:170`.

### D16 — three unbounded collections · minor

- `queue.js items[]` — transcripts pile up with no cap when no brain is listening (the "I'm
  holding your words" path is deliberate, but it holds *all* of them, forever).
- `orbit.rs list` — no cap on distinct orbiter ids (compounds D3).
- `audio.js utt.pending` — chunks are written with no regard for `stdin.write`'s backpressure
  return, and buffer without limit while an utterance waits behind another.

None was reached tonight; all three are memory growth under a misbehaving caller.

### D17 — no unhandled-rejection safety net · minor

The body installs no `process.on('unhandledRejection')` or `'uncaughtException'`, and
`main.js:193` is `audio.stopCapture().then((samples) => transcribe(...))` with **no `.catch()`**.
Under node 24 an unhandled rejection terminates the process — the eye vanishes and systemd
restarts it 5 s later, burning one of the 5 `StartLimitBurst` slots. Hard to trigger (the
`voiceReady` guard covers the obvious IPC-closed case) but the whole body rides on one
un-netted promise chain.

### D18 — no retry if the render socket fails to listen · minor

`render.js` calls `spawnRenderer()` only from `server.listen`'s callback. If `listen` errors, the
error is logged and nothing else ever happens: the unit stays `active (running)`, `eye health`
answers `{"ok":true}`, and there is no eye — forever, with no restart. Related, smaller: a second
connection overwrites `conn` without destroying the first, leaking that socket.
*Evidence:* `body/src/render.js:52-56,30-51`.

---

## 7. Deferred to the owner

Everything here needs him awake, needs sound, needs the mic, or needs the physical TV.

1. **Real TV power-cycle** (§3.2, RUNBOOK "Open question"). Switch the TV off ~30 s and back on,
   then read `journalctl --user -u dark-eye --since "-5 min" | grep 'display o'` beside
   `cat /sys/class/drm/card1-HDMI-A-1/{status,dpms,enabled}`. No rung has ever been seen moving.
   If none does, his decision on the additive `eye display on|off` fallback.
2. **Speech on the new body** — `eye speak`, gapless A2DP on the buds, `pw-cat` appearing and
   disappearing. *Not attempted:* the night rules allow a muted-null-sink test, but the PTT
   sidecar owns the default-sink ladder and a failure between switching and the trap would leave
   his audio broken at 05:00. Not airtight, so skipped by rule.
3. **`--state speaking` and `--state mic`** — the audio half of §3.3. The renderer half is proved
   above (D7 notes the margin).
4. **Double-tap round trip** on the switched body — mic open, speak, mic closed, `heard (…)`, and
   a single tap still playing/pausing Spotify at unchanged volume. Never done on the node body.
5. **`bash body/test/e2e-voice.sh`** — it speaks the reply out loud and wakes the orchestrator's ear.
6. **`eye show … --ask` → "show me" → approve** on the TV, by voice. Tonight the canvas was driven
   directly through `canvas.js` (open/close/bounds/orphans all clean, D7-of-§6 fixed), but the
   voice intent path and the on-screen verdict were not exercised.
7. **Canvas readability from the couch** at `canvasZoom` 1.5 (E10).
8. **Earbud power-cycle reconnect** — close the case, reopen; the one untested path of E08.
9. **The deaf path (E06)** — with no `/eye` Monitor armed, the Eye should say "No one is
   listening" once and hold the words. Requires his live ear off.
10. **`node body/scripts/tts-test.js 17 "hola"`** — the README's voice check; makes sound.

## 8. Evidence

`tickets-ubuntu/qaC-*.png` (phase A's convention; there is no `qa-evidence/`):

| File | What |
|---|---|
| `qaC-idle.png`, `qaC-idle-zoom.png` | the shipped eye idle, at 1.8× |
| `qaC-orbiters.png`, `qaC-orbiters-done.png` | two agents working, then the gold burst |
| `qaC-caption.png` | `⟨ show ⟩ QA card` decoding above the eye |
| `qaC-busy-demo.png` | caption + rings + orbiters in one frame, over a dark area |
| `qaC-final.png` | the unit's eye after every test |

## 9. State left behind

`dark-eye.service` **active**, `NRestarts=0`, `eye health` → `{"ok":true,"brainListening":true,
"micOpen":false}`, one `eye-render` window `340x380+1010+372` — bottom-right of the 1366x768
output. No stray `eye-render`, `pw-cat`, `electron` or `canvas-app`. Nothing in the repo was
changed except this file and the `qaC-*.png` evidence.

---

## 10. Fixes (2026-09-06 05:15–05:35 CEST, same night, same rules)

Every fix landed with a failing test first. `npm test` **113 pass / 0 fail**, `cargo test`
**34 pass / 0 fail** (was 106 / 29). Release binary rebuilt, unit restarted, one
`eye-render` at `340x380+1010+372`, `eye health` ok, `NRestarts=0`.

| D# | Verdict | Evidence |
|---|---|---|
| D1 | **fixed** | `socket_thread` backs off 200 ms → 2 s on every attempt that carries no message, and resets to 200 ms on the first line read. Same flapping-socket repro: **15 ticks in 15 s = 1.00 % of a core** (was 1872 ticks = 124 %), 11 accepts in 20 s. Tests: `next_backoff` caps at 2 s; a live flapping unix socket yields ≤ 8 `Connected` events in 1.5 s. `main.rs:44-93` |
| D2 | **fixed** | Three parts. (a) `audio.js` gives every utterance an idle timer — 3 s *after the audio already handed over* has finished — that ends its `pw-cat` stdin, so a lost `last` cannot wedge the queue. (b) `audio.endOpen()` closes the open utterance, and `main.js` calls it on the voice worker's `err` **and** its `exit`. (c) `voice.js` generates each sentence in its own `try`, posting `audio` or `err` **per sentence** with `last` on the final one either way — one failing sentence no longer drops the rest of the utterance or its `last`. Tests: fake-spawn repro (next utterance plays, one `pw-cat` per utterance, none left open), `endOpen` repro, and a stubbed-Kokoro voice worker asserting `audio 0 / err 1 / audio 2 last` and `audio 0 / err 1 last`. |
| D3 | **fixed** | `working` orbiters no longer make the eye busy — they draw at the idle 8 fps (`Orbiters::busy` counts only the burst/error states); every orbiter now carries a `until`, `WORKING_TTL_MS = 600_000` refreshed by any status update for that id; `MAX_ORBITERS = 12`, oldest dropped. Repro on the unit: `eye status qa1 working; eye status qa2 working` → **21 ticks over 20 s = 1.05 % of a core** (was 8.0 %). `orbit.rs`, `sched.rs` |
| D4 | **fixed** | `main.js` installs `SIGTERM`/`SIGINT` → `render.stop()` + `voice.kill()`. Journal: `[body 05:28:49.958] SIGTERM — closing the eye`, no orphan `eye-render` after the restart. A `kill -9` of the body still leaks the child (nothing can catch it); RUNBOOK says so now. |
| D5 | **fixed** | `ready` re-sends `ptt` when `micOpen`. Orbiters and the live caption are still not resynced — they are short-lived by design (the caption fades, orbiters expire); a mic left silently open was the lie worth fixing. |
| D6 | **fixed** | `BUSY_MS = 1000/60 = 16` → `BUSY_PATTERN = [17, 17, 16]`, three frames per 50 ms = exactly 60 fps. Test asserts the three deadlines sum to 50 ms. |
| D7 | **skipped** | Measurement, not a defect: the ≤ 2 ms/frame margin needs the owner's speaking/mic run to judge. |
| D8 | **fixed** | The body stamps local time. Journal now reads `Sep 06 05:25:35.734 … [body 05:25:35.996]`. |
| D9 | **fixed** | `measure.sh` greps `audio chunk seq=` (what the node body actually logs) in both the `--state idle` pre-wait and the `--state speaking` drain-wait — the second carried the same dead string. |
| D10 | **skipped** | `DARK_EYE_STATS` on the unit was ruled out of scope by the brief. `fps: n/a` on the unit stands. |
| D11, D12 | **skipped** | Doc line caps are the owner's decision (`eye.sh` 167, RUNBOOK 322 — unchanged). |
| D13 | **skipped** | E19's wording is out of scope by the brief. |
| D14 | **skipped** | Cosmetic wording; not in the fix brief. |
| D15 | **fixed** | `render.js` and `main.js` take `(code, signal)`: `eye-render exited (signal SIGKILL) — respawning in 3000ms`. |
| D16 | **fixed** | All three bounded: `queue.js` holds the last `MAX = 200` transcripts (oldest dropped), `orbit.rs` caps at 12, `audio.js` stops buffering a queued utterance past `maxPendingBytes` (8 MB) and logs `audio buffer full`. Tests for the queue cap, the orbiter cap and the audio cap. |
| D17 | **fixed** | `process.on("unhandledRejection")` and `("uncaughtException")` log and `exit(1)`; the `stopCapture().then(…)` chain has its rejection handler. |
| D18 | **fixed** | `render.js` treats a `listen` error before it is listening as fatal (`onFatal`, `process.exit(1)` by default) — the unit can no longer sit `active` with no eye; a second connection destroys the first instead of leaking it. Test: a socket in a read-only directory calls `onFatal` once. |

### Verification after the fixes

```
$ body/scripts/measure.sh --state idle --seconds 60
state: idle · window: 60s · pids: 3 · idle wait: 0s

| Process | CPU % of one core | RSS MB | PSS MB |
|---|---|---|---|
| eye-render (2137569) | 0.9 | 32 | 19 |
| node body (2137305) | 0.0 | 62 | 40 |
| voice worker (2137568) | 0.0 | 1373 | 1351 |
| **body total** | **0.9** | 1467 | 1411 |
| **body total (excl. voice worker)** | **0.9** | 94 | 59 |

gpu render busy: 0.00 %   rc6: 98 %   gt_act_freq: 0 MHz   fps: n/a
```

Startup, `journalctl -o short-precise`: `Started dark-eye.service` 05:28:49.964 → `eye up at
1010,372` 05:28:50.292 = **0.329 s** (target ≤ 3 s). `kill -9` the renderer by PID:
`eye-render exited (signal SIGKILL) — respawning in 3000ms`, back at `1010,372` **3.04 s**
later, `eye health` `{"ok":true,…}`, `NRestarts=0`.

Not fixed and worth knowing: `test/server.test.js`'s "a body over the cap is answered 413"
flakes (~1 run in 3) with `ECONNRESET` on the writing side. Pre-existing — `server.js` was
not touched — and the 413 itself was verified by hand in §5.

Files changed: `body/src/{main.js,audio.js,voice.js,render.js,queue.js}`,
`body/render/src/{main.rs,orbit.rs,sched.rs}`, `body/scripts/measure.sh`,
`body/test/{audio.test.js,queue.test.js,render-bridge.test.js}`, new `body/test/voice.test.js`,
`RUNBOOK.md` (three lines: the backoff, the orbiter row, the hand-run kill note), this file.
