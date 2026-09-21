/** The phone's buffer-backed ear: block order, the cap, the idle drop, the final. */
const { test } = require("node:test");
const assert = require("node:assert");
const { createRemoteEars, MAX_SAMPLES } = require("../src/remote-ear");
const { createPartialEar } = require("../src/partials");

const RATE = 16000;
/** `n` samples of speech-loud audio — the ear needs an onset to start at all. */
const loud = (n) => Float32Array.from({ length: n }, (_, i) => (i % 2 ? 0.3 : -0.3));

/** An ear that only records what it was handed — no decoding at all. */
function stubEars(opts = {}) {
  const ears = [];
  const partials = [];
  const timers = [];
  const ears_ = createRemoteEars({
    makeEar: ({ read, onText }) => {
      const e = { read, onText, started: false, stopped: false, start() { e.started = true; }, stop() { e.stopped = true; } };
      ears.push(e);
      return e;
    },
    onPartial: (utt, text) => partials.push([utt, text]),
    timers: {
      setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimeout: (id) => id && timers[id - 1] && (timers[id - 1].fn = null),
    },
    ...opts,
  });
  return { ears: ears_, made: ears, partials, timers };
}

test("blocks are appended in seq order, whatever order they arrive in", () => {
  const t = stubEars();
  t.ears.push("u1", 0, Float32Array.from([0.1]));
  t.ears.push("u1", 2, Float32Array.from([0.3]));
  assert.equal(t.made[0].read(0).length, 1, "block 2 must wait for block 1");
  t.ears.push("u1", 1, Float32Array.from([0.2]));
  assert.deepEqual([...t.made[0].read(0)].map((x) => +x.toFixed(1)), [0.1, 0.2, 0.3]);
  // and the ear reads from wherever its anchor is, as it does off the local mic
  assert.deepEqual([...t.made[0].read(2)].map((x) => +x.toFixed(1)), [0.3]);
});

test("a block resent under a seq already in is ignored, not appended twice", () => {
  const t = stubEars();
  t.ears.push("u1", 0, Float32Array.from([0.1]));
  t.ears.push("u1", 0, Float32Array.from([0.1]));
  assert.equal(t.made[0].read(0).length, 1);
});

test("the cap is the page's own 10 MB clip, and held blocks count against it", () => {
  const t = stubEars({ maxSamples: 10 });
  assert.equal(t.ears.push("u1", 0, new Float32Array(6)), true);
  assert.equal(t.ears.push("u1", 1, new Float32Array(4)), true);
  assert.equal(t.ears.push("u1", 2, new Float32Array(1)), false, "the cap is spent");
  assert.equal(t.ears.live.samples, 10);
  // a block waiting for its predecessor is already spending the budget
  const q = stubEars({ maxSamples: 10 });
  q.ears.push("u2", 1, new Float32Array(10));
  assert.equal(q.ears.push("u2", 0, new Float32Array(1)), false);
});

test("the default cap is 10 MB of Int16 — the same clip the upload route takes", () => {
  assert.equal(MAX_SAMPLES * 2, 10_000_000);
});

test("a second utterance closes the first: one thumb, one clip in flight", () => {
  const t = stubEars();
  t.ears.push("u1", 0, new Float32Array(4));
  t.ears.push("u2", 0, new Float32Array(4));
  assert.equal(t.made.length, 2);
  assert.equal(t.made[0].stopped, true);
  assert.equal(t.ears.live.utt, "u2");
  assert.equal(t.ears.close("u1", null), null, "the abandoned one is gone");
});

test("finalize hands back the whole clip and its ear, and frees the buffer", () => {
  const t = stubEars();
  t.ears.push("u1", 0, Float32Array.from([0.1, 0.2]));
  const got = t.ears.close("u1", Float32Array.from([0.3]));
  assert.deepEqual([...got.samples].map((x) => +x.toFixed(1)), [0.1, 0.2, 0.3]);
  assert.equal(got.ear, t.made[0]);
  assert.equal(t.made[0].stopped, true);
  assert.equal(t.ears.live, null);
  assert.equal(t.ears.close("u1", null), null, "closing twice hands back nothing");
});

test("finalize with no tail keeps what was streamed — an empty body means 'what you have'", () => {
  const t = stubEars();
  t.ears.push("u1", 0, Float32Array.from([0.1, 0.2]));
  assert.equal(t.ears.close("u1", new Float32Array(0)).samples.length, 2);
});

