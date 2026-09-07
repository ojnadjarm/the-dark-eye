//! The eye itself: lids, the rim rain, the filling, the slit, the phosphor
//! trail, the bloom, the scanlines and the iris — the port of `spec/eye-reference.html`
//! lines 315-485, composed into one offscreen surface per frame.
use crate::atlas::{font, show_text, Blur, GLYPH_FONT};
use crate::caption::Painter;
use crate::orbit;
use crate::overlay;
use crate::rain::TAU;
use crate::sched::State;
use crate::sim::{Frame, Sim};
use cairo::{Context, Filter, Format, ImageSurface, Operator};
use std::error::Error;

pub const W: i32 = 340;
pub const H: i32 = 380;
// layout: a cat eye at the bottom, words breathing just above it
pub const CX: f64 = 170.0;
pub const CY: f64 = 316.0;
pub const RX: f64 = 92.0;
pub const RY: f64 = 42.0;
pub const IRIS_RX: f64 = 21.0;
pub const IRIS_RY: f64 = 34.0;
// the bloom buffer is smaller than the eye's neighbourhood, so the glow
// physically cannot reach the window bounds
pub const BLOOM_X: f64 = CX - RX - 20.0;
pub const BLOOM_Y: f64 = CY - RY - 20.0;
pub const BLOOM_W: f64 = (RX + 20.0) * 2.0;
pub const BLOOM_H: f64 = (RY + 20.0) * 2.0;
const GREEN: [f64; 3] = [77.0, 255.0, 160.0];
/// Everything the eye can touch — the lids, the rim glyphs at full size, the
/// bloom — with room to spare. Nothing is drawn outside it, so every buffer
/// op and the blit to the window stay inside it. `x, y, w, h`.
pub const DIRTY: Rect = (30.0, 220.0, 280.0, 160.0);

/// A region of the window: `x, y, w, h`.
pub type Rect = (f64, f64, f64, f64);

/// Cut a rect down to the window — nothing is ever drawn outside it.
pub fn clamp_rect(r: Rect) -> Rect {
    let (x0, y0) = (r.0.max(0.0), r.1.max(0.0));
    let (x1, y1) = ((r.0 + r.2).min(W as f64), (r.1 + r.3).min(H as f64));
    (x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0))
}

/// The smallest rect holding both.
pub fn union(a: Rect, b: Rect) -> Rect {
    if b.2 <= 0.0 || b.3 <= 0.0 {
        return a;
    }
    let (x0, y0) = (a.0.min(b.0), a.1.min(b.1));
    let (x1, y1) = ((a.0 + a.2).max(b.0 + b.2), (a.1 + a.3).max(b.1 + b.3));
    (x0, y0, x1 - x0, y1 - y0)
}

/// Restrict a context to `r`; the caller has saved.
pub fn clip_rect(g: &Context, r: Rect) {
    g.rectangle(r.0, r.1, r.2, r.3);
    g.clip();
}

/// Restrict a context to `DIRTY`; the caller has saved.
pub fn clip_dirty(g: &Context) {
    clip_rect(g, DIRTY);
}

/// What this frame can have changed: the eye, plus everything drawn on top of it.
pub fn dirty_rect(st: &State) -> Rect {
    let mut cur = DIRTY;
    if !st.orbiters.list.is_empty() {
        cur = union(cur, orbit::DIRTY);
    }
    if st.heard.is_some() {
        cur = union(cur, overlay::heard_rect());
    }
    if let Some(c) = &st.caption {
        cur = union(cur, c.rect());
    }
    cur
}

/// The cat-eye lid curve: pointed corners, full centre.
pub fn lid_y(a: f64) -> f64 {
    let s = a.sin();
    RY * s.signum() * s.abs().powf(1.6)
}

/// `#rrggbb` → 0-255 components; anything else stays green.
pub fn hex_rgb(h: &str) -> [f64; 3] {
    let b = h.as_bytes();
    if b.len() < 7 || b[0] != b'#' {
        return GREEN;
    }
    let p = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).map(f64::from);
    match (p(1), p(3), p(5)) {
        (Ok(r), Ok(g), Ok(bl)) => [r, g, bl],
        _ => GREEN,
    }
}

