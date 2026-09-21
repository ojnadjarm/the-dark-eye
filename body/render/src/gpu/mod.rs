//! The GL ES 3.0 backend: one instanced draw for the glyph rain, a ping-pong
//! trail, a 56x31 bloom blurred with the CPU path's own kernel in two passes,
//! one composite into the window, and one instanced draw of the glyph cache
//! for the iris, the orbiters, the heard line and the caption, plus a shaded
//! ellipse for the listening and speaking rings. Same numbers as `eye.rs`.
mod egl;
mod glyphs;

use crate::atlas::{self, font, show_text, Atlas, GLYPH_FONT, ORX, ORY};
use crate::caption::{measure, style_of, Caption, Painter, Style, BG_PAD, FADE_MS, MAX_LINES, TEXT_FONT, TEXT_X};
use crate::eye::{hex_rgb, lid_y, BLOOM_H, BLOOM_W, BLOOM_X, BLOOM_Y, CX, CY, H, IRIS_RX, IRIS_RY, RX, RY, W};
use crate::orbit;
use crate::overlay;
use crate::rain::TAU;
use crate::sched::State;
use crate::sim::{Frame, Sim};
use crate::window::Window;
use cairo::{Context, Format, ImageSurface};
use egl::Egl;
use glow::HasContext;
use glyphs::{FontKey, GlyphCache};
use std::error::Error;

/// device px per atlas cell (CELL * AS)
const D: usize = 60;
const BX: f32 = BLOOM_X as f32;
const BY: f32 = BLOOM_Y as f32;
const BW: f32 = BLOOM_W as f32;
const BH: f32 = BLOOM_H as f32;
/// The burst and the heard line are the same gold as the software path.
const GOLD: [f64; 3] = [255.0, 209.0, 102.0];

/// Rows of a cairo ARGB32 surface, tightly packed for `glTexImage2D`.
fn tight(s: &mut ImageSurface) -> Result<Vec<u8>, Box<dyn Error>> {
    let (w, h, stride) = (s.width() as usize, s.height() as usize, s.stride() as usize);
    let data = s.data()?;
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        out[y * w * 4..(y + 1) * w * 4].copy_from_slice(&data[y * stride..y * stride + w * 4]);
    }
    Ok(out)
}

/// The production atlas packed into one sheet: 41 glyph columns x 5 tier rows
/// of 60 px cells, drawn through `Atlas::blit` so the pixels are identical.
fn atlas_sheet(atlas: &Atlas) -> Result<(Vec<u8>, i32, i32, f32, f32), Box<dyn Error>> {
    let (cols, rows) = (atlas.len(), atlas::TIER_COUNT);
    let mut s = ImageSurface::create(Format::ARgb32, (cols * D) as i32, (rows * D) as i32)?;
    {
        let g = Context::new(&s)?;
        for tier in 0..rows {
            for gi in 0..cols {
                // size 26 = 2x13: `blit` takes the supersampled cell at 1:1
                atlas.blit(&g, gi, tier, (gi * D) as f64 + ORX * atlas::AS, (tier * D) as f64 + ORY * atlas::AS, 26.0, 1.0);
            }
        }
    }
    s.flush();
    let data = tight(&mut s)?;
    Ok((data, (cols * D) as i32, (rows * D) as i32, cols as f32, rows as f32))
}

/// White 13 px glyph masks, one 30 px cell each — the caption's decode noise
/// tints these; the iris comes from the glyph cache.
fn mask_sheet(atlas: &Atlas) -> Result<(Vec<u8>, i32, i32, f32, f32), Box<dyn Error>> {
    let n = atlas.len();
    let c = atlas::CELL as usize;
    let mut s = ImageSurface::create(Format::ARgb32, (n * c) as i32, c as i32)?;
    {
        let g = Context::new(&s)?;
        let desc = font(GLYPH_FONT, 13.0);
        g.set_source_rgba(1.0, 1.0, 1.0, 1.0);
        for gi in 0..n {
            show_text(&g, &desc, atlas.glyph(gi), (gi * c) as f64 + ORX, ORY);
        }
    }
    s.flush();
    let data = tight(&mut s)?;
    Ok((data, (n * c) as i32, c as i32, n as f32, 1.0))
}

const VS_GLYPH: &str = r#"#version 300 es
precision highp float;
layout(location=0) in vec2 corner;
layout(location=1) in vec4 inst;
layout(location=2) in vec2 idx;
uniform vec2 uRes;
uniform vec2 uCells;
out vec2 vUv; out float vA; out vec2 vP;
void main(){
  // `Atlas::blit`: a size in SIZES uses the cell pre-scaled to the rounded
  // size and lands it on whole pixels; any other size scales and does not
  float rs = floor(inst.z + 0.5);
  bool pre = rs >= 9.0 && rs <= 15.0;
  float k = (pre ? rs : inst.z) / 13.0;
  vec2 org = vec2(inst.x - 9.0*k, inst.y - 21.0*k);
  if(pre) org = floor(org + 0.5);
  vec2 p = org + corner * (30.0*k);
  vP = p; vA = inst.w;
  vUv = (idx + corner) / uCells;
  gl_Position = vec4(p.x/uRes.x*2.0-1.0, 1.0-p.y/uRes.y*2.0, 0.0, 1.0);
}"#;

const FS_GLYPH: &str = r#"#version 300 es
precision highp float;
in vec2 vUv; in float vA; in vec2 vP;
uniform sampler2D uTex;
uniform float uClip;
uniform float uUseTint;
uniform vec3 uTint;
out vec4 frag;
void main(){
  if(uClip > 0.5){
    float u = (vP.x-170.0)/92.0;
    if(abs(u) > 1.0) discard;
    float sa = sqrt(max(0.0,1.0-u*u));
    if(abs(vP.y-316.0) > 42.0*pow(sa,1.6)) discard;
  }
  vec4 t = texture(uTex, vUv);
  vec4 c = (uUseTint > 0.5) ? vec4(uTint, 1.0) * t.a : t.bgra;
  frag = c * vA;
}"#;

const VS_TEXT: &str = r#"#version 300 es
precision highp float;
layout(location=0) in vec2 corner;
layout(location=1) in vec4 rect;
layout(location=2) in vec4 uv;
layout(location=3) in vec4 tint;
uniform vec2 uRes;
out vec2 vUv; out vec4 vTint;
void main(){
  vec2 p = rect.xy + corner*rect.zw;
  vUv = uv.xy + corner*uv.zw;
  vTint = tint;
  gl_Position = vec4(p.x/uRes.x*2.0-1.0, 1.0-p.y/uRes.y*2.0, 0.0, 1.0);
}"#;

const FS_TEXT: &str = r#"#version 300 es
precision highp float;
in vec2 vUv; in vec4 vTint; out vec4 frag;
uniform sampler2D uTex;
void main(){
  float m = texture(uTex, vUv).r * vTint.a;
  frag = vec4(vTint.rgb * m, m);
}"#;

