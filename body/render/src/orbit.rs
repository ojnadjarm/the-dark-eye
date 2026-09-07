//! The agents: coloured glyphs orbiting OUTSIDE the eye, with comet tails
//! while they work and a gold burst when they finish. Port of
//! `spec/eye-reference.html` lines 485-514 and the `statuses` handler at 607-623.
//! Green is the Eye's own colour and never an agent's.
use crate::atlas::{font, Atlas, GLYPH_FONT};
use crate::caption::show;
use crate::eye::{hex_rgb, Rect, CX, CY, RX, RY};
use crate::rain::{Rng, TAU};
use cairo::Context;

/// One distinct colour per agent — rainbow, never green.
pub const AGENT_COLORS: [&str; 6] = ["#4dd9ff", "#ff4dd9", "#ff9a4d", "#b04dff", "#ffe14d", "#ff4d88"];
/// A non-working orbiter is removed 1.6 s after its last message.
pub const LINGER_MS: u64 = 1600;
/// A working orbiter is removed 10 min after its last status update.
pub const WORKING_TTL_MS: u64 = 600_000;
/// At most this many orbiters at once; the oldest makes room.
pub const MAX_ORBITERS: usize = 12;
/// How long the gold burst takes to grow and fade.
pub const BURST_MS: f64 = 1200.0;
/// Everything an orbiter can reach: the widest ring plus the gold burst.
pub const DIRTY: Rect = (24.0, 196.0, 300.0, 184.0);

/// One agent on its orbit.
pub struct Orbiter {
    pub id: String,
    pub state: String,
    pub color: [f64; 3],
    pub phase: f64,
    pub gi: usize,
    pub tail: [usize; 3],
    /// the error colour flickers between the two reds; chosen in `step`
    pub err_hot: bool,
    pub done_at: u64,
    /// when it disappears, unless a status update pushes it back
    pub until: u64,
}

/// The orbiters, in the order they first reported — that order is their orbit.
#[derive(Default)]
pub struct Orbiters {
    pub list: Vec<Orbiter>,
    next_color: usize,
}

/// Where orbiter `oi` rides this frame: its two radii and its angle.
pub fn place(oi: usize, phase: f64, t: f64) -> (f64, f64, f64) {
    let orx = RX + 16.0 + (oi % 2) as f64 * 10.0;
    let ory = RY + 20.0 + (oi % 2) as f64 * 8.0;
    (orx, ory, t * (0.9 + (oi % 3) as f64 * 0.25) + phase)
}

impl Orbiters {
    /// Apply one `status` message; colour, phase and glyphs survive a restate.
    pub fn set(&mut self, id: String, state: String, now: u64, rng: &mut Rng, n_glyphs: usize) {
        let until = now + if state == "working" { WORKING_TTL_MS } else { LINGER_MS };
        if let Some(o) = self.list.iter_mut().find(|o| o.id == id) {
            if state == "done" && o.state != "done" {
                o.done_at = now;
            }
            o.state = state;
            o.until = until;
            return;
        }
        let color = hex_rgb(AGENT_COLORS[self.next_color % AGENT_COLORS.len()]);
        self.next_color += 1;
        self.list.push(Orbiter {
            id,
            done_at: now,
            state,
            color,
            phase: rng.f() * TAU,
            gi: rng.idx(n_glyphs),
            tail: [rng.idx(n_glyphs), rng.idx(n_glyphs), rng.idx(n_glyphs)],
            err_hot: false,
            until,
        });
        if self.list.len() > MAX_ORBITERS {
            self.list.remove(0);
        }
    }

    /// Drop the ones whose linger or ttl is over.
    pub fn sweep(&mut self, now: u64) {
        self.list.retain(|o| now < o.until);
    }

    /// Only the short-lived states (the gold burst, an error) need 60 fps.
    pub fn busy(&self, now: u64) -> bool {
        self.list.iter().any(|o| o.state != "working" && now < o.until)
    }

    /// The frame's random choices, drawn from the shared `Rng` before either
    /// backend paints, so both draw the same glyphs.
    pub fn step(&mut self, s: f64, rng: &mut Rng, n_glyphs: usize) {
        for o in self.list.iter_mut() {
            match o.state.as_str() {
                "working" => {
                    if rng.f() < 0.02 * s {
                        o.gi = rng.idx(n_glyphs);
                    }
                }
                "error" => o.err_hot = rng.f() < 0.6,
                _ => {}
            }
        }
    }

