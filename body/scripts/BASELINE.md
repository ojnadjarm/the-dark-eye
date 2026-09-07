# BASELINE — measured runs of `scripts/measure.sh`

Every run of `bash scripts/measure.sh --state <state> --seconds N --append` adds a
section below. Reference numbers: `PLAN-LOWRES.md` §1; targets: §3.

States and how they are produced:

- `idle` — nothing spoken or heard for 20 s; the script waits for that itself.
- `speaking` — `--allow-sound`, the script says a fixed 45-word paragraph and samples
  until the audio stops. **Pending the owner (awake, buds off or willing).**
- `mic` — `--allow-sound`, `eye mic on`, 20 s, `eye mic off`. **Pending the owner.**
- `tvoff` — a human turns the TV off first; the run only labels the window and prints
  `card1-HDMI-A-1` status/dpms/enabled.

`fps: n/a` means the running body was started without `DARK_EYE_STATS=1`, so the
renderer emits no `renderer: fps=…` line. Set it in the unit's environment and restart
to fill that row — never restart just to take a measurement of the current state.

## 2026-09-06 02:23 — state=idle, 60s

state: idle · window: 60s · pids: 12 · idle wait: 0s

| Process | CPU % of one core | RSS MB | PSS MB |
|---|---|---|---|
| gpu-process (491222) | 3.9 | 169 | 63 |
| audio service (492839) | 3.4 | 93 | 26 |
| renderer (491239) | 3.2 | 274 | 201 |
| cat (491172) | 0.0 | 7 | 3 |
| main (491186) | 0.0 | 206 | 108 |
| network service (491226) | 0.0 | 84 | 22 |
| node cli (491171) | 0.0 | 47 | 43 |
| unit shell (490931) | 0.0 | 7 | 3 |
| voice worker (491246) | 0.0 | 2238 | 2163 |
| zygote (491193) | 0.0 | 65 | 12 |
| zygote (491194) | 0.0 | 65 | 10 |
| zygote (491196) | 0.0 | 16 | 4 |
| **body total** | **10.5** | 3272 | 2659 |
| **body total (excl. voice worker)** | **10.5** | 1035 | 497 |

gpu render busy: 0.37 %
rc6: 97 %
gt_act_freq: 0 MHz
fps: n/a

Notes on the run above:

- Within ±25 % of §1 for CPU everywhere (gpu-process 3.9 vs 3.7, audio service 3.4 vs 3.2,
  renderer 3.2 vs 3.5, total 10.5 vs 10.5) and for the voice worker's 2238 MB RSS.
- The one row outside the band is the renderer's memory: 274 MB RSS / 201 MB PSS against
  §1's 198 / 138. The process is the same one §1 measured, an hour older; the growth is the
  renderer's own V8 heap and canvas backing store, not a second window.
- `fps: n/a` because the unit runs without `DARK_EYE_STATS=1`. Measured separately by
  restarting the unit once with it set: `renderer: fps=7.9 ms=4.3/13.7` — 8 fps idle at
  ≈4.3 ms of renderer CPU per frame, which is §1's ≈4.4 ms. The unit was put back as found.

## 2026-09-06 03:17 — state=idle, 60s

state: idle · window: 60s · pids: 1 · idle wait: 0s

| Process | CPU % of one core | RSS MB | PSS MB |
|---|---|---|---|
| eye-render (1256643) | 1.0 | 30 | 17 |
| **body total** | **1.0** | 30 | 17 |
| **body total (excl. voice worker)** | **1.0** | 30 | 17 |

gpu render busy: 0.00 %
rc6: 95 %
gt_act_freq: 0 MHz
fps: n/a

