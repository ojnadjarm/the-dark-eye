//! The caption: text decoding out of katakana noise just above the eye — the
//! port of `spec/eye-reference.html` lines 208-283 (`layoutCaption`, `drawCaption`).
//! Wrapping and character advances come from Pango at the same `13px
//! "DejaVu Sans Mono"` the canvas measures with, so the lines break the same.
use crate::atlas::{font, Atlas, Blur};
use crate::eye::{clamp_rect, Rect, CY, RY};
use crate::rain::Rng;
use cairo::{Context, Format, ImageSurface};
use std::cell::RefCell;
use std::collections::HashMap;
use std::error::Error;

pub const TEXT_X: f64 = 14.0;
pub const TEXT_W: f64 = 312.0;
pub const LINE_H: f64 = 19.0;
pub const MAX_LINES: usize = 11;
pub const ANCHOR: f64 = CY - RY - 24.0;
pub const TEXT_FONT: &str = "DejaVu Sans Mono";
pub const CPS: f64 = 38.0;
pub const FADE_MS: u64 = 1600;
/// `filter: blur(12px)` on the backdrop; a gaussian of that many px sigma.
const BG_SIGMA: f64 = 12.0;
pub const BG_PAD: f64 = 36.0; // 3 sigma — past it the blurred rect is nothing

/// Whose words a caption is: the Eye's own, or his, read back to him.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Voice {
    #[default]
    Eye,
    Owner,
}

/// The four colours a caption is drawn in, 0-255.
pub struct Palette {
    pub noise: [f64; 3],
    pub hot: [f64; 3],
    pub lit: [f64; 3],
    pub backdrop: [f64; 3],
}

/// The Eye's own green — `spec/eye-reference.html` `drawCaption`.
pub const EYE_PALETTE: Palette = Palette {
    noise: [77.0, 255.0, 160.0],
    hot: [234.0, 255.0, 242.0],
    lit: [159.0, 255.0, 200.0],
    backdrop: [1.0, 4.0, 3.0],
};

/// His voice: the `» heard` gold, `#ffd166`. The Eye's green survives being
/// mixed toward white; gold does not — washed out it reads as cream — so the
/// resolved words keep the gold itself and only the 160 ms flash whitens.
pub const OWNER_PALETTE: Palette = Palette {
    noise: [255.0, 209.0, 102.0],
    hot: [255.0, 242.0, 205.0],
    lit: [255.0, 209.0, 102.0],
    backdrop: [4.0, 3.0, 1.0],
};

impl Voice {
    /// `who` on the wire; anything but `owner` is the Eye.
    pub fn from_name(s: &str) -> Self {
        if s.eq_ignore_ascii_case("owner") {
            Voice::Owner
        } else {
            Voice::Eye
        }
    }

    pub fn palette(self) -> &'static Palette {
        match self {
            Voice::Eye => &EYE_PALETTE,
            Voice::Owner => &OWNER_PALETTE,
        }
    }
}

/// Unhinted metrics, as the canvas measures and draws: integer advances would
/// drift a whole glyph across a 40-character line.
fn font_options() -> cairo::FontOptions {
    let mut fo = cairo::FontOptions::new().expect("font options");
    fo.set_hint_metrics(cairo::HintMetrics::Off);
    fo.set_hint_style(cairo::HintStyle::None);
    fo
}

thread_local! {
    static SCRATCH: RefCell<Context> = RefCell::new({
        let s = ImageSurface::create(Format::ARgb32, 1, 1).expect("scratch surface");
        let g = Context::new(&s).expect("scratch context");
        g.set_font_options(&font_options());
        g
    });
}

thread_local! {
    /// One layout per font: building one costs more than shaping a line, and
    /// a busy frame draws fifty of them.
    static LAYOUTS: RefCell<HashMap<String, pango::Layout>> = RefCell::new(HashMap::new());
}

