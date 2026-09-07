# The Dark Eye — Runbook: earbuds

The Sony WF-1000XM5 half of the ops truth: pairing, the AVRCP node, the
push-to-talk sidecar, and every Bluetooth trap that cost a night. Split out of
`RUNBOOK.md` in E19 to keep that file readable; everything else is still there.

## Earbuds — Sony WF-1000XM5 (E07)

MAC `AC:80:0A:27:65:6C`, paired, bonded, trusted, `WakeAllowed`. Card
`bluez_card.AC_80_0A_27_65_6C`, sink/source `bluez_output|bluez_input.AC:80:0A:27:65:6C`.
Profiles offered: `a2dp-sink` (AAC, the active one), `a2dp-sink-sbc`, `a2dp-sink-sbc_xq`,
`headset-head-unit` (HFP mSBC) and `headset-head-unit-cvsd` — so HFP for the mic is there
and WirePlumber can autoswitch to it while the Eye's mic is open (E09).

**The AVRCP evdev device.** BlueZ creates `WF-1000XM5 (AVRCP)` on connect:
`/dev/input/event14`, bus `0x5`, vendor `0x54c`, product `0xe63`, `Handlers=kbd event14`,
`Sysfs=/devices/virtual/input/input18`. The node number is not stable — find it with
`grep -B1 -A6 AVRCP /proc/bus/input/devices`. The user is **not** in group `input`, so
reading it needs `sudo` (or a udev rule) — `sudo evtest /dev/input/eventN`.

**`mpris-proxy` steals every key.** While `mpris-proxy.service` (user unit, enabled by
default) runs, it registers an MPRIS player with BlueZ, BlueZ routes AVRCP passthrough to
that player over D-Bus, and the uinput device emits **nothing at all**. `install.sh` masks
it and `dark-eye-ptt.service` carries `Conflicts=mpris-proxy.service`. Music still works:
the sidecar re-injects the single-tap keys through a uinput clone and GNOME's media-key
handler passes them to Spotify.

**Measured 2026-09-06, buds worn, Spotify playing, right bud only:**

| Gesture | Emits | Press → release | Misfires |
|---|---|---|---|
| Right **double** tap | one `KEY_NEXTSONG` (163) press+release. **Nothing else** — no play/pause key before or after it | 15-22 ms (mean 18.6) | 0 of 5 |
| Right **single** tap | one key, **alternating** `KEY_PAUSECD` (201) / `KEY_PLAYCD` (200) — the buds track playback state themselves and send the explicit command, never `KEY_PLAYPAUSE` | 19-22 ms (mean 20.7) | 0 of 6 |
| **Left** bud (single and double) | nothing on the node — noise control is local to the buds | — | — |

So the double tap is cleanly distinguishable: a different keycode, one event, no
ambiguity, and no debounce window needed. `ptt-earbuds.py` consumes `KEY_NEXTSONG` and
re-injects `KEY_PLAYCD`/`KEY_PAUSECD` (not `KEY_PLAYPAUSE`) so music keeps working.
Gaps between gestures in the test were 3-6 s; a fast double-double was not measured.

### Push-to-talk (E08) — how it works and why

`body/linux/ptt-earbuds.py` (`dark-eye-ptt.service`, user unit) grabs the AVRCP node
exclusively. `KEY_NEXTSONG` press (double tap) = PTT; `KEY_PREVIOUSSONG` (triple tap, 165)
is re-emitted as `KEY_NEXTSONG` = next track, owner's request; every other event is
re-injected as is through a uinput clone (`dark-eye-ptt passthrough`). On PTT it saves the
A2DP sink volume, runs `pactl set-card-profile … headset-head-unit`, waits (≤1 s, polling
every 50 ms) for the `bluez_input.…` source to **exist**, points the default source at it
with `pactl set-default-source`, then `POST /bridge/mic` (toggle) — the whole open path is
70-90 ms. When the bridge answers `on:false` it restores the previous default source, waits
0.5 s (SCO release), switches back to `a2dp-sink` and only writes the volume if the sink
came back at a different level. If the body's 90 s failsafe closes
the mic instead, the sidecar restores A2DP and the volume itself after 95 s. Nothing needs sudo at runtime:
`/etc/udev/rules.d/90-dark-eye-ptt.rules` (from `body/linux/`) gives the user an ACL on
`*AVRCP*` nodes and `/dev/uinput`.