Notes on the run above (E14, the native renderer's full idle look):

- `MEASURE_PIDS` on a hand-run `eye-render` (no socket, so nothing is ever busy),
  next to the untouched Electron eye. **1.0 % of one core, 30 MB RSS / 17 MB PSS**
  against the Electron renderer + gpu-process's 7.1 % and 443 MB in the run above.
- Its own `DARK_EYE_STATS=1` line over the same window: `fps=8 msAvg=1.05..1.21
  msMax=1.26..2.50` — §3's ≤1.2 ms idle frame, against the Electron renderer's 4.3 ms.
- Busy, same binary, `--demo` (≈85 % of the window at 60 fps): **6.0 %**, `fps=62
  msAvg=1.05..1.19 msMax=1.72..3.32`. A pure 60 fps run is therefore ≈6.6 % of one
  core, against §1's ≈28 % for the Electron pair at the same rate.
- Atlas build (41 glyphs × 5 tiers, plus the 7 pre-scaled sizes): 19-26 ms at start.

## 2026-09-06 04:06 — E16, the pw-cat audio path (hand-run, not `measure.sh`)

Night rules: the owner asleep wearing the buds. Playback went to a `module-null-sink`
(`PIPEWIRE_NODE=eyetest`) with the default sink muted for the whole window; capture came
from a `module-pipe-source` made the default source, as `test/e2e-voice.sh` does. Default
sink, default source, mute state and modules were restored in a trap; the bluez card
profile was never touched. Both harnesses drove `src/audio.js` itself.

| Path | CPU % of one core | When it exists |
|---|---|---|
| `pw-cat -p` playing a 30 s utterance | **0.15** | only while a chunk is unplayed — exits 0 at +30.07 s, `pgrep -c pw-cat` = 0 three seconds later |
| `pw-cat -r` recording 2.3 s | **< 0.2** (below the 10 ms `/proc` tick over the window) | only between `ptt on` and `ptt off` |
| Electron audio service (§1, and the 02:23 run above) | **3.2-3.4** | 24/7, silent or not |

`pipewire` itself idles at **1.0 %** with nothing playing and read **1.2 %** across the
playback window, so the stream's marginal cost on the daemon is ≈0.2 %; `wireplumber`'s
1.0 % over the window is the test rig's module load/unload (0 % idle). The saving is
therefore the whole audio service: **≈3.3 % of one core and 93 MB RSS**, for ≈0.35 % only
while a mouth is open.

Round trips: 6 s and 30 s utterances of three chunks each drained in 6.04 s / 30.07 s with
one process and no gap; `speaking ms=` came out 2000 / 3992 / 5989 for the 6 s one (each
chunk extends what is still to play). Capture returned 36837 samples = 2.30 s over 2.31 s
of wall clock, peak 0.108 for a -20 dBFS tone, and logged `mic captured 2.3s`.

## 2026-09-06 04:31 — state=idle, 120s

state: idle · window: 120s · pids: 3 · idle wait: 0s

| Process | CPU % of one core | RSS MB | PSS MB |
|---|---|---|---|
| eye-render (1754415) | 1.0 | 30 | 17 |
| node body (1754153) | 0.0 | 62 | 40 |
| voice worker (1754414) | 0.0 | 1366 | 1344 |
| **body total** | **1.0** | 1457 | 1401 |
| **body total (excl. voice worker)** | **1.0** | 91 | 57 |

gpu render busy: 0.00 %
rc6: 98 %
gt_act_freq: 0 MHz
fps: n/a

## 2026-09-06 04:47 — state=idle, 60s

After E19 (the Electron eye deleted) and a `systemctl --user restart`: the same
1.0 % and the same look as the E18 row above — E19 removed only dead code.
First frame after the restart: **0.33 s** (`Started` 04:45:46.113 → `eye up` …46.444).

state: idle · window: 60s · pids: 3 · idle wait: 0s

| Process | CPU % of one core | RSS MB | PSS MB |
|---|---|---|---|
| eye-render (1868615) | 0.9 | 30 | 17 |
| node body (1868351) | 0.0 | 56 | 34 |
| voice worker (1868614) | 0.0 | 1362 | 1340 |
| **body total** | **1.0** | 1447 | 1391 |
| **body total (excl. voice worker)** | **1.0** | 85 | 51 |

gpu render busy: 0.00 %
rc6: 98 %
gt_act_freq: 0 MHz
fps: n/a

## 2026-09-06 11:09 — state=idle, 60s

E20: the idle rate is `DARK_EYE_IDLE_FPS`, default **30**. Measured on the unit, one
60 s idle window each, only the rate changed:

| idle fps | eye-render CPU % of a core | gpu render busy | rc6 | msAvg | msMax |
|---|---|---|---|---|---|
| 8 (old) | 0.9 | 0.00 % | 98 % | 1.2 | 2.5 |
| **30** | **3.3** | 0.00 % | 92 % | 1.2 | 6.6 |
| 60 | 6.7 | 0.00 % | 81 % (600 MHz) | 1.2 | 6.7 |

`msAvg` does not move with the rate — the cost is one frame's work times the rate, so
60 fps idle would cost 6.7 %, over the ≤4 % budget. The table below is the shipped 30.

state: idle · window: 60s · pids: 3 · idle wait: 0s

| Process | CPU % of one core | RSS MB | PSS MB |
|---|---|---|---|
| eye-render (207688) | 3.3 | 30 | 17 |
| node body (207417) | 0.1 | 56 | 34 |
| voice worker (207687) | 0.0 | 1364 | 1342 |
| **body total** | **3.4** | 1449 | 1393 |
| **body total (excl. voice worker)** | **3.4** | 85 | 51 |

gpu render busy: 0.00 %
rc6: 92 %
gt_act_freq: 0 MHz
fps: 29.9 (ms 1.1 avg, 5.1 max)

## 2026-09-06 14:31–15:05 — G06, the `PLAN-GPU.md` §3 table (software 30 vs GPU 60)

Method: SPIKE §4, three baselines interleaved. Five 60 s windows, `SECS=60 SETTLE=6`, in the
order below. The production `dark-eye.service` eye (software, 30 fps idle) ran throughout and
is inside every row, baselines included — it *is* the `soft-30-idle` row, so no second software
eye was started. The GPU rows are a hand-run `eye-render` **in addition** to it, offscreen at
`--x-offset -1400` (x = −390; `-700` is x = 310, on the TV — G05 deviation 4) with
`DARK_EYE_RENDER_SOCK=/tmp/dead.sock` and `DARK_EYE_STATS=1`, killed by PID.

Also running, unchanged, in every window: the five Moodle/`moodle-shared` docker containers
(`dockerd` + `containerd` ≈ 0.6 core), gnome-shell, pipewire, and a **runaway
`xdg-desktop-portal-gtk` (pid 3293) burning a constant 100 % of one core** for 16 h before the
run and through all five windows. No Chrome. Load average 4–7 of 16 threads. Owner-owned
processes, not touched.

### The table

| Row | CPU % of a core | msAvg | msMax | RSS MB | PSS MB | GPU busy % | proc GPU % | GPU MHz | RAPL uncore W | first frame |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline (unit only) | — | — | — | — | — | 7.99 | — | 52 | 0.041 | — |
| **soft-30-idle** (the unit) | **3.2** | 1.1 † | 5.1 † | 32 | 20 | 8.00 | 0.00 | 32 | 0.044 | 0.05 s binary / 0.34 s unit ‡ |
| **gpu-60-idle** | **1.8** | 0.24 | **5.19** | 103 | 47 | 10.42 | 4.32 | 85 | 0.054 | 0.09 s binary / ≈0.38 s unit ‡ |
| **gpu-60-busy** (`--demo --busy`) | **2.1** | 0.29 | **9.08** | 105 | 49 | 10.59 | 5.74 | 45 | 0.058 | — |
| baseline (repeat) | — | — | — | — | — | 7.98 | — | 35 | 0.042 | — |

† The unit runs without `DARK_EYE_STATS=1` and must not be restarted for a measurement, so the
software frame times are the 11:09 row above (unit, 30 fps idle: `fps: 29.9 (ms 1.1 avg, 5.1
max)`). Five hand-run software eyes over the same afternoon read `msAvg 1.21–1.31, msMax
3.89–7.00` — the same frame cost.
‡ First frame, 5 runs each, wall clock from `exec` to the `backend …` line (the last thing
before the loop) plus the first swap, bounded by the first `stats` window's `msMax`:
GPU `window` at 43–49 ms, `backend gpu` at **84–97 ms**, first swap ≤ 5.6 ms → **≈0.09–0.10 s**;
software `window` at 43–52 ms, `backend software` at **49–57 ms**, first swap ≤ 7.0 ms →
**≈0.06 s**. The unit adds node spawn + socket: RUNBOOK measures 0.34 s end to end today with
the 0.06 s software binary, so the GPU binary's +0.04 s puts the unit at **≈0.38 s** — an
estimate, not a restart.

`speaking` and `mic` make sound and were not run; `--demo --busy` is the busy stand-in
(captions revealing, orbiters, rings, ≈60 fps throughout).

Raw `measure-gpu.sh` lines, `name|cpu%|rssMB|pssMB|gpuBusy%|procGpu%|MHz|pkgW|coreW|uncoreW`
(the second baseline was run as `baseline-repeat`; the `soft-30-idle` line is the GPU side only —
its CPU/RSS/PSS come from `measure.sh` with `MEASURE_PIDS=468111`, run over the same window):

```
baseline|0.0|0|0|7.99|0.00|52|15.43|11.20|0.041
soft-30-idle|0.0|0|0|8.00|0.00|32|15.45|11.28|0.044
gpu-60-idle|1.8|103|47|10.42|4.32|85|15.43|11.17|0.054
gpu-60-busy|2.1|105|49|10.59|5.74|45|15.41|11.11|0.058
baseline|0.0|0|0|7.98|0.00|35|15.45|11.30|0.042
```

### `PLAN-GPU.md` §3 gates

| # | Gate | Measured | |
|---|---|---|---|
| 1 | 60 fps idle and busy; `display{on:false}` → 0 CPU ticks over 20 s; resume ≤ 1 s | `fps=59.5` in all 26 five-second windows (13 idle, 13 busy); **0 ticks** over 20 s unmapped; 5 ticks in the 3 s after `display{on:true}` | **pass** |
| 2 | `eye-render` ≤ 2.5 % of a core idle, ≤ 4 % busy | **1.8 %** idle, **2.1 %** busy | **pass** |
| 3 | RSS ≤ 130 MB excl. the voice worker; PSS alongside | **103 MB** idle / **105 MB** busy; PSS 47 / 49 | **pass** |
| 4 | First frame ≤ 0.5 s from unit start | binary 0.09–0.10 s; unit ≈ **0.38 s** (estimate, ‡) | **pass** |
| 5 | No frame > 16 ms in a 60 s `DARK_EYE_STATS=1` window, idle and busy | `msMax` **5.19** idle, **9.08** busy (both in the first window, which carries the atlas build and shader compile; every later window ≤ 2.57 idle, ≤ 2.25 busy) | **pass** |
| 6 | Reported, not gated: system GPU busy, proc `drm-engine-render`, RAPL uncore delta | GPU busy 8.0 → 10.4 idle / 10.6 busy; proc GPU 4.32 / 5.74 %; uncore **+0.013 W** idle, **+0.017 W** busy over a 0.041–0.042 W baseline (repeats to ±0.001 W) — the software eye's own delta is +0.003 W | **reported** |

Reading of row 6, for the record: the GPU backend at 60 fps costs the CPU **1.8 %** where the
software backend costs **3.2 %** at half the rate (and 6.7 % at 60 fps, the 11:09 table), for
**+71 MB of RSS** and **+0.010 W** of iGPU power. Same conclusion as SPIKE §5, now with
captions, orbiters, rings and the heard line drawn.

## 2026-09-06 14:52 — state=idle, 60s — **G07: the unit on the GPU backend**

`GPU_DEFAULT = true`, one `systemctl --user restart dark-eye` at 14:51:09 with the owner's
word. Journal: `EGL 1.5 · Mesa Intel(R) Iris(R) Xe Graphics (ADL GT2) · OpenGL ES 3.2`,
`backend gpu`, `eye up at 1010,372 (340x380) on HDMI-1 (gpu)` — first frame **0.312 s**
(`Started` 14:51:09.708983 → `eye up` 14:51:10.021084). This is the G06 `gpu-60-idle` row
measured on the unit instead of a hand-run eye: 2.0 % vs 1.8 %, 103 MB either way, against
the software unit's 3.3 % / 30 MB at 30 fps. `fps: n/a` — the unit runs without
`DARK_EYE_STATS=1`, and is not restarted for a measurement.


state: idle · window: 60s · pids: 3 · idle wait: 0s

| Process | CPU % of one core | RSS MB | PSS MB |
|---|---|---|---|
| eye-render (1698893) | 2.0 | 103 | 48 |
| node body (1698629) | 0.0 | 56 | 34 |
| voice worker (1698892) | 0.0 | 1364 | 1342 |
| **body total** | **2.0** | 1523 | 1424 |
| **body total (excl. voice worker)** | **2.0** | 159 | 82 |

gpu render busy: 1.15 %
rc6: 83 %
gt_act_freq: 0 MHz
fps: n/a

## EF01 — dockerd + containerd idle churn (2026-09-06 19:11–19:20)

Same sampler, 60 s (90 s after the fix), 5 Moodle containers up throughout, no stack and no
docker/containerd restart at any point.

| Window | dockerd CPU % | dockerd cs/s | containerd CPU % | containerd cs/s | machine cores |
|---|---|---|---|---|---|
| baseline | 12.13 | 3329 | 12.47 | 3286 | 1.15 |
| netdata stopped (bisect) | 0.07 | 20 | 0.08 | 15 | 0.26 |
| after fix (netdata up, docker job at 60 s) | 0.57 | 213 | 0.59 | 213 | 0.46 |

Cause: netdata's `go.d` docker collector polls `GET /v1.52/images/json` once per cycle, and on
Docker 29's containerd image store (`io.containerd.snapshotter.v1`) that call re-walks the whole
content store. Measured per call over 20 calls: `/images/json` 229 ms dockerd + 249 ms containerd,
`/containers/json?all=1` 26 ms + 28 ms, `/info` 2.5 ms + 0.5 ms. At netdata's 2 s cycle (one
`/info`, one `/images/json`, four filtered `/containers/json`) that is the whole 24 %.