/// Run `f` on the cached layout of `desc`, holding `text`.
fn with_layout<R>(desc: &pango::FontDescription, text: &str, f: impl FnOnce(&pango::Layout) -> R) -> R {
    LAYOUTS.with(|m| {
        let mut m = m.borrow_mut();
        let l = m.entry(desc.to_string().to_string()).or_insert_with(|| {
            SCRATCH.with(|c| {
                let l = pangocairo::functions::create_layout(&c.borrow());
                l.set_font_description(Some(desc));
                l
            })
        });
        l.set_text(text);
        f(l)
    })
}

/// The width canvas `measureText(text).width` would report, in px.
pub fn measure(desc: &pango::FontDescription, text: &str) -> f64 {
    with_layout(desc, text, |l| l.size().0 as f64 / pango::SCALE as f64)
}

/// `fillText`: the baseline origin lands on `x,y`, with unhinted metrics.
pub fn show(g: &Context, desc: &pango::FontDescription, text: &str, x: f64, y: f64) {
    with_layout(desc, text, |l| {
        g.move_to(x, y - l.baseline() as f64 / pango::SCALE as f64);
        pangocairo::functions::show_layout(g, l);
    });
}

/// Break `text` at `TEXT_W` exactly as `layoutCaption` does.
pub fn wrap(text: &str, desc: &pango::FontDescription) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for w in text.split_whitespace() {
        let probe = if cur.is_empty() { w.to_string() } else { format!("{cur} {w}") };
        if measure(desc, &probe) > TEXT_W && !cur.is_empty() {
            lines.push(std::mem::take(&mut cur));
            cur = w.to_string();
        } else {
            cur = probe;
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

/// One character of the caption, and the moment its noise resolves into it.
pub struct Ch {
    pub ch: char,
    pub x: f64,
    pub line: usize,
    pub resolve_at: u64,
    pub noise: usize,
}

/// A laid-out caption and its life: reveal, linger, fade.
pub struct Caption {
    pub chars: Vec<Ch>,
    pub lines: usize,
    pub fade_at: u64,
    pub reveal_ms: u64,
    /// whose words these are — it picks the palette, nothing else
    pub voice: Voice,
    text: String,
}

impl Caption {
    /// Lay `text` out at `now`; the reveal runs at `CPS` characters a second,
    /// or across `ms` when the voice says how long the sentence sounds.
    pub fn layout(text: &str, voice: Voice, now: u64, ms: Option<u64>, rng: &mut Rng, n_glyphs: usize) -> Self {
        Self::build(text.trim().to_string(), voice, &[], now, ms, rng, n_glyphs)
    }

    /// The next sentence of the same utterance: what is already laid out keeps
    /// its timing, the new words reveal from `now`.
    pub fn append(&mut self, text: &str, now: u64, ms: Option<u64>, rng: &mut Rng, n_glyphs: usize) {
        let prior: Vec<u64> = self.chars.iter().map(|c| c.resolve_at).collect();
        let full = format!("{} {}", self.text, text.trim());
        *self = Self::build(full, self.voice, &prior, now, ms, rng, n_glyphs);
    }

    /// The whole text laid out again; the first `prior.len()` characters keep
    /// the moments they already had, the rest reveal from `now`.
    fn build(text: String, voice: Voice, prior: &[u64], now: u64, ms: Option<u64>, rng: &mut Rng, n_glyphs: usize) -> Self {
        let desc = font(TEXT_FONT, 13.0);
        let lines = wrap(&text, &desc);
        let mut chars = Vec::new();
        for (li, ln) in lines.iter().enumerate() {
            let mut x = TEXT_X;
            for ch in ln.chars() {
                chars.push(Ch { ch, x, line: li, resolve_at: now, noise: rng.idx(n_glyphs) });
                x += measure(&desc, &ch.to_string());
            }
        }
        let fresh = chars.iter().skip(prior.len()).filter(|c| c.ch != ' ').count();
        let total = chars.iter().filter(|c| c.ch != ' ').count();
        let cps = match ms {
            Some(ms) if ms > 0 && fresh > 0 => fresh as f64 * 1000.0 / ms as f64,
            _ => CPS,
        };
        let mut k = 0usize;
        for (i, c) in chars.iter_mut().enumerate() {
            match prior.get(i) {
                Some(&at) => c.resolve_at = at,
                None => {
                    c.resolve_at = now + (k as f64 / cps * 1000.0) as u64;
                    if c.ch != ' ' {
                        k += 1;
                    }
                }
            }
        }
        let reveal = (fresh as f64 / cps * 1000.0) as u64;
        let linger = ((total as f64 * 45.0) as u64).clamp(7000, 22000);
        Self { chars, lines: lines.len(), fade_at: now + reveal + linger, reveal_ms: reveal, voice, text }
    }

    /// Faded out — the frame loop drops it.
    pub fn dead(&self, now: u64) -> bool {
        now >= self.fade_at + FADE_MS
    }

    /// How many lines are on screen at once.
    pub fn visible(&self) -> usize {
        self.lines.min(MAX_LINES)
    }

    /// Baseline of a visible line index.
    pub fn y_for(&self, line: usize) -> f64 {
        ANCHOR - (self.visible() - 1 - line) as f64 * LINE_H
    }

    /// The band the backdrop covers, `(top, bottom)`.
    pub fn band(&self) -> (f64, f64) {
        (self.y_for(0) - 15.0, self.y_for(self.visible() - 1) + 7.0)
    }

    /// Everything the caption touches, backdrop blur included.
    pub fn rect(&self) -> Rect {
        let (top, bot) = self.band();
        clamp_rect((0.0, top - BG_PAD, 340.0, bot - top + 2.0 * BG_PAD))
    }

    /// How many lines have scrolled off the top by `now`.
    pub fn scroll(&self, now: u64) -> usize {
        let last_line = self.chars.iter().filter(|c| c.resolve_at <= now).map(|c| c.line).max().unwrap_or(0);
        last_line.min(self.lines - 1).saturating_sub(MAX_LINES - 1)
    }

    /// The frame's noise flips, drawn from the shared `Rng` before either
    /// backend paints, so both draw the same characters.
    pub fn step(&mut self, now: u64, rng: &mut Rng, n_glyphs: usize) {
        if self.dead(now) {
            return;
        }
        let scroll = self.scroll(now);
        for i in 0..self.chars.len() {
            let line = self.chars[i].line as isize - scroll as isize;
            let shown = line >= 0 && (line as usize) < MAX_LINES;
            if shown && style_of(&self.chars[i], now) == Style::Noise && rng.f() < 0.25 {
                self.chars[i].noise = rng.idx(n_glyphs);
            }
        }
    }
}

/// How one character shows this frame.
#[derive(PartialEq, Clone, Copy)]
pub enum Style {
    Hidden,
    Noise,
    Hot,
    Lit,
}

/// Where one character is in its reveal at `now`.
pub fn style_of(c: &Ch, now: u64) -> Style {
    if now >= c.resolve_at {
        if now - c.resolve_at < 160 {
            Style::Hot
        } else {
            Style::Lit
        }
    } else if c.resolve_at - now < 900 {
        Style::Noise
    } else {
        Style::Hidden
    }
}

/// Draws captions and keeps the blurred backdrop it already built.
pub struct Painter {
    text: pango::FontDescription,
    mask: Option<(usize, ImageSurface)>,
    blur: Blur,
}

impl Default for Painter {
    fn default() -> Self {
        Self {
            text: font(TEXT_FONT, 13.0),
            mask: None,
            blur: Blur::default(),
        }
    }
}

impl Painter {
    /// The blurred backdrop rectangle, built once per line count.
    pub fn backdrop(&mut self, vis: usize, h: f64) -> Result<&mut ImageSurface, Box<dyn Error>> {
        if self.mask.as_ref().is_none_or(|(v, _)| *v != vis) {
            let w = (TEXT_W + 20.0 + 2.0 * BG_PAD).round() as i32;
            let hh = (h + 2.0 * BG_PAD).round() as i32;
            let mut s = ImageSurface::create(Format::A8, w, hh)?;
            {
                let g = Context::new(&s)?;
                g.set_source_rgba(0.0, 0.0, 0.0, 1.0);
                g.rectangle(BG_PAD, BG_PAD, TEXT_W + 20.0, h);
                g.fill()?;
            }
            s.flush();
            let stride = s.stride() as usize;
            {
                let mut data = s.data()?;
                self.blur.plane(&mut data, w as usize, hh as usize, stride, BG_SIGMA);
            }
            self.mask = Some((vis, s));
        }
        Ok(&mut self.mask.as_mut().expect("just built").1)
    }

    /// One caption frame. `atlas` supplies the katakana noise glyphs.
    pub fn draw(&mut self, g: &Context, cap: &Caption, atlas: &Atlas, now: u64) -> Result<(), Box<dyn Error>> {
        let fade_k = if now > cap.fade_at { ((now - cap.fade_at) as f64 / FADE_MS as f64).min(1.0) } else { 0.0 };
        if fade_k >= 1.0 {
            return Ok(());
        }
        let alpha = 1.0 - fade_k;
        let pal = cap.voice.palette();
        let vis = cap.visible();
        let scroll = cap.scroll(now);
        let (top, bot) = cap.band();

        g.save()?;
        g.set_font_options(&font_options());
        let mask = self.backdrop(vis, bot - top)?;
        g.set_source_rgba(pal.backdrop[0] / 255.0, pal.backdrop[1] / 255.0, pal.backdrop[2] / 255.0, 0.86 * alpha);
        g.mask_surface(&*mask, TEXT_X - 10.0 - BG_PAD, top - BG_PAD)?;

        // resolved characters are drawn as runs — one Pango layout a line
        // instead of one a glyph — and the noise, which is another font at
        // canvas-measured positions, one at a time
        let mut run = String::new();
        let mut run_at = (0.0f64, 0.0f64);
        let mut run_style = Style::Hidden;
        let flush = |g: &Context, text: &mut String, style: Style, at: (f64, f64)| {
            if text.is_empty() {
                return;
            }
            let ([r, gg, b], a) = match style {
                Style::Hot => (pal.hot, alpha),
                _ => (pal.lit, 0.95 * alpha),
            };
            g.set_source_rgba(r / 255.0, gg / 255.0, b / 255.0, a);
            show(g, &self.text, text, at.0, at.1);
            text.clear();
        };

        for i in 0..cap.chars.len() {
            let (cc, cx, cline) = (cap.chars[i].ch, cap.chars[i].x, cap.chars[i].line);
            let line = cline as isize - scroll as isize;
            let style = style_of(&cap.chars[i], now);
            let shown = line >= 0 && (line as usize) < MAX_LINES;
            // a space inherits the run it sits in: it draws nothing either way
            let joins = shown && !run.is_empty() && i > 0 && cline == cap.chars[i - 1].line && (style == run_style || cc == ' ');
            if !joins {
                flush(g, &mut run, run_style, run_at);
            }
            if !shown {
                continue;
            }
            let y = cap.y_for(line as usize);
            match style {
                Style::Hidden => {}
                Style::Noise => {
                    g.set_source_rgba(pal.noise[0] / 255.0, pal.noise[1] / 255.0, pal.noise[2] / 255.0, 0.34 * alpha);
                    atlas.mask(g, cap.chars[i].noise, cx, y);
                }
                Style::Hot | Style::Lit => {
                    if run.is_empty() {
                        run_at = (cx, y);
                        run_style = style;
                    }
                    run.push(cc);
                }
            }
        }
        flush(g, &mut run, run_style, run_at);
        g.restore()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const LOREM: &str = "the eye keeps watch over the room and reports what it hears in a \
        long steady sentence that has to wrap across several lines before it ends here ok";

    #[test]
    fn the_font_is_monospaced_so_a_probe_is_the_sum_of_its_characters() {
        let d = font(TEXT_FONT, 13.0);
        let w = measure(&d, "abcdefghij");
        assert!((w - measure(&d, "a") * 10.0).abs() < 0.01, "10 chars = 10 advances (w={w})");
        assert!(w > 70.0 && w < 90.0, "13px mono is about 7.8 px a glyph (w={w})");
    }

    /// The ticket's parity check: the JS wrap loop, fed this crate's Pango
    /// widths, breaks a 300-character text into the same lines.
    #[test]
    fn the_wrap_agrees_with_the_js_on_the_same_widths() {
        let text: String = LOREM.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(text.chars().count() >= 140);
        let d = font(TEXT_FONT, 13.0);
        let mine = wrap(&text, &d);
        let Some(node) = node_bin() else {
            eprintln!("node not found — JS wrap parity skipped");
            return;
        };
        let advance = measure(&d, "a");
        let out = Command::new(node)
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/scripts/wrap-check.js"))
            .arg(&text)
            .arg(advance.to_string())
            .arg(TEXT_W.to_string())
            .output()
            .expect("run wrap-check.js");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let js: Vec<String> = serde_json::from_slice(&out.stdout).expect("wrap-check json");
        assert_eq!(mine, js, "the native wrap and the JS wrap disagree");
    }

    fn node_bin() -> Option<std::path::PathBuf> {
        if Command::new("node").arg("-v").output().is_ok_and(|o| o.status.success()) {
            return Some("node".into());
        }
        let home = std::env::var("HOME").ok()?;
        std::fs::read_dir(format!("{home}/.nvm/versions/node"))
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("bin/node"))
            .find(|p| p.exists())
    }

    #[test]
    fn a_caption_reveals_at_38_characters_a_second_and_lingers_at_least_seven() {
        let mut rng = Rng::new();
        let cap = Caption::layout("one two three", Voice::Eye, 1000, None, &mut rng, 41);
        assert_eq!(cap.lines, 1);
        assert_eq!(cap.chars.len(), 13, "spaces are laid out too");
        assert_eq!(cap.reveal_ms, (11.0 / CPS * 1000.0) as u64);
        assert_eq!(cap.fade_at, 1000 + cap.reveal_ms + 7000, "short text gets the floor linger");
        assert!(cap.dead(1000 + cap.reveal_ms + 7000 + FADE_MS));
        assert!(!cap.dead(1000 + cap.reveal_ms + 7000 + FADE_MS - 1));
        let xs: Vec<f64> = cap.chars.iter().map(|c| c.x).collect();
        assert_eq!(xs[0], TEXT_X);
        assert!(xs.windows(2).all(|w| w[1] > w[0]), "characters advance left to right");
    }

    /// The reveal is paced by the sentence's own audio, and the next sentence
    /// leaves what is already on screen exactly where it is.
    #[test]
    fn a_sentence_reveals_across_its_audio_and_the_next_one_joins_it() {
        let mut rng = Rng::new();
        // 11 non-space characters over 2200 ms of audio = 5 a second
        let mut cap = Caption::layout("one two three", Voice::Eye, 1000, Some(2200), &mut rng, 41);
        assert_eq!(cap.reveal_ms, 2200);
        let last = cap.chars.last().expect("chars").resolve_at;
        assert!((1000 + 1800..=1000 + 2200).contains(&last), "the words land with the voice ({last})");
        let before: Vec<u64> = cap.chars.iter().map(|c| c.resolve_at).collect();
        cap.append("and four", 5000, Some(1000), &mut rng, 41);
        assert_eq!(
            cap.chars.iter().take(before.len()).map(|c| c.resolve_at).collect::<Vec<_>>(),
            before,
            "what is already on screen does not move"
        );
        assert!(cap.chars.len() > before.len(), "the sentence was added");
        assert!(cap.chars.iter().skip(before.len()).all(|c| c.resolve_at >= 5000), "the tail reveals from now");
        assert_eq!(cap.reveal_ms, 1000, "the tail reveals across its own audio");
        assert_eq!(cap.fade_at, 5000 + 1000 + 7000, "the linger runs from the last sentence");
    }

    #[test]
    fn a_long_caption_scrolls_but_never_shows_more_than_eleven_lines() {
        let mut rng = Rng::new();
        let text = LOREM.repeat(4);
        let cap = Caption::layout(&text, Voice::Eye, 0, None, &mut rng, 41);
        assert!(cap.lines > MAX_LINES, "{} lines", cap.lines);
        assert_eq!(cap.visible(), MAX_LINES);
        assert_eq!(cap.y_for(MAX_LINES - 1), ANCHOR, "the last line sits on the anchor");
        assert_eq!(cap.y_for(0), ANCHOR - (MAX_LINES - 1) as f64 * LINE_H);
        let r = cap.rect();
        assert!(r.1 >= 0.0 && r.1 + r.3 <= 380.0, "the band stays in the window: {r:?}");
    }

    /// His words are gold where the Eye's are green, and nothing else about
    /// the caption changes.
    #[test]
    fn the_voice_picks_the_palette_and_owner_is_the_heard_gold() {
        let mut rng = Rng::new();
        let eye = Caption::layout("hola", Voice::Eye, 0, None, &mut rng, 41);
        let mine = Caption::layout("hola", Voice::Owner, 0, None, &mut rng, 41);
        assert_eq!(eye.voice, Voice::Eye, "no voice on the wire means the Eye");
        assert_eq!(Voice::from_name("owner"), Voice::Owner);
        for other in ["eye", "", "OWNERS", "brain"] {
            assert_eq!(Voice::from_name(other), Voice::Eye, "{other}");
        }
        let g = mine.voice.palette();
        assert_eq!(g.noise, [255.0, 209.0, 102.0], "the `heard` gold, unmixed");
        assert_eq!(g.lit, g.noise, "the resolved words are the gold itself, not a washed-out cream");
        assert!(g.hot[0] >= g.hot[1] && g.hot[1] > g.hot[2], "the flash is a whiter gold, never cold");
        let e = eye.voice.palette();
        assert!(e.lit[1] > e.lit[0] && e.noise[1] > e.noise[0], "the Eye stays green");
        assert_ne!(g.backdrop, e.backdrop, "the backdrop is tinted with the voice");
        assert_eq!(mine.reveal_ms, eye.reveal_ms, "only the colour differs");
        assert_eq!(mine.fade_at, eye.fade_at);
    }

    #[test]
    fn a_caption_paints_text_and_a_backdrop_and_stops_when_it_has_faded() {
        let atlas = Atlas::build().expect("atlas");
        let mut rng = Rng::new();
        let mut p = Painter::default();
        let cap = Caption::layout("hola oscar", Voice::Owner, 0, None, &mut rng, atlas.len());
        let mut s = ImageSurface::create(Format::ARgb32, 340, 380).expect("surface");
        let ink = |s: &mut ImageSurface| -> u64 {
            s.flush();
            let stride = s.stride() as usize;
            let d = s.data().expect("data");
            (0..380).map(|y| (0..340).map(|x| d[y * stride + x * 4 + 3] as u64).sum::<u64>()).sum()
        };
        {
            let g = Context::new(&s).expect("ctx");
            p.draw(&g, &cap, &atlas, 400).expect("draw");
        }
        assert!(ink(&mut s) > 200_000, "backdrop and glyphs are on screen");
        let gone = cap.fade_at + FADE_MS;
        let mut s2 = ImageSurface::create(Format::ARgb32, 340, 380).expect("surface");
        {
            let g = Context::new(&s2).expect("ctx");
            p.draw(&g, &cap, &atlas, gone).expect("draw");
        }
        assert_eq!(ink(&mut s2), 0, "a faded caption draws nothing");
    }
}
