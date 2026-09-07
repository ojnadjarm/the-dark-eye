"""Unit tests for ptt-earbuds.py — routing, profile sequence, config loading, device-name match."""
import importlib.util
import json
import os
import tempfile
import time
import unittest

from evdev import ecodes

spec = importlib.util.spec_from_file_location(
    "ptt_earbuds", os.path.join(os.path.dirname(os.path.abspath(__file__)), "ptt-earbuds.py"))
ptt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ptt)


class Event:
    def __init__(self, type, code, value, sec=0.0):
        self.type, self.code, self.value, self.sec = type, code, value, sec

    def timestamp(self):
        return self.sec


PTT = ecodes.KEY_NEXTSONG
NEXT = ecodes.KEY_PREVIOUSSONG


class Route(unittest.TestCase):
    def test_press_toggles(self):
        self.assertEqual(ptt.route(Event(ecodes.EV_KEY, PTT, 1), None, PTT), "toggle")

    def test_release_and_repeat_drop(self):
        self.assertEqual(ptt.route(Event(ecodes.EV_KEY, PTT, 0), None, PTT), "drop")
        self.assertEqual(ptt.route(Event(ecodes.EV_KEY, PTT, 2), None, PTT), "drop")

    def test_debounce_drops_a_fast_second_press(self):
        self.assertEqual(ptt.route(Event(ecodes.EV_KEY, PTT, 1, 10.2), 10.0, PTT), "drop")

    def test_debounce_lets_a_late_press_through(self):
        self.assertEqual(ptt.route(Event(ecodes.EV_KEY, PTT, 1, 10.5), 10.0, PTT), "toggle")

    def test_single_tap_keys_pass(self):
        for code in (ecodes.KEY_PLAYCD, ecodes.KEY_PAUSECD):
            for value in (1, 0):
                self.assertEqual(ptt.route(Event(ecodes.EV_KEY, code, value), 0.0, PTT), "pass")

    def test_triple_tap_key_becomes_next_track(self):
        self.assertEqual(ptt.route(Event(ecodes.EV_KEY, NEXT, 1), 0.0, PTT, NEXT), "next")
        self.assertEqual(ptt.route(Event(ecodes.EV_KEY, NEXT, 0), 0.0, PTT, NEXT), "drop")
        self.assertEqual(ptt.route(Event(ecodes.EV_KEY, NEXT, 1), 0.0, PTT), "pass")

    def test_syn_passes(self):
        self.assertEqual(ptt.route(Event(ecodes.EV_SYN, 0, 0), 0.0, PTT), "pass")


SINKS = """Sink #12
	Name: alsa_output.pci-0000_00_1f.3.hdmi-stereo
	Volume: front-left: 65536 / 100% / 0.00 dB
Sink #40
	Name: bluez_output.AC_80_0A_27_65_6C.1
	Volume: front-left: 26214 /  40% / -23.81 dB,   front-right: 26214 /  40% / -23.81 dB
	Properties:
		api.bluez5.profile = "a2dp-sink"
"""


CARDS = """Card #40
	Name: bluez_card.AC_80_0A_27_65_6C
	Profiles:
		a2dp-sink: High Fidelity Playback (A2DP Sink, codec AAC)
		headset-head-unit: Headset Head Unit (HSP/HFP, codec MSBC)
	Active Profile: a2dp-sink
"""

SOURCES = """13090	alsa_input.pci-0000_00_1f.3.analog-stereo	PipeWire	s32le 2ch	SUSPENDED
312022	bluez_input.AC_80_0A_27_65_6C.0	PipeWire	s16le 1ch	SUSPENDED
"""


