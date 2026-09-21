//! eye-render — the Eye's window on the TV: an override-redirect ARGB X11
//! surface under XWayland, fed by one JSON line per message over the render
//! socket, drawn at `DARK_EYE_IDLE_FPS` (60 on the GPU, 30 in software) idle
//! and 60 fps while something is happening.
use eye_render::backend::Backend;
use eye_render::sched::{idle_fps_from_env, parse_line, Msg, State, MARKS_LINE};
use eye_render::{rain, sim, window};
use serde_json::json;
use std::error::Error;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::Event as XEvent;
use x11rb::xcb_ffi::XCBConnection;

/// First wait between socket attempts; it doubles up to `RETRY_MAX`.
const RETRY_MIN: Duration = Duration::from_millis(200);
const RETRY_MAX: Duration = Duration::from_millis(2000);
const STATS_MS: u64 = 5000;
/// Which backend `DARK_EYE_GPU` unset means; flipped to the GPU in G07.
const GPU_DEFAULT: bool = true;

enum Ev {
    X(XEvent),
    Line(String),
    Connected(UnixStream),
    Disconnected,
}

/// `DARK_EYE_GPU`: `0` never, `1` always, anything else the built-in default.
fn gpu_wanted() -> bool {
    match std::env::var("DARK_EYE_GPU").as_deref() {
        Ok("0") => false,
        Ok("1") => true,
        _ => GPU_DEFAULT,
    }
}

/// `$XDG_RUNTIME_DIR/dark-eye/render.sock`, or `DARK_EYE_RENDER_SOCK`.
fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("DARK_EYE_RENDER_SOCK") {
        return PathBuf::from(p);
    }
    let run = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(run).join("dark-eye").join("render.sock")
}

/// The next wait after a failed or dropped connection.
fn next_backoff(d: Duration) -> Duration {
    (d * 2).min(RETRY_MAX)
}