test("a stream nobody finalised is dropped after the idle window", () => {
  const t = stubEars({ idleMs: 120_000 });
  t.ears.push("u1", 0, new Float32Array(4));
  const armed = t.timers.filter((x) => x.fn);
  assert.equal(armed.length, 1);
  assert.equal(armed[0].ms, 120_000);
  armed[0].fn();
  assert.equal(t.ears.live, null);
  assert.equal(t.made[0].stopped, true);
  // and a finalised one arms nothing that could fire later
  t.ears.push("u2", 0, new Float32Array(4));
  t.ears.close("u2", null);
  assert.deepEqual(t.timers.filter((x) => x.fn), []);
});

test("the buffer grows past its first block without losing a sample", () => {
  const t = stubEars();
  for (let i = 0; i < 6; i++) t.ears.push("u1", i, loud(20_000));
  const all = t.ears.close("u1", null).samples;
  assert.equal(all.length, 120_000);
  assert.equal(all[119_999], loud(2)[1]);
});

// -- with the real partial ear over it ---------------------------------------

/**
 * The real ear reading the streamed buffer, on a hand-driven clock: `words` are
 * said at their second and the decoder is a perfect recogniser of its window.
 */
function realEars(words) {
  const partials = [];
  let now = 0;
  let tick = null;
  let from = 0;
  const ears = createRemoteEars({
    makeEar: ({ read, onText }) =>
      createPartialEar({
        read: (f) => ((from = f), read(f)),
        decode: (s) => {
          const at = from / RATE;
          const dur = s.length / RATE;
          const inside = words.filter((w) => w.at >= at - 1e-9 && w.at < at + dur);
          return Promise.resolve({
            text: inside.map((w) => w.w).join(" "),
            tokens: inside.map((w) => ` ${w.w}`),
            timestamps: inside.map((w) => +(w.at - at).toFixed(3)),
            durations: inside.map(() => 0.2),
          });
        },
        onText,
        rate: RATE,
        anchorMs: 60_000,
        clock: () => now,
        timers: { setInterval: (f) => ((tick = f), 1), clearInterval: () => (tick = null) },
      }),
    onPartial: (utt, text) => partials.push(text),
  });
  return {
    ears,
    partials,
    /** `n` ticks of `ms`, letting every decode settle. */
    async run(n, ms = 250) {
      for (let i = 0; i < n; i++) {
        now += ms;
        tick?.();
        await new Promise(setImmediate);
        await new Promise(setImmediate);
      }
    },
  };
}

const counting = (n, gap = 0.4) =>
  "one two three four five six seven eight nine ten eleven twelve".split(" ").slice(0, n).map((w, i) => ({ w, at: +(i * gap).toFixed(3) }));

test("his words grow on the phone while he is still streaming, and never shrink", async () => {
  const t = realEars(counting(10));
  for (let i = 0; i < 10; i++) {
    t.ears.push("u1", i, loud(0.5 * RATE)); // half a second of speech at a time
    await t.run(4);
  }
  assert.ok(t.partials.length >= 2, `only ${t.partials.length} partials`);
  for (let i = 1; i < t.partials.length; i++)
    assert.ok(t.partials[i].startsWith(t.partials[i - 1]), `"${t.partials[i - 1]}" → "${t.partials[i]}"`);
  assert.ok(t.partials.at(-1).startsWith("one two"), t.partials.at(-1));
});

test("the final at the tap is the ear's stitched transcript, not a fresh whole-clip decode", async () => {
  const t = realEars(counting(6));
  for (let i = 0; i < 6; i++) {
    t.ears.push("u1", i, loud(0.5 * RATE));
    await t.run(4);
  }
  const got = t.ears.close("u1", loud(0.2 * RATE));
  const final = await got.ear.finalize(got.samples);
  assert.equal(final.text, "one two three four five six");
  assert.equal(got.samples.length, 3.2 * RATE);
});

test("an utterance that streamed only silence hands the clip back to the caller", async () => {
  const t = realEars([]);
  t.ears.push("u1", 0, new Float32Array(RATE));
  await t.run(8);
  const got = t.ears.close("u1", null);
  assert.equal(await got.ear.finalize(got.samples), null);
  assert.deepEqual(t.partials, []);
});
