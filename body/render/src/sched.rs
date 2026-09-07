//! The frame model: what the renderer knows, when the next frame is due.
//! Mirrors `spec/eye-reference.html`: `busy()` = speaking, ptt, caption alive, heard,
//! orbiters; 60 fps while busy, `DARK_EYE_IDLE_FPS` otherwise, no timer at all
//! when the display is off or the window is unmapped.
use crate::atlas::KATA;
use crate::caption::{Caption, Voice};
use crate::orbit::Orbiters;
use crate::rain::Rng;
use serde::{Deserialize, Deserializer};

pub const BUSY_FPS: u64 = 60;
const SPEAK_TAIL_MS: u64 = 1200;
const HEARD_MS: u64 = 4500;
const FRAME_MS: f64 = 16.67;
/// Catch-up cap on `S`, in 1/60 s steps — never below one idle frame, or a slow
/// idle rate would slow the motion down with it.
const MAX_S: f64 = 4.0;

/// Which backend is drawing — the idle rate is not the same for both.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Soft,
    Gpu,
}

/// Idle rate when `DARK_EYE_IDLE_FPS` says nothing: 8 fps was visibly choppy,
/// and a cairo frame costs 1.2 ms of CPU where a GL one costs 0.29 ms, so
/// software stays at 30 (3.3 % of a core) and the GPU idles at 60.
pub fn default_idle_fps(backend: Kind) -> u64 {
    match backend {
        Kind::Soft => 30,
        Kind::Gpu => 60,
    }
}

/// The idle rate the environment asks for, or this backend's default.
pub fn idle_fps_from_env(backend: Kind) -> u64 {
    parse_idle_fps(std::env::var("DARK_EYE_IDLE_FPS").ok().as_deref(), default_idle_fps(backend))
}

/// `DARK_EYE_IDLE_FPS`, 1-60; anything else is `default`.
pub fn parse_idle_fps(v: Option<&str>, default: u64) -> u64 {
    v.and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|f| (1..=BUSY_FPS).contains(f))
        .unwrap_or(default)
}

/// How long frame `n` of a second at `fps` lasts, in ms — 1000/60 is 16 ms
/// (62.5 fps), so the steps of one second are spread to sum to exactly 1000.
pub fn step_ms(fps: u64, n: u64) -> u64 {
    let n = n % fps;
    (n + 1) * 1000 / fps - n * 1000 / fps
}

/// One line of the render socket protocol, main → render.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Msg {
    Session { active: String, color: String },
    /// `append` joins the sentence to the caption already on screen; `ms` is
    /// how long its audio lasts, so the words reveal with the voice. `who` is
    /// whose words they are: the Eye's, or his own read back in gold.
    Speak {
        text: String,
        #[serde(default)]
        append: bool,
        #[serde(default)]
        ms: Option<u64>,
        #[serde(default, deserialize_with = "de_voice")]
        who: Voice,
    },
    Speaking { ms: u64 },
    Status {
        id: String,
        state: String,
        #[serde(default)]
        label: String,
    },
    Ptt { on: bool },
    Heard { text: String },
    Display { on: bool },
}

/// `who`: absent, null or anything but `owner` is the Eye — an older sender
/// that knows nothing about voices still parses.
fn de_voice<'de, D: Deserializer<'de>>(d: D) -> Result<Voice, D::Error> {
    Ok(Option::<String>::deserialize(d)?.as_deref().map_or(Voice::Eye, Voice::from_name))
}

/// One JSON object per line; anything unparseable is dropped by the caller.
pub fn parse_line(line: &str) -> Option<Msg> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    serde_json::from_str(line).ok()
}

/// Everything the frame loop reads, and the clock it runs on (ms, monotonic).
#[derive(Default)]
pub struct State {
    pub session: Option<(String, String)>,
    pub caption: Option<Caption>,
    pub heard: Option<String>,
    pub orbiters: Orbiters,
    pub ptt: bool,
    /// frames a second while nothing is happening
    pub idle_fps: u64,
    pub display_on: bool,
    pub mapped: bool,
    /// the renderer's own `Math.random()`, shared by caption and orbiters
    pub rng: Rng,
    speak_until: u64,
    heard_until: u64,
    last_paint: Option<u64>,
    frames: u64,
}

