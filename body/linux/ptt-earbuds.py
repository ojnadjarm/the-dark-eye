#!/usr/bin/env python3
"""Right-bud double tap opens and closes the Eye's mic; every other key passes through.

The buds' AVRCP node sends KEY_NEXTSONG for a double tap, KEY_PREVIOUSSONG for a triple
tap and KEY_PLAYCD/KEY_PAUSECD for a single tap (E07). The triple tap becomes "next track". The node is grabbed exclusively so GNOME never sees the
double tap, and a uinput clone re-injects everything else so music control still works.
The earbud mic only exists in the HFP profile, so the sidecar switches the card to
HFP and points the default source at the earbud before opening the mic, and back to A2DP
when it closes (E08). The switch itself takes ~30 ms, so it happens before the mic call
and the rings still come up at the tap; a card that cannot give a source inside
SOURCE_WAIT_SECONDS falls straight back to A2DP and the laptop mic (E20).
"""
import json
import os
import re
import select
import subprocess
import sys
import time
import urllib.request

from evdev import InputDevice, UInput, ecodes, list_devices

DEBOUNCE_MS = 400
SCAN_SECONDS = 0.3
HFP = "headset-head-unit"
A2DP = "a2dp-sink"
SOURCE_WAIT_SECONDS = 1.0
TALK_MAX_SECONDS = 95  # the body's 90 s mic failsafe, plus slack
A2DP_SETTLE_SECONDS = 0.5  # only when the buds' MAC is unknown and nothing can be watched
SCO_RELEASE_SECONDS = 4.0  # suspending the source drops the link in ~1 s (measured 1.09 s)
HFP_CONNECT_SECONDS = 5.0  # BlueZ takes ~2 s to bring the profile back
SCO_WATCH_SECONDS = 30  # the phantom marker showed 4 s and 20 s after a close (E24)
SCO_POLL_SECONDS = 5
TAP_GUARD_SECONDS = 4  # a tap this recent means the owner is mid-conversation (E30)
RECONNECT_SETTLE_SECONDS = 5
RECOVERY_STEPS = ("suspend-source", "hfp-profile", "device-bounce")
PHANTOM_SCO = "SCO packet for unknown connection handle"
HFP_UUID = "0000111e-0000-1000-8000-00805f9b34fb"


def log(msg):
    print(f"[ptt] {msg}", flush=True)


def load_config(path=None):
    """Read the bridge secret and port from the dark-eye config."""
    path = path or os.environ.get("DARK_EYE_CONFIG") or os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
        "dark-eye", "config.json")
    with open(path) as fh:
        cfg = json.load(fh)
    if not cfg.get("secret"):
        raise ValueError(f"no secret in {path}")
    return {"secret": cfg["secret"], "port": int(cfg.get("port", 8642))}


def matches(name, wanted):
    """Device-name match, case-insensitive substring."""
    return wanted.lower() in (name or "").lower()


def find_device(wanted, paths=None):
    """First input device whose name contains `wanted`, or None."""
    for path in sorted(paths if paths is not None else list_devices()):
        try:
            dev = InputDevice(path)
        except PermissionError as err:
            log(f"cannot open {path}: {err} — is the udev rule in place?")
            continue
        except OSError:
            continue
        if matches(dev.name, wanted):
            return dev
        dev.close()
    return None


def route(event, last_ts, ptt_key, next_key=None):
    """One event -> "toggle" the mic, "next" track, "pass" it on, or "drop" it."""
    if event.type != ecodes.EV_KEY or event.code not in (ptt_key, next_key):
        return "pass"
    if event.value != 1:
        return "drop"
    if event.code == next_key:
        return "next"
    if last_ts is not None and (event.timestamp() - last_ts) * 1000 < DEBOUNCE_MS:
        return "drop"
    return "toggle"


def capture(*args):
    """Run a command; return stdout, or "" if it failed."""
    res = subprocess.run(args, capture_output=True, text=True)
    return res.stdout if res.returncode == 0 else ""


def card_mac(card):
    """AC:80:0A:27:65:6C from bluez_card.AC_80_0A_27_65_6C, or None."""
    if not card or "." not in card:
        return None
    return card.split(".", 1)[1].replace("_", ":")


def device_path(mac):
    """BlueZ object path for `mac` on the only adapter this box has."""
    return "/org/bluez/hci0/dev_" + mac.replace(":", "_") if mac else None


