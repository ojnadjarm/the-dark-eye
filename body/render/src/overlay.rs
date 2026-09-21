//! What sits on top of the eye but is not the eye: the listening and speaking
//! rings, and the gold `» heard` line. Port of `spec/eye-reference.html` lines 570-597.
use crate::atlas::font;
use crate::caption::{measure, show, TEXT_FONT, TEXT_X};
use crate::eye::{clamp_rect, hex_rgb, Rect, CX, CY, RX, RY};
use crate::sched::{Mark, Mode};
use cairo::Context;

/// The eye's own green, mixed 0.35 toward white — the listening ring.
pub const MID: [f64; 3] = [139.0, 255.0, 193.0];
pub const RING_MS: f64 = 1.1;
/// The speaking ripple runs half a beat behind the listening one.
pub const SPEAK_OFFSET: f64 = 0.55;
/// The heard line's row, wide enough for a line that fills the window.
pub const HEARD_DIRTY: Rect = (8.0, 246.0, 332.0, 26.0);
/// The marks: square side, gap, how many before the `+`, the row's top and alpha.
pub const MARK: f64 = 6.0;
pub const MARK_GAP: f64 = 4.0;
pub const MARK_MAX: usize = 5;
pub const MARK_Y: f64 = CY + RY + 8.0;
pub const MARK_ALPHA: f64 = 0.85;
/// The row under the eye, wide enough for the ring, five marks and the `+`.
pub const MARKS_DIRTY: Rect = (CX - 40.0, MARK_Y - 3.0, 80.0, 14.0);

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

/// The row of marks as both backends draw it: the left edge of the mode
/// ring's cell, of each square with its colour, and of the `+` past five.
pub struct MarkRow {
    pub ring: Option<f64>,
    pub squares: Vec<(f64, [f64; 3])>,
    pub plus: Option<f64>,
}

/// Cells of `MARK` px, `MARK_GAP` apart, the whole row centred under the eye.
pub fn mark_row(items: &[Mark], mode: Mode) -> MarkRow {
    let n = items.len().min(MARK_MAX);
    let ringed = mode == Mode::Async;
    let cells = n + usize::from(ringed) + usize::from(items.len() > MARK_MAX);
    let w = cells as f64 * MARK + cells.saturating_sub(1) as f64 * MARK_GAP;
    let mut x = (CX - w / 2.0).round();
    let mut next = || {
        let at = x;
        x += MARK + MARK_GAP;
        at
    };
    let ring = ringed.then(&mut next);
    let squares = items.iter().take(n).map(|m| (next(), hex_rgb(&m.color))).collect();
    let plus = (items.len() > MARK_MAX).then(next);
    MarkRow { ring, squares, plus }
}

/// The ring and the `+` are glyphs, so both backends rasterise them alike.
pub const RING_GLYPH: char = '\u{25cb}';
pub const PLUS_GLYPH: char = '+';
pub const MARK_PX: u16 = 10;

/// Where a mark glyph sits in its cell: centred, its baseline on the squares' bottom.
pub fn mark_glyph(left: f64, ch: char) -> (String, f64, f64) {
    let s = ch.to_string();
    let x = left + (MARK - measure(&font(TEXT_FONT, MARK_PX as f64), &s)) / 2.0;
    (s, x, MARK_Y + MARK)
}

/// The marks: one square per waiting thing in its own colour, a hollow ring
/// while the mode is audio notes, a `+` past five. Static — nothing here moves
/// between frames.
pub fn marks(g: &Context, items: &[Mark], mode: Mode) {
    let row = mark_row(items, mode);
    g.save().ok();
    for (x, rgb) in &row.squares {
        g.set_source_rgba(rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0, MARK_ALPHA);
        g.rectangle(*x, MARK_Y, MARK, MARK);
        g.fill().ok();
    }
    g.set_source_rgba(MID[0] / 255.0, MID[1] / 255.0, MID[2] / 255.0, MARK_ALPHA);
    let desc = font(TEXT_FONT, MARK_PX as f64);
    for (left, ch) in [(row.ring, RING_GLYPH), (row.plus, PLUS_GLYPH)] {
        if let Some(left) = left {
            let (s, x, y) = mark_glyph(left, ch);
            show(g, &desc, &s, x, y);
        }
    }
    g.restore().ok();
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
    fn the_marks_row_is_centred_capped_at_five_plus_and_stays_under_the_eye() {
        let item = |c: &str| Mark { color: c.into(), kind: "held".into() };
        let two = [item("#4dd9ff"), item("#b04dff")];
        let row = mark_row(&two, Mode::Call);
        assert_eq!(row.squares.len(), 2);
        assert!(row.ring.is_none() && row.plus.is_none());
        let (l, r) = (row.squares[0].0, row.squares[1].0 + MARK);
        assert!((l + r - 2.0 * CX).abs() <= 1.0, "centred: {l}..{r}");
        assert_eq!(row.squares[0].1, [77.0, 217.0, 255.0], "the item's own colour");
        let seven = vec![item("#4dd9ff"); 7];
        let row = mark_row(&seven, Mode::Async);
        assert_eq!(row.squares.len(), MARK_MAX, "five at most");
        assert!(row.plus.is_some(), "and a + for the rest");
        assert!(row.ring.expect("the mode ring") < row.squares[0].0, "the ring leads the row");
        let (d, stride) = draw(|g| marks(g, &seven, Mode::Async));
        let row_ink = |y: usize| (0..340).map(|x| d[y * stride + x * 4 + 3] as u64).sum::<u64>();
        assert!((MARK_Y as usize..(MARK_Y + MARK) as usize).map(row_ink).sum::<u64>() > 0, "ink on the row");
        let r = clamp_rect(MARKS_DIRTY);
        for y in 0..380usize {
            if (y as f64) >= r.1 && (y as f64) < r.1 + r.3 {
                continue;
            }
            assert_eq!(row_ink(y), 0, "ink on row {y}, outside the marks rect");
        }
        let (d0, s0) = draw(|g| marks(g, &[], Mode::Call));
        assert_eq!((0..380).map(|y| (0..340).map(|x| d0[y * s0 + x * 4 + 3] as u64).sum::<u64>()).sum::<u64>(), 0, "nothing waiting: nothing drawn");
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