**The bug the first version had, and the fix.** The first double tap opened the mic, the
second never arrived — no event at all on the grabbed node. Cause, measured with `btmon`:
PipeWire's HFP gateway fakes an active call whenever the SCO link comes up (`+CIEV: 2,1`
on SCO acquire, `+CIEV: 2,0` on release — `backend-native.c`, "dummy call", there so that
picky headsets accept audio). In a call the WF-1000XM5 turn the double tap into an HFP
**hang-up** (`AT+CHUP`), which PipeWire answers with ERROR (no ModemManager) and nobody
else ever sees — no AVRCP key, nothing on D-Bus (PipeWire 1.6's `org.pipewire.Telephony`
is for the hands-free role only). Fix: the per-device property
`bluez5.disable-dummy-call = true`, set for `bluez_card.*` by a WirePlumber rule in
`body/linux/50-dark-eye-ptt.conf` (symlinked into `~/.config/wireplumber/wireplumber.conf.d/`).
Verified: SCO still opens and the capture works, no `+CIEV` is sent, and the buds keep
sending AVRCP `KEY_NEXTSONG` under HFP. The same drop-in sets
`bluetooth.autoswitch-to-headset-profile = false` so WirePlumber does not fight the sidecar
over the profile. Check it applied with `pw-dump | grep disable-dummy-call` (→ `true`).

**A WirePlumber restart drops A2DP/AVRCP.** Restarting `wireplumber.service` unregisters
the media endpoints; the buds keep HFP but A2DP and AVRCP (and the evdev node) are gone
until the buds retry on their own (~2 min) — `bluetoothctl connect <MAC>` brings them
back in 2 s. `install.sh` does that after installing the drop-in. The profile-switch itself
(A2DP ↔ HFP) does **not** touch the AVRCP node; the node survived every switch measured.