def sco_line(mac, listing=None):
    """The `hcitool con` line for a live (e)SCO link to `mac`, or None. This line is the
    only evidence a recovery step is allowed to act on, and it goes in the log with it."""
    listing = capture("hcitool", "con") if listing is None else listing
    for line in listing.splitlines():
        if "SCO" in line and mac in line:
            return line.strip()
    return None


def sco_up(mac, listing=None):
    """True while an (e)SCO voice link to `mac` is still open."""
    return sco_line(mac, listing) is not None


def release_voice_link(mac):
    """Hand the HFP link back *before* the profile is torn down. PipeWire holds the (e)SCO
    for its whole suspend timeout after the recorder stops — 6.2 s measured, far past any
    blind settle — and tearing the profile down under a live link is what leaves the buds
    in their own call context, where every further tap goes to their assistant (E24).
    Suspending the source releases it in ~1 s; a link that still will not go gets the HFP
    profile disconnected on its own, which leaves A2DP and the AVRCP node alone."""
    source = bluez_source()
    if source:
        pactl("suspend-source", source, "1")
    if not mac:
        time.sleep(A2DP_SETTLE_SECONDS)
        return False
    if wait_for(lambda: not sco_up(mac), timeout=SCO_RELEASE_SECONDS):
        return True
    log("voice link still up; disconnecting the HFP profile")
    capture("busctl", "call", "org.bluez", device_path(mac), "org.bluez.Device1",
            "DisconnectProfile", "s", HFP_UUID)
    return bool(wait_for(lambda: not sco_up(mac), timeout=SCO_RELEASE_SECONDS))


def hfp_available(card, listing=None):
    """True while the card still offers the HFP profile. `DisconnectProfile` — the fallback
    in `release_voice_link` — removes it and BlueZ never brings it back on its own, so every
    later mic open failed with "No such entity" and captured the laptop mic instead (E27)."""
    listing = pactl("list", "cards") or "" if listing is None else listing
    for block in listing.split("\nCard #"):
        if f"Name: {card}\n" in block:
            return f"{HFP}:" in block
    return False


def connect_hfp(mac):
    """Ask BlueZ for the HFP profile again, and wait for the card to offer it."""
    if not mac:
        return False
    capture("busctl", "call", "org.bluez", device_path(mac), "org.bluez.Device1",
            "ConnectProfile", "s", HFP_UUID)
    return True


def phantom_marker(since, listing=None):
    """The kernel's "SCO packet for unknown connection handle" line since `since`, or None.
    Context for the log, never a reason to act: the controller emits it after almost every
    teardown — 35 times on the day it was trusted, always handle 3584, ~8 s after the close,
    with working cycles either side — so on its own it says nothing about a stuck link (E30)."""
    if listing is None:
        listing = capture("journalctl", "-k", "--since",
                          time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(since)))
    for line in listing.splitlines():
        if PHANTOM_SCO in line:
            return line.strip()
    return None


def recover_voice_link(mac, step):
    """One recovery step, cheapest first: suspend the earbud source, then take the HFP
    profile down and back up on its own, then bounce the whole device. True once the link
    is gone. Only the last step costs the owner his audio, so it is only ever reached
    after the two cheap ones were tried and the link survived them (E30)."""
    if step == 0:
        source = bluez_source()
        if source:
            pactl("suspend-source", source, "1")
    elif step == 1:
        capture("busctl", "call", "org.bluez", device_path(mac), "org.bluez.Device1",
                "DisconnectProfile", "s", HFP_UUID)
        wait_for(lambda: not sco_up(mac), timeout=SCO_RELEASE_SECONDS)
        connect_hfp(mac)
    else:
        capture("bluetoothctl", "disconnect", mac)
        time.sleep(RECONNECT_SETTLE_SECONDS)
        capture("bluetoothctl", "connect", mac)
    return bool(wait_for(lambda: not sco_up(mac), timeout=SCO_RELEASE_SECONDS))


def pactl(*args):
    """Run pactl; return stdout, or None on failure."""
    res = subprocess.run(["pactl", *args], capture_output=True, text=True)
    if res.returncode != 0:
        log(f"pactl {' '.join(args)} failed: {res.stderr.strip()}")
        return None
    return res.stdout


def bluez_card(listing=None):
    """(name, active profile) of the bluez card from `pactl list cards`, or (None, None)."""
    listing = pactl("list", "cards") or "" if listing is None else listing
    for block in listing.split("\nCard #"):
        name = re.search(r"Name: (bluez_card\.\S+)", block)
        active = re.search(r"Active Profile: (\S+)", block)
        if name:
            return name.group(1), active.group(1) if active else None
    return None, None