class Parsing(unittest.TestCase):
    def test_bluez_sink_parses_pactl(self):
        self.assertEqual(ptt.bluez_sink(SINKS), ("bluez_output.AC_80_0A_27_65_6C.1", "a2dp-sink", "40%"))
        self.assertIsNone(ptt.bluez_sink("Sink #1\n\tName: alsa_output.x\n"))

    def test_bluez_card_parses_name_and_active_profile(self):
        self.assertEqual(ptt.bluez_card(CARDS), ("bluez_card.AC_80_0A_27_65_6C", "a2dp-sink"))
        self.assertEqual(ptt.bluez_card("Card #1\n\tName: alsa_card.x\n"), (None, None))

    def test_hfp_available_reads_the_card_profiles(self):
        self.assertTrue(ptt.hfp_available("bluez_card.AC_80_0A_27_65_6C", CARDS))
        self.assertFalse(ptt.hfp_available("bluez_card.AC_80_0A_27_65_6C", CARDS_NO_HFP))
        self.assertFalse(ptt.hfp_available("bluez_card.other", CARDS))

    def test_bluez_source_is_the_earbud_one(self):
        self.assertEqual(ptt.bluez_source(SOURCES), "bluez_input.AC_80_0A_27_65_6C.0")
        self.assertIsNone(ptt.bluez_source(SOURCES.splitlines()[0]))


CARDS_NO_HFP = """Card #40
	Name: bluez_card.AC_80_0A_27_65_6C
	Profiles:
		a2dp-sink: High Fidelity Playback (A2DP Sink, codec AAC)
	Active Profile: a2dp-sink
"""


