//! The glyph cache: Pango rasterises every `(font, size, char, x-phase)` once
//! into one growing R8 sheet, the GPU composites the cells. No text is laid
//! out at frame time, and the ink is cairo's own — a cell is the glyph the
//! software renderer would have drawn, moved to a texture.
use crate::atlas::{font, show_text};
use crate::caption::show;
use cairo::{Context, Format, ImageSurface};
use glow::HasContext;
use std::collections::HashMap;
use std::error::Error;

/// The sheet starts here and doubles in height when a shelf runs out.
const SHEET: i32 = 1024;
/// cairo positions a glyph on quarter pixels in x and in y; a cell per pair.
const PHASES: i64 = 4;
/// Slack around a cell so no glyph touches its own border.
const PAD: i32 = 2;

/// A face and how it is rasterised. Either way cairo quantises the glyph's
/// origin to quarter pixels, so every face has four phases on each axis.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct FontKey {
    pub face: &'static str,
    pub unhinted: bool,
}

impl FontKey {
    /// `atlas::show_text` on a default context — the iris.
    pub const fn glyph(face: &'static str) -> Self {
        Self { face, unhinted: false }
    }

    /// `caption::show` — the orbiters, the heard line, the caption.
    pub const fn text(face: &'static str) -> Self {
        Self { face, unhinted: true }
    }
}

/// One rasterised glyph in the sheet: its pixel rect, and where its top-left
/// sits relative to the baseline origin it was drawn at.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Cell {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub dx: f32,
    pub dy: f32,
}

pub struct GlyphCache {
    w: i32,
    h: i32,
    px: Vec<u8>,
    map: HashMap<(FontKey, u16, char, u8, u8), Cell>,
    shelf_y: i32,
    shelf_h: i32,
    pen_x: i32,
    /// cells written since the last upload; `grown` forces a whole re-upload
    pending: Vec<Cell>,
    grown: bool,
}

impl Default for GlyphCache {
    fn default() -> Self {
        Self {
            w: SHEET,
            h: SHEET,
            px: vec![0; (SHEET * SHEET) as usize],
            map: HashMap::new(),
            shelf_y: 0,
            shelf_h: 0,
            pen_x: 0,
            pending: Vec::new(),
            grown: true,
        }
    }
}

impl GlyphCache {
    /// The whole-pixel coordinate a glyph is drawn at, and the phase that
    /// carries the rest — cairo's own quarter-pixel grid, on either axis.
    pub fn place(&self, x: f64) -> (f64, u8) {
        let n = PHASES;
        let s = (x * n as f64).round() as i64;
        let phase = s.rem_euclid(n);
        (((s - phase) / n) as f64, phase as u8)
    }

    /// The cell for one glyph, rasterising it on the first ask.
    pub fn cell(&mut self, k: FontKey, px: u16, ch: char, phase: (u8, u8)) -> Cell {
        if let Some(c) = self.map.get(&(k, px, ch, phase.0, phase.1)) {
            return *c;
        }
        let c = self.rasterise(k, px, ch, phase).unwrap_or_default();
        self.map.insert((k, px, ch, phase.0, phase.1), c);
        if c.w > 0 {
            self.pending.push(c);
        }
        c
    }

    /// The cell's uv rect on the current sheet.
    pub fn uv(&self, c: &Cell) -> [f32; 4] {
        [c.x as f32 / self.w as f32, c.y as f32 / self.h as f32, c.w as f32 / self.w as f32, c.h as f32 / self.h as f32]
    }

    /// Draw the glyph with Pango, exactly as the software renderer would, and
    /// copy its alpha into the sheet.
    fn rasterise(&mut self, k: FontKey, px: u16, ch: char, phase: (u8, u8)) -> Result<Cell, Box<dyn Error>> {
        let size = px as f64;
        let (ox, oy) = ((size * 0.6).ceil() as i32 + PAD, (size * 1.4).ceil() as i32 + PAD);
        let (w, h) = ((size * 2.4).ceil() as i32 + 2 * PAD, (size * 2.2).ceil() as i32 + 2 * PAD);
        let mut s = ImageSurface::create(Format::A8, w, h)?;
        {
            let g = Context::new(&s)?;
            g.set_source_rgba(1.0, 1.0, 1.0, 1.0);
            let desc = font(k.face, size);
            let t = ch.to_string();
            let x = ox as f64 + phase.0 as f64 / PHASES as f64;
            let y = oy as f64 + phase.1 as f64 / PHASES as f64;
            if k.unhinted {
                show(&g, &desc, &t, x, y);
            } else {
                show_text(&g, &desc, &t, x, y);
            }
        }
        s.flush();
        let (x0, y0) = self.alloc(w, h);
        let stride = s.stride() as usize;
        let data = s.data()?;
        for row in 0..h as usize {
            let dst = (y0 as usize + row) * self.w as usize + x0 as usize;
            self.px[dst..dst + w as usize].copy_from_slice(&data[row * stride..row * stride + w as usize]);
        }
        Ok(Cell { x: x0, y: y0, w, h, dx: -ox as f32, dy: -oy as f32 })
    }

    /// Shelf packing: fill a row left to right, open a new row when it ends,
    /// double the sheet when the rows do.
    fn alloc(&mut self, w: i32, h: i32) -> (i32, i32) {
        if self.pen_x + w > self.w {
            self.shelf_y += self.shelf_h;
            self.shelf_h = 0;
            self.pen_x = 0;
        }
        while self.shelf_y + h > self.h {
            self.h *= 2;
            self.px.resize((self.w * self.h) as usize, 0);
            self.grown = true;
        }
        let at = (self.pen_x, self.shelf_y);
        self.pen_x += w;
        self.shelf_h = self.shelf_h.max(h);
        at
    }