const VS_RECT: &str = r#"#version 300 es
precision highp float;
layout(location=0) in vec2 corner;
uniform vec4 uRect;
uniform vec4 uSrc;
uniform vec2 uRes;
out vec2 vUv; out vec2 vP;
void main(){
  vec2 p = uRect.xy + corner*uRect.zw;
  vP = p;
  vUv = uSrc.xy + corner*uSrc.zw;
  gl_Position = vec4(p.x/uRes.x*2.0-1.0, 1.0-p.y/uRes.y*2.0, 0.0, 1.0);
}"#;

const FS_BLIT: &str = r#"#version 300 es
precision highp float;
in vec2 vUv; out vec4 frag;
uniform sampler2D uTex; uniform float uAlpha;
void main(){ frag = texture(uTex, vUv) * uAlpha; }"#;

const FS_TRAIL: &str = r#"#version 300 es
precision highp float;
in vec2 vUv; out vec4 frag;
uniform sampler2D uPrev; uniform sampler2D uEye; uniform float uKeep;
void main(){
  vec4 tr = texture(uPrev, vUv) * uKeep;
  vec4 e = texture(uEye, vUv) * 0.45;
  frag = e + tr * (1.0 - e.a);
}"#;

/// `Blur::plane`'s three `[1,1,1]/3` box passes compose to `[1,3,6,7,6,3,1]/27`,
/// with the missing samples counted as zero and the divisor kept whole — the
/// zero padding that darkens the buffer's border. One pass an axis, texelFetch
/// so no filter and no edge clamp can soften it.
const FS_BLUR: &str = r#"#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D uTex; uniform ivec2 uDir; uniform ivec2 uSize;
void main(){
  float w[7] = float[7](1.0, 3.0, 6.0, 7.0, 6.0, 3.0, 1.0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = vec4(0.0);
  for(int i = -3; i <= 3; i++){
    ivec2 q = p + uDir * i;
    if(q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) continue;
    s += texelFetch(uTex, q, 0) * w[i + 3];
  }
  frag = s / 27.0;
}"#;

const FS_SCAN: &str = r#"#version 300 es
precision highp float;
in vec2 vP; out vec4 frag;
void main(){
  float u = (vP.x-170.0)/92.0;
  if(abs(u) > 1.0) discard;
  float sa = sqrt(max(0.0,1.0-u*u));
  if(abs(vP.y-316.0) > 42.0*pow(sa,1.6)) discard;
  if(mod(vP.y - 274.0, 3.0) >= 1.0) discard;
  frag = vec4(0.0,0.0,0.0,0.10);
}"#;

const FS_RING: &str = include_str!("ring.frag");

/// One flat premultiplied colour over its rect — the marks' squares.
const FS_FILL: &str = r#"#version 300 es
precision highp float;
out vec4 frag;
uniform vec4 uColor;
void main(){ frag = vec4(uColor.rgb * uColor.a, uColor.a); }"#;

/// One glyph to draw: baseline origin, css size, alpha, atlas cell. The
/// fields are read as raw bytes by the instance buffer, never by name.
#[allow(dead_code)]
#[derive(Clone, Copy)]
struct Inst {
    x: f32,
    y: f32,
    size: f32,
    alpha: f32,
    gi: f32,
    tier: f32,
}

/// One cached glyph as an instance: `x, y, w, h`, its uv rect, its tint.
type Quad = [f32; 12];

/// One glyph of `k` at `px`, its baseline origin on `x,y` — where cairo would
/// have put it, from the cell cairo rasterised.
fn push(out: &mut Vec<Quad>, cache: &mut GlyphCache, k: FontKey, px: u16, ch: char, x: f64, y: f64, rgb: [f64; 3], a: f64) {
    let (bx, phx) = cache.place(x);
    let (by, phy) = cache.place(y);
    let cell = cache.cell(k, px, ch, (phx, phy));
    if cell.w == 0 {
        return;
    }
    let uv = cache.uv(&cell);
    out.push([
        bx as f32 + cell.dx,
        by as f32 + cell.dy,
        cell.w as f32,
        cell.h as f32,
        uv[0],
        uv[1],
        uv[2],
        uv[3],
        (rgb[0] / 255.0) as f32,
        (rgb[1] / 255.0) as f32,
        (rgb[2] / 255.0) as f32,
        a as f32,
    ]);
}

/// One ripple at `t`, `off` seconds behind, fading over its 1.1 s life.
fn ripple(t: f64, off: f64, rgb: [f64; 3], peak: f64) -> Ring {
    let k = overlay::ring_k(t, off);
    let (a, b) = overlay::ring_shape(k);
    Ring { cx: CX as f32, cy: CY as f32, a: a as f32, b: b as f32, rgb: unit(rgb), alpha: (peak * (1.0 - k)) as f32 }
}

/// 0-255 components as GL's 0-1.
fn unit(rgb: [f64; 3]) -> [f32; 3] {
    [(rgb[0] / 255.0) as f32, (rgb[1] / 255.0) as f32, (rgb[2] / 255.0) as f32]
}

/// The heard line's characters and their x, laid out once per sentence.
fn heard_layout(text: &str) -> (String, Vec<(char, f64)>) {
    let (s, x) = overlay::heard_line(text);
    let desc = font(TEXT_FONT, 12.0);
    let at = s.char_indices().map(|(i, ch)| (ch, x + measure(&desc, &s[..i]))).collect();
    (text.to_string(), at)
}

/// One ring this frame: its centre, its two radii and the colour it strokes with.
#[derive(Clone, Copy)]
struct Ring {
    cx: f32,
    cy: f32,
    a: f32,
    b: f32,
    rgb: [f32; 3],
    alpha: f32,
}

/// The caption as plain instances — every decision `Painter::draw` makes, with
/// no cairo and no GL: the backdrop's band, the characters still decoding out
/// of the noise, and the ones that have resolved with the colour they take.
struct CapDraw {
    alpha: f64,
    vis: usize,
    top: f64,
    h: f64,
    /// the noise glyphs' colour and the backdrop's, from the caption's voice
    noise_rgb: [f64; 3],
    backdrop_rgb: [f64; 3],
    /// atlas glyph index, baseline origin
    noise: Vec<(usize, f64, f64)>,
    /// character, baseline origin, colour, alpha
    text: Vec<(char, f64, f64, [f64; 3], f64)>,
}

/// What `cap` draws at `now`, or `None` once it has faded out.
fn caption_draw(cap: &Caption, now: u64) -> Option<CapDraw> {
    let fade_k = if now > cap.fade_at { ((now - cap.fade_at) as f64 / FADE_MS as f64).min(1.0) } else { 0.0 };
    if fade_k >= 1.0 {
        return None;
    }
    let alpha = 1.0 - fade_k;
    let scroll = cap.scroll(now);
    let (top, bot) = cap.band();
    let pal = cap.voice.palette();
    let mut d = CapDraw {
        alpha,
        vis: cap.visible(),
        top,
        h: bot - top,
        noise_rgb: pal.noise,
        backdrop_rgb: pal.backdrop,
        noise: Vec::new(),
        text: Vec::new(),
    };
    for c in &cap.chars {
        let line = c.line as isize - scroll as isize;
        if line < 0 || line as usize >= MAX_LINES {
            continue;
        }
        let y = cap.y_for(line as usize);
        match style_of(c, now) {
            Style::Hidden => {}
            // a space decodes out of the noise like any other cell
            Style::Noise => d.noise.push((c.noise, c.x, y)),
            _ if c.ch == ' ' => {}
            Style::Hot => d.text.push((c.ch, c.x, y, pal.hot, alpha)),
            Style::Lit => d.text.push((c.ch, c.x, y, pal.lit, 0.95 * alpha)),
        }
    }
    Some(d)
}

pub struct Renderer {
    egl: Egl,
    gl: glow::Context,
    /// where the composite lands: the window's default framebuffer, or an
    /// offscreen RGBA8 FBO when there is no window at all (the parity harness)
    out: Option<glow::Framebuffer>,
    p_glyph: glow::Program,
    p_text: glow::Program,
    p_blit: glow::Program,
    p_trail: glow::Program,
    p_blur: glow::Program,
    p_scan: glow::Program,
    p_ring: glow::Program,
    p_fill: glow::Program,
    vao: glow::VertexArray,
    vao_text: glow::VertexArray,
    inst_vbo: glow::Buffer,
    text_vbo: glow::Buffer,
    tex_atlas: glow::Texture,
    tex_mask: glow::Texture,
    tex_cache: glow::Texture,
    tex_backdrop: glow::Texture,
    atlas_cells: (f32, f32),
    mask_cells: (f32, f32),
    cache: GlyphCache,
    painter: Painter,
    /// the line count the backdrop texture currently holds, and its size
    backdrop: Option<(usize, f32, f32)>,
    fbo_eye: glow::Framebuffer,
    tex_eye: glow::Texture,
    fbo_trail: [glow::Framebuffer; 2],
    tex_trail: [glow::Texture; 2],
    trail_cur: usize,
    fbo_bloom: [glow::Framebuffer; 2],
    tex_bloom: [glow::Texture; 2],
    /// the horizontal pass's target, half-float unless the driver refused
    fbo_mid: glow::Framebuffer,
    tex_mid: glow::Texture,
    bw: i32,
    bh: i32,
    /// frames painted, and the one `DARK_EYE_GPU_FAIL_AFTER` fails on
    frames: u64,
    /// `DARK_EYE_SWAP_DAMAGE=1` and the extension present: present the changed
    /// rect instead of the whole surface
    damage: bool,
    /// what the last presented frame touched — this one must repair it too
    last_damage: crate::eye::Rect,
    fail_after: Option<u64>,
    /// `glGetGraphicsResetStatusKHR`, when `GL_KHR_robustness` is there
    reset_status: Option<unsafe extern "C" fn() -> u32>,
    body: Vec<Inst>,
    inner: Vec<Inst>,
    /// the iris and the orbiters — under the rings
    text: Vec<Quad>,
    /// the heard line — over the rings, under the caption backdrop
    over: Vec<Quad>,
    /// the caption's resolved characters
    cap_text: Vec<Quad>,
    /// the caption's katakana noise, off the 13 px mask sheet, and its colour
    noise: Vec<Inst>,
    noise_rgb: [f64; 3],
    /// the backdrop quad, when a caption is on screen
    backdrop_quad: Option<Quad>,
    rings: Vec<Ring>,
    heard: Option<(String, Vec<(char, f64)>)>,
    /// the marks' squares: rect and premultiplied-ready colour
    fills: Vec<([f32; 4], [f32; 4])>,
}

unsafe fn program(gl: &glow::Context, vs: &str, fs: &str) -> Result<glow::Program, Box<dyn Error>> {
    let p = gl.create_program()?;
    for (kind, src) in [(glow::VERTEX_SHADER, vs), (glow::FRAGMENT_SHADER, fs)] {
        let s = gl.create_shader(kind)?;
        gl.shader_source(s, src);
        gl.compile_shader(s);
        if !gl.get_shader_compile_status(s) {
            return Err(format!("shader: {}", gl.get_shader_info_log(s)).into());
        }
        gl.attach_shader(p, s);
        gl.delete_shader(s);
    }
    gl.link_program(p);
    if !gl.get_program_link_status(p) {
        return Err(format!("link: {}", gl.get_program_info_log(p)).into());
    }
    Ok(p)
}

unsafe fn rgba_tex(gl: &glow::Context, w: i32, h: i32, data: Option<&[u8]>) -> Result<glow::Texture, Box<dyn Error>> {
    let t = gl.create_texture()?;
    gl.bind_texture(glow::TEXTURE_2D, Some(t));
    gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, w, h, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(data));
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::LINEAR as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::LINEAR as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);
    Ok(t)
}

