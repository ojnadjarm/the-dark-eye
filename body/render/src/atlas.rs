//! The phosphor atlas: every katakana glyph pre-rendered in five brightness
//! tiers with baked glow, supersampled 2x — the port of `spec/eye-reference.html`
//! lines 46-100. No text layout and no blur at frame time.
use cairo::{Context, Filter, Format, ImageSurface};
use std::error::Error;

/// Half-width katakana — the condensed film look — plus the digits.
pub const KATA: &str = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎ0123456789";
pub const GLYPH_FONT: &str = "Noto Sans Mono CJK JP";

pub const AS: f64 = 2.0; // atlas supersample
pub const CELL: f64 = 30.0; // css px per cell
pub const ORX: f64 = 9.0; // glyph baseline origin inside the cell (css px)
pub const ORY: f64 = 21.0;
const D: i32 = (CELL * AS) as i32; // device px per cell

type Rgba = (f64, f64, f64, f64);

/// fill, glow radius in atlas-device px, glow colour — the JS `TIERS` table.
struct Tier {
    fill: Rgba,
    glow: f64,
    glow_color: Rgba,
}

const TIERS: [Tier; 5] = [
    // ember
    Tier { fill: (26.0 / 255.0, 84.0 / 255.0, 56.0 / 255.0, 0.92), glow: 0.0, glow_color: (0.0, 0.0, 0.0, 0.0) },
    // dim
    Tier { fill: (47.0 / 255.0, 158.0 / 255.0, 99.0 / 255.0, 0.95), glow: 0.0, glow_color: (0.0, 0.0, 0.0, 0.0) },
    // lit
    Tier { fill: (0x4d as f64 / 255.0, 1.0, 0xa0 as f64 / 255.0, 1.0), glow: 8.0, glow_color: (77.0 / 255.0, 1.0, 160.0 / 255.0, 0.85) },
    // bright
    Tier { fill: (0x9f as f64 / 255.0, 1.0, 0xc8 as f64 / 255.0, 1.0), glow: 12.0, glow_color: (120.0 / 255.0, 1.0, 185.0 / 255.0, 0.9) },
    // white-hot lead
    Tier { fill: (0xea as f64 / 255.0, 1.0, 0xf2 as f64 / 255.0, 1.0), glow: 16.0, glow_color: (190.0 / 255.0, 1.0, 220.0 / 255.0, 0.95) },
];

pub const TIER_COUNT: usize = TIERS.len();

/// A pango font description at an absolute pixel size, as canvas `13px <face>`.
pub fn font(face: &str, px: f64) -> pango::FontDescription {
    let mut d = pango::FontDescription::from_string(face);
    d.set_absolute_size(px * pango::SCALE as f64);
    d
}

/// Draw `text` with its baseline origin at `x,y`, exactly where `fillText` puts it.
pub fn show_text(g: &Context, desc: &pango::FontDescription, text: &str, x: f64, y: f64) {
    let layout = pangocairo::functions::create_layout(g);
    layout.set_font_description(Some(desc));
    layout.set_text(text);
    let base = layout.baseline() as f64 / pango::SCALE as f64;
    g.move_to(x, y - base);
    pangocairo::functions::show_layout(g, &layout);
}

/// Three box blurs ≈ one gaussian; the scratch planes are kept between calls
/// so a per-frame blur allocates nothing. The passes run in f32: quantising
/// between them wipes a thin glyph out.
#[derive(Default)]
pub struct Blur {
    a: Vec<f32>,
    b: Vec<f32>,
    c: Vec<u8>,
}