Fix: `/etc/netdata/go.d/docker.conf` pins the job to `update_every: 60`. Combined 24.6 % → 1.16 %.

## 2026-09-06 19:40 — EF05, Kokoro fp32 vs int8 and the arena that never shrinks

Hand-run workers only (`scripts/tts-test.js --bench`), no sink loaded and nothing played:
the bench writes WAVs and reads its own `smaps_rollup`. The unit was not restarted and still
loads the fp32 model. Text: the 45-word `measure.sh` paragraph (2 chunks, 11.9 s of audio),
speaker 17, `numThreads: 4`; ASR is the same Parakeet int8 on one thread in both columns.
Medians of 6 utterances / 10 decodes, two interleaved passes (a 20/20 pass first, same numbers).

| | **fp32** `kokoro-multi-lang-v1_0` | **int8** `kokoro-int8-multi-lang-v1_0` |
|---|---|---|
| model on disk | 384 MB (`model.onnx` 326 MB) | 182 MB (`model.int8.onnx` 114 MB) |
| TTS init | 1.10–1.19 s | 1.19 s |
| **time to first chunk** | **1.87 s cold, 2.45 s median** | **5.20 s cold, 5.17 s median** |
| **total for the paragraph** | **5.81 s** (2.1× realtime) | **12.2 s** (0.97× realtime) |
| decode of a 1.1 s clip | 196–201 ms | 202–241 ms |
| **RSS fresh** (TTS + ASR loaded) | **1372 MB** | **1169 MB** |
| **RSS after 20 utterances** | **1708 MB** | **1534 MB** |
| **RSS after 20 more transcriptions** | **1716 MB** | **1541 MB** |