/// A single-channel sheet, sampled 1:1 — the glyph cache's texture.
unsafe fn r8_tex(gl: &glow::Context) -> Result<glow::Texture, Box<dyn Error>> {
    let t = gl.create_texture()?;
    gl.bind_texture(glow::TEXTURE_2D, Some(t));
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MIN_FILTER, glow::NEAREST as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_MAG_FILTER, glow::NEAREST as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE as i32);
    gl.tex_parameter_i32(glow::TEXTURE_2D, glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE as i32);
    Ok(t)
}

unsafe fn target(gl: &glow::Context, w: i32, h: i32) -> Result<(glow::Framebuffer, glow::Texture), Box<dyn Error>> {
    let t = rgba_tex(gl, w, h, None)?;
    let f = gl.create_framebuffer()?;
    gl.bind_framebuffer(glow::FRAMEBUFFER, Some(f));
    gl.framebuffer_texture_2d(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(t), 0);
    if gl.check_framebuffer_status(glow::FRAMEBUFFER) != glow::FRAMEBUFFER_COMPLETE {
        return Err("incomplete framebuffer".into());
    }
    Ok((f, t))
}

/// The blur's intermediate, RGBA16F where the driver will render to it
/// (`GL_EXT_color_buffer_half_float`) and RGBA8 where it will not; `true` when
/// it had to fall back to 8 bits.
unsafe fn mid_target(gl: &glow::Context, w: i32, h: i32) -> Result<(glow::Framebuffer, glow::Texture, bool), Box<dyn Error>> {
    let t = gl.create_texture()?;
    gl.bind_texture(glow::TEXTURE_2D, Some(t));
    gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA16F as i32, w, h, 0, glow::RGBA, glow::HALF_FLOAT, glow::PixelUnpackData::Slice(None));
    for (k, v) in [(glow::TEXTURE_MIN_FILTER, glow::NEAREST), (glow::TEXTURE_MAG_FILTER, glow::NEAREST), (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE), (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE)] {
        gl.tex_parameter_i32(glow::TEXTURE_2D, k, v as i32);
    }
    let f = gl.create_framebuffer()?;
    gl.bind_framebuffer(glow::FRAMEBUFFER, Some(f));
    gl.framebuffer_texture_2d(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(t), 0);
    if gl.check_framebuffer_status(glow::FRAMEBUFFER) == glow::FRAMEBUFFER_COMPLETE {
        return Ok((f, t, false));
    }
    gl.bind_texture(glow::TEXTURE_2D, Some(t));
    gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, w, h, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(None));
    if gl.check_framebuffer_status(glow::FRAMEBUFFER) != glow::FRAMEBUFFER_COMPLETE {
        return Err("incomplete bloom framebuffer".into());
    }
    eprintln!("[eye-render] bloom: 8-bit intermediate");
    Ok((f, t, true))
}