    /// Push what changed to the texture: the whole sheet after a growth, the
    /// new cells otherwise.
    ///
    /// # Safety
    /// `tex` must be a live texture on `gl`'s current context.
    pub unsafe fn upload(&mut self, gl: &glow::Context, tex: glow::Texture) {
        if !self.grown && self.pending.is_empty() {
            return;
        }
        gl.bind_texture(glow::TEXTURE_2D, Some(tex));
        gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
        if self.grown {
            gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::R8 as i32, self.w, self.h, 0, glow::RED, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(&self.px)));
            self.grown = false;
        } else {
            let mut buf = Vec::new();
            for c in &self.pending {
                buf.clear();
                for row in 0..c.h as usize {
                    let src = (c.y as usize + row) * self.w as usize + c.x as usize;
                    buf.extend_from_slice(&self.px[src..src + c.w as usize]);
                }
                gl.tex_sub_image_2d(glow::TEXTURE_2D, 0, c.x, c.y, c.w, c.h, glow::RED, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(&buf)));
            }
        }
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atlas::GLYPH_FONT;

    /// The ink box of an alpha plane, as `(x0, y0, x1, y1)` relative to `org`.
    fn ink(data: &[u8], w: i32, h: i32, stride: usize, org: (i32, i32)) -> (i32, i32, i32, i32) {
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for y in 0..h {
            for x in 0..w {
                if data[y as usize * stride + x as usize] > 0 {
                    x0 = x0.min(x - org.0);
                    y0 = y0.min(y - org.1);
                    x1 = x1.max(x - org.0);
                    y1 = y1.max(y - org.1);
                }
            }
        }
        (x0, y0, x1, y1)
    }

    #[test]
    fn the_same_glyph_is_rasterised_once_and_handed_out_twice() {
        let mut c = GlyphCache::default();
        let k = FontKey::glyph(GLYPH_FONT);
        let a = c.cell(k, 12, 'ｱ', (0, 0));
        let b = c.cell(k, 12, 'ｱ', (0, 0));
        assert_eq!(a, b, "the second lookup is the same cell");
        assert_eq!(c.map.len(), 1, "and nothing else was packed");
        assert_eq!(c.pending.len(), 1, "one cell to upload");
        assert!(a.w > 0 && a.h > 0);
        c.cell(k, 10, 'ｱ', (0, 0));
        assert_eq!(c.map.len(), 2, "another size is another cell");
    }

    /// The "not bolder" guarantee in a number: the cached ink is the ink cairo
    /// draws at the same size, in the same place.
    #[test]
    fn a_cached_cell_carries_the_same_ink_box_as_cairo_at_that_size() {
        let mut c = GlyphCache::default();
        let k = FontKey::glyph(GLYPH_FONT);
        let cell = c.cell(k, 12, 'ｱ', (0, 0));
        let cached = {
            let mut buf = vec![0u8; (cell.w * cell.h) as usize];
            for row in 0..cell.h as usize {
                let src = (cell.y as usize + row) * c.w as usize + cell.x as usize;
                buf[row * cell.w as usize..(row + 1) * cell.w as usize].copy_from_slice(&c.px[src..src + cell.w as usize]);
            }
            ink(&buf, cell.w, cell.h, cell.w as usize, (-cell.dx as i32, -cell.dy as i32))
        };
        let (org, mut s) = ((20, 30), ImageSurface::create(Format::A8, 60, 60).expect("scratch"));
        {
            let g = Context::new(&s).expect("ctx");
            g.set_source_rgba(1.0, 1.0, 1.0, 1.0);
            show_text(&g, &font(GLYPH_FONT, 12.0), "ｱ", org.0 as f64, org.1 as f64);
        }
        s.flush();
        let stride = s.stride() as usize;
        let scratch = ink(&s.data().expect("data"), 60, 60, stride, org);
        for (a, b, what) in [
            (cached.0, scratch.0, "left"),
            (cached.1, scratch.1, "top"),
            (cached.2, scratch.2, "right"),
            (cached.3, scratch.3, "bottom"),
        ] {
            assert!((a - b).abs() <= 1, "{what} edge: cached {a} vs cairo {b}");
        }
    }

    /// A cell must hold its whole glyph, at every size the eye asks for.
    #[test]
    fn no_glyph_touches_the_edge_of_its_cell() {
        let mut c = GlyphCache::default();
        for (k, chars) in [(FontKey::glyph(GLYPH_FONT), "ｱﾎ0"), (FontKey::text(crate::caption::TEXT_FONT), "\u{bb}gW")] {
            for px in [10u16, 12, 13, 23] {
                for ch in chars.chars() {
                    let cell = c.cell(k, px, ch, (0, 0));
                    for row in 0..cell.h {
                        for col in 0..cell.w {
                            let edge = row == 0 || col == 0 || row == cell.h - 1 || col == cell.w - 1;
                            let v = c.px[(cell.y + row) as usize * c.w as usize + (cell.x + col) as usize];
                            assert!(!edge || v == 0, "{ch} at {px}px inks its cell border");
                        }
                    }
                }
            }
        }
    }

    /// The quarter-pixel grid cairo rasterises on, negative x included.
    #[test]
    fn a_position_splits_into_a_whole_pixel_and_one_of_four_phases() {
        let c = GlyphCache::default();
        assert_eq!(c.place(10.0), (10.0, 0));
        assert_eq!(c.place(10.4), (10.0, 2));
        assert_eq!(c.place(10.8), (10.0, 3));
        assert_eq!(c.place(10.9), (11.0, 0));
        assert_eq!(c.place(-0.3), (-1.0, 3));
    }
}