/// The lid outline, as `leafPath()` walks it.
fn leaf_path(g: &Context) {
    g.new_path();
    g.move_to(CX - RX, CY);
    for i in 1..=40 {
        let a = (i as f64 / 40.0) * std::f64::consts::PI;
        g.line_to(CX - a.cos() * RX, CY - lid_y(a));
    }
    for i in 1..=40 {
        let a = std::f64::consts::PI + (i as f64 / 40.0) * std::f64::consts::PI;
        g.line_to(CX - a.cos() * RX, CY - lid_y(a));
    }
    g.close_path();
}

/// The cairo backend's buffers: the simulation lives in `Sim`.
pub struct Scene {
    frame_buf: ImageSurface,
    eye_buf: ImageSurface,
    trail_buf: ImageSurface,
    bloom_buf: ImageSurface,
    blur: Blur,
    painter: Painter,
    /// what the last frame touched — this one must clear it too
    last_dirty: Rect,
}

fn clear(s: &ImageSurface, area: Option<Rect>) -> Result<(), Box<dyn Error>> {
    let g = Context::new(s)?;
    if let Some(r) = area {
        clip_rect(&g, r);
    }
    g.set_operator(Operator::Clear);
    g.paint()?;
    Ok(())
}

impl Scene {
    pub fn new() -> Result<Self, Box<dyn Error>> {
        Ok(Self {
            frame_buf: ImageSurface::create(Format::ARgb32, W, H)?,
            eye_buf: ImageSurface::create(Format::ARgb32, W, H)?,
            trail_buf: ImageSurface::create(Format::ARgb32, W, H)?,
            bloom_buf: ImageSurface::create(Format::ARgb32, (BLOOM_W / 4.0).round() as i32, (BLOOM_H / 4.0).round() as i32)?,
            blur: Blur::default(),
            painter: Painter::default(),
            last_dirty: DIRTY,
        })
    }

    /// One frame into the offscreen surface; the caller blits it to the window.
    /// Returns the region of the window this frame changed.
    pub fn render(&mut self, sim: &Sim, st: &State, f: &Frame, now: u64) -> Result<Rect, Box<dyn Error>> {
        // everything on top of the eye widens the frame's dirty rect
        let cur = dirty_rect(st);
        let paint = clamp_rect(union(self.last_dirty, cur));
        self.last_dirty = cur;

        self.draw_body(sim, f)?;
        self.feed_trail(f)?;

        clear(&self.frame_buf, Some(paint))?;
        let g = Context::new(&self.frame_buf)?;
        clip_rect(&g, paint);
        g.save()?;
        clip_dirty(&g);
        let body_alpha = f.breathe;
        g.set_source_surface(&self.trail_buf, 0.0, 0.0)?;
        g.paint_with_alpha(body_alpha * 0.55)?; // the ghost underneath
        g.set_source_surface(&self.eye_buf, 0.0, 0.0)?; // the crisp present
        g.paint_with_alpha(body_alpha)?;

        self.bloom(&g, body_alpha)?;

        // scanlines: faint row shading living only inside the eye — CRT whisper
        g.save()?;
        leaf_path(&g);
        g.clip();
        g.set_operator(Operator::DestOut);
        g.set_source_rgba(0.0, 0.0, 0.0, 0.10);
        let mut sy = CY - RY;
        while sy < CY + RY {
            g.rectangle(CX - RX, sy, RX * 2.0, 1.0);
            sy += 3.0;
        }
        g.fill()?;
        g.restore()?;

        // iris — session-coloured, slowly turning (few glyphs: direct text is fine)
        let iris = f.iris;
        let col = |a: f64| (iris[0] / 255.0, iris[1] / 255.0, iris[2] / 255.0, a);
        let f10 = font(GLYPH_FONT, 10.0);
        for p in &sim.rain.iris_fill {
            let x = CX + f.gx + p.a.cos() * IRIS_RX * p.r;
            let y = CY + f.gy + p.a.sin() * IRIS_RY * p.r;
            let (r, gg, b, a) = col(p.o);
            g.set_source_rgba(r, gg, b, a);
            show_text(&g, &f10, sim.atlas.glyph(p.gi), x, y);
        }
        let f12 = font(GLYPH_FONT, 12.0);
        for (i, gi) in sim.rain.iris.iter().enumerate() {
            let a = sim.rain.iris_rot + (i as f64 / 14.0) * TAU;
            let x = CX + f.gx + a.cos() * IRIS_RX;
            let y = CY + f.gy + a.sin() * IRIS_RY;
            let (r, gg, b, al) = col(0.62 + if f.speaking { 0.2 } else { 0.0 });
            g.set_source_rgba(r, gg, b, al);
            show_text(&g, &f12, sim.atlas.glyph(*gi), x, y);
        }
        g.restore()?;

        // ---- on top of the eye: agents, rings, what it heard, the caption
        st.orbiters.draw(&g, &sim.atlas, f.t, now);
        if f.listening {
            overlay::listening_ring(&g, f.t);
        }
        if f.speaking {
            overlay::speaking_ring(&g, f.t, iris);
        }
        if let Some(text) = &st.heard {
            overlay::heard(&g, text);
        }
        if let Some(cap) = &st.caption {
            self.painter.draw(&g, cap, &sim.atlas, now)?;
        }
        drop(g);
        self.frame_buf.flush();
        Ok(paint)
    }