impl Renderer {
    /// EGL on the eye's own window, the atlas packed into GL sheets.
    pub fn open(win: &Window, sim: &Sim) -> Result<Self, Box<dyn Error>> {
        let (visual_id, _) = win.visual();
        let egl = Egl::on_window(win.conn(), win.id, visual_id)?;
        let gl = egl.gl();
        let sheet = atlas_sheet(&sim.atlas)?;
        let mask = mask_sheet(&sim.atlas)?;
        Self::build(egl, gl, (&sheet.0, sheet.1, sheet.2, sheet.3, sheet.4), (&mask.0, mask.1, mask.2, mask.3, mask.4))
    }

    /// The same renderer with no window and no X server: a surfaceless EGL
    /// context compositing into an RGBA8 FBO the caller reads back.
    pub fn surfaceless(sim: &Sim) -> Result<Self, Box<dyn Error>> {
        let egl = Egl::surfaceless()?;
        let gl = egl.gl();
        let sheet = atlas_sheet(&sim.atlas)?;
        let mask = mask_sheet(&sim.atlas)?;
        let mut r = Self::build(egl, gl, (&sheet.0, sheet.1, sheet.2, sheet.3, sheet.4), (&mask.0, mask.1, mask.2, mask.3, mask.4))?;
        let (fbo, _) = unsafe { target(&r.gl, W, H)? };
        r.out = Some(fbo);
        Ok(r)
    }