/// Connect forever: node listens, and it may not be up yet or may go away.
/// Every attempt that does not carry a message backs off, so a socket that
/// accepts and EOFs cannot spin the thread.
fn socket_thread(path: PathBuf, tx: Sender<Ev>) {
    let mut wait = RETRY_MIN;
    loop {
        match UnixStream::connect(&path) {
            Ok(stream) => {
                match stream.try_clone() {
                    Ok(reader) => {
                        if tx.send(Ev::Connected(stream)).is_err() {
                            return;
                        }
                        for line in BufReader::new(reader).lines() {
                            match line {
                                Ok(l) => {
                                    wait = RETRY_MIN;
                                    if tx.send(Ev::Line(l)).is_err() {
                                        return;
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        if tx.send(Ev::Disconnected).is_err() {
                            return;
                        }
                    }
                    Err(_) => {}
                }
            }
            Err(_) => {}
        }
        thread::sleep(wait);
        wait = next_backoff(wait);
    }
}

/// `--demo --busy`: everything on screen at once, so the stats measure the
/// most expensive frame the eye can draw.
fn busy_thread(tx: Sender<Ev>) {
    let script = [
        (0, r##"{"type":"session","active":"claude","color":"#b04dff"}"##),
        (0, r#"{"type":"ptt","on":true}"#),
        (0, r#"{"type":"heard","text":"what is the eye doing right now"}"#),
        (0, r#"{"type":"status","id":"a","state":"working","label":"one"}"#),
        (0, r#"{"type":"status","id":"b","state":"working","label":"two"}"#),
        (0, r#"{"type":"speaking","ms":4000}"#),
        (0, r#"{"type":"speak","text":"the eye keeps watch over the room and reports what it hears in a long steady sentence that has to wrap across several lines before it ends, so that the caption, the orbiters, the rings and the heard line are all alive in the same frame"}"#),
    ];
    loop {
        for (_, line) in script {
            if tx.send(Ev::Line(line.into())).is_err() {
                return;
            }
        }
        // the caption lingers ~13 s; renew the whole picture just after it goes
        thread::sleep(Duration::from_millis(14_000));
    }
}

/// `--demo`: no socket, the states cycle so the drawing can be seen.
fn demo_thread(tx: Sender<Ev>) {
    let script = [
        (0, r##"{"type":"session","active":"claude","color":"#b04dff"}"##),
        (1000, r#"{"type":"speak","text":"the eye is awake"}"#),
        (6000, r#"{"type":"ptt","on":true}"#),
        (9000, r#"{"type":"ptt","on":false}"#),
        (9500, r#"{"type":"heard","text":"hola"}"#),
        (12000, r#"{"type":"status","id":"d","state":"working","label":"thinking"}"#),
        (16000, r#"{"type":"status","id":"d","state":"done","label":"done"}"#),
    ];
    loop {
        let mut at = 0;
        for (ms, line) in script {
            thread::sleep(Duration::from_millis(ms - at));
            at = ms;
            if tx.send(Ev::Line(line.into())).is_err() {
                return;
            }
        }
        thread::sleep(Duration::from_millis(6000));
    }
}

struct Stats {
    on: bool,
    frames: u32,
    ms_sum: f64,
    ms_max: f64,
    since: u64,
}

impl Stats {
    /// `{fps,msAvg,msMax}` every 5 s, on the socket and on stderr.
    fn tick(&mut self, now: u64, out: &mut Option<UnixStream>) {
        if !self.on || now - self.since < STATS_MS || self.frames == 0 {
            return;
        }
        let secs = (now - self.since) as f64 / 1000.0;
        let fps = (self.frames as f64 / secs * 10.0).round() / 10.0;
        let avg = (self.ms_sum / self.frames as f64 * 100.0).round() / 100.0;
        let max = (self.ms_max * 100.0).round() / 100.0;
        eprintln!("[eye-render] stats fps={fps} msAvg={avg} msMax={max}");
        send(out, &json!({"type": "stats", "fps": fps, "msAvg": avg, "msMax": max}));
        *self = Stats { on: true, frames: 0, ms_sum: 0.0, ms_max: 0.0, since: now };
    }
}

/// One JSON object per line, render → main; a dead socket is not an error.
fn send(out: &mut Option<UnixStream>, v: &serde_json::Value) {
    if let Some(s) = out.as_mut() {
        if writeln!(s, "{v}").and_then(|_| s.flush()).is_err() {
            *out = None;
        }
    }
}

/// The GPU backend if it is wanted and it comes up; `None` means cairo, and a
/// failure says why on stderr before falling back.
#[cfg(feature = "gpu")]
fn gpu_backend(win: &window::Window, sim: &sim::Sim) -> Result<Option<Backend>, Box<dyn Error>> {
    if !gpu_wanted() {
        return Ok(None);
    }
    match Backend::gpu(win, sim) {
        Ok(b) => Ok(Some(b)),
        Err(e) => {
            eprintln!("[eye-render] gpu: {e} — software renderer");
            Ok(None)
        }
    }
}

#[cfg(not(feature = "gpu"))]
fn gpu_backend(_win: &window::Window, _sim: &sim::Sim) -> Result<Option<Backend>, Box<dyn Error>> {
    if gpu_wanted() {
        eprintln!("[eye-render] gpu: built without the gpu feature — software renderer");
    }
    Ok(None)
}

/// The long sentence the caption scenes decode, one `speak` line.
const CAPTION_LINE: &str = r#"{"type":"speak","text":"the eye keeps watch over the room and reports what it hears in a long steady sentence that has to wrap across several lines before it ends","ms":6000}"#;

/// What he says, read back to him: one `speak` in his own voice, no audio
/// behind it, so it decodes at the reference's 38 characters a second.
const HEARD_CAPTION_LINE: &str =
    r#"{"type":"speak","who":"owner","text":"que estas haciendo ahora mismo y cuanto te falta para terminar lo que te pedi"}"#;

/// The scripted scenes `--dump` can freeze: the messages, and the frame the
/// PNG is taken on. `agents` is the default — a purple session, two agents
/// with one of them mid-burst and the heard line.
fn scene(name: &str) -> Option<(Vec<(u64, &'static str)>, u64)> {
    let session = (0u64, r##"{"type":"session","active":"claude","color":"#b04dff"}"##);
    Some(match name {
        "agents" => (
            vec![
                session,
                (0, r#"{"type":"status","id":"a","state":"working","label":"one"}"#),
                (0, r#"{"type":"status","id":"b","state":"working","label":"two"}"#),
                (240, r#"{"type":"heard","text":"que estas haciendo"}"#),
                (240, r#"{"type":"status","id":"a","state":"done","label":"done"}"#),
            ],
            270,
        ),
        // half way through the reveal: noise, hot heads and cooled text at once
        "caption" => (vec![session, (0, CAPTION_LINE), (0, r#"{"type":"speaking","ms":6000}"#)], 190),
        // the same sentence a second after the last character landed
        "resolved" => (vec![session, (0, CAPTION_LINE), (0, r#"{"type":"speaking","ms":6000}"#)], 435),
        // his own sentence, mid-reveal, in the gold of the `heard` line
        "heard-caption" => (vec![session, (0, HEARD_CAPTION_LINE)], 190),
        // both ripples, out of phase, with nothing else on top of the eye
        "rings" => (vec![session, (0, r#"{"type":"ptt","on":true}"#), (0, r#"{"type":"speaking","ms":60000}"#)], 100),
        // audio notes mode, five held replies in five colours and a sixth behind the `+`
        "marks" => (vec![session, (0, MARKS_LINE)], 100),
        _ => return None,
    })
}

/// `--dump <png> [--scene <name>]`: one scripted scene stepped at a fixed rate
/// and written to a file. With `DARK_EYE_SEED` both backends draw the very
/// same frame.
fn dump_scene(backend: &mut Backend, sim: &mut sim::Sim, seed: u64, name: &str, path: &str) -> Result<(), Box<dyn Error>> {
    let mut st = State::new();
    st.rng = rain::Rng::seeded(seed);
    let (script, last) = scene(name).ok_or_else(|| format!("unknown scene: {name}"))?;
    for i in 0..=last {
        let now = i * 16;
        for (_, line) in script.iter().filter(|(at, _)| *at == i) {
            if let Some(msg) = parse_line(line) {
                st.apply(msg, now);
            }
        }
        st.sweep(now);
        let f = sim.step(&mut st, i as f64 / 60.0, 1.0, now);
        if i == last {
            return backend.dump_png(sim, &mut st, &f, now, path);
        }
        backend.paint(sim, &mut st, &f, now)?;
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let demo = args.iter().any(|a| a == "--demo");
    let busy = args.iter().any(|a| a == "--busy");
    let x_offset = args
        .iter()
        .position(|a| a == "--x-offset")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(0);

    let (conn, screen_num) = XCBConnection::connect(None)?;
    let conn = Arc::new(conn);
    let root = conn.setup().roots[screen_num].root;
    window::watch_outputs(&conn, root)?;
    let mut outs = window::outputs(&conn, root)?;
    let t_atlas = Instant::now();
    // `DARK_EYE_SEED` gives two hand-run eyes the same rain and the same iris
    let seed = std::env::var("DARK_EYE_SEED").ok().and_then(|s| s.parse().ok());
    let mut sim = match seed {
        Some(s) => sim::Sim::seeded(s)?,
        None => sim::Sim::new()?,
    };
    eprintln!("[eye-render] atlas built in {:.0} ms", t_atlas.elapsed().as_secs_f64() * 1000.0);
    let mut win = window::Window::open(conn.clone(), screen_num, &outs, x_offset)?;
    eprintln!("[eye-render] window {} at {},{} on {} outputs", win.id, win.x, win.y, outs.len());
    let mut backend = gpu_backend(&win, &sim).unwrap_or(None).map_or_else(|| Backend::soft(&win), Ok)?;
    eprintln!("[eye-render] backend {}", backend.name());
    if let Some(path) = args.iter().position(|a| a == "--dump").and_then(|i| args.get(i + 1)) {
        let name = args.iter().position(|a| a == "--scene").and_then(|i| args.get(i + 1)).map_or("agents", |s| s.as_str());
        return dump_scene(&mut backend, &mut sim, seed.unwrap_or(0), name, path);
    }

    let (tx, rx) = channel();
    {
        let conn = conn.clone();
        let tx = tx.clone();
        thread::spawn(move || {
            while let Ok(ev) = conn.wait_for_event() {
                if tx.send(Ev::X(ev)).is_err() {
                    return;
                }
            }
        });
    }
    if demo {
        thread::spawn(move || if busy { busy_thread(tx) } else { demo_thread(tx) });
    } else {
        thread::spawn(move || socket_thread(socket_path(), tx));
    }

    let start = Instant::now();
    let now_ms = move || start.elapsed().as_millis() as u64;
    let mut state = State::new();
    state.idle_fps = idle_fps_from_env(backend.kind());
    let mut out: Option<UnixStream> = None;
    let mut stats = Stats {
        on: std::env::var("DARK_EYE_STATS").as_deref() == Ok("1"),
        frames: 0,
        ms_sum: 0.0,
        ms_max: 0.0,
        since: 0,
    };
    let mut t = 0.0f64;

    loop {
        let now = now_ms();
        state.sweep(now);
        stats.tick(now, &mut out);
        // due, or overdue because events kept arriving: draw before waiting again
        if let Some(due) = state.next_deadline(now) {
            if due <= now {
                let t0 = Instant::now();
                let s = state.step_scale(now);
                t += s / 60.0;
                let frame = sim.step(&mut state, t, s, now);
                if let Err(e) = backend.paint(&sim, &mut state, &frame, now) {
                    backend.demote(&win, &e.to_string())?;
                    // the software default, unless the environment named a rate
                    state.idle_fps = idle_fps_from_env(backend.kind());
                    continue;
                }
                state.on_paint(now);
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                stats.frames += 1;
                stats.ms_sum += ms;
                stats.ms_max = stats.ms_max.max(ms);
                continue;
            }
        }
        let ev = match state.next_deadline(now_ms()) {
            Some(due) => match rx.recv_timeout(Duration::from_millis(due.saturating_sub(now_ms()))) {
                Ok(ev) => ev,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() {
                Ok(ev) => ev,
                Err(_) => break,
            },
        };
        match ev {
            Ev::Connected(stream) => {
                out = Some(stream);
                send(
                    &mut out,
                    &json!({"type": "ready", "x": win.x, "y": win.y, "w": window::EYE_W, "h": window::EYE_H,
                            "backend": backend.name(),
                            "output": outs.iter().max_by_key(|o| o.w as u64 * o.h as u64).map(|o| o.name.clone())}),
                );
                send(&mut out, &json!({"type": "outputs", "outputs": outs}));
            }
            Ev::Disconnected => out = None,
            Ev::Line(line) => {
                let Some(msg) = parse_line(&line) else { continue };
                let display = matches!(msg, Msg::Display { .. });
                state.apply(msg, now_ms());
                if display {
                    if state.display_on {
                        outs = window::outputs(&conn, root)?;
                        win.replace_at(&outs, x_offset)?;
                    }
                    win.set_mapped(state.display_on)?;
                }
            }
            Ev::X(XEvent::MapNotify(_)) => state.mapped = true,
            Ev::X(XEvent::UnmapNotify(_)) => state.mapped = false,
            Ev::X(XEvent::Expose(_)) => state.on_paint(0),
            Ev::X(XEvent::ConfigureNotify(e)) => {
                win.x = e.x;
                win.y = e.y;
            }
            Ev::X(XEvent::RandrScreenChangeNotify(_)) => {
                outs = window::outputs(&conn, root)?;
                win.replace_at(&outs, x_offset)?;
                send(&mut out, &json!({"type": "outputs", "outputs": outs}));
                eprintln!("[eye-render] outputs changed — at {},{}", win.x, win.y);
            }
            Ev::X(_) => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn the_backoff_doubles_up_to_the_cap() {
        assert_eq!(next_backoff(RETRY_MIN), Duration::from_millis(400));
        assert_eq!(next_backoff(Duration::from_millis(1500)), RETRY_MAX);
        assert_eq!(next_backoff(RETRY_MAX), RETRY_MAX);
    }

    /// D1: a socket that accepts and immediately EOFs must not be reconnected
    /// in a tight loop.
    #[test]
    fn a_flapping_socket_backs_off_instead_of_spinning() {
        let dir = std::env::temp_dir().join(format!("eye-render-flap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("render.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind");
        thread::spawn(move || {
            for c in listener.incoming() {
                drop(c);
            }
        });
        let (tx, rx) = channel();
        let p = path.clone();
        thread::spawn(move || socket_thread(p, tx));
        thread::sleep(Duration::from_millis(1500));
        let n = rx.try_iter().filter(|e| matches!(e, Ev::Connected(_))).count();
        let _ = std::fs::remove_file(&path);
        assert!(n >= 1, "the thread never connected");
        assert!(n <= 8, "connected {n} times in 1.5 s — the socket thread is spinning");
    }
}