def set_profile(card, profile):
    """Switch `card` to `profile`."""
    return pactl("set-card-profile", card, profile) is not None


def wait_for(check, timeout=SOURCE_WAIT_SECONDS, poll=0.05):
    """Poll `check` until it returns a truthy value or `timeout` passes."""
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value or time.monotonic() >= deadline:
            return value
        time.sleep(poll)


def bluez_source(listing=None):
    """Name of the earbud capture source, or None. The default source is not it:
    WirePlumber only promotes a new source when nothing is configured, and a pinned
    laptop mic used to make the old wait time out on every single tap."""
    listing = pactl("list", "short", "sources") or "" if listing is None else listing
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) > 1 and parts[1].startswith("bluez_input"):
            return parts[1]
    return None


def bluez_sink(listing=None):
    """(name, profile, volume%) of the bluez sink from `pactl list sinks`, or None."""
    listing = pactl("list", "sinks") or "" if listing is None else listing
    for block in listing.split("\nSink #"):
        name = re.search(r"Name: (bluez_output\S+)", block)
        profile = re.search(r'api\.bluez5\.profile = "([^"]+)"', block)
        volume = re.search(r"Volume:.*?(\d+)%", block)
        if name and profile and volume:
            return name.group(1), profile.group(1), volume.group(1) + "%"
    return None


def sink_on(profile):
    """The bluez sink, but only once it is the `profile` one."""
    sink = bluez_sink()
    return sink if sink and sink[1] == profile else None


def match_volume(profile, volume):
    """Put the `profile` sink at `volume`, but only if it is actually sitting somewhere else.
    Each profile keeps its own stored level, so the HFP sink has to be told what the owner
    was hearing on A2DP; writing a level that is already there is what used to ratchet it."""
    sink = wait_for(lambda: sink_on(profile))
    if volume and sink and sink[2] != volume:
        log(f"{profile} sink at {sink[2]}; writing {volume}")
        pactl("set-sink-volume", sink[0], volume)


def toggle_mic(cfg):
    """POST /bridge/mic with no body — the bridge toggles."""
    req = urllib.request.Request(
        f"http://127.0.0.1:{cfg['port']}/bridge/mic",
        data=b"{}",
        headers={"content-type": "application/json", "x-dark-eye-key": cfg["secret"]},
        method="POST")
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read() or b"{}")


def open_talk(cfg, state):
    """HFP and the earbud source first — both take ~30 ms — then the mic, so the rings
    come up at the tap. A card that gives no source is put straight back on A2DP."""
    state.update(switched=False, volume=None, source=None, watch_sco=None, watch_step=0,
                 marker_logged=False)
    card, profile = bluez_card()
    if card and profile != HFP:
        if not hfp_available(card):
            log("HFP profile gone since the last close; reconnecting it")
            connect_hfp(card_mac(card))
            wait_for(lambda: hfp_available(card), timeout=HFP_CONNECT_SECONDS)
        state["volume"] = (bluez_sink() or (None, None, None))[2]
        state["source"] = (pactl("get-default-source") or "").strip() or None
        if set_profile(card, HFP) and wait_for(bluez_source):
            pactl("set-default-source", bluez_source())
            match_volume(HFP, state["volume"])
            state["switched"] = True
        else:
            log("no earbud source after the HFP switch; the mic will use the default source")
            set_profile(card, A2DP)
    return bool(toggle_mic(cfg).get("on"))


def restore_audio(state):
    """Undo our own HFP switch. Nothing is touched — the volume least of all — if we
    never switched: that is the "double tap moves the volume" bug. The profile only flips
    back once the voice link is really gone, and the watch is armed after it (E24)."""
    if not state.get("switched"):
        return
    state["switched"] = False
    if state.get("source"):
        pactl("set-default-source", state["source"])
    card, _ = bluez_card()
    mac = card_mac(card)
    if not release_voice_link(mac):
        log("voice link outlived the release; the watch will take it from there")
    if card:
        set_profile(card, A2DP)
    match_volume(A2DP, state.get("volume"))
    state["watch_sco"] = (time.time(), mac)
    state["watch_last"] = time.time()
    state["watch_step"] = 0
    state["marker_logged"] = False