    /// One frame of every orbit.
    pub fn draw(&self, g: &Context, atlas: &Atlas, t: f64, now: u64) {
        let f10 = font(GLYPH_FONT, 10.0);
        let f13 = font(GLYPH_FONT, 13.0);
        for (oi, o) in self.list.iter().enumerate() {
            let (orx, ory, ang) = place(oi, o.phase, t);
            let (x, y) = (CX + ang.cos() * orx, CY + ang.sin() * ory);
            let [r, gg, b] = o.color;
            match o.state.as_str() {
                "working" => {
                    for k in 1..=3usize {
                        let a2 = ang - k as f64 * 0.13;
                        g.set_source_rgba(r / 255.0, gg / 255.0, b / 255.0, (140.0 - k as f64 * 40.0) / 255.0);
                        show(g, &f10, atlas.glyph(o.tail[k - 1]), CX + a2.cos() * orx, CY + a2.sin() * ory);
                    }
                    g.set_source_rgba(r / 255.0, gg / 255.0, b / 255.0, 1.0);
                    show(g, &f13, atlas.glyph(o.gi), x, y);
                }
                "done" => {
                    let k = (now.saturating_sub(o.done_at) as f64 / BURST_MS).min(1.0);
                    g.set_source_rgba(1.0, 209.0 / 255.0, 102.0 / 255.0, 0.9 * (1.0 - k));
                    show(g, &font(GLYPH_FONT, (13.0 + k * 10.0).round()), atlas.glyph(o.gi), x, y);
                }
                "error" => {
                    let [er, eg, eb] = hex_rgb(if o.err_hot { "#ff3b4d" } else { "#7a1020" });
                    g.set_source_rgba(er / 255.0, eg / 255.0, eb / 255.0, 1.0);
                    show(g, &f13, atlas.glyph(o.gi), x, y);
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cairo::{Format, ImageSurface};

    fn orbiters() -> (Orbiters, Rng) {
        (Orbiters::default(), Rng::new())
    }

    #[test]
    fn each_agent_keeps_its_own_colour_from_the_rainbow_and_never_green() {
        let (mut o, mut rng) = orbiters();
        for i in 0..7 {
            o.set(format!("a{i}"), "working".into(), 0, &mut rng, 41);
        }
        assert_eq!(o.list.len(), 7);
        assert_eq!(o.list[0].color, hex_rgb(AGENT_COLORS[0]));
        assert_eq!(o.list[6].color, hex_rgb(AGENT_COLORS[0]), "the palette wraps");
        assert!(!AGENT_COLORS.contains(&"#4dffa0"), "green is the Eye only");
        let first = o.list[0].color;
        o.set("a0".into(), "done".into(), 500, &mut rng, 41);
        assert_eq!(o.list[0].color, first, "a restate keeps the colour");
        assert_eq!(o.list[0].done_at, 500);
    }

    #[test]
    fn a_working_orbiter_expires_after_its_ttl_and_a_finished_one_after_the_linger() {
        let (mut o, mut rng) = orbiters();
        o.set("a".into(), "working".into(), 0, &mut rng, 41);
        o.sweep(WORKING_TTL_MS - 1);
        assert_eq!(o.list.len(), 1);
        o.set("a".into(), "working".into(), 1000, &mut rng, 41);
        o.sweep(WORKING_TTL_MS);
        assert_eq!(o.list.len(), 1, "a status update refreshes the ttl");
        o.sweep(1000 + WORKING_TTL_MS);
        assert!(o.list.is_empty(), "a working orbiter expires on its own");
        o.set("b".into(), "done".into(), 2000, &mut rng, 41);
        o.sweep(2000 + LINGER_MS - 1);
        assert_eq!(o.list.len(), 1);
        o.sweep(2000 + LINGER_MS);
        assert!(o.list.is_empty());
    }

    /// D3: working orbiters animate at the idle rate; only a burst is busy.
    #[test]
    fn a_working_orbiter_does_not_make_the_eye_busy_but_a_finished_one_does() {
        let (mut o, mut rng) = orbiters();
        o.set("a".into(), "working".into(), 0, &mut rng, 41);
        o.set("b".into(), "working".into(), 0, &mut rng, 41);
        assert_eq!(o.list.len(), 2, "they are still drawn");
        assert!(!o.busy(0), "two working orbiters do not pin the frame loop");
        o.set("b".into(), "done".into(), 100, &mut rng, 41);
        assert!(o.busy(100));
        assert!(!o.busy(100 + LINGER_MS), "the burst is over");
    }

    #[test]
    fn the_list_is_capped_and_the_oldest_orbiter_is_dropped() {
        let (mut o, mut rng) = orbiters();
        for i in 0..MAX_ORBITERS + 3 {
            o.set(format!("a{i}"), "working".into(), 0, &mut rng, 41);
        }
        assert_eq!(o.list.len(), MAX_ORBITERS);
        assert_eq!(o.list[0].id, "a3", "the oldest three were dropped");
    }

    #[test]
    fn the_orbits_draw_inside_their_dirty_rect_and_the_burst_fades_to_nothing() {
        let atlas = Atlas::build().expect("atlas");
        let (mut o, mut rng) = orbiters();
        o.set("w".into(), "working".into(), 0, &mut rng, atlas.len());
        o.set("d".into(), "done".into(), 0, &mut rng, atlas.len());
        let mut ink = |o: &mut Orbiters, t: f64, now: u64| -> u64 {
            let mut s = ImageSurface::create(Format::ARgb32, 340, 380).expect("surface");
            {
                let g = Context::new(&s).expect("ctx");
                o.draw(&g, &atlas, t, now);
            }
            s.flush();
            let stride = s.stride() as usize;
            let d = s.data().expect("data");
            for y in 0..380usize {
                for x in 0..340usize {
                    let inside = (x as f64) >= DIRTY.0 && (x as f64) < DIRTY.0 + DIRTY.2 && (y as f64) >= DIRTY.1 && (y as f64) < DIRTY.1 + DIRTY.3;
                    assert!(inside || d[y * stride + x * 4 + 3] == 0, "ink at {x},{y} outside the orbit rect");
                }
            }
            (0..380).map(|y| (0..340).map(|x| d[y * stride + x * 4 + 3] as u64).sum::<u64>()).sum()
        };
        for turn in 0..12 {
            assert!(ink(&mut o, turn as f64 * 0.5, 0) > 0, "the orbiters are drawn");
        }
        o.list[0].state = "gone".into();
        assert_eq!(ink(&mut o, 0.0, 1200), 0, "a finished burst has faded out");
    }
}