    /// `atlas` is the packed glyph-by-tier sheet, `mask` the 13 px noise sheet.
    fn build(egl: Egl, gl: glow::Context, atlas: (&[u8], i32, i32, f32, f32), mask: (&[u8], i32, i32, f32, f32)) -> Result<Self, Box<dyn Error>> {
        unsafe {
            let p_glyph = program(&gl, VS_GLYPH, FS_GLYPH)?;
            let p_text = program(&gl, VS_TEXT, FS_TEXT)?;
            let p_blit = program(&gl, VS_RECT, FS_BLIT)?;
            let p_trail = program(&gl, VS_RECT, FS_TRAIL)?;
            let p_blur = program(&gl, VS_RECT, FS_BLUR)?;
            let p_scan = program(&gl, VS_RECT, FS_SCAN)?;
            let p_ring = program(&gl, VS_RECT, FS_RING)?;
            let p_fill = program(&gl, VS_RECT, FS_FILL)?;

            let vao = gl.create_vertex_array()?;
            gl.bind_vertex_array(Some(vao));
            let quad: [f32; 8] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0];
            let qb = gl.create_buffer()?;
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(qb));
            gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, bytes(&quad), glow::STATIC_DRAW);
            gl.enable_vertex_attrib_array(0);
            gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, 8, 0);

            let inst_vbo = gl.create_buffer()?;
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(inst_vbo));
            gl.enable_vertex_attrib_array(1);
            gl.vertex_attrib_pointer_f32(1, 4, glow::FLOAT, false, 24, 0);
            gl.vertex_attrib_divisor(1, 1);
            gl.enable_vertex_attrib_array(2);
            gl.vertex_attrib_pointer_f32(2, 2, glow::FLOAT, false, 24, 16);
            gl.vertex_attrib_divisor(2, 1);

            let vao_text = gl.create_vertex_array()?;
            gl.bind_vertex_array(Some(vao_text));
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(qb));
            gl.enable_vertex_attrib_array(0);
            gl.vertex_attrib_pointer_f32(0, 2, glow::FLOAT, false, 8, 0);
            let text_vbo = gl.create_buffer()?;
            gl.bind_buffer(glow::ARRAY_BUFFER, Some(text_vbo));
            for (loc, off) in [(1u32, 0i32), (2, 16), (3, 32)] {
                gl.enable_vertex_attrib_array(loc);
                gl.vertex_attrib_pointer_f32(loc, 4, glow::FLOAT, false, 48, off);
                gl.vertex_attrib_divisor(loc, 1);
            }
            gl.bind_vertex_array(Some(vao));

            let tex_atlas = rgba_tex(&gl, atlas.1, atlas.2, Some(atlas.0))?;
            let tex_mask = rgba_tex(&gl, mask.1, mask.2, Some(mask.0))?;
            let tex_cache = r8_tex(&gl)?;
            let tex_backdrop = r8_tex(&gl)?;

            let (fbo_eye, tex_eye) = target(&gl, W, H)?;
            let (f0, t0) = target(&gl, W, H)?;
            let (f1, t1) = target(&gl, W, H)?;
            let bw = (BW / 4.0).round() as i32;
            let bh = (BH / 4.0).round() as i32;
            let (bf0, bt0) = target(&gl, bw, bh)?;
            let (bf1, bt1) = target(&gl, bw, bh)?;
            let (fbo_mid, tex_mid, _) = mid_target(&gl, bw, bh)?;
            let reset_status = gl.supported_extensions().contains("GL_KHR_robustness").then(|| egl.reset_status()).flatten();
            let damage = std::env::var("DARK_EYE_SWAP_DAMAGE").as_deref() == Ok("1") && egl.has_swap_damage();
            if std::env::var("DARK_EYE_SWAP_DAMAGE").as_deref() == Ok("1") {
                eprintln!("[eye-render] swap damage: {}", if damage { "on" } else { "unsupported, full swaps" });
            }
            for f in [f0, f1] {
                gl.bind_framebuffer(glow::FRAMEBUFFER, Some(f));
                gl.clear_color(0.0, 0.0, 0.0, 0.0);
                gl.clear(glow::COLOR_BUFFER_BIT);
            }
            gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            gl.blend_func(glow::ONE, glow::ONE_MINUS_SRC_ALPHA);

            Ok(Self {
                egl,
                gl,
                out: None,
                p_glyph,
                p_text,
                p_blit,
                p_trail,
                p_blur,
                p_scan,
                p_ring,
                p_fill,
                vao,
                vao_text,
                inst_vbo,
                text_vbo,
                tex_atlas,
                tex_mask,
                tex_cache,
                tex_backdrop,
                atlas_cells: (atlas.3, atlas.4),
                mask_cells: (mask.3, mask.4),
                cache: GlyphCache::default(),
                painter: Painter::default(),
                backdrop: None,
                fbo_eye,
                tex_eye,
                fbo_trail: [f0, f1],
                tex_trail: [t0, t1],
                trail_cur: 0,
                fbo_bloom: [bf0, bf1],
                tex_bloom: [bt0, bt1],
                fbo_mid,
                tex_mid,
                bw,
                bh,
                frames: 0,
                damage,
                last_damage: (0.0, 0.0, W as f64, H as f64),
                fail_after: std::env::var("DARK_EYE_GPU_FAIL_AFTER").ok().and_then(|v| v.parse().ok()),
                reset_status,
                body: Vec::with_capacity(128),
                inner: Vec::with_capacity(64),
                text: Vec::with_capacity(64),
                over: Vec::with_capacity(64),
                cap_text: Vec::with_capacity(512),
                noise: Vec::with_capacity(64),
                backdrop_quad: None,
                rings: Vec::with_capacity(2),
                heard: None,
                fills: Vec::with_capacity(overlay::MARK_MAX),
                noise_rgb: crate::caption::EYE_PALETTE.noise,
            })
        }
    }

    unsafe fn set2(&self, p: glow::Program, n: &str, a: f32, b: f32) {
        if let Some(l) = self.gl.get_uniform_location(p, n) {
            self.gl.uniform_2_f32(Some(&l), a, b);
        }
    }
    unsafe fn set1(&self, p: glow::Program, n: &str, a: f32) {
        if let Some(l) = self.gl.get_uniform_location(p, n) {
            self.gl.uniform_1_f32(Some(&l), a);
        }
    }
    unsafe fn set4(&self, p: glow::Program, n: &str, a: f32, b: f32, c: f32, d: f32) {
        if let Some(l) = self.gl.get_uniform_location(p, n) {
            self.gl.uniform_4_f32(Some(&l), a, b, c, d);
        }
    }
    unsafe fn set2i(&self, p: glow::Program, n: &str, a: i32, b: i32) {
        if let Some(l) = self.gl.get_uniform_location(p, n) {
            self.gl.uniform_2_i32(Some(&l), a, b);
        }
    }
    unsafe fn seti(&self, p: glow::Program, n: &str, v: i32) {
        if let Some(l) = self.gl.get_uniform_location(p, n) {
            self.gl.uniform_1_i32(Some(&l), v);
        }
    }

    /// One instanced batch of glyphs into the bound framebuffer.
    unsafe fn glyphs(&self, insts: &[Inst], tex: glow::Texture, cells: (f32, f32), clip: bool, tint: Option<[f64; 3]>, res: (f32, f32)) {
        if insts.is_empty() {
            return;
        }
        let gl = &self.gl;
        gl.use_program(Some(self.p_glyph));
        gl.bind_buffer(glow::ARRAY_BUFFER, Some(self.inst_vbo));
        gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, bytes(insts), glow::STREAM_DRAW);
        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(glow::TEXTURE_2D, Some(tex));
        self.seti(self.p_glyph, "uTex", 0);
        self.set2(self.p_glyph, "uRes", res.0, res.1);
        self.set2(self.p_glyph, "uCells", cells.0, cells.1);
        self.set1(self.p_glyph, "uClip", if clip { 1.0 } else { 0.0 });
        match tint {
            Some(c) => {
                self.set1(self.p_glyph, "uUseTint", 1.0);
                if let Some(l) = gl.get_uniform_location(self.p_glyph, "uTint") {
                    gl.uniform_3_f32(Some(&l), (c[0] / 255.0) as f32, (c[1] / 255.0) as f32, (c[2] / 255.0) as f32);
                }
            }
            None => self.set1(self.p_glyph, "uUseTint", 0.0),
        }
        gl.draw_arrays_instanced(glow::TRIANGLE_STRIP, 0, 4, insts.len() as i32);
    }

    /// One instanced batch of tinted quads off a single-channel sheet.
    unsafe fn quads(&self, insts: &[Quad], tex: glow::Texture, res: (f32, f32)) {
        if insts.is_empty() {
            return;
        }
        let gl = &self.gl;
        gl.bind_vertex_array(Some(self.vao_text));
        gl.use_program(Some(self.p_text));
        gl.bind_buffer(glow::ARRAY_BUFFER, Some(self.text_vbo));
        gl.buffer_data_u8_slice(glow::ARRAY_BUFFER, bytes(insts), glow::STREAM_DRAW);
        gl.active_texture(glow::TEXTURE0);
        gl.bind_texture(glow::TEXTURE_2D, Some(tex));
        self.seti(self.p_text, "uTex", 0);
        self.set2(self.p_text, "uRes", res.0, res.1);
        gl.draw_arrays_instanced(glow::TRIANGLE_STRIP, 0, 4, insts.len() as i32);
        gl.bind_vertex_array(Some(self.vao));
    }

    /// A textured rect with `prog`; `src` is the uv rect of the source.
    unsafe fn rect(&self, prog: glow::Program, dst: [f32; 4], src: [f32; 4], res: (f32, f32)) {
        let gl = &self.gl;
        gl.use_program(Some(prog));
        self.set4(prog, "uRect", dst[0], dst[1], dst[2], dst[3]);
        self.set4(prog, "uSrc", src[0], src[1], src[2], src[3]);
        self.set2(prog, "uRes", res.0, res.1);
        gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
    }

    /// One flat rect.
    unsafe fn fill(&self, dst: [f32; 4], rgba: [f32; 4], res: (f32, f32)) {
        let gl = &self.gl;
        gl.use_program(Some(self.p_fill));
        self.set4(self.p_fill, "uRect", dst[0], dst[1], dst[2], dst[3]);
        self.set2(self.p_fill, "uRes", res.0, res.1);
        self.set4(self.p_fill, "uColor", rgba[0], rgba[1], rgba[2], rgba[3]);
        gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
    }

    /// One shaded ring over its own bounding box.
    unsafe fn ring(&self, r: &Ring, res: (f32, f32)) {
        let gl = &self.gl;
        let (cx, cy) = (r.cx, r.cy);
        let dst = [cx - r.a - 2.0, cy - r.b - 2.0, 2.0 * (r.a + 2.0), 2.0 * (r.b + 2.0)];
        gl.use_program(Some(self.p_ring));
        self.set4(self.p_ring, "uRect", dst[0], dst[1], dst[2], dst[3]);
        self.set2(self.p_ring, "uRes", res.0, res.1);
        self.set2(self.p_ring, "uC", cx, cy);
        self.set2(self.p_ring, "uAB", r.a, r.b);
        self.set4(self.p_ring, "uColor", r.rgb[0], r.rgb[1], r.rgb[2], r.alpha);
        gl.draw_arrays(glow::TRIANGLE_STRIP, 0, 4);
    }

    /// The next present damages the whole surface — after any frame the window
    /// did not get (unmapped, or a remap's fresh buffer).
    pub fn full_damage(&mut self) {
        self.last_damage = (0.0, 0.0, W as f64, H as f64);
    }

    /// One frame from the simulation into the render target, no present.
    pub fn draw(&mut self, sim: &Sim, st: &mut State, f: &Frame, now: u64) {
        self.instances(sim, st, f, now);
        self.frame(f.breathe, f.s, f.wipe);
    }

    /// One frame from the simulation, then the swap. An error here is what
    /// `Backend::demote` turns into a cairo eye on the same window.
    pub fn paint(&mut self, sim: &Sim, st: &mut State, f: &Frame, now: u64) -> Result<(), Box<dyn Error>> {
        self.draw(sim, st, f, now);
        self.frames += 1;
        if self.fail_after == Some(self.frames) {
            return Err(format!("DARK_EYE_GPU_FAIL_AFTER={}", self.frames).into());
        }
        if self.damage {
            let cur = crate::eye::dirty_rect(st);
            let r = crate::eye::clamp_rect(crate::eye::union(self.last_damage, cur));
            self.last_damage = cur;
            // EGL counts from the surface's bottom-left; the scene from the top-left
            let (x0, y0) = (r.0.floor() as i32, (H as f64 - (r.1 + r.3)).floor() as i32);
            let (x1, y1) = ((r.0 + r.2).ceil() as i32, (H as f64 - r.1).ceil() as i32);
            self.egl.swap_with_damage(&[x0, y0, x1 - x0, y1 - y0])?;
        } else {
            self.egl.swap()?;
        }
        if let Some(status) = self.reset_status {
            let s = unsafe { status() };
            if s != glow::NO_ERROR {
                return Err(format!("context lost (reset status 0x{s:04x})").into());
            }
        }
        Ok(())
    }

    /// The composed frame straight off the render target: premultiplied RGBA,
    /// top-down, the row order cairo and the parity harness work in.
    pub fn read_rgba(&self) -> Vec<u8> {
        let n = (W * H * 4) as usize;
        let mut buf = vec![0u8; n];
        unsafe {
            self.gl.bind_framebuffer(glow::FRAMEBUFFER, self.out);
            self.gl.read_pixels(0, 0, W, H, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelPackData::Slice(Some(&mut buf)));
        }
        let row = (W * 4) as usize;
        let mut out = vec![0u8; n];
        for y in 0..H as usize {
            let src = (H as usize - 1 - y) * row;
            out[y * row..(y + 1) * row].copy_from_slice(&buf[src..src + row]);
        }
        out
    }

    /// The same frame, read back before the swap and written to `path` — the
    /// window's own pixels, with no desktop behind them.
    pub fn dump_png(&mut self, sim: &Sim, st: &mut State, f: &Frame, now: u64, path: &str) -> Result<(), Box<dyn Error>> {
        self.draw(sim, st, f, now);
        let s = rgba_surface(&self.read_rgba())?;
        s.write_to_png(&mut std::fs::File::create(path)?)?;
        self.egl.swap()
    }

    /// The instances this frame draws, from the simulation and the state.
    fn instances(&mut self, sim: &Sim, st: &mut State, f: &Frame, now: u64) {
        let n = sim.atlas.len();
        self.inner.clear();
        for m in &sim.rain.inner {
            let lid = RY * (1.0 - m.u * m.u).max(0.0).powf(0.9);
            self.inner.push(Inst {
                x: (CX + m.u * RX) as f32,
                y: (CY + m.f * lid * 0.8) as f32,
                size: m.s as f32,
                alpha: (m.o * 1.5).min(1.0) as f32,
                gi: (m.gi % n) as f32,
                tier: if m.o > 0.16 { 1.0 } else { 0.0 },
            });
        }
        self.body.clear();
        for m in &sim.rain.rim {
            let tier = sim.rain.rim_tier(m);
            self.body.push(Inst {
                x: (CX + m.a.cos() * RX * f.pulse) as f32,
                y: (CY + lid_y(m.a) * f.pulse + m.j) as f32,
                size: m.s as f32,
                alpha: if tier >= 2 { 1.0 } else { m.o as f32 },
                gi: (m.gi % n) as f32,
                tier: tier as f32,
            });
        }
        for j in -3i32..=3 {
            let tier = if j == 0 && f.exc > 0.5 { 4.0 } else if j.abs() == 3 { 2.0 } else { 3.0 };
            let alpha = f.slit_pulse * if j.abs() == 3 { 0.5 } else { 1.0 };
            self.body.push(Inst {
                x: (CX - 4.0 + f.gx) as f32,
                y: (CY + j as f64 * 11.0 + f.gy) as f32,
                size: 13.0,
                alpha: alpha.clamp(0.0, 1.0) as f32,
                gi: (sim.rain.slit[(j + 3) as usize] % n) as f32,
                tier,
            });
        }
        self.text.clear();
        let ch = |gi: usize| sim.atlas.glyph(gi).chars().next().unwrap_or(' ');
        let (text, cache) = (&mut self.text, &mut self.cache);

        // the iris, as `eye.rs` draws it: the filling at 10 px, the ring at 12
        let ik = FontKey::glyph(GLYPH_FONT);
        for p in &sim.rain.iris_fill {
            let (x, y) = (CX + f.gx + p.a.cos() * IRIS_RX * p.r, CY + f.gy + p.a.sin() * IRIS_RY * p.r);
            push(text, cache, ik, 10, ch(p.gi), x, y, f.iris, p.o);
        }
        let ring_alpha = 0.62 + if f.speaking { 0.2 } else { 0.0 };
        for (i, gi) in sim.rain.iris.iter().enumerate() {
            let a = sim.rain.iris_rot + (i as f64 / 14.0) * TAU;
            let (x, y) = (CX + f.gx + a.cos() * IRIS_RX, CY + f.gy + a.sin() * IRIS_RY);
            push(text, cache, ik, 12, ch(*gi), x, y, f.iris, ring_alpha);
        }

        // the agents on their orbits, `orbit.rs`'s draw call for draw call
        let ok = FontKey::text(GLYPH_FONT);
        for (oi, o) in st.orbiters.list.iter().enumerate() {
            let (orx, ory, ang) = orbit::place(oi, o.phase, f.t);
            let (x, y) = (CX + ang.cos() * orx, CY + ang.sin() * ory);
            match o.state.as_str() {
                "working" => {
                    for k in 1..=3usize {
                        let a2 = ang - k as f64 * 0.13;
                        let alpha = (140.0 - k as f64 * 40.0) / 255.0;
                        push(text, cache, ok, 10, ch(o.tail[k - 1]), CX + a2.cos() * orx, CY + a2.sin() * ory, o.color, alpha);
                    }
                    push(text, cache, ok, 13, ch(o.gi), x, y, o.color, 1.0);
                }
                "done" => {
                    let k = (now.saturating_sub(o.done_at) as f64 / orbit::BURST_MS).min(1.0);
                    push(text, cache, ok, (13.0 + k * 10.0).round() as u16, ch(o.gi), x, y, GOLD, 0.9 * (1.0 - k));
                }
                "error" => {
                    let col = hex_rgb(if o.err_hot { "#ff3b4d" } else { "#7a1020" });
                    push(text, cache, ok, 13, ch(o.gi), x, y, col, 1.0);
                }
                _ => {}
            }
        }

        // the ripples, between the orbiters and the heard line as `eye.rs`
        self.rings.clear();
        if f.listening {
            self.rings.push(ripple(f.t, 0.0, overlay::MID, 0.5));
        }
        if f.speaking {
            self.rings.push(ripple(f.t, overlay::SPEAK_OFFSET, f.iris, 0.45));
        }

        // what he said, laid out once and drawn from the cache after that
        self.over.clear();
        if let Some(said) = &st.heard {
            if self.heard.as_ref().map_or(true, |h| h.0 != *said) {
                self.heard = Some(heard_layout(said));
            }
            if let Some((_, at)) = &self.heard {
                let hk = FontKey::text(TEXT_FONT);
                for (c, x) in at {
                    push(&mut self.over, &mut self.cache, hk, 12, *c, *x, CY - RY - 10.0, GOLD, 0.78);
                }
            }
        }

        // the marks under the eye: static squares, the mode ring, the `+`
        self.fills.clear();
        let row = overlay::mark_row(&st.marks, st.mode);
        let (m, a) = (overlay::MARK as f32, overlay::MARK_ALPHA);
        for (x, rgb) in &row.squares {
            let [r, g, b] = unit(*rgb);
            self.fills.push(([*x as f32, overlay::MARK_Y as f32, m, m], [r, g, b, a as f32]));
        }
        for (left, ch) in [(row.ring, overlay::RING_GLYPH), (row.plus, overlay::PLUS_GLYPH)] {
            if let Some(left) = left {
                let (_, x, y) = overlay::mark_glyph(left, ch);
                push(&mut self.over, &mut self.cache, FontKey::text(TEXT_FONT), overlay::MARK_PX, ch, x, y, overlay::MID, a);
            }
        }

        // the caption: the blurred band, the noise still decoding, the words
        self.cap_text.clear();
        self.noise.clear();
        self.backdrop_quad = None;
        let Some(cap) = st.caption.as_ref().and_then(|c| caption_draw(c, now)) else { return };
        self.noise_rgb = cap.noise_rgb;
        if let Ok((w, h)) = self.upload_backdrop(cap.vis, cap.h) {
            self.backdrop_quad = Some([
                (TEXT_X - 10.0 - BG_PAD) as f32,
                (cap.top - BG_PAD) as f32,
                w,
                h,
                0.0,
                0.0,
                1.0,
                1.0,
                (cap.backdrop_rgb[0] / 255.0) as f32,
                (cap.backdrop_rgb[1] / 255.0) as f32,
                (cap.backdrop_rgb[2] / 255.0) as f32,
                (0.86 * cap.alpha) as f32,
            ]);
        }
        for (gi, x, y) in &cap.noise {
            // `Atlas::mask` lands the cell on whole pixels; the cell is 30 px
            // with its baseline origin at ORX,ORY, which is what VS_GLYPH wants
            self.noise.push(Inst {
                x: ((x - ORX).round() + ORX) as f32,
                y: ((y - ORY).round() + ORY) as f32,
                size: 13.0,
                alpha: (0.34 * cap.alpha) as f32,
                gi: (*gi % n) as f32,
                tier: 0.0,
            });
        }
        let ck = FontKey::text(TEXT_FONT);
        for (ch, x, y, rgb, a) in &cap.text {
            push(&mut self.cap_text, &mut self.cache, ck, 13, *ch, *x, *y, *rgb, *a);
        }
    }

    /// The blurred backdrop mask on the GPU, rebuilt only when the caption
    /// grows a line; returns its size in px.
    fn upload_backdrop(&mut self, vis: usize, h: f64) -> Result<(f32, f32), Box<dyn Error>> {
        if let Some((v, w, hh)) = self.backdrop {
            if v == vis {
                return Ok((w, hh));
            }
        }
        let mask = self.painter.backdrop(vis, h)?;
        let (w, hh, stride) = (mask.width(), mask.height(), mask.stride() as usize);
        let mut tight = vec![0u8; (w * hh) as usize];
        {
            let data = mask.data()?;
            for row in 0..hh as usize {
                let dst = row * w as usize;
                tight[dst..dst + w as usize].copy_from_slice(&data[row * stride..row * stride + w as usize]);
            }
        }
        unsafe {
            self.gl.bind_texture(glow::TEXTURE_2D, Some(self.tex_backdrop));
            self.gl.pixel_store_i32(glow::UNPACK_ALIGNMENT, 1);
            self.gl
                .tex_image_2d(glow::TEXTURE_2D, 0, glow::R8 as i32, w, hh, 0, glow::RED, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(Some(&tight)));
        }
        self.backdrop = Some((vis, w as f32, hh as f32));
        Ok((w as f32, hh as f32))
    }

    /// The whole frame: eye buffer, trail, bloom, composite, iris.
    fn frame(&mut self, body_alpha: f64, s: f64, wipe: bool) {
        let gl_res = (W as f32, H as f32);
        let full = [0.0f32, 0.0, W as f32, H as f32];
        let flip = [0.0f32, 1.0, 1.0, -1.0];
        unsafe {
            let gl = &self.gl;
            gl.bind_vertex_array(Some(self.vao));
            gl.enable(glow::BLEND);

            // 1. the eye body on its own buffer
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo_eye));
            gl.viewport(0, 0, W, H);
            gl.clear_color(0.0, 0.0, 0.0, 0.0);
            gl.clear(glow::COLOR_BUFFER_BIT);
            gl.blend_func(glow::ONE, glow::ONE_MINUS_SRC_ALPHA);
            self.glyphs(&self.inner, self.tex_atlas, self.atlas_cells, true, None, gl_res);
            self.glyphs(&self.body, self.tex_atlas, self.atlas_cells, false, None, gl_res);

            // 2. phosphor trail: decay the old, add this frame's light
            let keep = if wipe { 0.6 } else { 0.84f64.powf(s) };
            let dst = 1 - self.trail_cur;
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo_trail[dst]));
            gl.disable(glow::BLEND);
            gl.use_program(Some(self.p_trail));
            gl.active_texture(glow::TEXTURE0);
            gl.bind_texture(glow::TEXTURE_2D, Some(self.tex_trail[self.trail_cur]));
            gl.active_texture(glow::TEXTURE1);
            gl.bind_texture(glow::TEXTURE_2D, Some(self.tex_eye));
            self.seti(self.p_trail, "uPrev", 0);
            self.seti(self.p_trail, "uEye", 1);
            self.set1(self.p_trail, "uKeep", keep as f32);
            self.rect(self.p_trail, full, flip, gl_res);
            self.trail_cur = dst;
            gl.active_texture(glow::TEXTURE0);
            gl.enable(glow::BLEND);

            // 3. bloom: downscale the eye, then the 7-tap kernel each way
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(self.fbo_bloom[0]));
            gl.viewport(0, 0, self.bw, self.bh);
            gl.disable(glow::BLEND);
            gl.bind_texture(glow::TEXTURE_2D, Some(self.tex_eye));
            gl.use_program(Some(self.p_blit));
            self.seti(self.p_blit, "uTex", 0);
            self.set1(self.p_blit, "uAlpha", 1.0);
            let u0 = BX / W as f32;
            let v0 = 1.0 - BY / H as f32;
            self.rect(
                self.p_blit,
                [0.0, 0.0, self.bw as f32, self.bh as f32],
                [u0, v0, BW / W as f32, -BH / H as f32],
                (self.bw as f32, self.bh as f32),
            );
            gl.use_program(Some(self.p_blur));
            self.seti(self.p_blur, "uTex", 0);
            self.set2i(self.p_blur, "uSize", self.bw, self.bh);
            let quad = [0.0, 0.0, self.bw as f32, self.bh as f32];
            let bres = (self.bw as f32, self.bh as f32);
            for (dir, fbo, tex) in [((1, 0), self.fbo_mid, self.tex_bloom[0]), ((0, 1), self.fbo_bloom[1], self.tex_mid)] {
                gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
                gl.bind_texture(glow::TEXTURE_2D, Some(tex));
                self.set2i(self.p_blur, "uDir", dir.0, dir.1);
                self.rect(self.p_blur, quad, [0.0, 0.0, 1.0, 1.0], bres);
            }

            // 4. composite into the window, or into the offscreen target
            gl.bind_framebuffer(glow::FRAMEBUFFER, self.out);
            gl.viewport(0, 0, W, H);
            gl.clear_color(0.0, 0.0, 0.0, 0.0);
            gl.clear(glow::COLOR_BUFFER_BIT);
            gl.enable(glow::BLEND);
            gl.blend_func(glow::ONE, glow::ONE_MINUS_SRC_ALPHA);
            gl.use_program(Some(self.p_blit));
            self.seti(self.p_blit, "uTex", 0);
            gl.bind_texture(glow::TEXTURE_2D, Some(self.tex_trail[self.trail_cur]));
            self.set1(self.p_blit, "uAlpha", (body_alpha * 0.55) as f32);
            self.rect(self.p_blit, full, flip, gl_res);
            gl.bind_texture(glow::TEXTURE_2D, Some(self.tex_eye));
            self.set1(self.p_blit, "uAlpha", body_alpha as f32);
            self.rect(self.p_blit, full, flip, gl_res);
            // bloom back, additive
            gl.blend_func(glow::ONE, glow::ONE);
            gl.bind_texture(glow::TEXTURE_2D, Some(self.tex_bloom[1]));
            self.set1(self.p_blit, "uAlpha", (0.3 * body_alpha) as f32);
            self.rect(self.p_blit, [BX, BY, BW, BH], [0.0, 0.0, 1.0, 1.0], gl_res);
            // scanlines carve out of what is there
            gl.blend_func(glow::ZERO, glow::ONE_MINUS_SRC_ALPHA);
            self.rect(self.p_scan, full, [0.0, 0.0, 1.0, 1.0], gl_res);
            // on top of the eye: the iris and the agents, the ripples, what it
            // heard, then the caption over all of them — the order `eye.rs` draws
            gl.blend_func(glow::ONE, glow::ONE_MINUS_SRC_ALPHA);
            self.cache.upload(&self.gl, self.tex_cache);
            self.quads(&self.text, self.tex_cache, gl_res);
            for r in &self.rings {
                self.ring(r, gl_res);
            }
            self.quads(&self.over, self.tex_cache, gl_res);
            for (dst, rgba) in &self.fills {
                self.fill(*dst, *rgba, gl_res);
            }
            if let Some(q) = self.backdrop_quad {
                self.quads(&[q], self.tex_backdrop, gl_res);
            }
            self.glyphs(&self.noise, self.tex_mask, self.mask_cells, false, Some(self.noise_rgb), gl_res);
            self.quads(&self.cap_text, self.tex_cache, gl_res);
        }
    }
}

