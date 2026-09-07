//! The glyph rain: the rim flowing along the lid, the dim filling adrift
//! inside it, the slit, the iris and the illumination waves. State and motion
//! only — `eye.rs` draws it. Port of `spec/eye-reference.html` lines 100-160, 350-460.
use std::time::{SystemTime, UNIX_EPOCH};

pub const TAU: f64 = std::f64::consts::TAU;

/// xorshift64*: `Math.random()` for this renderer, no crate needed.
pub struct Rng(u64);

impl Default for Rng {
    fn default() -> Self {
        Self::new()
    }
}

impl Rng {
    pub fn new() -> Self {
        let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0x2545F491);
        Self(seed | 1)
    }
    /// A fixed sequence — the parity tests need two of the same.
    #[allow(dead_code)]
    pub fn seeded(seed: u64) -> Self {
        Self(seed | 1)
    }
    pub fn f(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + self.f() * (hi - lo)
    }
    pub fn idx(&mut self, n: usize) -> usize {
        (self.f() * n as f64) as usize % n
    }
}

/// Cheap 1/f-ish noise: two incommensurate sines, never a metronome.
pub fn noise1(x: f64) -> f64 {
    (x + 1.7 * (x * 0.213).sin()).sin() * 0.6 + (x * 0.607 + 2.1).sin() * 0.4
}

/// A glyph riding the lid line.
pub struct Rim {
    pub a: f64,
    pub v: f64,
    pub gi: usize,
    pub s: f64,
    pub o: f64,
    pub j: f64,
}

/// A dim glyph drifting inside the lids.
pub struct Inner {
    pub u: f64,
    pub f: f64,
    pub v: f64,
    pub gi: usize,
    pub o: f64,
    pub s: f64,
}

/// An illumination wave travelling the lid — most dim, ~1 in 5 white-hot.
pub struct Wave {
    pub pos: f64,
    pub speed: f64,
    pub width: f64,
    pub hot: bool,
}

/// A spark inside the iris ring.
pub struct IrisFill {
    pub a: f64,
    pub r: f64,
    pub v: f64,
    pub gi: usize,
    pub o: f64,
}

pub struct Rain {
    pub rim: Vec<Rim>,
    pub inner: Vec<Inner>,
    pub waves: Vec<Wave>,
    pub slit: Vec<usize>,
    pub iris: Vec<usize>,
    pub iris_fill: Vec<IrisFill>,
    pub iris_rot: f64,
    rng: Rng,
    n_glyphs: usize,
}

fn make_wave(rng: &mut Rng, pos: f64) -> Wave {
    Wave { pos, speed: rng.range(0.35, 0.7), width: rng.range(0.55, 1.05), hot: rng.f() < 0.2 }
}

impl Rain {
    pub fn new(n_glyphs: usize) -> Self {
        Self::with_rng(n_glyphs, Rng::new())
    }

    /// The same population every time — for the parity tests.
    #[allow(dead_code)]
    pub fn seeded(n_glyphs: usize, seed: u64) -> Self {
        Self::with_rng(n_glyphs, Rng::seeded(seed))
    }

    fn with_rng(n_glyphs: usize, mut rng: Rng) -> Self {
        let rim = (0..52)
            .map(|i| Rim {
                a: (i as f64 / 52.0) * TAU,
                v: (if rng.f() < 0.5 { -1.0 } else { 1.0 }) * rng.range(0.05, 0.17),
                gi: rng.idx(n_glyphs),
                s: rng.range(10.0, 15.0),
                o: rng.range(0.5, 0.88),
                j: rng.range(-1.5, 1.5),
            })
            .collect();
        let inner = (0..30)
            .map(|_| Inner {
                u: rng.range(-1.0, 1.0),
                f: rng.range(-0.8, 0.8),
                v: (rng.f() - 0.5) * 0.10,
                gi: rng.idx(n_glyphs),
                o: rng.range(0.09, 0.22),
                s: rng.range(9.0, 12.0),
            })
            .collect();
        let waves = vec![make_wave(&mut rng, 0.0), make_wave(&mut rng, std::f64::consts::PI)];
        let slit = (0..7).map(|_| rng.idx(n_glyphs)).collect();
        let iris = (0..14).map(|_| rng.idx(n_glyphs)).collect();
        let iris_fill = (0..6)
            .map(|_| IrisFill {
                a: rng.f() * TAU,
                r: rng.f() * 0.75,
                v: (rng.f() - 0.5) * 0.4,
                gi: rng.idx(n_glyphs),
                o: rng.range(0.12, 0.26),
            })
            .collect();
        Self { rim, inner, waves, slit, iris, iris_fill, iris_rot: 0.0, rng, n_glyphs }
    }

    pub fn rng(&mut self) -> &mut Rng {
        &mut self.rng
    }

