/**
 * The mic at whatever rate the phone gave us (44.1k, 48k, anything) down to the
 * 16 kHz Int16 the ear wants: a 4th-order low-pass at 7 kHz, then a fractional
 * resampler, then blocks over the port. Nothing here assumes 48 kHz.
 */
const OUT_RATE = 16000;
const BLOCK = 512; // 32 ms — small enough that a release loses nothing that matters
const CUTOFF = 7000; // just under the 8 kHz Nyquist of the output

/** RBJ low-pass coefficients, normalised: `[b0, b1, b2, a1, a2]`. */
function lowpass(fc, rate, q) {
  const w = (2 * Math.PI * fc) / rate;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, (-2 * cw) / a0, (1 - alpha) / a0];
}

class Biquad {
  constructor(c) {
    this.c = c;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  run(x) {
    const [b0, b1, b2, a1, a2] = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE; // input samples per output sample, fractional
    // two Butterworth-paired sections: -3 dB at 7 kHz, well down by 8
    this.filters = [new Biquad(lowpass(CUTOFF, sampleRate, 0.5412)), new Biquad(lowpass(CUTOFF, sampleRate, 1.3066))];
    this.cursor = 0; // where the next output sample sits, in this block's index space
    this.prev = 0; // the last filtered sample of the block before, for the interpolation
    this.out = new Int16Array(BLOCK);
    this.n = 0;
    this.on = false;
    this.port.onmessage = (e) => {
      if (e.data === "flush") return void this.flush();
      this.on = e.data === "on";
      if (!this.on) this.flush();
    };
  }

  flush() {
    if (!this.n) return;
    const block = this.out.slice(0, this.n);
    this.n = 0;
    this.port.postMessage(block, [block.buffer]);
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!this.on || !ch) return true;
    const n = ch.length;
    const filtered = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = ch[i];
      for (const f of this.filters) v = f.run(v);
      filtered[i] = v;
    }
    let p = this.cursor;
    while (p <= n - 1) {
      const i = Math.floor(p);
      const t = p - i;
      const a = i < 0 ? this.prev : filtered[i];
      const b = i + 1 < n ? filtered[i + 1] : a;
      const s = a + (b - a) * t;
      this.out[this.n++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (this.n === BLOCK) this.flush();
      p += this.ratio;
    }
    this.cursor = p - n;
    this.prev = filtered[n - 1];
    return true;
  }
}

registerProcessor("downsampler", Downsampler);