/// Premultiplied top-down RGBA into a cairo ARGB32 surface (little-endian BGRA).
pub fn rgba_surface(px: &[u8]) -> Result<ImageSurface, Box<dyn Error>> {
    let mut s = ImageSurface::create(Format::ARgb32, W, H)?;
    {
        let stride = s.stride() as usize;
        let mut d = s.data()?;
        for y in 0..H as usize {
            for x in 0..W as usize {
                let (p, q) = ((y * W as usize + x) * 4, y * stride + x * 4);
                d[q] = px[p + 2];
                d[q + 1] = px[p + 1];
                d[q + 2] = px[p];
                d[q + 3] = px[p + 3];
            }
        }
    }
    s.flush();
    Ok(s)
}

fn bytes<T>(v: &[T]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caption::{Voice, OWNER_PALETTE};
    use crate::rain::Rng;

    const LONG: &str = "the eye keeps watch over the room and reports what it hears in a long \
        steady sentence that has to wrap across several lines before it ends, so that the caption \
        and the noise it decodes out of are both alive in the very same frame, all of it \
        wrapped over eight lines and none of them scrolled away yet ok";

    fn laid_out(at: u64) -> Caption {
        let mut rng = Rng::new();
        let text: String = LONG.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(text.chars().count() >= 300, "{} chars", text.chars().count());
        let cap = Caption::layout(&text, Voice::Eye, at, None, &mut rng, 41);
        assert!(cap.lines <= MAX_LINES, "{} lines — this one must not scroll", cap.lines);
        cap
    }

    /// A second after the last character lands, every one of them is a text
    /// instance and nothing is still decoding.
    #[test]
    fn a_revealed_caption_draws_one_glyph_a_character_and_no_noise() {
        let cap = laid_out(0);
        let d = caption_draw(&cap, cap.reveal_ms + 1000).expect("still on screen");
        let want = cap.chars.iter().filter(|c| c.ch != ' ').count();
        assert_eq!(d.text.len(), want, "one instance per non-space character");
        assert!(d.noise.is_empty(), "nothing is still noise");
        assert!(d.text.iter().all(|(_, _, _, rgb, _)| *rgb == crate::caption::EYE_PALETTE.lit), "the whole line has cooled");
        assert_eq!(d.vis, cap.lines, "the backdrop covers every line");
    }

    /// Before the first character lands there is no text at all, only the
    /// katakana standing in for the ones about to resolve.
    #[test]
    fn a_caption_that_has_not_started_draws_noise_and_never_a_character() {
        let cap = laid_out(500);
        let d = caption_draw(&cap, 0).expect("still on screen");
        assert!(d.text.is_empty(), "nothing has resolved yet");
        assert!(!d.noise.is_empty(), "the first characters are already decoding");
        assert!(d.noise.len() <= cap.chars.len(), "at most one noise glyph a character");
        assert!(d.noise.iter().all(|(gi, _, _)| *gi < 41), "every noise glyph is in the atlas");
        assert!(caption_draw(&cap, cap.fade_at + FADE_MS).is_none(), "a faded caption draws nothing");
    }
}