WAVs for the owner's A/B: `scripts/ab/fp32.wav`, `scripts/ab/int8.wav` (same paragraph, sid 17).

**Recommendation: keep fp32.** int8 buys 203 MB fresh / 175 MB warm and costs **2.1× the
latency** — the first sound arrives 2.7 s later and a 12 s answer takes 12 s to synthesise, i.e.
no faster than it is spoken, so any answer longer than a sentence would stutter. §3's "first-audio
time unchanged" fails outright, and the ticket's ≤ 1.1 GB fresh is missed by int8 too (1.17 GB):
the 1.0 GB is the two models plus the arena, not the 200 MB the quantisation saves. The model is
downloaded and sits beside the fp32 one; the switch is `voiceModelDir` in `config.json` (or
`DARK_EYE_VOICE_MODEL_DIR`), default `kokoro-multi-lang-v1_0`, so the owner's A/B can be
honoured either way without another download.

The growth is the ORT CPU arena, and it is the utterances that grow it, not the decodes:
+336 MB over 20 utterances (fp32), +8 MB over 20 decodes on top. It never comes back.
So the cap is `src/recycle.js`: every 5 min the body reads the worker's `smaps_rollup`, and
over `DARK_EYE_VOICE_RSS_MAX_MB` (1600) **and** no speak, decode or mic for 10 min it kills the
worker — the existing 3 s respawn path, with speech asked for meanwhile queued, logged as
`voice worker recycled at N MB`. `DARK_EYE_VOICE_RSS_MAX_MB=0` disables it. Expected effect:
the 2.2–3.5 GB evening RSS is capped at ≈1.7 GB, and a fresh worker after every quiet spell.