impl State {
    pub fn new() -> Self {
        Self { display_on: true, idle_fps: idle_fps_from_env(Kind::Soft), rng: Rng::new(), ..Default::default() }
    }

    /// How many glyphs the noise can draw from.
    fn n_glyphs() -> usize {
        KATA.chars().count()
    }

    /// Apply one message at `now`.
    pub fn apply(&mut self, msg: Msg, now: u64) {
        match msg {
            Msg::Session { active, color } => self.session = Some((active, color)),
            Msg::Speak { text, append, ms, who } => {
                let n = Self::n_glyphs();
                // his words never join the Eye's sentence, and never the reverse
                let live = self.caption.as_ref().is_some_and(|c| !c.dead(now) && c.voice == who);
                match self.caption.as_mut() {
                    Some(cap) if append && live => cap.append(&text, now, ms, &mut self.rng, n),
                    _ => self.caption = Some(Caption::layout(&text, who, now, ms, &mut self.rng, n)),
                }
                let reveal = self.caption.as_ref().expect("just laid out").reveal_ms;
                // only the Eye's own words open its mouth: his caption must not
                // brighten the iris or start the speaking ripple
                if who == Voice::Eye {
                    self.speak_until = self.speak_until.max(now + reveal + SPEAK_TAIL_MS);
                }
            }
            Msg::Speaking { ms } => self.speak_until = self.speak_until.max(now + ms),
            Msg::Status { id, state, .. } => {
                let n = Self::n_glyphs();
                self.orbiters.set(id, state, now, &mut self.rng, n);
            }
            Msg::Ptt { on } => self.ptt = on,
            Msg::Heard { text } => {
                self.heard_until = now + HEARD_MS;
                self.heard = Some(text);
            }
            Msg::Display { on } => self.display_on = on,
        }
    }

    /// Drop what has expired; call before reading the state for a frame.
    pub fn sweep(&mut self, now: u64) {
        if self.caption.as_ref().is_some_and(|c| c.dead(now)) {
            self.caption = None;
        }
        if now >= self.heard_until {
            self.heard = None;
        }
        self.orbiters.sweep(now);
    }

    /// Speaking, listening, a caption on screen, a heard line or an orbiter.
    pub fn busy(&self, now: u64) -> bool {
        now < self.speak_until
            || self.ptt
            || self.caption.as_ref().is_some_and(|c| !c.dead(now))
            || now < self.heard_until
            || self.orbiters.busy(now)
    }

    /// The caption/audio window the eye speaks in — drives `exc` and the iris.
    pub fn speaking(&self, now: u64) -> bool {
        now < self.speak_until
    }

    /// The active session's colour, or the eye's own green.
    pub fn session_color(&self) -> &str {
        self.session.as_ref().map(|(_, c)| c.as_str()).unwrap_or("#b04dff")
    }

    /// When the next frame is due, or `None` — nothing to draw, arm no timer.
    pub fn next_deadline(&self, now: u64) -> Option<u64> {
        if !self.display_on || !self.mapped {
            return None;
        }
        let fps = if self.busy(now) { BUSY_FPS } else { self.idle_fps };
        let step = step_ms(fps, self.frames);
        Some(match self.last_paint {
            Some(t) => (t + step).max(now),
            None => now,
        })
    }

    /// `S`: how many 1/60 s steps this frame advances, capped at 4.
    pub fn step_scale(&self, now: u64) -> f64 {
        match self.last_paint {
            Some(t) => ((now - t) as f64 / FRAME_MS).clamp(1.0, MAX_S.max(BUSY_FPS as f64 / self.idle_fps as f64)),
            None => 1.0,
        }
    }