def check_phantom(state):
    """After a close, walk the recovery ladder for as long as a real voice link is still up.
    A live (e)SCO in `hcitool con` is the only justification: the kernel marker fires after
    almost every teardown and bouncing the whole device on it dropped the owner's buds
    mid-use (E30). Nothing runs while the mic is open or a tap just landed. True only after
    a device bounce, which is what takes the AVRCP node away and needs a re-grab."""
    watch = state.get("watch_sco")
    if not watch or state.get("talking"):
        return False
    since, mac = watch
    now = time.time()
    if now - state.get("last_tap", 0) < TAP_GUARD_SECONDS:
        return False
    if now - since > SCO_WATCH_SECONDS or not mac:
        state["watch_sco"] = None
        return False
    if now - state.get("watch_last", since) < SCO_POLL_SECONDS:
        return False
    state["watch_last"] = now
    live = sco_line(mac)
    marker = phantom_marker(since) if live or not state.get("marker_logged") else None
    if not live:
        if marker and not state.get("marker_logged"):
            state["marker_logged"] = True
            log(f"kernel marker but no live voice link; leaving the buds alone: {marker}")
        return False
    step = state.get("watch_step", 0)
    name = RECOVERY_STEPS[step]
    log(f"voice link still up {int(now - since)}s after the close; recovery step "
        f"{step + 1}/{len(RECOVERY_STEPS)} ({name}); link: {live}; "
        f"kernel: {marker or 'no marker'}")
    gone = recover_voice_link(mac, step)
    state["watch_step"] = step + 1
    log(f"{name}: voice link {'released' if gone else 'still up'}")
    if gone or state["watch_step"] >= len(RECOVERY_STEPS):
        state["watch_sco"] = None
    return name == RECOVERY_STEPS[-1]


def toggle_talk(cfg, state):
    """One tap: open on the earbud mic, or close and hand the card back to A2DP."""
    state["last_tap"] = time.time()
    on = bool(toggle_mic(cfg).get("on")) if state.get("talking") else open_talk(cfg, state)
    state["talking"] = on
    if not on:
        restore_audio(state)
    return on


def press(ui, code):
    """Emit one press+release of `code` on the passthrough clone."""
    for value in (1, 0):
        ui.write(ecodes.EV_KEY, code, value)
        ui.syn()


def pump(dev, cfg, ptt_key, next_key):
    """Grab the device and forward its events until it goes away."""
    ui = None
    last_ts = None
    talking_since = None
    state = {}
    try:
        dev.grab()
        ui = UInput.from_device(dev, name="dark-eye-ptt passthrough")
        log(f"grabbed {dev.name} on {dev.path}")
        while True:
            ready, _, _ = select.select([dev.fd], [], [], 1.0)
            if not ready:
                if talking_since and time.monotonic() - talking_since > TALK_MAX_SECONDS:
                    log("mic failsafe passed; back to A2DP")
                    state["talking"] = False
                    restore_audio(state)
                    talking_since = None
                if check_phantom(state):
                    return
                continue
            for event in dev.read():
                action = route(event, last_ts, ptt_key, next_key)
                if action == "toggle":
                    last_ts = event.timestamp()
                    try:
                        on = toggle_talk(cfg, state)
                    except Exception as err:
                        log(f"ptt toggle failed: {err}")
                        continue
                    talking_since = time.monotonic() if on else None
                    log(f"ptt toggle -> mic {on}")
                elif action == "next":
                    log(f"key {event.code} -> next track")
                    press(ui, ecodes.KEY_NEXTSONG)
                elif action == "pass":
                    if event.type == ecodes.EV_KEY:
                        log(f"passthrough key {event.code} value {event.value}")
                    ui.write_event(event)
                    ui.syn()
    except OSError as err:
        log(f"device lost: {err}")
    finally:
        for closeable in (ui, dev):
            try:
                closeable and closeable.close()
            except OSError:
                pass


def main():
    wanted = os.environ.get("PTT_DEVICE", "AVRCP")
    key_name = os.environ.get("PTT_KEY", "KEY_NEXTSONG")
    next_name = os.environ.get("NEXT_KEY", "KEY_PREVIOUSSONG")
    ptt_key = getattr(ecodes, key_name, None)
    next_key = getattr(ecodes, next_name, None)
    if ptt_key is None or next_key is None:
        log(f"unknown key: PTT_KEY={key_name} NEXT_KEY={next_name}")
        return 2
    cfg = load_config()
    log(f"watching for '{wanted}', ptt key {key_name} ({ptt_key}), next-track key {next_name} ({next_key})")
    while True:
        dev = find_device(wanted)
        if dev is None:
            time.sleep(SCAN_SECONDS)
            continue
        pump(dev, cfg, ptt_key, next_key)
        time.sleep(SCAN_SECONDS)


if __name__ == "__main__":
    sys.exit(main() or 0)