## EF02 — what the compositor pays for the 60 fps eye (2026-09-06 19:42–19:48)

Steps 1 and 3 only. The unit was **not restarted and the frame rate not changed**: every number
below is the shipped eye (GPU backend, 60 fps idle, pid 3285018, 47 min old at the first window),
TV off, owner away. `sample.sh`, 5 × 60 s back to back, nothing else of this agent's running.

| Window | gnome-shell CPU % | cs/s | Xwayland CPU % | eye-render CPU % | machine cores |
|---|---|---|---|---|---|
| 19:42:50 | 20.53 | 454.5 | 1.05 | 1.98 | 0.33 |
| 19:43:50 | 21.68 | 453.7 | 1.07 | 2.12 | 0.35 |
| 19:44:51 | 21.50 | 453.9 | 1.08 | 2.08 | 0.34 |
| 19:45:51 | 21.42 | 453.4 | 1.07 | 2.03 | 0.33 |
| 19:46:51 | 20.82 | 456.0 | 1.07 | 2.00 | 0.34 |
| **mean** | **21.19** | 454.3 | **1.07** | **2.04** | 0.34 |

RSS/PSS steady across all five: gnome-shell 682/583 MB, Xwayland 98/48, eye-render 132/77.
`PLAN-EFFICIENCY.md` §1 read 21.5 / 1.0 / 2.0-2.2 — the same box, and EF01's docker fix took the
machine from 1.15 cores to 0.34.

### Where gnome-shell's 21 % goes

`perf record -F 999 -g -p 2138` for 20 s at idle, 8285 samples, with `gnome-shell-dbgsym`
50.1-0ubuntu1.2 and `libmutter-18-0-dbgsym` 50.1-0ubuntu2.2 from the ddebs repo (added as
`/etc/apt/sources.list.d/ddebs.sources`; the installed versions, not `-proposed`; docker untouched).
Samples folded by the stack, not by the leaf:

| Bucket | % of gnome-shell CPU | What it is |
|---|---|---|
| **`libatspi` D-Bus source** | **42.8** | `meta_context_run_main_loop` → glib prepare/check → libatspi → `dbus_connection_get_dispatch_status`, which takes the connection mutex. Leaves: `pthread_mutex_lock` 1779 samples, `pthread_mutex_unlock` 731, `dbus_connection_get_dispatch_status` 333. |
| **glib main loop itself** | **36.9** | `g_source_ref` (599 leaf samples), `g_mutex_lock`/`unlock`, the unnamed `g_main_context_prepare`/`check` walk over every source, per iteration |
| clutter/cogl paint | 10.9 | the actual composite; `cogl_onscreen_egl_swap_buffers_with_damage` is the top named mutter frame in it (5.2 % of the non-atspi samples) |
| KMS thread | 7.6 | `drmModeAtomicCommit` and the buffer bookkeeping around it, on its own thread (630 samples) |
| wayland event source, gjs, other | 1.7 | |

**The dominant cost is per-main-loop-iteration, not per-pixel.** Roughly 80 % of gnome-shell's CPU
is the cost of *waking up*: every iteration of mutter's main loop walks the source list and asks the
a11y D-Bus connection whether it has anything, and that check alone is 43 % of the process. Real
compositing — paint plus swap plus the atomic commit — is ≈ 18 %. Note that `toolkit-accessibility`
is on by design (`quirks.md`: `pc tree` needs it), so the 43 % is the price of the agent desktop,
not of the eye.

That cost is **rate-fixed**: the eye's frame clock is what makes the loop iterate 60 times a second,
and nothing about a frame's *content* or *area* changes what one iteration costs. The netdata step
the plan already recorded fits a straight line — 5.1 % at 8 fps, 21.2 % at 60 — i.e.
`gnome-shell ≈ 2.6 % + 0.315 % per fps`. On that line 30 fps is ≈ 12 % and 15 fps ≈ 7.3 %, and
**≤ 10 % is not reachable at 60 fps** by any change to how the eye draws. Step 2's rate table is the
lever; step 3's partial damage can only touch the 10.9 % paint bucket.

### `DARK_EYE_SWAP_DAMAGE=1` — partial damage on the GPU backend

