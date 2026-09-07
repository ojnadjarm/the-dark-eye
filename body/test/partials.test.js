/** partials.js — the growing window, what reaches the caption, and the transcript at mic close. */
const { test } = require("node:test");
const assert = require("node:assert");

const {
  createPartialEar,
  captionDelta,
  timedWords,
  agreedCount,
  speechAt,
  cutIndex,
  SETTLE_MS,
} = require("../src/partials");

const RATE = 16000;
/** `secs` of samples: `loud` marks the ranges (in seconds) that carry speech. */
function clip(secs, loud = []) {
  const s = new Float32Array(Math.round(secs * RATE));
  for (const [a, b] of loud)
    for (let i = Math.round(a * RATE); i < Math.round(b * RATE) && i < s.length; i++)
      s[i] = i % 2 ? 0.3 : -0.3;
  return s;
}

test("silence has no speech in it, and speech is found where it starts", () => {
  assert.equal(speechAt(clip(2)), -1);
  const at = speechAt(clip(2, [[1, 2]]));
  assert.ok(at >= RATE - 512 && at <= RATE + 512, `speech at ${at}, want ~${RATE}`);
});

test("the cut lands in the quiet between words, not inside one", () => {
  // loud to 1.7 s, quiet to 1.8 s, loud again: the cut must be in that gap
  const s = clip(2, [[0, 1.7], [1.8, 2]]);
  const i = cutIndex(s, RATE, 400);
  assert.ok(i > 1.7 * RATE && i <= 1.81 * RATE, `cut at ${i / RATE}s`);
});

test("word pieces are glued back into words that know when they were said", () => {
  const got = timedWords({
    text: "What time",
    tokens: [" W", "hat", " time", "?"],
    timestamps: [0.08, 0.24, 0.4, 0.64],
    durations: [0.16, 0.16, 0.24, 0.08],
  });
  assert.deepEqual(got.map((w) => w.w), ["What", "time?"]);
  assert.equal(got[0].at, 0.08);
  assert.ok(Math.abs(got[1].to - 0.72) < 1e-9, `word ends at ${got[1].to}`);
  // no timings at all is still a hypothesis, just one that can never be frozen
  assert.deepEqual(timedWords("hola que tal").map((w) => w.at), [null, null, null]);
});

test("agreement reads through the case and the commas the recogniser keeps changing", () => {
  assert.equal(agreedCount(["Oye,", "necesito", "que"], ["oye", "Necesito", "tal"]), 2);
});

/**
 * An ear over a scripted utterance: `words` are said at their second, the clip
 * is loud throughout, and the decoder is a perfect recogniser of whatever
 * window it is handed. The clock is hand-driven, so no test waits on anything.
 */