    /// The composed frame — the caller blits it, the tests read its pixels.
    pub fn frame(&mut self) -> &mut ImageSurface {
        &mut self.frame_buf
    }

    /// The eye body: filling, rim and slit, green phosphor, on its own buffer.
    fn draw_body(&mut self, sim: &Sim, f: &Frame) -> Result<(), Box<dyn Error>> {
        clear(&self.eye_buf, Some(DIRTY))?;
        let g = Context::new(&self.eye_buf)?;
        clip_dirty(&g);

        // filling: dim glyphs adrift inside the lids
        g.save()?;
        leaf_path(&g);
        g.clip();
        for m in &sim.rain.inner {
            let lid = RY * (1.0 - m.u * m.u).max(0.0).powf(0.9);
            let x = CX + m.u * RX;
            let y = CY + m.f * lid * 0.8;
            let tier = if m.o > 0.16 { 1 } else { 0 };
            sim.atlas.blit(&g, m.gi, tier, x, y, m.s, (m.o * 1.5).min(1.0));
        }
        g.restore()?;

        // rim — glyphs flowing along the lid lines, lit by travelling waves
        for m in &sim.rain.rim {
            let x = CX + m.a.cos() * RX * f.pulse;
            let y = CY + lid_y(m.a) * f.pulse + m.j;
            let tier = sim.rain.rim_tier(m);
            let alpha = if tier >= 2 { 1.0 } else { m.o };
            sim.atlas.blit(&g, m.gi, tier, x, y, m.s, alpha);
        }

        // the slit — tall, vertical, feline, the hottest thing in the eye
        for j in -3i32..=3 {
            let gi = sim.rain.slit[(j + 3) as usize];
            let tier = if j == 0 && f.exc > 0.5 { 4 } else if j.abs() == 3 { 2 } else { 3 };
            let alpha = f.slit_pulse * if j.abs() == 3 { 0.5 } else { 1.0 };
            sim.atlas.blit(&g, gi, tier, CX - 4.0 + f.gx, CY + j as f64 * 11.0 + f.gy, 13.0, alpha.clamp(0.0, 1.0));
        }
        Ok(())
    }

    /// Phosphor memory: decay, then feed this frame's light into it.
    fn feed_trail(&mut self, f: &Frame) -> Result<(), Box<dyn Error>> {
        let g = Context::new(&self.trail_buf)?;
        clip_dirty(&g);
        g.set_operator(Operator::DestOut);
        // a periodic hard wipe kills 8-bit alpha residue
        let a = if f.wipe { 0.4 } else { 1.0 - 0.84f64.powf(f.s) };
        g.set_source_rgba(0.0, 0.0, 0.0, a);
        g.paint()?;
        g.set_operator(Operator::Over);
        g.set_source_surface(&self.eye_buf, 0.0, 0.0)?;
        g.paint_with_alpha(0.45)?;
        Ok(())
    }