`eglSwapBuffersWithDamageKHR` with the rect the frame actually changed, behind the flag; unset =
today's `eglSwapBuffers`, byte for byte. The rect is the software backend's own `dirty`, now a
shared `eye::dirty_rect(st)` (eye ∪ orbiters ∪ heard ∪ caption) unioned with the previous
*presented* frame's rect, clamped to the window and flipped to EGL's bottom-left origin. Idle that
is `DIRTY` = 280×160 of the 340×380 window — **35 % of the area** the full swap posts today. The
whole frame is still drawn every time, so the damage is a present hint only and the pixels are
unchanged; `Backend::paint`'s unmapped arm calls `full_damage()` so the first frame after a remap
damages everything.

- `cargo build --release` green; `cargo test --release` green offscreen
  (`DARK_EYE_RENDER_SOCK=/tmp/dead.sock`), parity `1 passed` — the parity harness is surfaceless,
  so it proves the pixels, not the swap.
- Offscreen hand-run, `--x-offset -1400` (window at −390,372), `DARK_EYE_SWAP_DAMAGE=1`:
  `[eye-render] swap damage: on` — the extension is there on this XWayland EGL display — then
  `backend gpu`, `fps=59.4 msAvg=0.24 msMax=0.55`, 2.00 % of a core, 103 MB RSS. Same as G06's
  `gpu-60-idle` row: the flag costs the renderer nothing.

**Does mutter honour it?** Yes, and neither ARGB nor override-redirect changes that. Read from the
installed version's source (mutter 50.1, `mutter_50.1.orig.tar.xz`):

- `src/wayland/meta-wayland-surface.c:303 surface_process_damage()` — the client's buffer damage is
  intersected with the buffer rect and handed on rect by rect to `meta_surface_actor_process_damage()`.
- `src/compositor/meta-surface-actor-wayland.c:52 meta_surface_actor_wayland_process_damage()` →
  `meta_surface_actor_update_area()`.
- `src/compositor/meta-surface-actor.c:434 meta_surface_actor_update_area()` → line 468/476
  `clutter_actor_queue_redraw_with_clip()`. Nothing in the path tests for a visual, an alpha channel
  or override-redirect — under XWayland there is no `meta-surface-actor-x11.c` in 50.x at all, so an
  X11 client's window is an ordinary Wayland surface to mutter.
- `src/backends/meta-stage-impl.c:441 should_use_clipped_redraw()` — the clip is used unless the
  redraw clip is NULL (full redraw), `CLUTTER_DEBUG_DISABLE_CLIPPED_REDRAWS` is set, the buffer age
  is invalid, or the onscreen is in its first 3 frames.

What ARGB *does* cost: `meta_surface_actor.c:353 subtract_opaque_region()` cannot subtract the eye
from what is painted behind it, so the wallpaper under the damage rect is repainted too — work
proportional to the damage area, which is exactly what a smaller rect reduces.

**Expected gain, stated before the measurement:** the flag shrinks the damaged area to 35 % of a
window that is itself 9 % of a 1366×768 output, inside the 10.9 % paint bucket. That is ≈ 1–2 points
of gnome-shell's 21 %, against step 4's "keep it only if it drops ≥ 5 points". The honest prediction
is that the flag does not pay and the rate table is the only real lever. Steps 2 and 4 measure it.

### Steps 2 and 4 on the unit — the rate table and what the flag bought (2026-09-06 19:52–19:56)

One batched window of four restarts, announced to the owner, TV off, nothing else of this agent's
running. Each row: a `dark-eye.service.d/ef02.conf` drop-in, `daemon-reload`, `systemctl --user
restart dark-eye`, **15 s settle**, the `eye-render` pid re-read, then `sample.sh 60` over
gnome-shell (2138), Xwayland (2593) and that pid. The drop-in was removed and the unit restarted
a fourth time at 19:56:34; `ls ~/.config/systemd/user/dark-eye.service.d` is absent again.

| Row | idle fps | swap damage | eye-render pid | gnome-shell CPU % | cs/s | Xwayland CPU % | eye-render CPU % | machine cores |
|---|---|---|---|---|---|---|---|---|
| baseline (19:42–19:48 mean, 5 × 60 s) | 60 | off | 3285018 | **21.19** | 454.3 | 1.07 | 2.04 | 0.34 |
| **A** | 60 | **on** | 3590809 | **20.83** | 449.2 | 1.03 | 2.25 | 0.43 |
| **B** | 30 | off | 3593810 | **11.65** | 220.5 | 0.58 | 1.40 | 1.05 |
| **C** | 15 | off | 3598262 | **5.85** | 122.3 | 0.33 | 0.80 | 0.14 |

RSS/PSS did not move across the four rows: gnome-shell 682/583 MB, Xwayland 98/48, eye-render
107–108/51. `[eye-render] swap damage: on` appears only in row A's journal; every row logged
`backend gpu`, `eye up at 1010,372 (340x380) on HDMI-1 (gpu)` and `voice ready` ≈2.8 s later.
The `machine cores` column is the whole box and is noise here — row B caught a Moodle container
and row A this agent's own `npm test` tail; the three per-process columns are the measurement.

