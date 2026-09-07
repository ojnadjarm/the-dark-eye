//! What sits on top of the eye but is not the eye: the listening and speaking
//! rings, and the gold `» heard` line. Port of `spec/eye-reference.html` lines 570-597.
use crate::atlas::font;
use crate::caption::{measure, show, TEXT_FONT, TEXT_X};
use crate::eye::{clamp_rect, Rect, CX, CY, RX, RY};
use cairo::Context;

/// The eye's own green, mixed 0.35 toward white — the listening ring.
pub const MID: [f64; 3] = [139.0, 255.0, 193.0];
pub const RING_MS: f64 = 1.1;
/// The speaking ripple runs half a beat behind the listening one.
pub const SPEAK_OFFSET: f64 = 0.55;
/// The heard line's row, wide enough for a line that fills the window.
pub const HEARD_DIRTY: Rect = (8.0, 246.0, 332.0, 26.0);

/// The ripple's two radii at `k` — both backends draw this one shape.
pub fn ring_shape(k: f64) -> (f64, f64) {
    ((RX + 6.0) * (1.0 + k * 0.15), (RY + 12.0) * (1.0 + k * 0.4))
}

/// Where a ripple offset `off` seconds is in its life at `t`.
pub fn ring_k(t: f64, off: f64) -> f64 {
    ((t + off) % RING_MS) / RING_MS
}

/// One expanding ripple around the eye, `k` through its 1.1 s life.
fn ring(g: &Context, k: f64, rgb: [f64; 3], alpha: f64) {
    let (a, b) = ring_shape(k);
    g.save().ok();
    g.translate(CX, CY);
    g.scale(a, b);
    g.new_path();
    g.arc(0.0, 0.0, 1.0, 0.0, std::f64::consts::TAU);
    g.restore().ok();
    g.set_source_rgba(rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0, alpha);
    g.set_line_width(1.5);
    g.stroke().ok();
}

/// The Eye leans in: a quiet ripple while the mic is open.
pub fn listening_ring(g: &Context, t: f64) {
    let k = ring_k(t, 0.0);
    ring(g, k, MID, 0.5 * (1.0 - k));
}

/// The voice made visible, in the session's colour, half a beat offset.
pub fn speaking_ring(g: &Context, t: f64, iris: [f64; 3]) {
    let k = ring_k(t, SPEAK_OFFSET);
    ring(g, k, iris, 0.45 * (1.0 - k));
}

/// The gold line and the x its baseline starts at — both backends draw this.
pub fn heard_line(text: &str) -> (String, f64) {
    let desc = font(TEXT_FONT, 12.0);
    let s = format!("\u{bb} {text}");
    let w = measure(&desc, &s);
    let x = (CX - w / 2.0).max(TEXT_X).min(340.0 - w - 8.0);
    (s, x)
}

/// What he said, gold, brief, centred above the eye and kept in the window.
pub fn heard(g: &Context, text: &str) {
    let desc = font(TEXT_FONT, 12.0);
    let (s, x) = heard_line(text);
    g.save().ok();
    g.set_source_rgba(1.0, 209.0 / 255.0, 102.0 / 255.0, 0.78);
    show(g, &desc, &s, x, CY - RY - 10.0);
    g.restore().ok();
}

/// The row the heard line occupies, clamped to the window.
pub fn heard_rect() -> Rect {
    clamp_rect(HEARD_DIRTY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cairo::{Format, ImageSurface};

    fn draw(f: impl FnOnce(&Context)) -> (Vec<u8>, usize) {
        let mut s = ImageSurface::create(Format::ARgb32, 340, 380).expect("surface");
        {
            let g = Context::new(&s).expect("ctx");
            f(&g);
        }
        s.flush();
        let stride = s.stride() as usize;
        let d = s.data().expect("data").to_vec();
        (d, stride)
    }

    #[test]
    fn a_ring_expands_and_fades_over_its_beat_and_stays_off_the_window_edge() {
        for (k, expect_ink) in [(0.0, true), (0.99, true)] {
            let (d, stride) = draw(|g| ring(g, k, MID, 0.5 * (1.0 - k)));
            let ink: u64 = (0..380).map(|y| (0..340).map(|x| d[y * stride + x * 4 + 3] as u64).sum::<u64>()).sum();
            assert_eq!(ink > 0, expect_ink, "k={k}");
            for y in 0..380usize {
                for x in [0usize, 339] {
                    assert_eq!(d[y * stride + x * 4 + 3], 0, "the ring touches the window edge at k={k}");
                }
            }
        }
        let bright: u64 = {
            let (d, stride) = draw(|g| listening_ring(g, 0.0));
            (0..380).map(|y| (0..340).map(|x| d[y * stride + x * 4 + 3] as u64).sum::<u64>()).sum()
        };
        let faint: u64 = {
            let (d, stride) = draw(|g| listening_ring(g, 1.05));
            (0..380).map(|y| (0..340).map(|x| d[y * stride + x * 4 + 3] as u64).sum::<u64>()).sum()
        };
        assert!(bright > faint * 2, "the ripple fades as it grows ({bright} vs {faint})");
    }

    #[test]
    fn the_heard_line_is_centred_until_it_is_too_long_and_stays_in_its_row() {
        let (d, stride) = draw(|g| heard(g, "hola"));
        let row = |y: usize| (0..340).map(|x| d[y * stride + x * 4 + 3] as u64).sum::<u64>();
        assert!((250..268).map(row).sum::<u64>() > 0, "the line is on its row");
        let r = heard_rect();
        for y in 0..380usize {
            if (y as f64) >= r.1 && (y as f64) < r.1 + r.3 {
                continue;
            }
            assert_eq!(row(y), 0, "ink on row {y}, outside the heard rect");
        }
        let long = "x".repeat(120);
        let (d2, s2) = draw(|g| heard(g, &long));
        for y in 0..380usize {
            assert_eq!(d2[y * s2 + 339 * 4 + 3], 0, "a long line still stops before the edge");
        }
    }
}