class Talk(unittest.TestCase):
    """The sequence, and the rule that a toggle which changed no profile changes no volume."""

    def fake(self, *, mic, card=("bluez_card.x", ptt.A2DP), source="bluez_input.x.0",
             profile_ok=True, sink=("bluez_output.x.1", ptt.A2DP, "67%"),
             hfp_sink=("bluez_output.x.1", ptt.HFP, "67%"), hfp_there=True):
        calls = []
        self.addCleanup(setattr, ptt, "A2DP_SETTLE_SECONDS", ptt.A2DP_SETTLE_SECONDS)
        ptt.A2DP_SETTLE_SECONDS = 0
        active = {"profile": card[1]}

        def pactl(*args):
            calls.append(" ".join(args))
            return "alsa_input.laptop\n" if args[0] == "get-default-source" else ""

        def set_profile(_card, profile):
            calls.append(f"profile {profile}")
            if profile_ok:
                active["profile"] = profile
            return profile_ok

        for name, fn in (
                ("pactl", pactl),
                ("bluez_card", lambda listing=None: card),
                ("bluez_source", lambda listing=None: source),
                ("bluez_sink", lambda listing=None: hfp_sink if active["profile"] == ptt.HFP else sink),
                ("set_profile", set_profile),
                ("hfp_available", lambda _card, listing=None: hfp_there),
                ("sco_up", lambda mac, listing=None: False),
                ("wait_for", lambda check, **kw: check()),
                ("connect_hfp", lambda mac: calls.append(f"connect-hfp {mac}")),
                ("toggle_mic", lambda cfg: calls.append("mic") or {"ok": True, "on": mic.pop(0)})):
            self.addCleanup(setattr, ptt, name, getattr(ptt, name))
            setattr(ptt, name, fn)
        return calls

    def test_opening_switches_the_profile_and_the_source_before_the_mic(self):
        calls = self.fake(mic=[True])
        state = {}
        self.assertTrue(ptt.toggle_talk({"secret": "s", "port": 1}, state))
        self.assertEqual(calls, ["get-default-source", f"profile {ptt.HFP}",
                                 "set-default-source bluez_input.x.0", "mic"])
        self.assertTrue(state["switched"])
        self.assertEqual(state["volume"], "67%")

    def test_closing_calls_the_mic_first_then_undoes_the_switch(self):
        calls = self.fake(mic=[True, False])
        state = {}
        ptt.toggle_talk({"secret": "s", "port": 1}, state)
        del calls[:]
        self.assertFalse(ptt.toggle_talk({"secret": "s", "port": 1}, state))
        self.assertEqual(calls[:4], ["mic", "set-default-source alsa_input.laptop",
                                     "suspend-source bluez_input.x.0 1", f"profile {ptt.A2DP}"])
        self.assertFalse(state["switched"])

    def test_a_missing_earbud_source_falls_back_to_a2dp_without_a_volume_change(self):
        calls = self.fake(mic=[True], source=None)
        ptt.toggle_talk({"secret": "s", "port": 1}, {})
        self.assertEqual(calls, ["get-default-source", f"profile {ptt.HFP}",
                                 f"profile {ptt.A2DP}", "mic"])
        self.assertNotIn("set-sink-volume", " ".join(calls))

    def test_a_failed_profile_set_falls_back_without_waiting(self):
        calls = self.fake(mic=[True], profile_ok=False)
        ptt.toggle_talk({"secret": "s", "port": 1}, {})
        self.assertEqual(calls[-1], "mic")
        self.assertNotIn("set-default-source bluez_input.x.0", calls)

    def test_a_toggle_records_the_tap_the_recovery_guard_reads(self):
        self.fake(mic=[True])
        state = {}
        ptt.toggle_talk({"secret": "s", "port": 1}, state)
        self.assertAlmostEqual(state["last_tap"], time.time(), delta=5)

    def test_no_profile_change_means_no_volume_and_no_profile_call(self):
        calls = self.fake(mic=[True, False], card=("bluez_card.x", ptt.HFP))
        state = {}
        ptt.toggle_talk({"secret": "s", "port": 1}, state)
        ptt.toggle_talk({"secret": "s", "port": 1}, state)
        self.assertEqual(calls, ["mic", "mic"])

    def test_the_hfp_write_is_the_level_read_just_before_the_switch(self):
        """Each profile stores its own level, so a stale HFP sink is pulled to the A2DP one."""
        calls = self.fake(mic=[True], sink=("bluez_output.x.1", ptt.A2DP, "67%"),
                          hfp_sink=("bluez_output.x.1", ptt.HFP, "40%"))
        ptt.toggle_talk({"secret": "s", "port": 1}, {})
        self.assertEqual(calls, ["get-default-source", f"profile {ptt.HFP}",
                                 "set-default-source bluez_input.x.0",
                                 "set-sink-volume bluez_output.x.1 67%", "mic"])

    def test_an_hfp_sink_already_at_the_a2dp_level_is_not_written(self):
        calls = self.fake(mic=[True])
        ptt.toggle_talk({"secret": "s", "port": 1}, {})
        self.assertNotIn("set-sink-volume", " ".join(calls))

    def test_the_a2dp_sink_is_untouched_when_it_comes_back_unchanged(self):
        calls = self.fake(mic=[True, False], hfp_sink=("bluez_output.x.1", ptt.HFP, "40%"))
        state = {}
        ptt.toggle_talk({"secret": "s", "port": 1}, state)
        del calls[:]
        ptt.toggle_talk({"secret": "s", "port": 1}, state)
        self.assertNotIn("set-sink-volume", " ".join(calls))

    def test_a_card_that_lost_hfp_gets_the_profile_reconnected_first(self):
        """E27: after release_voice_link had to disconnect HFP, BlueZ never offers it again."""
        calls = self.fake(mic=[True], hfp_there=False)
        ptt.toggle_talk({"secret": "s", "port": 1}, {})
        self.assertEqual(calls[:2], ["connect-hfp x", "get-default-source"])

    def test_a_card_that_still_offers_hfp_is_not_reconnected(self):
        calls = self.fake(mic=[True])
        ptt.toggle_talk({"secret": "s", "port": 1}, {})
        self.assertNotIn("connect-hfp x", calls)

    def test_match_volume_only_writes_when_the_level_moved(self):
        calls = self.fake(mic=[])
        ptt.match_volume(ptt.A2DP, "67%")
        self.assertEqual(calls, [])
        ptt.match_volume(ptt.A2DP, "40%")
        self.assertEqual(calls, ["set-sink-volume bluez_output.x.1 40%"])