function earOf({ words, secs, loudTo = secs, emptyFinal = false, ...opts }) {
  const samples = clip(secs, [[0, loudTo]]);
  /** The mic only has what has been said so far. */
  const head = (ms) => Math.min(samples.length, Math.round((ms * RATE) / 1000));
  const said = [];
  const windows = [];
  let tick = null;
  let now = 0;
  let from = 0;
  const decodeOf = (s, final) => {
    const at = from / RATE;
    if (final && emptyFinal) {
      windows.push({ at: +at.toFixed(2), dur: +(s.length / RATE).toFixed(2), final: true });
      return Promise.resolve({ text: "", tokens: [], timestamps: [], durations: [] });
    }
    const dur = s.length / RATE;
    windows.push({ at: +at.toFixed(2), dur: +dur.toFixed(2), final: !!final });
    const inside = words.filter((w) => w.at >= at - 1e-9 && w.at < at + dur);
    return Promise.resolve({
      text: inside.map((w) => w.w).join(" "),
      tokens: inside.map((w) => ` ${w.w}`),
      timestamps: inside.map((w) => +(w.at - at).toFixed(3)),
      durations: inside.map(() => 0.2),
    });
  };
  const ear = createPartialEar({
    read: (f) => ((from = f), samples.subarray(Math.min(f, head(now)), head(now))),
    decode: decodeOf,
    onText: (text, append, ms) => said.push({ text, append, ms }),
    rate: RATE,
    clock: () => now,
    timers: { setInterval: (f) => ((tick = f), 1), clearInterval: () => (tick = null) },
    ...opts,
  });
  return {
    ear,
    said,
    windows,
    samples,
    /** `n` ticks, `ms` of wall clock each, letting every decode settle. */
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

/** "one two three …" said one word every 0.4 s. */
function counting(n, gap = 0.4) {
  const names = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");
  return Array.from({ length: n }, (_, i) => ({ w: names[i % names.length], at: +(i * gap).toFixed(3) }));
}

test("the window grows from the anchor instead of being a fresh chunk each time", async () => {
  const t = earOf({ words: counting(12), secs: 6, anchorMs: 60000 });
  t.ear.start();
  await t.run(40);
  assert.ok(t.windows.length >= 3, `only ${t.windows.length} decodes`);
  for (const w of t.windows) assert.equal(w.at, 0, "a decode started somewhere other than the anchor");
  for (let i = 1; i < t.windows.length; i++)
    assert.ok(t.windows[i].dur > t.windows[i - 1].dur, "the window did not grow");
});

test("only what two decodes agree on reaches the caption, and it is only ever appended", async () => {
  const t = earOf({ words: counting(10), secs: 5, anchorMs: 60000 });
  t.ear.start();
  await t.run(40);
  assert.ok(t.said.length >= 2, "the caption never grew");
  assert.equal(t.said[0].append, false, "the first words open the caption");
  for (const s of t.said.slice(1)) assert.equal(s.append, true, `"${s.text}" redrew the caption`);
  assert.equal(t.ear.shown, "one two three four five six seven eight nine ten".split(" ").slice(0, t.ear.shown.split(" ").length).join(" "));
});

test("a settled word is frozen and cut out, so the window stays short", async () => {
  const t = earOf({ words: counting(30), secs: 12, anchorMs: 2500, safeTailMs: 1200, leadMs: 700 });
  t.ear.start();
  await t.run(120);
  const longest = Math.max(...t.windows.map((w) => w.dur));
  assert.ok(longest < 6, `the window reached ${longest}s — nothing was frozen`);
  const late = t.windows[t.windows.length - 1];
  assert.ok(late.at > 3, `the anchor never moved (last window at ${late.at}s)`);
});

test("the window keeps a lead of already-frozen audio, and its words are not said twice", async () => {
  const t = earOf({ words: counting(30), secs: 12, anchorMs: 2500, safeTailMs: 1200, leadMs: 700 });
  t.ear.start();
  await t.run(120);
  const shown = t.ear.shown.split(" ");
  assert.deepEqual(shown, counting(30).slice(0, shown.length).map((w) => w.w), "a word was repeated or lost at a cut");
});

test("only one decode at a time — the ear never costs more than its one thread", async () => {
  let open = 0;
  let peak = 0;
  const t = earOf({
    words: counting(20),
    secs: 8,
    decode: () => new Promise((r) => { peak = Math.max(peak, ++open); setTimeout(() => (open--, r({ text: "" })), 0); }),
  });
  t.ear.start();
  await t.run(40);
  assert.equal(peak, 1);
});

test("the transcript at mic close decodes only the tail, and stitches it to what was frozen", async () => {
  const t = earOf({ words: counting(30), secs: 12, anchorMs: 2500, safeTailMs: 1200, leadMs: 700 });
  t.ear.start();
  await t.run(120);
  t.ear.stop();
  const done = await t.ear.finalize(t.samples);
  assert.equal(done.reused, false);
  assert.deepEqual(done.text.split(" "), counting(30).map((w) => w.w));
  const last = t.windows[t.windows.length - 1];
  assert.ok(last.final && last.dur < 6, `the final decode was ${last.dur}s of the 12s clip`);
});

test("a short silent tail is already in the last window: no final decode at all", async () => {
  // he stopped talking 0.8 s before releasing the key, and the ear had read it all
  const t = earOf({ words: counting(18), secs: 8, loudTo: 7.2, anchorMs: 2500 });
  t.ear.start();
  await t.run(80);
  t.ear.stop();
  const n = t.windows.length;
  const done = await t.ear.finalize(t.samples);
  assert.equal(done.reused, true, "the tail was silent and short — it decoded anyway");
  assert.equal(t.windows.length, n, "a decode ran for a reused final");
});

test("an ear that heard nothing leaves the clip to the caller", async () => {
  const t = earOf({ words: [], secs: 1 });
  t.ear.start();
  assert.equal(await t.ear.finalize(clip(1)), null);
});

test("the final caption completes the partials instead of repeating them", () => {
  assert.deepEqual(captionDelta("hola que", "hola que tal"), { text: "tal", append: true });
  assert.equal(captionDelta("hola que tal", "hola que tal"), null);
  // a partial the final does not agree with is redrawn whole — settled, not retyped
  assert.deepEqual(captionDelta("ola k", "hola que tal"), { text: "hola que tal", append: false, ms: SETTLE_MS });
  // with nothing on screen it is the caption E27 already shipped: no ms, his own pace
  assert.deepEqual(captionDelta("", "hola"), { text: "hola", append: false, ms: undefined });
  assert.equal(captionDelta("hola", ""), null, "an empty hypothesis never wipes the caption");
});

test("a final decode that comes back empty falls back to the words he already saw", async () => {
  // the recogniser answers the final window with silence — 2026-09-06 16:30:21
  const t = earOf({ words: counting(20), secs: 8, anchorMs: 2500, emptyFinal: true });
  t.ear.start();
  await t.run(80);
  const seen = t.ear.shown;
  assert.ok(seen.length, "nothing was shown, the test proves nothing");
  const done = await t.ear.finalize(t.samples);
  assert.ok(done && done.text.startsWith(seen), `final "${done && done.text}" lost "${seen}"`);
});