**A wedged SCO state, and how to get out of it.** After a bare HFP↔A2DP switch with no
capture running (a volume experiment, 01:46) the buds kept a phantom voice link: the kernel
logged `SCO packet for unknown connection handle`, every new eSCO setup came back
`Unsupported LMP Parameter Value (0x20)` (`Failure in Bluetooth audio transport` in the
WirePlumber log, `mic captured 0.0s` in the body's), and the buds played **no** A2DP audio
either (they mute playback while "in a call"). Recovery: `bluetoothctl disconnect
AC:80:0A:27:65:6C && sleep 4 && bluetoothctl connect AC:80:0A:27:65:6C` — 10 s, the
sidecar re-grabs on its own. Symptom to look for: `heard` missing after a round, or the
owner hearing nothing. The sidecar's 0.5 s settle before the A2DP return is there to keep
the SCO release and the profile teardown apart; not proven to be the cause.

Sink name: it is `bluez_output.AC_80_0A_27_65_6C.1` (underscores, `.1`) in every listing
since the start of E08; `pc-spotify` matches `^bluez_output`, nothing hardcodes it.

**Verified 2026-09-06 01:44–01:57, live with the owner:** double tap → `mic open` (card in
HFP, earbud mic), sentence, double tap → `mic closed`, `heard (623ms): [49 chars]`; then a
single tap → `KEY_PLAYCD` passed through, Spotify Playing; another → `KEY_PAUSECD`, Paused.
Second round after the fixes: volume 40 % before and after the cycle, triple tap →
`key 165 -> next track`, Spotify Creeping Death → Battery. Last round after the reconnect:
"do you hear me?" answered by voice, 23 s captured, `heard (3009ms): [139 chars]`.
Before that, two injected cycles (a uinput test device driven by a second sidecar instance)
produced open/close/`heard` twice in a row. Mic-open latency after the tap is ~1 s (the HFP
switch). Rings on the eye were not screenshotted this round.

**The 5 s lag and the volume drift (E20, 2026-09-06 11:17).** The sidecar waited for
`bluez_input.…` to become the **default source**, which WirePlumber will not do while a
default is configured — `~/.local/state/wireplumber/default-nodes` had
`default.configured.audio.source=alsa_input.pci-0000_00_1f.3.analog-stereo` pinned, so the
3 s wait timed out on *every* tap, opening and closing, and the mic silently fell back to
the laptop mic. The profile switch itself was never the problem: measured by hand,
`pactl set-card-profile … headset-head-unit` returns in 26 ms and `bluez_input.…` is listed
33 ms later. Fix: wait for the source to **exist**, then set it as the default explicitly,
and restore the previous default source on close. The volume writes went with it — a bare
A2DP→HFP→A2DP round trip with no volume command at all came back at exactly the same raw
level (43863 / 67 %) on PipeWire 1.6.2, so the sidecar's own `set-sink-volume` on the
mono, 16-step HFP sink was what ratcheted the level up. It now writes the volume only when
a profile change it made brought the sink back different. Measured after the fix: open
70-90 ms (was ~5.5 s), close 570-600 ms (the deliberate 0.5 s SCO settle), earbud source
default while open, `mic captured 1.5s` on all three cycles, 67 % before and after.

**The loudness jump across the switch (E22, 2026-09-06 11:26).** After E21 removed the
ratcheting writes, each profile simply keeps its own stored level — WirePlumber's
`default-routes` holds `headset-output` (A2DP) and `headset-hf-output` (HFP) separately, and
a level set in one is invisible to the other (measured: HFP left at 40 %, A2DP still 67 %,
and HFP came back at 40 % on the next entry). The sidecar now writes the A2DP percentage it
read just before the switch onto the **HFP sink only**, and only when the HFP sink is
actually sitting somewhere else; the A2DP return keeps the E21 rule. Three cycles with the
write in place: A2DP 43863 / 67 % before and after every one, HFP 43909 / 67 % while open,
zero drift; a deliberately stale HFP sink (40 %) was pulled back to 67 % with one write.
Both sinks are `HARDWARE HW_VOLUME_CTRL` with **different hardware scales**, from the route
params: A2DP `volumeStep 0.007812` = 1/128, i.e. AVRCP absolute volume 0-127 (67 % → 85);
HFP `volumeStep 0.0625` = 1/16, i.e. AT+VGS 0-15 (67 % → step 10). So the HFP write rounds to
the nearest of 16 steps — 6.7 percentage points per step, ±3.3 worst case — while `pactl`
still reports the fine value. PipeWire equalises the *number* on both scales; any loudness
difference left is the buds' own call-path gain, which no `set-sink-volume` can reach.

Still not verified: the power-cycle reconnect (case closed and reopened) — that the
node reappears and is re-grabbed (the lookup is by name, scan every 0.3 s), and whether the
buds come back on A2DP by themselves after it. Also: while the mic is open the music keeps
playing through the HFP sink (phone quality); nothing pauses it.

### The buds say "the digital assistant is not connected" (E24, 2026-09-06 15:14)

**Symptom.** A single tap on the right bud makes the buds announce "the digital assistant
is not connected"; a double tap usually cannot even be completed. **Nothing reaches the
host by any path** — no event on the grabbed AVRCP node, nothing in `bluetoothd`, no
D-Bus call. It looks like "the tap only works when a media app is playing", because a
mic round or a reconnect happens to clear it.

**Root cause: bud-side gesture state, not the host.** The buds keep a phantom
voice/call context after a mic close and re-route the right-bud gestures to their voice
assistant, exactly as they turn the double tap into `AT+CHUP` during a real call (E08).
The marker in the journal is the same one as the wedged-SCO case above, and it lands
seconds after the last good mic close:

```
14:48:55 [ptt] ptt toggle -> mic False          # last tap that worked
14:49:15 kernel: Bluetooth: hci0: SCO packet for unknown connection handle 3584
14:49:15 bluetoothd: /org/bluez/…/fd0: fd(42) ready
# every tap from here on is swallowed by the buds
```

The same pair appears at 13:30:10, right before the previous outage, which a reconnect
at 13:54 cleared.

**Fix.** Reset the buds' state: put them in the case and take them out again, or, from
the host, `bluetoothctl disconnect AC:80:0A:27:65:6C && sleep 5 && bluetoothctl connect
AC:80:0A:27:65:6C`. Both worked; the reconnect at 15:14 had the double tap opening the
mic 3 s after the node was re-grabbed (15:14:22, 15:14:40, 15:15:19), before the owner
power-cycled the case. Check `bluetoothctl` leaves the card on `a2dp-sink` — WirePlumber
briefly probes `headset-head-unit` on connect.

**Ruled out, with evidence — do not re-derive.**

- *A dummy AVRCP player.* With no player registered BlueZ answers the buds' AVRCP
  queries with "no available players", so registering a permanent `org.bluez.MediaPlayer1`
  (via `org.bluez.Media1.RegisterPlayer` on `/org/bluez/hci0`, `PlaybackStatus` "playing",
  Identity, Metadata) looks like the fix. It is not: registered and confirmed by
  bluetoothd (`Player registered: path=/dark_eye/player0`), taps during a 10-minute
  window produced **nothing at all** — not the `Next()` the player would have received,
  not an evdev event. Note `bluetoothctl player.list` can never show it: that command
  lists remote (controller-side) players only; the `bluetoothd` log line is the check.
- *An active A2DP stream.* A silent `pw-cat` loop with the sink confirmed `RUNNING` — the
  buds cannot tell it from music — changed nothing either.
- *The host input path.* Throughout, `WF-1000XM5 (AVRCP)` was present on `/dev/input/event14`
  and grabbed by the sidecar (fd 4 of the service PID), card on `a2dp-sink`, no live SCO in
  `hcitool con`, `dark-eye-ptt` active.

**Why a registered player would not be a free change anyway** (BlueZ 5.85 source, worth
keeping): `avctp.c:handle_panel_passthrough` only falls through to the uinput node when
the registered passthrough handler returns false, and `avrcp.c:handle_passthrough` →
`avrcp_handle_next`/`_play`/`_pause` return false *precisely because* no player is
registered. So any player — mpris-proxy's (E07) or ours — moves the double tap off evdev
onto `org.mpris.MediaPlayer2.Player.Next` on the registered path. Registering one means
rewriting the sidecar's key path, not adding to it.

**Why the buds keep the context: PipeWire holds the (e)SCO for its whole suspend timeout.**
Measured at the audio layer, no bridge involved — HFP profile, a 2 s `pw-cat -r` from
`bluez_input.…`, then stop the recorder and touch nothing:

```
t=0.01  sco=1 srcout=0     # the recorder is gone at once
t=6.20  sco=0 srcout=0     # the link finally drops, 6.2 s later
```

The old close path slept 0.5 s and flipped the card back to A2DP — **on top of a live voice
link** — and the E24 attempt that waited 2 s was still inside that window ("voice link still
up; settling before A2DP" in the journal, and the lock came straight back). Tearing the HFP
profile down under a live (e)SCO is what leaves the buds in their call context. One command
fixes the timing: `pactl suspend-source <bluez_input…> 1` makes PipeWire release the
transport immediately — measured **1.09 s** to link down instead of 6.2 s.

**What the sidecar now does (E24).** `restore_audio` calls `release_voice_link` before it
touches the profile: suspend the earbud source, then wait — bounded, `SCO_RELEASE_SECONDS`
= 4 s, polled every 50 ms — until `hcitool con` shows no (e)SCO line for the buds' MAC
(`card_mac` derives it from the card name). A link that still refuses gets **only its HFP
profile** disconnected (`org.bluez.Device1.DisconnectProfile` with the Handsfree UUID over
`busctl`, so A2DP and the AVRCP node survive), then the same bounded wait again. Only then
does the card go back to `a2dp-sink`. Afterwards a watch is armed for `SCO_WATCH_SECONDS`
(30 s): every 5 s from the pump loop's idle tick, `check_phantom` bounces the link once
(`bluetoothctl disconnect` / 5 s / `connect`) if **either** the kernel logs `SCO packet for
unknown connection handle` **or** the link is simply still up. The watch is disarmed while
the mic is open, so a fast second tap is never mistaken for a stuck link.

Measured with the real close path and a real recorder, two cycles: `(e)SCO up while open`,
close **1.09-1.14 s**, link down *before* the profile flip, card back on `a2dp-sink`, no
phantom marker, only the ACL left in `hcitool con`.

**Open question.** Whether the phantom context comes from the buds' multipoint state —
the owner's phone as the primary device holding a call/assistant slot — has not been
tested. If the announcement returns often, check what the phone is connected to first.

### `DisconnectProfile` kills HFP for good (E27, 2026-09-06 15:32)

**Symptom.** After E26's `release_voice_link` fallback fires once ("voice link still up;
disconnecting the HFP profile"), every later tap opens the mic on the **laptop** mic:

```
15:32:36 [ptt] voice link still up; disconnecting the HFP profile
15:32:53 [ptt] pactl set-card-profile … headset-head-unit failed: Failure: No such entity
15:32:53 [ptt] no earbud source after the HFP switch; the mic will use the default source
```

The card stops offering `headset-head-unit` / `headset-head-unit-cvsd` altogether —
`pactl list cards` shows only the three `a2dp-sink*` profiles — and BlueZ never brings the
profile back on its own. It survives a `dark-eye-ptt` restart; only
`org.bluez.Device1.ConnectProfile` (or a full reconnect) restores it. Measured: the
profile is offered again **0.49 s** after `ConnectProfile`.

**Fix.** `open_talk` checks `hfp_available(card)` before the switch and calls
`connect_hfp(mac)` + a bounded wait (`HFP_CONNECT_SECONDS` = 5 s) when the profile is
gone. Self-healing, costs one `pactl list cards` per mic open, nothing at idle.

### What the buds and PipeWire actually say to each other (E27, btmon)

Captured with `btmon -w` over four real mic cycles. The service-level connection is:

```
> AT+BRSF=925     (HF)   -> < +BRSF: 3680  (AG, PipeWire)
> AT+BAC=1,2 / AT+CIND=? / AT+CIND? / AT+CMER=3,0,0,1 / AT+BIND… -> OK
> AT+NREC=0       (HF)   -> < ERROR
> AT+CLIP=1 / AT+XAPL=054C-0E63-… / AT+VGS=10 / AT+BIEV=2,100 / AT+BCS=2 -> OK
```

HF features **925** have bit 3 set = *voice-recognition activation*: the buds are willing
to send `AT+BVRA`. AG features **3680** = 32+64+512+1024+2048 — **bit 2 (voice
recognition) is clear**, and there is no `BVRA` string anywhere in
`/usr/lib/x86_64-linux-gnu/spa-0.2/bluez5/libspa-bluez5.so` (PipeWire 1.6.2). So the
native HFP AG **cannot** be configured to accept `AT+BVRA`: no `bluez5.*` property, no
WirePlumber setting, and `org.pipewire.Telephony` (registered, wireplumber owns it) has
no voice-recognition method either. Anything the buds send that PipeWire does not
implement gets `ERROR` — exactly what `AT+NREC=0` gets above.

The only host-side way to see such a command is to sniff HCI (`btmon`, needs root); the
`RFCOMM << %s` / `RFCOMM received unsupported event: %s` log lines in the bluez5 plugin
are below level 4 and never reached the journal even with `log.level 4`
(`pw-metadata -n settings 0 log.level` accepts the `spa.bluez5.native:D` topic string but
nothing came out).

**Where the announcement comes from — most likely the missing HFP profile itself.**
Every reproduction of "the digital assistant is not connected" today sits *after* a
`DisconnectProfile`: with no HFP link the right-bud double tap has nowhere to send its
assistant request, the buds say so, and only the *next* tap falls back to AVRCP — which is
exactly the reported "first tap lost, second one works". The mic still looked like it
opened because the sidecar fell back to the laptop mic.

Evidence for and against the AT+BVRA hypothesis: **no `AT+BVRA` (and no `AT+CHUP`) was ever
captured**. In a 100 s window with the card on HFP and a live (e)SCO, four real double taps
all arrived as AVRCP `KEY_NEXTSONG` on the grabbed node (15:40:21, 15:40:30, 15:41:10,
15:41:19); after the E27 fix, three owner-driven cycles with the sniffer running
(15:45:36/15:45:51, 15:46:48/15:47:07, 15:47:24/15:48:00 — `heard` on all three,
17.3 s and 34.1 s captured from the earbud mic) produced nothing on RFCOMM but the buds'
periodic `AT+BIEV=2,99` battery report. So the closing tap is a normal AVRCP passthrough
whenever the HFP profile is connected, in a call context or not.

### The phantom marker is the teardown's own echo (E30, 2026-09-06 15:51)

**Symptom.** The owner's buds dropped once mid-session. `dark-eye-ptt` (pid 2070095):

```
15:51:42.711  ptt toggle -> mic False
15:51:51.315  kernel: Bluetooth: hci0: SCO packet for unknown connection handle 3584
15:51:52.734  phantom voice link after the mic close; reconnecting AC:80:0A:27:65:6C
15:52:03.128  grabbed WF-1000XM5 (AVRCP) on /dev/input/event14
```

Ten seconds of no audio, from a working link.

**Verdict: false positive.** Three independent lines of evidence.

1. **The handle is ours.** A live mic open on this box shows
   `< eSCO AC:80:0A:27:65:6C handle 3584 state 1 lm CENTRAL` in `hcitool con` — measured
   directly. Every one of the ~35 "unknown connection handle" lines the kernel logged on
   2026-09-06 names **the same handle, 3584**. The marker is the controller delivering the
   last trailing eSCO packets *after* the host tore that link down — the echo of a
   **successful** release, not a link the buds kept.
2. **It fires on closes that were fine.** 15:43:31, 15:44:33 and 15:51:51 are all ~7-9 s
   after a mic close (PipeWire's 6.2 s suspend timeout plus the trailing packets). The
   15:44:33 one hit a window with no watch armed, nothing was bounced, and the very next
   cycle (15:45:36) worked. Markers at 11:17, 13:19, 13:30, 14:49, 15:24 and 15:28 likewise
   passed with no complaint. One marker, one bounce, one complaint — the bounce was the
   only thing the owner felt.
3. **The link was already gone.** `release_voice_link` returned cleanly at the 15:51:42
   close (no "voice link still up" line), so there was no (e)SCO left to justify anything.

The bounce came from `check_phantom`'s `sco_up(mac) or phantom_sco(since)`: the marker
half alone was enough, and it is always eventually true.

**What the sidecar now does.**

- **A live (e)SCO is the only justification.** `sco_line()` returns the `hcitool con` line
  and that line goes in the log. `phantom_marker()` returns the kernel line as *context*
  only; a marker with no live link logs one "leaving the buds alone" line and does nothing.
- **Cheapest recovery first**, one step per 5 s poll, each re-checked against the live link:
  `suspend-source` → HFP-only `DisconnectProfile` + `ConnectProfile` → whole-device bounce.
  The ladder stops the moment the link goes, so the owner only loses audio if the two cheap
  steps both failed against a link that is provably still up. Each step logs its name, the
  step number, the `hcitool con` evidence line and the kernel marker (or "no marker").
- **Never mid-conversation.** The existing `talking` guard, plus `TAP_GUARD_SECONDS` (4 s):
  `toggle_talk` stamps `state["last_tap"]` on every tap, and no recovery step runs inside
  that window — which covers the case where a mic open *failed* and the owner is tapping
  again while `talking` is still False.
- Only the device-bounce step returns True to `pump` (a re-grab is needed only when the
  AVRCP node actually goes away); the two cheap steps leave the node alone.

**Verified live.** One self-driven cycle, no sound: A2DP → HFP → source captured to
/dev/null → `release_voice_link` returned True in **1.04 s** → back to A2DP; `hcitool con`
showed the eSCO during the open and nothing after, and five polls over 26 s saw no live
link and no marker. Default sink stayed on the buds at 67%, default source back on the
laptop mic. 45 unit tests pass (was 39).

### Capturing the failing state (E31, 2026-09-06)

Every fix up to E30 assumed a host-side cause and none stopped the announcement, so
the rule now is: **capture first, recover second.** Two CLIs, both in `~/agents/bin`
and symlinked into `~/.local/bin`.

```
buds-capture [seconds] [--quiet]     # default 60 s; --quiet skips the owner push
buds-recover                         # bluetoothctl bounce, then the case instruction
```

`buds-capture` starts `sudo btmon -w` first (so nothing is missed), pushes the owner
"capture running Ns: do two double taps now, then wait", and snapshots into
`~/agents/log/buds-capture/<timestamp>/`:

| file | content |
|---|---|
| `cap.btsnoop` / `cap.txt` | the HCI trace, decoded with `btmon -T -r` (wall clock) |
| `state.txt` | `hcitool con`, `bluetoothctl info`/`show`, the bluez card, short sinks/sources/sink-inputs/source-outputs, `wpctl status`, the AVRCP node, `hci0` sysfs, `journalctl -k` 5 min, `dark-eye-ptt` 10 min, `bluetooth` 10 min |
| `evdev.txt` | the sidecar journal followed live **plus** `libinput debug-events` on the `dark-eye-ptt passthrough` uinput clone — `evtest --grab` is unavailable, the sidecar holds the exclusive grab on the real node |
| `passthrough.txt` | one decoded line per AV/C passthrough frame |

Then it prints a numbered summary (passthrough frames, of which FORWARD, HFP AT
commands, SCO setups, RFCOMM, evdev lines, card profile, links, sizes).

**btmon joined mid-connection cannot decode L2CAP.** It never saw the channel
configuration, so AVCTP and RFCOMM arrive as `[PSM 0 mode Basic]` raw hex and
`grep Passthrough` finds nothing. Decode by hand — the frame is
`<avctp> 11 0e <avc> 48 7c <operand>`: `11 0e` = AV/C PID, `48` = panel subunit,
`7c` = PASSTHROUGH; operand `4b` FORWARD (the double tap), `44` PLAY, `46` PAUSE,
`4c` BACKWARD, high bit set = release. Response ctype nibble `9` = ACCEPTED.
`buds-capture` does this for you. Note `-S`/`-A` are **not** passed, so SCO and A2DP
payloads are counted but not dumped.

Cleanup: each root sniffer writes its own pid into the capture dir and is killed by
that pid on exit and on INT/TERM — `sudo` does not relay signals to a grandchild, and
`pkill -f` would match this script's own command line and kill the caller.

### What the failing state actually looks like on the wire (E31)

One 60 s capture across the transition, `~/agents/log/buds-capture/20260906-160818`.
Timeline, all from `cap.txt` and `evdev.txt`:

```
16:08:21.485  < AVDTP START  (80 07 08)  -> 16:08:21.519 accepted   # A2DP streaming
16:08:32.334  < AVDTP SUSPEND (90 09 08) -> 16:08:32.393 accepted   # stream stops, stays stopped
16:08:43.954  > 80 11 0e 00 48 7c 4b 00   FORWARD press   -> +0.20 ms  82 …09… 4b  ACCEPTED
16:08:44.180  > eSCO handle 3584 up, Status Success        # [ptt] mic True
16:08:52.845  > a0 11 0e 00 48 7c 4b 00   FORWARD press   -> +0.33 ms  a2 …09… 4b  ACCEPTED
16:08:53.881  > last SCO packet (1.04 s after the close tap)  # [ptt] mic False
16:09:05.595  > c0 11 0e 00 48 7c 46 00   PAUSE  press    -> +0.35 ms  ACCEPTED   # "failed" tap 1
16:09:14.954  > e0 11 0e 00 48 7c 44 00   PLAY   press    -> +0.26 ms  ACCEPTED   # "failed" tap 2
16:09:17.213  > 00 11 0e 00 48 7c 46 00   PAUSE  press    -> +0.36 ms  ACCEPTED   # "failed" tap 3
```

**No frame of any kind for the double tap itself.** This is the finding. From
16:08:53.9 (the last SCO packet) to the end of the capture the *entire* radio
conversation between host and buds is those three passthrough press/release pairs —
nothing else: no AVCTP command other than them, no RFCOMM, no AVDTP, no LE/ATT, no HCI
link event. The owner reports each of those three gestures as a double tap that went
straight to the announcement, and the wire agrees that the double tap produced **no
FORWARD (`4b`), no `AT+BVRA`, no message at all**. Whatever the buds do with it, they
do it entirely on their own and tell the host nothing.

What the single `46 / 44 / 46` frames are is secondary and not settled by this capture.
They arrive at exactly the owner's tap moments (±ms of the sidecar's journal lines),
alternate PAUSE/PLAY/PAUSE, and each is press+release ~7.1 ms apart. Two readings fit:
the buds emitting one playback-state command as they duck and resume media around their
own announcement, or the first tap of the double being delivered as a single tap while
the second is swallowed by the assistant path. In-ear/wear detection also sends 200/201
on these buds, but that would give tightly spaced PAUSE-then-PLAY pairs on removal and
insertion, not one alternating frame per tap at the tap instants. Nothing in the trace
separates the two, and neither changes the conclusion.

Everything else in the window says the host is clean:

- **Every** passthrough, working and failing, was answered `ACCEPTED` (ctype nibble 9)
  in 0.20-0.36 ms. No missing or late acknowledgment — the "host stopped answering"
  hypothesis is dead.
- Inbound AVCTP in 60 s is **only** those five press/release pairs: no
  `RegisterNotification`, no `GetPlayStatus`, no `SetAbsoluteVolume`, no second AVCTP
  target. The buds never asked the host what was playing, so no host player state can
  be what they reacted to.
- **Zero AT commands in either direction.** No `AT+BVRA`, no `AT+CHUP`. The only
  RFCOMM payload all window is the host's own unsolicited `+VGS: 10` (twice, at the
  SCO open) and one credit-only UIH frame from the buds. The buds never asked HFP for
  an assistant — consistent with E27: PipeWire's AG clears the voice-recognition
  feature bit, so the buds know not to try and announce the failure locally instead.
- No LE/ATT traffic at all. One eSCO setup, one teardown, released cleanly in 1.04 s
  (E30's `release_voice_link` working as designed).
- A2DP was **suspended from 16:08:32 onwards** — during the two working taps *and* the
  three failing ones. "It only works while media is streaming" is ruled out again,
  now from the wire.

One lead the snapshot hands over for free: `bluetoothctl info` lists, besides the audio
profiles, a **Human Interface Device** UUID (`0x1124`) and **eight Sony vendor-specific
UUIDs** on these buds. This host connects none of them — only A2DP, AVRCP and HFP. On a
phone the Sony app talks over one of those vendor channels, and an assistant gesture
plausibly travels there too. That would explain a gesture that is completely silent on
every profile we do speak, and it is not something a Linux host can pick up without
implementing the vendor protocol.

**Verdict: the failure is entirely bud-side and invisible to the host.** The only
host-visible correlate is the eSCO cycle immediately before it (16:08:44-53): two double
taps worked during it, and from 12 s after it the double tap stopped producing a message
at all. No host-side change can be aimed at this, because there is nothing on the wire to
aim at.

**The stuck-call-indicator hypothesis is dead too (E31, read-only checks).** The theory
was that PipeWire's AG leaves the buds believing a call or voice-recognition session is
running after our mic cycle, which would explain a first-touch, no-tap-counting gesture
that is silent on the wire. Four checks, all negative:

- `bluez5.disable-dummy-call: true` is live on the card (`pw-dump`, two hits), so the
  `+CIEV: 2,%d` path in `libspa-bluez5.so` is never taken.
- The wire agrees: the **only** AG-to-buds RFCOMM payload in the whole 60 s capture,
  SCO open included, is `+VGS: 10` twice. No `+CIEV` of any index, ever.
- `strings libspa-bluez5.so` has **no `+BVRA` and no `+BSIR`** (PipeWire 1.6.2) — the
  native AG cannot start or stop a voice-recognition session in either direction. Its
  only indicator formats are `+CIEV: 2,%d` (the disabled dummy call), the generic
  `+CIEV: %u,%u` / `%d,%d`, and `+CIND: %d,%d,%d,0,%d,%d,%d` — note `callheld` is a
  hardcoded `0`.
- `org.pipewire.Telephony` (owned by wireplumber) exposes only `org.ofono.Manager` at
  `/org/pipewire/Telephony`. `GetModems` → **0 entries**, `GetManagedObjects` → **0**,
  `busctl tree` shows no child objects. There is no lingering call object, and no
  `Hangup`/`Answer` to call even if we wanted one.

So there is no AG-side call or VR state to clear, and nothing to send `+BVRA: 0` or
`+CIEV: call,0` *from*. Not re-tested across a fresh mic cycle — that needs a profile
switch on the owner's live buds.

**Cheapest fixes, in order.**

1. **Owner-side, zero cost, most likely the real one.** "The digital assistant is not
   connected" is the buds' own string for an assistant slot pointing at nothing. Check
   in the Sony app what the right bud's function is assigned to, and what the assistant
   slot points at (a phone assistant, with the phone not connected, produces exactly
   this). Nothing on this host can reach that setting.
2. **Stop depending on the double tap.** A play/pause passthrough still reaches the host
   at every failed gesture, three for three, while the double tap reaches it never.
   Whatever produces those frames, binding PTT to them (`44`/`46`, i.e.
   `KEY_PLAYCD`/`KEY_PAUSECD`) and leaving next-track on the triple tap would make the Eye
   work *in* the failing state instead of trying to prevent it. Needs one live check
   first: that a deliberate single tap in the healthy state is not confusable with this.
3. **If the double tap must stay, self-heal on an unambiguous marker.** A `PLAY` or
   `PAUSE` passthrough arriving while `talking` is False and within ~30 s of a mic close
   is the failure signature — it is the only thing the host ever sees; one `bluetoothctl` bounce clears it. This is three lines on
   `check_phantom`'s existing ladder and costs nothing at idle — but it still costs the
   owner ~10 s of audio each time, so 1 and 2 come first.