HCITOOL_SCO = """Connections:
	< ACL AC:80:0A:27:65:6C handle 51 state 1 lm CENTRAL AUTH ENCRYPT
	> SCO AC:80:0A:27:65:6C handle 52 state 1 lm CENTRAL
"""
HCITOOL_ACL = """Connections:
	< ACL AC:80:0A:27:65:6C handle 51 state 1 lm CENTRAL AUTH ENCRYPT
"""


class PhantomVoiceLink(unittest.TestCase):
    """E24: the buds keep a voice link after a close, and then send taps to their assistant.
    E30: the kernel marker alone is not that — recovery needs a live (e)SCO, and it climbs."""

    def ladder(self, *, live, marker=None):
        """Stub the evidence and every recovery step; return the list of steps taken."""
        taken = []

        def recover(mac, step):
            taken.append((ptt.RECOVERY_STEPS[step], mac))
            return live.pop(0) if live else True

        for name, fn in (("sco_line", lambda mac, listing=None: None if not live else "> SCO %s handle 52" % mac),
                         ("phantom_marker", lambda since, listing=None: marker),
                         ("recover_voice_link", recover)):
            self.addCleanup(setattr, ptt, name, getattr(ptt, name))
            setattr(ptt, name, fn)
        return taken

    def armed(self, **extra):
        state = {"watch_sco": (time.time() - ptt.SCO_POLL_SECONDS - 1, "AC:80:0A:27:65:6C")}
        state.update(extra)
        return state

    def test_device_path(self):
        self.assertEqual(ptt.device_path("AC:80:0A:27:65:6C"),
                         "/org/bluez/hci0/dev_AC_80_0A_27_65_6C")
        self.assertIsNone(ptt.device_path(None))

    def test_the_source_is_suspended_before_the_link_is_waited_for(self):
        """PipeWire holds the (e)SCO for its whole suspend timeout otherwise (6.2 s measured)."""
        calls = []
        for name, fn in (("bluez_source", lambda listing=None: "bluez_input.x.0"),
                         ("pactl", lambda *a: calls.append(" ".join(a))),
                         ("sco_up", lambda mac, listing=None: False),
                         ("wait_for", lambda check, **kw: check())):
            self.addCleanup(setattr, ptt, name, getattr(ptt, name))
            setattr(ptt, name, fn)
        self.assertTrue(ptt.release_voice_link("AC:80:0A:27:65:6C"))
        self.assertEqual(calls, ["suspend-source bluez_input.x.0 1"])

    def test_a_link_that_will_not_go_gets_the_hfp_profile_disconnected(self):
        calls = []
        for name, fn in (("bluez_source", lambda listing=None: None),
                         ("pactl", lambda *a: calls.append(" ".join(a))),
                         ("capture", lambda *a: calls.append(" ".join(a[:5]))),
                         ("sco_up", lambda mac, listing=None: True),
                         ("wait_for", lambda check, **kw: check())):
            self.addCleanup(setattr, ptt, name, getattr(ptt, name))
            setattr(ptt, name, fn)
        self.assertFalse(ptt.release_voice_link("AC:80:0A:27:65:6C"))
        self.assertIn("busctl call org.bluez /org/bluez/hci0/dev_AC_80_0A_27_65_6C org.bluez.Device1",
                      calls)

    def test_card_mac(self):
        self.assertEqual(ptt.card_mac("bluez_card.AC_80_0A_27_65_6C"), "AC:80:0A:27:65:6C")
        self.assertIsNone(ptt.card_mac(None))
        self.assertIsNone(ptt.card_mac("bluez_card"))

    def test_sco_line_is_the_evidence_and_sco_up_follows_it(self):
        self.assertIn("SCO", ptt.sco_line("AC:80:0A:27:65:6C", HCITOOL_SCO))
        self.assertIsNone(ptt.sco_line("AC:80:0A:27:65:6C", HCITOOL_ACL))
        self.assertIsNone(ptt.sco_line("AA:BB:CC:DD:EE:FF", HCITOOL_SCO))
        self.assertTrue(ptt.sco_up("AC:80:0A:27:65:6C", HCITOOL_SCO))
        self.assertFalse(ptt.sco_up("AC:80:0A:27:65:6C", HCITOOL_ACL))

    def test_phantom_marker_returns_the_kernel_line(self):
        line = "kernel: Bluetooth: hci0: " + ptt.PHANTOM_SCO + " 3584"
        self.assertEqual(ptt.phantom_marker(0, line + "\n"), line)
        self.assertIsNone(ptt.phantom_marker(0, "kernel: Bluetooth: hci0: link ok\n"))

    def test_a_kernel_marker_without_a_live_link_never_touches_the_buds(self):
        """E30: the marker fires after almost every teardown; acting on it dropped the buds."""
        taken = self.ladder(live=[], marker="kernel: ... " + ptt.PHANTOM_SCO + " 3584")
        state = self.armed()
        self.assertFalse(ptt.check_phantom(state))
        self.assertEqual(taken, [])
        self.assertIsNotNone(state["watch_sco"])

    def test_a_quiet_kernel_log_and_no_link_leaves_the_buds_alone(self):
        taken = self.ladder(live=[])
        state = self.armed()
        self.assertFalse(ptt.check_phantom(state))
        self.assertEqual(taken, [])
        self.assertIsNotNone(state["watch_sco"])

    def test_a_live_link_takes_the_cheapest_step_first(self):
        taken = self.ladder(live=[True])
        state = self.armed()
        self.assertFalse(ptt.check_phantom(state))
        self.assertEqual([step for step, _ in taken], ["suspend-source"])
        self.assertIsNone(state["watch_sco"])

    def test_a_link_that_survives_climbs_one_step_per_poll(self):
        """Whole-device bounce only after suspend-source and the HFP profile both failed."""
        taken = self.ladder(live=[False, False, False])
        state = self.armed()
        self.assertFalse(ptt.check_phantom(state))
        state["watch_last"] = time.time() - ptt.SCO_POLL_SECONDS - 1
        self.assertFalse(ptt.check_phantom(state))
        state["watch_last"] = time.time() - ptt.SCO_POLL_SECONDS - 1
        self.assertTrue(ptt.check_phantom(state))
        self.assertEqual([step for step, _ in taken], list(ptt.RECOVERY_STEPS))
        self.assertIsNone(state["watch_sco"])

    def test_only_the_device_bounce_asks_for_a_re_grab(self):
        taken = self.ladder(live=[False, False])
        state = self.armed()
        self.assertFalse(ptt.check_phantom(state))
        state["watch_last"] = time.time() - ptt.SCO_POLL_SECONDS - 1
        self.assertFalse(ptt.check_phantom(state))
        self.assertEqual([step for step, _ in taken], ["suspend-source", "hfp-profile"])

    def test_an_open_mic_is_never_recovered(self):
        taken = self.ladder(live=[True])
        self.assertFalse(ptt.check_phantom(self.armed(talking=True)))
        self.assertEqual(taken, [])

    def test_a_tap_in_the_last_few_seconds_is_never_recovered(self):
        """Mid-conversation: the owner just tapped, so the link is his, not a leftover."""
        taken = self.ladder(live=[True])
        state = self.armed(last_tap=time.time())
        self.assertFalse(ptt.check_phantom(state))
        self.assertEqual(taken, [])
        self.assertIsNotNone(state["watch_sco"])
        state["last_tap"] = time.time() - ptt.TAP_GUARD_SECONDS - 1
        self.assertFalse(ptt.check_phantom(state))
        self.assertEqual([step for step, _ in taken], ["suspend-source"])

    def test_the_watch_is_armed_by_a_close_and_expires(self):
        state = {"watch_sco": (time.time() - ptt.SCO_WATCH_SECONDS - 1, "AC:80:0A:27:65:6C")}
        self.assertFalse(ptt.check_phantom(state))
        self.assertIsNone(state["watch_sco"])
        self.assertFalse(ptt.check_phantom({}))

    def test_a_close_arms_a_fresh_ladder(self):
        for name, fn in (("bluez_card", lambda listing=None: ("bluez_card.x", ptt.A2DP)),
                         ("bluez_source", lambda listing=None: None),
                         ("pactl", lambda *a: ""),
                         ("set_profile", lambda card, profile: True),
                         ("match_volume", lambda profile, volume: None),
                         ("release_voice_link", lambda mac: True)):
            self.addCleanup(setattr, ptt, name, getattr(ptt, name))
            setattr(ptt, name, fn)
        state = {"switched": True, "watch_step": 2, "marker_logged": True}
        ptt.restore_audio(state)
        self.assertEqual(state["watch_step"], 0)
        self.assertFalse(state["marker_logged"])

    def test_recover_voice_link_runs_one_command_per_step(self):
        calls = []
        for name, fn in (("bluez_source", lambda listing=None: "bluez_input.x.0"),
                         ("pactl", lambda *a: calls.append(" ".join(a))),
                         ("capture", lambda *a: calls.append(" ".join(a[:2]))),
                         ("connect_hfp", lambda mac: calls.append(f"connect-hfp {mac}")),
                         ("sco_up", lambda mac, listing=None: False),
                         ("wait_for", lambda check, **kw: check())):
            self.addCleanup(setattr, ptt, name, getattr(ptt, name))
            setattr(ptt, name, fn)
        self.addCleanup(setattr, ptt, "RECONNECT_SETTLE_SECONDS", ptt.RECONNECT_SETTLE_SECONDS)
        ptt.RECONNECT_SETTLE_SECONDS = 0
        mac = "AC:80:0A:27:65:6C"
        self.assertTrue(ptt.recover_voice_link(mac, 0))
        self.assertEqual(calls, ["suspend-source bluez_input.x.0 1"])
        del calls[:]
        ptt.recover_voice_link(mac, 1)
        self.assertEqual(calls, ["busctl call", f"connect-hfp {mac}"])
        del calls[:]
        ptt.recover_voice_link(mac, 2)
        self.assertEqual(calls, ["bluetoothctl disconnect", "bluetoothctl connect"])