    /// Advance every particle by `s` sixtieths of a second at excitement `exc`.
    pub fn step(&mut self, s: f64, exc: f64, t: f64) {
        for i in 0..self.waves.len() {
            let w = &mut self.waves[i];
            w.pos += w.speed * (s / 60.0) * (1.0 + 1.5 * exc) * (1.0 + 0.25 * noise1(t * 0.5));
            if w.pos > TAU {
                let pos = w.pos - TAU;
                let next = make_wave(&mut self.rng, pos);
                self.waves[i] = next;
            }
        }
        // mutation stays rare — he called the flicker "tickling", annoying
        let mut_p = (0.003 + 0.005 * exc) * s;
        for m in self.inner.iter_mut() {
            m.u += m.v * (s / 60.0);
            if m.u > 1.0 {
                m.u = -1.0;
            } else if m.u < -1.0 {
                m.u = 1.0;
            }
            if self.rng.f() < 0.002 * s {
                m.gi = self.rng.idx(self.n_glyphs);
            }
        }
        for m in self.rim.iter_mut() {
            m.a += m.v * (s / 60.0) * (1.0 + exc);
            if self.rng.f() < mut_p {
                m.gi = self.rng.idx(self.n_glyphs);
            }
        }
        for cell in self.slit.iter_mut() {
            if self.rng.f() < 0.03 * s {
                *cell = self.rng.idx(self.n_glyphs);
            }
        }
        self.iris_rot += (s / 60.0) * (0.22 + 0.7 * exc);
        for p in self.iris_fill.iter_mut() {
            p.a += p.v * (s / 60.0);
            if self.rng.f() < 0.004 * s {
                p.gi = self.rng.idx(self.n_glyphs);
            }
        }
        for p in self.iris.iter_mut() {
            if self.rng.f() < 0.005 * s {
                *p = self.rng.idx(self.n_glyphs);
            }
        }
    }

    /// How bright one rim glyph is under the waves passing over it.
    pub fn rim_tier(&self, m: &Rim) -> usize {
        let mut tier = if m.o > 0.72 { 1 } else { 0 };
        for w in &self.waves {
            let mut d = w.pos - m.a;
            d -= TAU * (d / TAU).floor(); // how far behind the crest, 0..TAU
            if d < 0.16 {
                tier = tier.max(if w.hot { 4 } else { 3 });
            } else if d < w.width {
                let f = 1.0 - (d - 0.16) / (w.width - 0.16);
                tier = tier.max(if w.hot && f > 0.55 { 3 } else { 2 });
            }
        }
        tier
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rain_starts_with_the_js_population_inside_its_ranges() {
        let r = Rain::new(41);
        assert_eq!((r.rim.len(), r.inner.len(), r.waves.len()), (52, 30, 2));
        assert_eq!((r.slit.len(), r.iris.len(), r.iris_fill.len()), (7, 14, 6));
        for m in &r.rim {
            assert!(m.s >= 10.0 && m.s <= 15.0 && m.o >= 0.5 && m.o <= 0.88);
            assert!(m.v.abs() >= 0.05 && m.v.abs() <= 0.17);
            assert!(m.gi < 41);
        }
        for m in &r.inner {
            assert!(m.u >= -1.0 && m.u <= 1.0 && m.o >= 0.09 && m.o <= 0.22);
        }
    }

    #[test]
    fn a_step_moves_the_rim_and_wraps_the_filling_without_leaving_the_lids() {
        let mut r = Rain::new(41);
        let a0: Vec<f64> = r.rim.iter().map(|m| m.a).collect();
        for _ in 0..600 {
            r.step(1.0, 0.0, 0.0);
        }
        assert!(r.rim.iter().zip(&a0).any(|(m, a)| (m.a - a).abs() > 0.01), "the rim flows");
        assert!(r.inner.iter().all(|m| m.u >= -1.0 && m.u <= 1.0), "the filling wraps inside the lids");
        assert!(r.iris_rot > 0.0, "the iris turns");
    }

    #[test]
    fn a_wave_crest_lights_the_glyphs_it_passes_and_nothing_else() {
        let mut r = Rain::new(41);
        r.waves = vec![Wave { pos: 1.0, speed: 0.5, width: 0.8, hot: true }];
        let at = |a: f64, o: f64| r.rim_tier(&Rim { a, v: 0.0, gi: 0, s: 12.0, o, j: 0.0 });
        assert_eq!(at(0.95, 0.5), 4, "under the crest, hot");
        assert_eq!(at(0.5, 0.5), 2, "in its tail");
        assert_eq!(at(3.0, 0.5), 0, "far ahead of it, ember");
        assert_eq!(at(3.0, 0.9), 1, "a bright glyph rests one tier up");
    }

    #[test]
    fn the_noise_stays_bounded_and_never_repeats_on_a_short_period() {
        for i in 0..1000 {
            let x = i as f64 * 0.37;
            assert!(noise1(x).abs() <= 1.0001);
        }
        assert!((noise1(1.0) - noise1(1.0 + TAU)).abs() > 1e-6);
    }
}
