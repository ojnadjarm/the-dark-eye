//! The simulation: everything that moves between two frames — the rain, the
//! gaze, the excitement, the iris colour, the phosphor wipe and every
//! draw-time random choice. Stepped once a frame, before any backend draws,
//! so both backends paint the same picture.
use crate::atlas::Atlas;
use crate::eye::hex_rgb;
use crate::rain::{noise1, Rain};
use crate::sched::State;

/// Gaze: micro-saccades — jump to a fixation, snap in, hold with tremor.
#[derive(Default)]
struct Gaze {
    x: f64,
    y: f64,
    tx: f64,
    ty: f64,
    next: f64,
}

/// The scalars one frame is drawn from, whichever backend draws it.
pub struct Frame {
    pub speaking: bool,
    pub listening: bool,
    /// how far the rim breathes out of the lid line
    pub pulse: f64,
    /// the whole eye's luminance this frame
    pub breathe: f64,
    pub exc: f64,
    pub gx: f64,
    pub gy: f64,
    pub slit_pulse: f64,
    pub iris: [f64; 3],
    /// the periodic hard wipe of the trail lands on this frame
    pub wipe: bool,
    pub s: f64,
    pub t: f64,
}

pub struct Sim {
    pub atlas: Atlas,
    pub rain: Rain,
    gaze: Gaze,
    /// excitement eases between idle / listening / speaking (no hard switches)
    exc: f64,
    iris_rgb: [f64; 3],
    wipe_counter: u64,
}

impl Sim {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let atlas = Atlas::build()?;
        let rain = Rain::new(atlas.len());
        Ok(Self::from_parts(atlas, rain))
    }

    /// The same simulation every time — the parity tests and `DARK_EYE_SEED`.
    pub fn seeded(seed: u64) -> Result<Self, Box<dyn std::error::Error>> {
        let atlas = Atlas::build()?;
        let rain = Rain::seeded(atlas.len(), seed);
        Ok(Self::from_parts(atlas, rain))
    }

    fn from_parts(atlas: Atlas, rain: Rain) -> Self {
        Self { atlas, rain, gaze: Gaze::default(), exc: 0.0, iris_rgb: hex_rgb("#b04dff"), wipe_counter: 0 }
    }

    /// Advance everything by `s` sixtieths of a second and return the frame.
    pub fn step(&mut self, st: &mut State, t: f64, s: f64, now: u64) -> Frame {
        let speaking = st.speaking(now);
        let listening = st.ptt;
        let target = if speaking { 1.0 } else if listening { 0.55 } else { 0.0 };
        self.exc += (target - self.exc) * (0.04 * s).min(1.0); // ~400 ms ease
        let exc = self.exc;
        let pulse = 1.0 + (t * (1.1 + 5.0 * exc)).sin() * (0.025 + 0.028 * exc);
        // the whole eye breathes in luminance, slow and slightly irregular
        let breathe = 1.0 - 0.09 * (0.5 + 0.5 * noise1(t * 0.63));

        // saccade: new fixation point every 1-4 s, snappy ease-out, then tremor
        if t > self.gaze.next {
            self.gaze.tx = self.rain.rng().range(-3.0, 3.0);
            self.gaze.ty = self.rain.rng().range(-2.0, 2.0);
            self.gaze.next = t + 1.0 + self.rain.rng().f() * 3.0;
        }
        let gk = (0.22 * s).min(1.0);
        self.gaze.x += (self.gaze.tx - self.gaze.x) * gk;
        self.gaze.y += (self.gaze.ty - self.gaze.y) * gk;
        let gx = self.gaze.x + noise1(t * 2.3) * 0.15;
        let gy = self.gaze.y + noise1(t * 2.9 + 5.0) * 0.12;

        // the iris eases toward the active session's colour on switch
        let it = hex_rgb(st.session_color());
        for i in 0..3 {
            self.iris_rgb[i] += (it[i] - self.iris_rgb[i]) * (0.05 * s).min(1.0);
        }

        self.rain.step(s, exc, t);
        self.wipe_counter += 1;
        let wipe = self.wipe_counter % (45.0 / s).round().max(1.0) as u64 == 0;

        // the choices the drawing used to make: once, here, for both backends
        let n = self.atlas.len();
        st.orbiters.step(s, &mut st.rng, n);
        if let Some(cap) = st.caption.as_mut() {
            cap.step(now, &mut st.rng, n);
        }

        Frame {
            speaking,
            listening,
            pulse,
            breathe,
            exc,
            gx,
            gy,
            slit_pulse: 0.75 + 0.25 * (t * (1.1 + 4.0 * exc)).sin(),
            iris: self.iris_rgb,
            wipe,
            s,
            t,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both backends draw the same picture only because the simulation is
    /// reproducible from its seed alone.
    #[test]
    fn two_sims_with_the_same_seed_step_to_the_same_rain_and_iris() {
        let (mut a, mut b) = (Sim::seeded(12345).expect("sim"), Sim::seeded(12345).expect("sim"));
        let (mut sa, mut sb) = (State::new(), State::new());
        let (mut fa, mut fb) = (None, None);
        for i in 0..300 {
            let t = i as f64 / 60.0;
            fa = Some(a.step(&mut sa, t, 1.0, i * 16));
            fb = Some(b.step(&mut sb, t, 1.0, i * 16));
        }
        let (fa, fb) = (fa.expect("frame"), fb.expect("frame"));
        assert_eq!((fa.gx, fa.gy, fa.pulse, fa.iris), (fb.gx, fb.gy, fb.pulse, fb.iris));
        assert_eq!(a.rain.iris_rot, b.rain.iris_rot, "the iris turned the same way");
        assert_eq!(a.rain.iris, b.rain.iris, "and shows the same glyphs");
        assert!(a.rain.rim.iter().zip(&b.rain.rim).all(|(x, y)| x.a == y.a && x.gi == y.gi), "the rim matches");
        assert!(a.rain.inner.iter().zip(&b.rain.inner).all(|(x, y)| x.u == y.u && x.gi == y.gi), "the filling matches");
        let mut c = Sim::seeded(999).expect("sim");
        let mut sc = State::new();
        for i in 0..300 {
            c.step(&mut sc, i as f64 / 60.0, 1.0, i * 16);
        }
        assert!(c.rain.iris != a.rain.iris || c.rain.rim[0].a != a.rain.rim[0].a, "another seed is another eye");
    }
}
