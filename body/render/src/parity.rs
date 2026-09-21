//! The parity harness: the same seeded `Sim` and the same scripted `State`
//! drawn by cairo and by GL on a surfaceless EGL context, compared per region
//! as PSNR on premultiplied pixels. No window, no X server, no owner-visible
//! pixel. `cargo test parity` is the gate every later GPU ticket runs.
use crate::eye::{clamp_rect, Rect, Scene, CX, CY, DIRTY, H, W};
use crate::gpu::{rgba_surface, Renderer};
use crate::orbit;
use crate::overlay;
use crate::rain::Rng;
use crate::sched::{parse_line, Mode, State, MARKS_LINE};
use crate::sim::Sim;
use std::error::Error;
use std::path::{Path, PathBuf};

/// One seed for both simulations and both states — the harness compares two
/// renderings of one picture, never two pictures.
pub const SEED: u64 = 0x2545F491;

/// A region of the frame and the PSNR it must reach: `rect`, less `minus`.
pub struct Region {
    pub name: &'static str,
    pub gate: f64,
}

/// The columns of the table, in the order they are printed. `PLAN-GPU.md` §5,
/// less two: the eye body and the caption are held back by the software
/// renderer's subpixel-antialiased text, which an A8 glyph cache cannot
/// reproduce (G04 deviation 7).
pub const REGIONS: [Region; 8] = [
    Region { name: "eye body", gate: 31.0 },
    Region { name: "bloom halo", gate: 35.0 },
    Region { name: "iris", gate: 30.0 },
    Region { name: "caption", gate: 29.0 },
    Region { name: "orbiters", gate: 30.0 },
    Region { name: "ring band", gate: 28.0 },
    Region { name: "heard", gate: 30.0 },
    Region { name: "marks", gate: 30.0 },
];

/// The eye body proper — the lids and everything between them.
pub const EYE_BODY: Rect = (78.0, 274.0, 184.0, 84.0);
/// The turning iris, inside the eye body.
pub const IRIS: Rect = (145.0, 278.0, 50.0, 76.0);

/// The bounding box of the widest ripple, `C ± (a+2, b+2)` at the end of its life.
pub fn ring_rect() -> Rect {
    let (a, b) = overlay::ring_shape(1.0);
    clamp_rect((CX - a - 2.0, CY - b - 2.0, 2.0 * (a + 2.0), 2.0 * (b + 2.0)))
}

/// One scripted comparison: the messages by their `now`, and the ms the two
/// frames are read at.
struct SceneDef {
    name: &'static str,
    msgs: &'static [(u64, &'static str)],
    at: u64,
}

/// The sentence the `speak` scene decodes: sixty words, fully revealed by 9 s.
const SPEAK: &str = r#"{"type":"speak","text":"the eye keeps watch over the room and reports what it hears in a long steady sentence that has to wrap across several lines before it ends, so that the caption and the noise it decodes out of are both alive in the very same frame, all of it wrapped over several lines and none of them scrolled away yet ok","ms":6000}"#;