    pub fn on_paint(&mut self, now: u64) {
        self.last_paint = Some(now);
        self.frames = self.frames.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caption::FADE_MS;

    fn st() -> State {
        let mut s = State::new();
        s.mapped = true;
        s
    }

    #[test]
    fn the_parser_takes_every_message_and_drops_the_rest() {
        assert_eq!(
            parse_line(r#"{"type":"ptt","on":true}"#),
            Some(Msg::Ptt { on: true })
        );
        assert_eq!(
            parse_line(r##"{"type":"session","active":"claude","color":"#b04dff"}"##),
            Some(Msg::Session { active: "claude".into(), color: "#b04dff".into() })
        );
        assert_eq!(
            parse_line(r#"{"type":"status","id":"a","state":"working"}"#),
            Some(Msg::Status { id: "a".into(), state: "working".into(), label: String::new() })
        );
        assert_eq!(parse_line(r#"{"type":"speaking","ms":900}"#), Some(Msg::Speaking { ms: 900 }));
        assert_eq!(
            parse_line(r#"{"type":"speak","text":"hola"}"#),
            Some(Msg::Speak { text: "hola".into(), append: false, ms: None, who: Voice::Eye }),
            "a caption with no audio behind it still parses"
        );
        assert_eq!(
            parse_line(r#"{"type":"speak","text":"hola","append":true,"ms":800}"#),
            Some(Msg::Speak { text: "hola".into(), append: true, ms: Some(800), who: Voice::Eye })
        );
        for bad in ["", "  ", "not json", r#"{"type":"dock"}"#, r#"{"type":"ptt"}"#] {
            assert_eq!(parse_line(bad), None, "{bad}");
        }
    }

    /// `who` is optional and unknown values are the Eye, so a sender that
    /// predates voices keeps working.
    #[test]
    fn a_speak_carries_a_voice_and_defaults_to_the_eye() {
        assert_eq!(
            parse_line(r#"{"type":"speak","text":"hola","who":"owner"}"#),
            Some(Msg::Speak { text: "hola".into(), append: false, ms: None, who: Voice::Owner })
        );
        for line in [
            r#"{"type":"speak","text":"hola"}"#,
            r#"{"type":"speak","text":"hola","who":"eye"}"#,
            r#"{"type":"speak","text":"hola","who":null}"#,
            r#"{"type":"speak","text":"hola","who":"nobody"}"#,
        ] {
            assert_eq!(
                parse_line(line),
                Some(Msg::Speak { text: "hola".into(), append: false, ms: None, who: Voice::Eye }),
                "{line}"
            );
        }
    }

    /// His caption lives the same life as the Eye's, but it must not open the
    /// Eye's mouth: no speaking ripple, no brightened iris.
    #[test]
    fn his_caption_keeps_the_eye_busy_without_making_it_speak() {
        let mut s = st();
        s.apply(Msg::Speak { text: "que estas haciendo".into(), append: false, ms: None, who: Voice::Owner }, 0);
        let cap = s.caption.as_ref().expect("caption");
        assert_eq!(cap.voice, Voice::Owner);
        let fade_at = cap.fade_at;
        assert!(s.busy(fade_at), "the caption keeps the frames coming");
        assert!(!s.speaking(0), "the Eye is not talking — he is");
        s.apply(Msg::Speak { text: "the eye answers".into(), append: true, ms: Some(1000), who: Voice::Eye }, 100);
        assert!(s.speaking(200), "its own words still do");
        assert_eq!(s.caption.as_ref().expect("caption").voice, Voice::Eye, "his caption is replaced, not appended to");
    }

    #[test]
    fn busy_follows_every_source_and_ends_with_it() {
        let mut s = st();
        assert!(!s.busy(0));
        s.apply(Msg::Ptt { on: true }, 0);
        assert!(s.busy(10_000));
        s.apply(Msg::Ptt { on: false }, 0);
        assert!(!s.busy(0));
        s.apply(Msg::Heard { text: "hola".into() }, 1000);
        assert!(s.busy(5000) && !s.busy(5600));
        s.apply(Msg::Speaking { ms: 500 }, 10_000);
        assert!(s.busy(10_400) && !s.busy(10_600));
        s.apply(Msg::Status { id: "x".into(), state: "working".into(), label: String::new() }, 0);
        assert!(!s.busy(11_000), "a working orbiter draws at the idle rate");
        s.apply(Msg::Status { id: "x".into(), state: "done".into(), label: String::new() }, 20_000);
        assert!(s.busy(21_000) && !s.busy(21_700));
    }

    #[test]
    fn a_caption_stays_busy_for_its_reveal_linger_and_fade() {
        let mut s = st();
        s.apply(Msg::Speak { text: "one two three".into(), append: false, ms: None, who: Voice::Eye }, 0); // 11 non-space chars
        let fade_at = s.caption.as_ref().expect("caption").fade_at;
        assert_eq!(fade_at, s.caption.as_ref().unwrap().reveal_ms + 7000);
        assert!(s.busy(fade_at));
        assert!(!s.busy(fade_at + FADE_MS));
        s.sweep(fade_at + FADE_MS);
        assert!(s.caption.is_none());
    }

    /// The caption follows the voice: sentence two joins sentence one while it
    /// is still up, and starts a fresh caption once it has gone.
    #[test]
    fn an_appended_sentence_joins_the_live_caption_and_replaces_a_dead_one() {
        let mut s = st();
        s.apply(Msg::Speak { text: "one two three".into(), append: false, ms: Some(1000), who: Voice::Eye }, 0);
        let first = s.caption.as_ref().expect("caption").chars.len();
        s.apply(Msg::Speak { text: "four five".into(), append: true, ms: Some(1000), who: Voice::Eye }, 1000);
        let cap = s.caption.as_ref().expect("caption");
        assert!(cap.chars.len() > first, "the sentence joined the one on screen");
        assert_eq!(cap.reveal_ms, 1000, "the tail reveals across its own audio");
        let gone = cap.fade_at + FADE_MS;
        s.sweep(gone);
        assert!(s.caption.is_none());
        s.apply(Msg::Speak { text: "six".into(), append: true, ms: Some(500), who: Voice::Eye }, gone);
        assert_eq!(s.caption.as_ref().expect("caption").chars.len(), 3, "a faded caption is not appended to");
    }

    /// His words as he says them: every partial joins the gold caption already
    /// up, keeping what is resolved, and the final line settles the rest at once.
    #[test]
    fn his_caption_grows_partial_by_partial_and_the_final_line_settles_it() {
        let mut s = st();
        let owner = |text: &str, append: bool, ms: Option<u64>| Msg::Speak { text: text.into(), append, ms, who: Voice::Owner };
        s.apply(owner("no preguntes", false, None), 0);
        let first = s.caption.as_ref().expect("caption").chars.len();
        let resolved_at = s.caption.as_ref().expect("caption").chars[0].resolve_at;
        s.apply(owner("que puede hacer", true, None), 1500);
        s.apply(owner("tu pais", true, None), 3000);
        let cap = s.caption.as_ref().expect("caption");
        assert!(cap.chars.len() > first, "the partials grew the same caption");
        assert_eq!(cap.voice, Voice::Owner, "still his own gold");
        assert_eq!(cap.chars[0].resolve_at, resolved_at, "the words already read keep their moment");
        assert_eq!(s.speak_until, 0, "his own words never open the Eye's mouth");
        // the full transcript disagrees with the partials: one redraw, resolved at once
        s.apply(owner("no preguntes que puede hacer tu pais por ti", false, Some(300)), 4000);
        let cap = s.caption.as_ref().expect("caption");
        assert!(cap.reveal_ms <= 300, "a redraw over words already up does not type itself again");
    }

    #[test]
    fn no_timer_when_the_display_is_off_or_the_window_is_unmapped() {
        let mut s = st();
        assert_eq!(s.next_deadline(0), Some(0));
        s.apply(Msg::Display { on: false }, 0);
        assert_eq!(s.next_deadline(0), None);
        s.apply(Msg::Display { on: true }, 0);
        s.mapped = false;
        assert_eq!(s.next_deadline(0), None);
    }

    #[test]
    fn the_idle_rate_is_the_configured_one_sixty_when_busy_and_never_in_the_past() {
        let mut s = st();
        s.idle_fps = 8;
        s.on_paint(1000);
        assert_eq!(s.next_deadline(1000), Some(1000 + 125));
        s.apply(Msg::Ptt { on: true }, 1000);
        assert_eq!(s.next_deadline(1000), Some(1000 + step_ms(BUSY_FPS, 1)), "the second frame of the second");
        assert_eq!(s.next_deadline(9000), Some(9000), "a late frame is due now");
    }

    /// The idle pattern of one second at 8, 30 and 60 fps: the right number of
    /// frames, none of them off by more than a millisecond, exactly 1000 ms.
    #[test]
    fn every_idle_rate_spreads_its_frames_over_exactly_one_second() {
        for fps in [8, 30, 60] {
            let steps: Vec<u64> = (0..fps).map(|n| step_ms(fps, n)).collect();
            assert_eq!(steps.iter().sum::<u64>(), 1000, "{fps} fps");
            assert!(steps.iter().all(|&m| m.abs_diff(1000 / fps) <= 1), "{fps} fps: {steps:?}");
            let mut s = st();
            s.idle_fps = fps;
            let mut at = 0;
            for _ in 0..fps {
                s.on_paint(at);
                at = s.next_deadline(at).expect("a deadline");
            }
            assert_eq!(at, 1000, "{fps} fps: a second of idle frames");
        }
        assert_eq!(step_ms(60, 0), 16, "1000/60 is 16 ms, not 17");
        assert_eq!(step_ms(30, 2), 34, "the odd millisecond lands on the last frame");
    }

    /// The env var is the only way to change it, and it overrides both
    /// backends; with it unset each backend gets its own default.
    #[test]
    fn the_idle_rate_comes_from_the_environment_and_falls_back_to_the_backend_default() {
        assert_eq!(default_idle_fps(Kind::Soft), 30, "cairo stays at 30");
        assert_eq!(default_idle_fps(Kind::Gpu), 60, "the GPU idles at 60");
        for k in [Kind::Soft, Kind::Gpu] {
            let d = default_idle_fps(k);
            assert_eq!(parse_idle_fps(Some("30"), d), 30);
            assert_eq!(parse_idle_fps(Some(" 8 "), d), 8, "{k:?}: the env overrides both");
            for bad in [None, Some(""), Some("0"), Some("61"), Some("-1"), Some("30.5"), Some("fast")] {
                assert_eq!(parse_idle_fps(bad, d), d, "{k:?} {bad:?}");
            }
        }
    }

    /// A slow idle rate must move the rain as far per second as a fast one.
    #[test]
    fn a_slow_idle_frame_advances_the_whole_time_it_covers() {
        let mut s = st();
        s.idle_fps = 8;
        s.on_paint(0);
        assert!((s.step_scale(125) - 125.0 / FRAME_MS).abs() < 1e-9, "one 8 fps frame is 7.5 steps");
        s.idle_fps = 60;
        assert_eq!(s.step_scale(2000), MAX_S, "a stall is still capped");
    }

    /// D6: 1000/60 is 16 ms — 62.5 fps. Three frames of 17+17+16 are exactly 60.
    #[test]
    fn the_busy_rate_is_exactly_sixty_frames_a_second() {
        let mut s = st();
        s.apply(Msg::Ptt { on: true }, 0);
        let mut at = 0;
        for _ in 0..3 {
            s.on_paint(at);
            at = s.next_deadline(at).expect("a deadline");
        }
        assert_eq!(at, 50, "three busy frames take 50 ms");
        assert_eq!((0..3).map(|n| step_ms(BUSY_FPS, n)).sum::<u64>(), 50);
    }

    #[test]
    fn s_is_the_elapsed_frame_count_between_one_and_four() {
        let mut s = st();
        assert_eq!(s.step_scale(0), 1.0, "the first frame advances one step");
        s.on_paint(1000);
        assert!((s.step_scale(1017) - 17.0 / FRAME_MS).abs() < 1e-9, "one 60 Hz frame is one step");
        assert_eq!(s.step_scale(1008), 1.0, "a fast frame still advances one step");
        assert_eq!(s.step_scale(2000), MAX_S, "a long gap is capped");
    }
}