impl Blur {
    /// Blur one 8-bit plane in place.
    pub fn plane(&mut self, buf: &mut [u8], w: usize, h: usize, stride: usize, sigma: f64) {
        if sigma <= 0.0 || w == 0 || h == 0 {
            return;
        }
        let r = (((1.0 + 4.0 * sigma * sigma).sqrt() - 1.0) / 2.0).round().max(1.0) as usize;
        let n = (2 * r + 1) as f32;
        self.a.clear();
        self.a.extend((0..h).flat_map(|y| (0..w).map(move |x| (y, x))).map(|(y, x)| buf[y * stride + x] as f32));
        self.b.clear();
        self.b.resize(w * h, 0.0);
        let (a, b) = (&mut self.a, &mut self.b);
        for _ in 0..3 {
            for y in 0..h {
                let row = &a[y * w..(y + 1) * w];
                let mut sum: f32 = row[..=r.min(w - 1)].iter().sum();
                for x in 0..w {
                    b[y * w + x] = sum / n;
                    if x + r + 1 < w {
                        sum += row[x + r + 1];
                    }
                    if x >= r {
                        sum -= row[x - r];
                    }
                }
            }
            for x in 0..w {
                let mut sum: f32 = (0..=r.min(h - 1)).map(|y| b[y * w + x]).sum();
                for y in 0..h {
                    a[y * w + x] = sum / n;
                    if y + r + 1 < h {
                        sum += b[(y + r + 1) * w + x];
                    }
                    if y >= r {
                        sum -= b[(y - r) * w + x];
                    }
                }
            }
        }
        for y in 0..h {
            for x in 0..w {
                buf[y * stride + x] = a[y * w + x].round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    /// Blur every channel of a premultiplied ARGB32 surface in place — the bloom.
    pub fn argb32(&mut self, s: &mut ImageSurface, sigma: f64) -> Result<(), Box<dyn Error>> {
        let (w, h) = (s.width() as usize, s.height() as usize);
        let stride = s.stride() as usize;
        let mut plane = std::mem::take(&mut self.c);
        plane.resize(w * h, 0);
        let mut data = s.data()?;
        for c in 0..4 {
            for y in 0..h {
                for x in 0..w {
                    plane[y * w + x] = data[y * stride + x * 4 + c];
                }
            }
            self.plane(&mut plane, w, h, w, sigma);
            for y in 0..h {
                for x in 0..w {
                    data[y * stride + x * 4 + c] = plane[y * w + x];
                }
            }
        }
        drop(data);
        self.c = plane;
        Ok(())
    }
}

/// A glyph's alpha mask in one atlas cell, drawn at `dx` off the baseline origin.
fn glyph_mask(desc: &pango::FontDescription, ch: &str, dx: f64) -> Result<ImageSurface, Box<dyn Error>> {
    let s = ImageSurface::create(Format::A8, D, D)?;
    {
        let g = Context::new(&s)?;
        g.scale(AS, AS);
        g.set_source_rgba(1.0, 1.0, 1.0, 1.0);
        show_text(&g, desc, ch, ORX + dx, ORY);
    }
    Ok(s)
}

/// A blurred copy of a mask — the baked glow of a tier.
fn blurred(mask: &ImageSurface, sigma: f64) -> Result<ImageSurface, Box<dyn Error>> {
    let mut out = ImageSurface::create(Format::A8, D, D)?;
    {
        let g = Context::new(&out)?;
        g.set_source_surface(mask, 0.0, 0.0)?;
        g.paint()?;
    }
    let stride = out.stride() as usize;
    let (w, h) = (D as usize, D as usize);
    {
        let mut data = out.data()?;
        Blur::default().plane(&mut data, w, h, stride, sigma);
    }
    Ok(out)
}

/// The glyph sizes the eye asks for, pre-scaled so a blit is a plain blend.
const SIZES: std::ops::RangeInclusive<u32> = 9..=15;

pub struct Atlas {
    /// one surface per glyph × tier, indexed `tier * len + gi` — a blit needs
    /// no clip that way, and the whole set is under 3 MB
    cells: Vec<ImageSurface>,
    /// the same cells already scaled to each size in `SIZES`, so the common
    /// blit resamples nothing; `sized[size - 9]` has the same indexing
    sized: Vec<Vec<ImageSurface>>,
    /// plain 13 px alpha masks — the caption's decode noise paints fifty a
    /// frame, far too many to lay out as text
    masks: Vec<ImageSurface>,
    pub glyphs: Vec<String>,
}

impl Atlas {
    /// Build every glyph × tier once; the JS builds it the same way at load.
    pub fn build() -> Result<Self, Box<dyn Error>> {
        let glyphs: Vec<String> = KATA.chars().map(|c| c.to_string()).collect();
        let desc = font(GLYPH_FONT, 13.0);
        let mut cells = Vec::with_capacity(glyphs.len() * TIER_COUNT);
        let masks: Vec<ImageSurface> = glyphs.iter().map(|ch| glyph_mask(&desc, ch, 0.0)).collect::<Result<_, _>>()?;
        for (ti, tier) in TIERS.iter().enumerate() {
            let halos: Vec<Option<ImageSurface>> = masks
                .iter()
                .map(|m| if tier.glow > 0.0 { blurred(m, tier.glow / 2.0).map(Some) } else { Ok(None) })
                .collect::<Result<_, _>>()?;
            for (ci, ch) in glyphs.iter().enumerate() {
                let cell = ImageSurface::create(Format::ARgb32, D, D)?;
                let g = Context::new(&cell)?;
                if ti == TIER_COUNT - 1 {
                    // chromatic fringe on the white-hot tier only — broadcast bleed
                    let red = glyph_mask(&desc, ch, -0.7)?;
                    g.set_source_rgba(1.0, 70.0 / 255.0, 90.0 / 255.0, 0.4);
                    g.mask_surface(&red, 0.0, 0.0)?;
                    let blue = glyph_mask(&desc, ch, 0.7)?;
                    g.set_source_rgba(90.0 / 255.0, 150.0 / 255.0, 1.0, 0.4);
                    g.mask_surface(&blue, 0.0, 0.0)?;
                }
                let (fr, fg, fb, fa) = tier.fill;
                match &halos[ci] {
                    Some(halo) => {
                        let (gr, gg, gb, ga) = tier.glow_color;
                        // glow pass, then the core over its own glow — twice, as the JS
                        for _ in 0..2 {
                            g.set_source_rgba(gr, gg, gb, ga);
                            g.mask_surface(halo, 0.0, 0.0)?;
                            g.set_source_rgba(fr, fg, fb, fa);
                            g.mask_surface(&masks[ci], 0.0, 0.0)?;
                        }
                    }
                    None => {
                        g.set_source_rgba(fr, fg, fb, fa);
                        g.mask_surface(&masks[ci], 0.0, 0.0)?;
                    }
                }
                drop(g);
                cell.flush();
                cells.push(cell);
            }
        }
        let mut sized = Vec::new();
        for size in SIZES {
            let k = size as f64 / 13.0;
            let d = (CELL * k).round() as i32;
            let mut set = Vec::with_capacity(cells.len());
            for cell in &cells {
                let scaled = ImageSurface::create(Format::ARgb32, d, d)?;
                let g = Context::new(&scaled)?;
                g.scale(k / AS, k / AS);
                g.set_source_surface(cell, 0.0, 0.0)?;
                if let Ok(p) = g.source().try_into() as Result<cairo::SurfacePattern, _> {
                    p.set_filter(Filter::Bilinear);
                }
                g.paint()?;
                drop(g);
                scaled.flush();
                set.push(scaled);
            }
            sized.push(set);
        }
        let mut masks = Vec::with_capacity(glyphs.len());
        for ch in &glyphs {
            let m = ImageSurface::create(Format::A8, CELL as i32, CELL as i32)?;
            {
                let g = Context::new(&m)?;
                g.set_source_rgba(1.0, 1.0, 1.0, 1.0);
                show_text(&g, &desc, ch, ORX, ORY);
            }
            m.flush();
            masks.push(m);
        }
        Ok(Self { cells, sized, masks, glyphs })
    }

    pub fn len(&self) -> usize {
        self.glyphs.len()
    }

    pub fn glyph(&self, gi: usize) -> &str {
        &self.glyphs[gi % self.glyphs.len()]
    }

    /// Paint one glyph at 13 px in the current source, baseline origin on
    /// `x,y` — the cheap `fillText` for glyphs that change every frame.
    pub fn mask(&self, g: &Context, gi: usize, x: f64, y: f64) {
        let m = &self.masks[gi % self.masks.len()];
        let _ = g.mask_surface(m, (x - ORX).round(), (y - ORY).round());
    }

    /// Blit a glyph so its baseline origin lands where `fillText` would put it.
    /// A size in `SIZES` (rounded) uses the pre-scaled cell — nothing to
    /// resample; any other size scales the supersampled one.
    pub fn blit(&self, g: &Context, gi: usize, tier: usize, x: f64, y: f64, size: f64, alpha: f64) {
        let i = tier * self.glyphs.len() + gi % self.glyphs.len();
        let rounded = size.round() as u32;
        let (cell, k, scale) = if SIZES.contains(&rounded) {
            (&self.sized[(rounded - SIZES.start()) as usize][i], rounded as f64 / 13.0, 1.0)
        } else {
            (&self.cells[i], size / 13.0, size / 13.0 / AS)
        };
        let _ = g.save();
        if scale == 1.0 {
            // integer origin: the pre-scaled cell lands pixel on pixel
            g.translate((x - ORX * k).round(), (y - ORY * k).round());
        } else {
            g.translate(x - ORX * k, y - ORY * k);
            g.scale(scale, scale);
        }
        let _ = g.set_source_surface(cell, 0.0, 0.0);
        if let Ok(p) = g.source().try_into() as Result<cairo::SurfacePattern, _> {
            p.set_filter(Filter::Bilinear);
        }
        let _ = g.paint_with_alpha(alpha);
        let _ = g.restore();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_atlas_holds_every_glyph_in_every_tier_and_none_of_them_is_empty() {
        let mut atlas = Atlas::build().expect("atlas");
        let n = atlas.len();
        assert_eq!(n, KATA.chars().count());
        assert_eq!(atlas.cells.len(), n * TIER_COUNT);
        for (i, cell) in atlas.cells.iter_mut().enumerate() {
            assert_eq!((cell.width(), cell.height()), (D, D));
            let stride = cell.stride() as usize;
            let data = cell.data().expect("cell data");
            let ink: u64 = (0..D as usize)
                .flat_map(|y| (0..D as usize).map(move |x| (y, x)))
                .map(|(y, x)| data[y * stride + x * 4 + 3] as u64)
                .sum();
            assert!(ink > 0, "glyph {} tier {} is blank", i % n, i / n);
        }
    }

    #[test]
    fn a_blur_spreads_ink_without_creating_any() {
        let mut buf = vec![0u8; 32 * 32];
        buf[16 * 32 + 16] = 255;
        Blur::default().plane(&mut buf, 32, 32, 32, 4.0);
        assert!(buf[16 * 32 + 16] < 255, "the peak spreads out");
        assert!(buf[16 * 32 + 20] > 0, "and reaches its neighbours");
        assert_eq!(buf[0], 0, "but not the far corner");
    }

    /// The bloom's σ = 1.2 is r = 1, and three `[1,1,1]/3` box passes with the
    /// missing samples counted as zero compose to `[1,3,6,7,6,3,1]/27` — the
    /// kernel `gpu::FS_BLUR` applies in one pass an axis. An impulse must come
    /// out as that kernel's outer product, zero from the fourth tap on.
    #[test]
    fn the_bloom_kernel_is_one_seven_tap_pass_an_axis() {
        let mut buf = vec![0u8; 15 * 15];
        buf[7 * 15 + 7] = 255;
        Blur::default().plane(&mut buf, 15, 15, 15, 1.2);
        let want: Vec<u8> = [7.0f64, 6.0, 3.0, 1.0, 0.0]
            .iter()
            .map(|w| (255.0 * 7.0 * w / (27.0 * 27.0)).round() as u8)
            .collect();
        for (d, &w) in want.iter().enumerate() {
            assert_eq!(buf[7 * 15 + 7 + d], w, "tap +{d} on the centre row");
            assert_eq!(buf[(7 + d) * 15 + 7], w, "tap +{d} down the centre column");
        }
        assert_eq!(buf[8 * 15 + 8], (255.0f64 * 36.0 / 729.0).round() as u8, "and the product off the axes");
    }

    #[test]
    fn text_lands_on_its_baseline() {
        let mut s = ImageSurface::create(Format::ARgb32, 60, 30).unwrap();
        let g = Context::new(&s).unwrap();
        let d = font(GLYPH_FONT, 13.0);
        g.set_source_rgba(1.0, 1.0, 1.0, 1.0);
        show_text(&g, &d, "M", 2.0, 20.0);
        drop(g);
        s.flush();
        let stride = s.stride() as usize;
        let data = s.data().unwrap();
        let ink_at = |y: usize| (0..60).map(|x| data[y * stride + x * 4 + 3] as u64).sum::<u64>();
        assert!(ink_at(15) > 0, "the glyph body sits above the baseline");
        assert_eq!(ink_at(25), 0, "nothing is drawn well below it");
    }
}