const SCENES: [SceneDef; 7] = [
    // nothing on top of the eye: the body, the bloom and the iris alone
    SceneDef { name: "idle", msgs: &[], at: 5000 },
    // fully revealed, no noise left, mid-linger
    SceneDef { name: "speak", msgs: &[(0, SPEAK), (0, r#"{"type":"speaking","ms":6000}"#)], at: 9000 },
    // two agents working, one of them 400 ms into its gold burst
    SceneDef {
        name: "orbiters",
        msgs: &[
            (0, r##"{"type":"session","active":"claude","color":"#b04dff"}"##),
            (0, r#"{"type":"status","id":"a","state":"working","label":"one"}"#),
            (0, r#"{"type":"status","id":"b","state":"working","label":"two"}"#),
            (4000, r#"{"type":"status","id":"a","state":"done","label":"done"}"#),
        ],
        at: 4400,
    },
    // the listening ripple on its own
    SceneDef { name: "ptt", msgs: &[(0, r#"{"type":"ptt","on":true}"#)], at: 600 },
    // the gold line above the eye
    SceneDef { name: "heard", msgs: &[(0, r#"{"type":"heard","text":"que estas haciendo"}"#)], at: 500 },
    // his own words as a caption, gold instead of green, mid-reveal
    SceneDef { name: "heard-caption", msgs: &[(0, HIS_WORDS)], at: 3000 },
    // five things waiting in five colours, the mode ring, and the `+` for a sixth
    SceneDef { name: "marks", msgs: &[(0, MARKS_LINE)], at: 500 },
];

/// The `heard-caption` scene's sentence: his, so the caption is gold.
const HIS_WORDS: &str = r#"{"type":"speak","who":"owner","text":"que estas haciendo ahora mismo y cuanto te falta para terminar lo que te pedi"}"#;

/// Every scene the harness knows, in table order.
pub fn scene_names() -> Vec<&'static str> {
    SCENES.iter().map(|s| s.name).collect()
}

/// One row of the table: the scene and its PSNR per region, `None` where the
/// region has nothing on it in that scene.
pub struct Row {
    pub scene: &'static str,
    pub cells: [Option<f64>; 8],
}

/// What a run produced, or why it could not run at all.
pub enum Outcome {
    /// EGL is not available here (a machine with no Mesa); the reason.
    NoEgl(String),
    Ran(Vec<Row>),
}

/// A cairo ARGB32 surface as premultiplied top-down RGBA — what both sides
/// are compared and written in.
fn soft_rgba(s: &mut cairo::ImageSurface) -> Result<Vec<u8>, Box<dyn Error>> {
    s.flush();
    let stride = s.stride() as usize;
    let d = s.data()?;
    let mut out = vec![0u8; (W * H * 4) as usize];
    for y in 0..H as usize {
        for x in 0..W as usize {
            let (p, q) = (y * stride + x * 4, (y * W as usize + x) * 4);
            out[q] = d[p + 2];
            out[q + 1] = d[p + 1];
            out[q + 2] = d[p];
            out[q + 3] = d[p + 3];
        }
    }
    Ok(out)
}

/// Is `(x, y)` inside `r`?
fn inside(r: Rect, x: usize, y: usize) -> bool {
    let (x, y) = (x as f64 + 0.5, y as f64 + 0.5);
    x >= r.0 && x < r.0 + r.2 && y >= r.1 && y < r.1 + r.3
}

/// PSNR over `rect` less every rect in `minus`, MSE across all four channels;
/// `f64::INFINITY` when the two are identical there.
pub fn psnr(a: &[u8], b: &[u8], rect: Rect, minus: &[Rect]) -> f64 {
    let (mut sum, mut n) = (0f64, 0u64);
    for y in 0..H as usize {
        for x in 0..W as usize {
            if !inside(rect, x, y) || minus.iter().any(|m| inside(*m, x, y)) {
                continue;
            }
            let p = (y * W as usize + x) * 4;
            for c in 0..4 {
                let d = a[p + c] as f64 - b[p + c] as f64;
                sum += d * d;
            }
            n += 4;
        }
    }
    if n == 0 {
        return f64::INFINITY;
    }
    let mse = sum / n as f64;
    if mse == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (255.0 * 255.0 / mse).log10()
    }
}

/// The amplified difference, opaque so a human can see it: every channel
/// `|Δ| × 8`, lifted by the alpha difference so a missing pixel shows too.
fn diff_rgba(a: &[u8], b: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; a.len()];
    for i in (0..a.len()).step_by(4) {
        let da = (a[i + 3] as i32 - b[i + 3] as i32).unsigned_abs();
        for c in 0..3 {
            let d = (a[i + c] as i32 - b[i + c] as i32).unsigned_abs().max(da);
            out[i + c] = (d * 8).min(255) as u8;
        }
        out[i + 3] = 255;
    }
    out
}

/// The regions this scene actually has something in, with their rects. The
/// bloom halo also drops the caption band: a caption sits on top of the haze,
/// and its subpixel-antialiased text is the text gate's business, not this one.
fn regions_for(st: &State, listening: bool, speaking: bool) -> [Option<(Rect, Vec<Rect>)>; 8] {
    let cap = st.caption.as_ref().map(|c| c.rect());
    [
        Some((EYE_BODY, vec![])),
        Some((DIRTY, [EYE_BODY].into_iter().chain(cap).collect())),
        Some((IRIS, vec![])),
        cap.map(|r| (r, vec![])),
        (!st.orbiters.list.is_empty()).then(|| (orbit::DIRTY, vec![EYE_BODY])),
        (listening || speaking).then(|| (ring_rect(), vec![EYE_BODY])),
        st.heard.as_ref().map(|_| (clamp_rect(overlay::HEARD_DIRTY), vec![])),
        (!st.marks.is_empty() || st.mode == Mode::Async).then(|| (clamp_rect(overlay::MARKS_DIRTY), vec![])),
    ]
}

/// Where the PNGs and `parity.md` go: `DARK_EYE_PARITY_DIR`, or `target/parity`.
pub fn out_dir() -> PathBuf {
    std::env::var("DARK_EYE_PARITY_DIR").map_or_else(|_| PathBuf::from("target/parity"), PathBuf::from)
}

/// One scene, both backends, from frame 0 to its comparison instant.
fn run_scene(def: &SceneDef, gpu: &mut Renderer, dir: &Path) -> Result<Row, Box<dyn Error>> {
    let mut scene = Scene::new()?;
    let (mut sim_s, mut sim_g) = (Sim::seeded(SEED)?, Sim::seeded(SEED)?);
    let (mut st_s, mut st_g) = (State::new(), State::new());
    st_s.rng = Rng::seeded(SEED);
    st_g.rng = Rng::seeded(SEED);
    let (mut listening, mut speaking);
    let mut i = 0u64;
    loop {
        // 60 fps on the wall clock: frame i lands on i * 1000 / 60 ms
        let now = i * 1000 / 60;
        for (_, line) in def.msgs.iter().filter(|(at, _)| *at == now) {
            let msg = parse_line(line).ok_or_else(|| format!("bad scene line: {line}"))?;
            st_s.apply(msg.clone(), now);
            st_g.apply(msg, now);
        }
        st_s.sweep(now);
        st_g.sweep(now);
        let t = i as f64 / 60.0;
        let f_s = sim_s.step(&mut st_s, t, 1.0, now);
        let f_g = sim_g.step(&mut st_g, t, 1.0, now);
        listening = f_s.listening;
        speaking = f_s.speaking;
        scene.render(&sim_s, &st_s, &f_s, now)?;
        gpu.draw(&sim_g, &mut st_g, &f_g, now);
        if now >= def.at {
            break;
        }
        i += 1;
    }
    let soft = soft_rgba(scene.frame())?;
    let hard = gpu.read_rgba();

    std::fs::create_dir_all(dir)?;
    for (px, tag) in [(&soft, "soft"), (&hard, "gpu"), (&diff_rgba(&soft, &hard), "diff")] {
        let s = rgba_surface(px)?;
        s.write_to_png(&mut std::fs::File::create(dir.join(format!("{}-{tag}.png", def.name)))?)?;
    }

    let rects = regions_for(&st_s, listening, speaking);
    let mut cells = [None; 8];
    for (k, r) in rects.iter().enumerate() {
        cells[k] = r.as_ref().map(|(rect, minus)| psnr(&soft, &hard, *rect, minus));
    }
    Ok(Row { scene: def.name, cells })
}

/// The markdown table the test prints and `parity.md` holds.
pub fn table(rows: &[Row]) -> String {
    let mut out = String::from("| scene");
    for r in REGIONS {
        out.push_str(&format!(" | {}", r.name));
    }
    out.push_str(" |\n|---|---|---|---|---|---|---|---|---|\n");
    for row in rows {
        out.push_str(&format!("| {}", row.scene));
        for c in row.cells {
            out.push_str(&match c {
                None => " | —".to_string(),
                Some(v) if v.is_infinite() => " | inf".to_string(),
                Some(v) => format!(" | {v:.1}"),
            });
        }
        out.push_str(" |\n");
    }
    out
}

/// Every gate that was not met, as `scene/region measured < gate`.
pub fn failures(rows: &[Row]) -> Vec<String> {
    let mut out = Vec::new();
    for row in rows {
        for (k, c) in row.cells.iter().enumerate() {
            if let Some(v) = c {
                if *v < REGIONS[k].gate {
                    out.push(format!("{}/{}: {v:.1} dB < {:.0} dB", row.scene, REGIONS[k].name, REGIONS[k].gate));
                }
            }
        }
    }
    out
}

/// Every scene (or just `only`) through both backends, with the PNGs, the
/// diffs and `parity.md` under `dir`.
pub fn run(dir: &Path, only: Option<&str>) -> Result<Outcome, Box<dyn Error>> {
    let probe = Sim::seeded(SEED)?;
    if let Err(e) = Renderer::surfaceless(&probe) {
        return Ok(Outcome::NoEgl(e.to_string()));
    }
    let mut rows = Vec::new();
    for def in SCENES.iter().filter(|d| only.is_none_or(|o| o == d.name)) {
        // a fresh context a scene: the trail and the glyph cache must not carry over
        let mut gpu = Renderer::surfaceless(&probe)?;
        rows.push(run_scene(def, &mut gpu, dir)?);
    }
    if rows.is_empty() {
        return Err(format!("unknown scene: {}", only.unwrap_or("")).into());
    }
    let mut md = String::from("# Backend parity — cairo vs GL ES 3.0\n\nPSNR in dB on premultiplied RGBA, MSE over all four channels, `inf` when identical.\n\n");
    md.push_str(&table(&rows));
    md.push_str("\nGates:\n");
    for r in REGIONS {
        md.push_str(&format!("- {}: {:.0} dB\n", r.name, r.gate));
    }
    std::fs::write(dir.join("parity.md"), md)?;
    Ok(Outcome::Ran(rows))
}