    /// Downscale the eye, blur, add back — haze that hugs the glyphs.
    fn bloom(&mut self, g: &Context, body_alpha: f64) -> Result<(), Box<dyn Error>> {
        clear(&self.bloom_buf, None)?;
        {
            let b = Context::new(&self.bloom_buf)?;
            let k = self.bloom_buf.width() as f64 / BLOOM_W;
            b.scale(k, k);
            b.set_source_surface(&self.eye_buf, -BLOOM_X, -BLOOM_Y)?;
            if let Ok(p) = b.source().try_into() as Result<cairo::SurfacePattern, _> {
                p.set_filter(Filter::Bilinear);
            }
            b.paint()?;
        }
        self.bloom_buf.flush();
        self.blur.argb32(&mut self.bloom_buf, 1.2)?;
        g.save()?;
        g.set_operator(Operator::Add);
        g.translate(BLOOM_X, BLOOM_Y);
        g.scale(BLOOM_W / self.bloom_buf.width() as f64, BLOOM_H / self.bloom_buf.height() as f64);
        g.set_source_surface(&self.bloom_buf, 0.0, 0.0)?;
        if let Ok(p) = g.source().try_into() as Result<cairo::SurfacePattern, _> {
            p.set_filter(Filter::Bilinear);
        }
        g.paint_with_alpha(0.3 * body_alpha)?;
        g.restore()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lid_curve_is_pointed_at_the_corners_and_full_in_the_middle() {
        assert_eq!(lid_y(0.0), 0.0);
        assert!((lid_y(std::f64::consts::FRAC_PI_2) - RY).abs() < 1e-9);
        assert!((lid_y(3.0 * std::f64::consts::FRAC_PI_2) + RY).abs() < 1e-9);
        assert!(lid_y(0.3) < RY * 0.3f64.sin(), "pointier than an ellipse near the corner");
    }

    #[test]
    fn a_colour_is_read_from_its_hex_and_anything_else_stays_green() {
        assert_eq!(hex_rgb("#b04dff"), [176.0, 77.0, 255.0]);
        assert_eq!(hex_rgb("#4dffa0"), [77.0, 255.0, 160.0]);
        for bad in ["", "b04dff", "#zz4dff", "#abc"] {
            assert_eq!(hex_rgb(bad), [77.0, 255.0, 160.0], "{bad}");
        }
    }

    /// Step the simulation and draw, as the frame loop does.
    fn draw(scene: &mut Scene, sim: &mut Sim, st: &mut State, t: f64, now: u64) {
        let f = sim.step(st, t, 1.0, now);
        scene.render(sim, st, &f, now).expect("frame");
    }

    #[test]
    fn a_frame_draws_ink_only_around_the_eye_and_leaves_the_window_transparent() {
        let mut scene = Scene::new().expect("scene");
        let mut sim = Sim::new().expect("sim");
        let mut st = State::new();
        for i in 0..30 {
            draw(&mut scene, &mut sim, &mut st, i as f64 / 60.0, 0);
        }
        draw(&mut scene, &mut sim, &mut st, 0.5, 0);
        let s = scene.frame();
        let stride = s.stride() as usize;
        let data = s.data().expect("frame data");
        let alpha = |x: usize, y: usize| data[y * stride + x * 4 + 3];
        let ink: u64 = (0..H as usize)
            .map(|y| (0..W as usize).map(|x| alpha(x, y) as u64).sum::<u64>())
            .sum();
        assert!(ink > 100_000, "the eye is drawn (ink={ink})");
        assert_eq!(alpha(2, 2), 0, "the top-left corner stays transparent");
        assert_eq!(alpha(W as usize - 3, 2), 0, "and so does the top-right");
        let band: u64 = (0..W as usize).map(|x| alpha(x, CY as usize) as u64).sum();
        assert!(band > 1000, "the eye's own row carries most of it");
    }

    #[test]
    fn the_eye_stays_inside_its_lids_and_the_bloom_never_reaches_the_edges() {
        let mut scene = Scene::new().expect("scene");
        let mut sim = Sim::new().expect("sim");
        let mut st = State::new();
        st.apply(crate::sched::Msg::Session { active: "a".into(), color: "#4dd9ff".into() }, 0);
        st.apply(crate::sched::Msg::Speaking { ms: 60_000 }, 0);
        for _ in 0..10 {
            draw(&mut scene, &mut sim, &mut st, 0.1, 100);
        }
        draw(&mut scene, &mut sim, &mut st, 0.2, 100);
        let s = scene.frame();
        let stride = s.stride() as usize;
        let data = s.data().expect("frame data");
        for y in 0..H as usize {
            for x in 0..W as usize {
                let a = data[y * stride + x * 4 + 3];
                let far = (y as f64) < CY - RY - 40.0 || (y as f64) > CY + RY + 40.0 || (x as f64) < CX - RX - 40.0 || (x as f64) > CX + RX + 40.0;
                assert!(!far || a == 0, "ink at {x},{y} is outside the eye's neighbourhood");
            }
        }
    }
}