class Config(unittest.TestCase):
    def write(self, data):
        fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(data, fh)
        fh.close()
        self.addCleanup(os.unlink, fh.name)
        return fh.name

    def test_reads_secret_and_port(self):
        cfg = ptt.load_config(self.write({"secret": "s3cret", "port": 9000}))
        self.assertEqual(cfg, {"secret": "s3cret", "port": 9000})

    def test_default_port(self):
        self.assertEqual(ptt.load_config(self.write({"secret": "x"}))["port"], 8642)

    def test_no_secret_raises(self):
        with self.assertRaises(ValueError):
            ptt.load_config(self.write({"port": 8642}))


class DeviceMatch(unittest.TestCase):
    def test_matches(self):
        self.assertTrue(ptt.matches("WF-1000XM5 (AVRCP)", "AVRCP"))
        self.assertTrue(ptt.matches("WF-1000XM5 (AVRCP)", "avrcp"))

    def test_does_not_match(self):
        self.assertFalse(ptt.matches("AT Translated Set 2 keyboard", "AVRCP"))
        self.assertFalse(ptt.matches(None, "AVRCP"))

    def test_find_device_picks_the_named_one(self):
        class Fake:
            def __init__(self, path):
                self.path, self.name = path, {"/a": "keyboard", "/b": "WF-1000XM5 (AVRCP)"}[path]

            def close(self):
                pass

        ptt.InputDevice, real = Fake, ptt.InputDevice
        self.addCleanup(setattr, ptt, "InputDevice", real)
        self.assertEqual(ptt.find_device("AVRCP", ["/a", "/b"]).path, "/b")
        self.assertIsNone(ptt.find_device("AVRCP", ["/a"]))


if __name__ == "__main__":
    unittest.main()