**`DARK_EYE_SWAP_DAMAGE=1`: not kept.** Row A is **0.36 points** below the baseline — inside the
±0.6 spread of the baseline's own five windows, and far under step 4's ≥ 5-point keep gate. The
prediction written before the run (≈1–2 points, "the honest prediction is that the flag does not
pay") was right and generous. The code stays in the binary and the flag stays documented and
**off**: it is correct, it costs the renderer nothing measurable (2.25 vs 2.04 %, one window each),
and it would matter on a compositor whose cost were per-pixel. Mutter's is not.

**The rate is the whole lever, and it is linear.** Fitting the three rows plus the 8 fps night
(5.1 %): `gnome-shell ≈ 2.6 % + 0.31 % per fps` — the line EF02 step 1 predicted from `perf`,
now measured end to end. Each halving of the idle rate halves gnome-shell, Xwayland and
eye-render together, because the cost is one main-loop iteration times the rate and nothing
about a frame's content changes what an iteration costs.

| idle fps | gnome-shell | Xwayland | eye-render | the three together |
|---|---|---|---|---|
| 60 (shipped) | 21.2 % | 1.07 % | 2.04 % | **24.3 %** |
| 30 | 11.7 % | 0.58 % | 1.40 % | **13.6 %** |
| 15 | 5.9 % | 0.33 % | 0.80 % | **7.0 %** |

≤ 10 % for gnome-shell is reachable only at ≈ 24 fps or below. **Nothing was changed**: the unit
came back at 19:56:34 on the shipped 60 fps with no drop-in, and the rate is the owner's call
(`RUNBOOK.md`, "The idle frame rate") — 8 fps was already rejected as choppy on the TV.

## 2026-09-06 19:58 — state=idle, 60s

state: idle · window: 60s · pids: 3 · idle wait: 0s

| Process | CPU % of one core | RSS MB | PSS MB |
|---|---|---|---|
| eye-render (3599622) | 2.2 | 108 | 51 |
| node body (3599383) | 0.1 | 63 | 42 |
| voice worker (3599621) | 0.0 | 1373 | 1351 |
| **body total** | **2.2** | 1544 | 1444 |
| **body total (excl. voice worker)** | **2.2** | 171 | 93 |

gpu render busy: 1.19 %
rc6: 83 %
gt_act_freq: 0 MHz
fps: n/a

Notes on the run above (EF05 step 5 — the unit on the recycler build):

- The first idle window after the 19:56:34 restart that put the unit on the tree carrying
  `src/recycle.js`. Same shape as G07's 14:52 row (eye-render 2.0 → 2.2 %, 103 → 108 MB): the
  recycler is a 5-minute `setInterval` reading one `smaps_rollup`, and it costs nothing visible.
- **Voice worker fresh: 1373 MB** (PSS 1351), against the 1364 MB of the G07 row and the
  1708–1720 MB an evening of turns used to reach. `DARK_EYE_VOICE_RSS_MAX_MB` is 1600 and the
  worker must also have been quiet 10 min, so **no recycle was due and none happened**: zero
  `recycled` lines in the journal over the 2 min 36 s after the restart, RSS flat at 1373 MB.
  The cap earns its keep later tonight, after the arena has grown.
- `fps: n/a` as always — the unit runs without `DARK_EYE_STATS=1` and is not restarted to measure.

## EF09 — sentinel-check tick cost, journal duplication, timer duplication (2026-09-06)

`~/agents/bin/pc-status` and `~/agents/bin/sentinel-check` (backups in `~/agents/backups/ef09/`,
also `lockcheck.sh` and `pc-mode` — touched to fold their `gsettings get` calls into the same
per-schema `list-recursively` change, see the file-by-file list below).

### `Consumed` — `systemctl --user start sentinel-check; journalctl --user -u sentinel-check -n 1 -o cat`

| | Before | After (3 consecutive ticks, warm cache) |
|---|---|---|
| Consumed | `Consumed 1.060s CPU time over 6.426s wall clock time` (2.8-2.96 s before EF04) | `269ms` / `255ms` / `259ms` CPU (6 ticks read: 255-282 ms, one 627 ms outlier attributed to a 60 s-TTL docker/tailscale re-probe landing on that tick, not a regression — `sentinel-runaway`, EF03's file, is untouched and also varies tick to tick) |

### `pc status --json --fresh` (cold, everything recomputed) vs `pc status --json` (warm, 900 s TTL caches populated)

| | Before (baseline) | After — `--fresh` | After — warm |
|---|---|---|---|
| exec count (`strace -f -e trace=execve`) | 199 | 129 | **59** |
| wall | 1.70 s | 0.71 s | 0.11 s |
| CPU (user+sys) | 0.95 s | 0.63 s | **0.08 s** |

### Journal / syslog

| | Before | After |
|---|---|---|
| journald disk usage | 64 MB (cap `SystemMaxUse=1G`) | 64 MB (cap now `SystemMaxUse=200M`; nothing to vacuum yet, existing data is under the new cap) |
| `/var/log/syslog` | 38,135,884 bytes, growing (rsyslog forwarding a copy of the journal) | 38,135,884 bytes, frozen (rsyslog + `syslog.socket` disabled and stopped; confirmed unchanged over a 2-minute window — the ticket's 30-minute freeze check was shortened, see report) |

### File-by-file

- `~/agents/bin/pc-status`: wifi probe no longer forces an AP rescan (`nmcli -t -f
  DEVICE,TYPE,STATE,CONNECTION dev status`, TTL 900); `lockcheck.sh`/`pc-mode` sourced instead of
  exec'd (kills a PATH-search-heavy child bash process per call) and their `gsettings get` calls
  folded into one `gsettings list-recursively` per schema (14 → 8); the `cached()` probe-cache
  writer no longer shells out to `mv` (a direct redirection instead of a temp-file-then-`mv`
  dance); screenshot probe replaced with a `busctl` portal-liveness call (still fails when the
  portal is dead) at TTL 900, no real screenshot in the health-check path at all (measured far
  cheaper than "real screenshot only under `--fresh`" and still meets the ticket's `--fresh`
  budget); lock/mode cache TTL raised 60 → 900 to match the sentinel's cadence (not repaired by
  the sentinel, so nothing needs them fresher).
- `~/agents/bin/lockcheck.sh`, `~/agents/bin/pc-mode`: `gsettings get` per key → one
  `gsettings list-recursively` per schema read up front, looked up with a bash loop (no `awk`
  fork per key).
- `~/agents/bin/sentinel-check`: added a pipewire `log.level > 2` known-fault fix
  (`pw-metadata -n settings 0 log.level` → reset to 2, one log line).
- `/etc/systemd/journald.conf.d/90-agents.conf`: `SystemMaxUse=200M`, `+ForwardToSyslog=no`.
- `/etc/systemd/journald.conf.d/syslog.conf` (new, masked to `/dev/null`): the packaged
  `/usr/lib/systemd/journald.conf.d/syslog.conf` sorts after `90-agents.conf` and was winning
  the merge, silently putting `ForwardToSyslog` back to `yes` — masked the same way `systemctl
  mask` masks a unit.
- `rsyslog.service` + `syslog.socket`: disabled and stopped.
- `sysstat-collect.timer`, `sysstat-summary.timer`, `sysstat-rotate.timer`: disabled and stopped;
  `ENABLED="false"` in `/etc/default/sysstat`.

## EF08 — netdata: charts nobody reads at 2 s (2026-09-06 21:20–21:38)

Same `sample.sh`, 60 s windows, pids matched by `pgrep -x` on the process name. Two restarts
total (ticket's explicit exception for the second, after the first left the column sum > 1.5 %).

| Window | netdata | apps.plugin | go.d.plugin | sd-jrnl.plugin | sd-unit.plugin | debugfs.plugin | scripts.d.plugi | **sum** | charts | alarms |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline (2 s, all plugins on) | 2.02 | 0.80 | 0.25 | 0.12 | 0.05 | 0.30 | 0.05 | **3.59** | 2761 | 218 |
| after restart 1 (db/apps/cgroups=5s; debugfs/systemd-units/tc/scripts.d=no) | 2.18 | 0.45 | 0.18 | 0.15 | — | — | — | **2.96** | — | — |
| after restart 2 (apps=10s; systemd-journal=no) | 2.12 | 0.28 | 0.18 | — | — | — | — | **2.58** | 1905 | 200 |

Target was ≤ 1.5 % of a core; final sum is 2.58 %, still over. `netdata` itself (the core daemon,
not a plugin) is the dominant, unmoved cost — 2.02 → 2.18 → 2.12 % across both restarts, despite
`[db] update every` going 2 → 5 s. The ticket's own knob list does not touch whatever the daemon
spends outside `apps`/`cgroups` collection (web server, health/alarm evaluation every second —
explicitly not touched per ground rules), so no further knob in the ticket closes the remaining
gap. Charts dropped 2761 → 1905 (well under the ≤ 2000 check); alarms dropped 218 → 200 because
alarm templates tied to the now-disabled collectors' contexts (`qos.conf`'s `10min_qos_packet_drops`
for `tc`, systemd-unit-failure templates, debugfs zswap/hugepage/extfrag templates) can no longer
instantiate — an unavoidable consequence of disabling those plugins, not a separate fault.

**Update (2026-09-06 21:45–21:48): `systemd-journal` re-enabled, owner call — the Logs tab is
worth the 0.15 %.** One more restart (third overall for this ticket), same 120 s settle, same
60 s window:

| Window | netdata | apps.plugin | go.d.plugin | sd-jrnl.plugin | **sum** | charts | alarms |
|---|---|---|---|---|---|---|---|
| final, systemd-journal back on (apps=10s) | 2.17 | 0.25 | 0.18 | 0.15 | **2.75** | 1918 | 201 |

`sd-jrnl.plugin` running again and the `systemd-journal` function (tags `logs`) is back in
`/api/v2/functions` — the Logs tab's backend answers. Daemon-core overhead is still the closed,
out-of-scope gap against the 1.5 % target; no further ticket is being opened for it.

## 2026-09-06 final restart

Pending body code shipped via one announced `systemctl --user restart dark-eye` (preflight
exit 1 for the intentional dirty tree, `npm test` 240/240 green, `cargo build --release`
no-op). Verified: `eye health` ok, backend gpu, `eye up at`, `orbiters: 1 put back`, voice
ready, no `second eye-render refused`, NRestarts=0, `curl 127.0.0.1:8644/` → 200.

60 s idle sample post-restart: gnome-shell 22.15 %, eye-render 2.20 %, node (main) 0.03 %,
voice worker RSS fresh 1364 MB (VmRSS 1396528 kB). Whole-machine idle: 0.30 cores.
