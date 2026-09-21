/** audio.js — the pw-cat argv, one mouth, gapless bytes, speaking ms and the mic clip. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createAudio, pickSink } = require("../src/audio");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-test-"));
// a fake pw-cat: logs its argv, keeps playback bytes in arrival order, and
// records a fixed pattern until SIGINT
const FAKE = path.join(dir, "fake-pw-cat.js");
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
   const fs = require("node:fs");
   const d = process.env.FAKE_DIR;
   const argv = process.argv.slice(2);
   if (argv[0] === "-r") {
     const pat = Buffer.alloc(16);
     [0.25, -0.5, 0.75, -1].forEach((v, i) => pat.writeFloatLE(v, i * 4));
     fs.writeSync(1, pat); // in the pipe before the test can see calls.log
   }
   fs.appendFileSync(d + "/calls.log", JSON.stringify(argv) + "\\n");
   if (argv[0] === "-r") {
     process.on("SIGINT", () => process.exit(0));
     setInterval(() => {}, 1000);
   } else {
     const live = d + "/live";
     if (fs.existsSync(live)) fs.appendFileSync(d + "/calls.log", JSON.stringify(["OVERLAP"]) + "\\n");
     fs.writeFileSync(live, "");
     const bufs = [];
     process.stdin.on("data", (b) => bufs.push(b));
     process.stdin.on("end", () => {
       fs.appendFileSync(d + "/played.raw", Buffer.concat(bufs));
       fs.unlinkSync(live);
       process.exit(0);
     });
   }`,
  { mode: 0o755 }
);

/** An audio with its own fake-pw-cat sandbox. */
function audioOf(opts = {}) {
  const box = fs.mkdtempSync(path.join(dir, "box-"));
  const lines = [];
  const speaking = [];
  const caps = [];
  const a = createAudio({
    bin: process.execPath,
    spawn: (bin, args, opts) => require("node:child_process").spawn(bin, [FAKE, ...args], { ...opts, env: { ...process.env, FAKE_DIR: box } }),
    onSpeaking: (ms) => speaking.push(ms),
    onCaption: (c) => caps.push({ ...c, at: Date.now() }),
    log: (m) => lines.push(m),
    readSink: () => null, // no pactl in the tests unless one is asked for
    ...opts,
  });
  const calls = () =>
    fs.existsSync(path.join(box, "calls.log"))
      ? fs.readFileSync(path.join(box, "calls.log"), "utf8").trim().split("\n").map(JSON.parse)
      : [];
  const played = () => (fs.existsSync(path.join(box, "played.raw")) ? fs.readFileSync(path.join(box, "played.raw")) : Buffer.alloc(0));
  return { a, calls, played, lines, speaking, caps };
}

/** Wait until `f()` is true, or fail after 5 s. */
async function until(f, what) {
  for (let i = 0; i < 500; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const NO_RESTORE = "{ state.restore-target = false, state.restore-props = false }";

const chunk = (seq, last, n, rate = 24000) => ({
  seq,
  last,
  sampleRate: rate,
  samples: Float32Array.from({ length: n }, (_, i) => (seq * 100 + i) / 1000),
});

test("playback spawns one pw-cat per utterance, raw f32 mono at the chunk's rate", async () => {
  const { a, calls, played } = audioOf();
  a.play(chunk(0, false, 4));
  a.play(chunk(1, false, 4));
  a.play(chunk(2, true, 4));
  await until(() => played().length === 48, "the three chunks to drain");
  assert.deepStrictEqual(calls(), [
    ["-p", "--raw", "--format", "f32", "--rate", "24000", "--channels", "1", "-P", NO_RESTORE, "-"],
  ]);
});

test("the chunks of one utterance arrive in order, byte for byte", async () => {
  const { a, played } = audioOf();
  const cs = [chunk(0, false, 4), chunk(1, false, 4), chunk(2, true, 4)];
  for (const c of cs) a.play(c);
  await until(() => played().length === 48, "the utterance to drain");
  const want = Buffer.concat(cs.map((c) => Buffer.from(c.samples.buffer)));
  assert.deepStrictEqual(played(), want);
});

test("a second utterance waits for the first — one mouth", async () => {
  const { a, calls, played } = audioOf();
  const cs = [chunk(0, false, 4), chunk(1, true, 4), { ...chunk(0, true, 4), samples: Float32Array.from([9, 9, 9, 9]) }];
  for (const c of cs) a.play(c);
  await until(() => played().length === 48, "both utterances to drain");
  assert.strictEqual(calls().length, 2, "one pw-cat per utterance");
  assert.ok(!calls().some((c) => c[0] === "OVERLAP"), "the two never played at the same time");
  assert.deepStrictEqual(played(), Buffer.concat(cs.map((c) => Buffer.from(c.samples.buffer))));
});

test("speaking ms is what is still to play, chunk after chunk", () => {
  const { a, speaking } = audioOf();
  a.play(chunk(0, false, 24000)); // 1000 ms at 24 kHz
  a.play(chunk(1, true, 12000)); // 500 ms more, on top of what is left
  assert.strictEqual(speaking.length, 2);
  assert.ok(Math.abs(speaking[0] - 1000) <= 20, `first ${speaking[0]}`);
  assert.ok(Math.abs(speaking[1] - 1500) <= 40, `second ${speaking[1]}`);
  assert.strictEqual(a.speaking, true);
});

test("capture records raw f32 mono at 16 kHz and hands the clip back on stop", async () => {
  const { a, calls, lines } = audioOf();
  a.startCapture();
  await until(() => calls().length === 1, "the capture pw-cat");
  assert.deepStrictEqual(calls()[0], ["-r", "--raw", "--format", "f32", "--rate", "16000", "--channels", "1", "-"]);
  const samples = await a.stopCapture();
  assert.deepStrictEqual([...samples], [0.25, -0.5, 0.75, -1]);
  assert.ok(lines.some((l) => l.startsWith("mic captured ")), `logged: ${lines.join(" | ")}`);
  assert.strictEqual(a.captureRate, 16000);
});

test("the partial ear reads the clip as it grows, from its own cursor", async () => {
  const { a, calls } = audioOf();
  assert.deepStrictEqual([...a.capturedFrom(0)], [], "no capture, no samples");
  a.startCapture();
  await until(() => calls().length === 1, "the capture pw-cat");
  await until(() => a.capturedFrom(0).length === 4, "the recorded pattern");
  assert.deepStrictEqual([...a.capturedFrom(0)], [0.25, -0.5, 0.75, -1]);
  assert.deepStrictEqual([...a.capturedFrom(2)], [0.75, -1], "only what is past the cursor");
  assert.deepStrictEqual([...a.capturedFrom(4)], []);
  assert.deepStrictEqual([...(await a.stopCapture())], [0.25, -0.5, 0.75, -1], "the whole clip is still there");
});

test("stopCapture without a capture is an empty clip, and a second start is a no-op", async () => {
  const { a, calls } = audioOf();
  assert.deepStrictEqual([...(await a.stopCapture())], []);
  a.startCapture();
  a.startCapture();
  await until(() => calls().length === 1, "the capture pw-cat");
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(calls().length, 1);
  await a.stopCapture();
});

test("an utterance whose last chunk never arrives is closed by the idle timeout", async () => {
  const { a, calls, played } = audioOf({ idleMs: 80 });
  a.play(chunk(0, false, 4));
  await until(() => played().length === 16, "the orphaned utterance to drain");
  a.play({ ...chunk(0, true, 4), samples: Float32Array.from([9, 9, 9, 9]) });
  await until(() => played().length === 32, "the next utterance to play");
  assert.strictEqual(calls().length, 2, "one pw-cat per utterance, none left open");
});

test("endOpen closes the utterance the voice worker abandoned", async () => {
  const { a, calls, played } = audioOf({ idleMs: 60_000 });
  a.play(chunk(0, false, 4));
  a.endOpen();
  await until(() => played().length === 16, "the abandoned utterance to drain");
  a.play({ ...chunk(0, true, 4), samples: Float32Array.from([9, 9, 9, 9]) });
  await until(() => played().length === 32, "the next utterance to play");
  assert.strictEqual(calls().length, 2);
});

test("an utterance waiting behind another stops buffering instead of growing without bound", async () => {
  const { a, lines, played } = audioOf({ idleMs: 80, maxPendingBytes: 64 });
  a.play(chunk(0, false, 4)); // the first utterance holds the mouth
  a.play({ ...chunk(0, false, 4), samples: Float32Array.from([1, 1, 1, 1]) }); // the second waits
  for (let i = 1; i < 40; i++) a.play(chunk(i, false, 4));
  assert.ok(lines.some((l) => l.startsWith("audio buffer full")), `logged: ${lines.join(" | ")}`);
  await until(() => played().length >= 16, "both utterances to drain");
});

test("the caption of a sentence is sent when its audio starts, not when it is enqueued", async () => {
  const { a, caps } = audioOf();
  const t0 = Date.now();
  a.play({ ...chunk(0, false, 2400), text: "one." }); // 100 ms at 24 kHz
  a.play({ ...chunk(1, true, 2400), text: "two." }); // waits behind it
  assert.deepStrictEqual(
    caps.map((c) => [c.text, c.append]),
    [["one.", false]],
    "the first sentence shows at once, the second is still to be spoken"
  );
  assert.ok(Math.abs(caps[0].ms - 100) <= 5, `the sentence lasts ${caps[0].ms} ms`);
  await until(() => caps.length === 2, "the second sentence to start");
  assert.deepStrictEqual(caps[1].text, "two.");
  assert.strictEqual(caps[1].append, true, "it joins the caption already on screen");
  assert.ok(caps[1].at - t0 >= 90, `it waited for the first to play (${caps[1].at - t0} ms)`);
});

test("a chunk with no text sends no caption, and a dropped one is never captioned", async () => {
  const { a, caps } = audioOf({ maxPendingBytes: 16 });
  a.play(chunk(0, false, 4));
  a.play({ ...chunk(0, false, 4), text: "first" }); // the second utterance waits
  for (let i = 1; i < 40; i++) a.play({ ...chunk(i, false, 4), text: `dropped ${i}` });
  assert.deepStrictEqual(
    caps.map((c) => c.text),
    ["first"],
    "only what is actually going to be heard"
  );
});

// --- barge-in (M08) ------------------------------------------------------------------

test("cut kills the live pw-cat, empties the queue and speaking is false at once", async () => {
  const { a, calls, speaking, lines, played } = audioOf({ idleMs: 60_000 });
  const plays = () => calls().filter((c) => c[0] === "-p"); // a killed fake leaves its OVERLAP mark
  a.play({ ...chunk(0, false, 24000), id: 1 }); // 1 s live
  a.play({ ...chunk(0, true, 24000), id: 2 }); // waits behind it
  await until(() => plays().length === 1, "the live pw-cat");
  assert.strictEqual(a.speaking, true);
  a.cut();
  assert.strictEqual(a.speaking, false);
  assert.strictEqual(speaking.at(-1), 0, "the eye is told the mouth is closed");
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(plays().length, 1, "the queued utterance never got its pw-cat");
  assert.strictEqual(played().length, 0, "the killed one never drained");
  a.play({ ...chunk(0, true, 4), id: 3, samples: Float32Array.from([9, 9, 9, 9]) });
  await until(() => plays().length === 2, "a later utterance plays");
  assert.ok(!lines.some((l) => l.startsWith("utterance went quiet")), `logged: ${lines.join(" | ")}`);
});

test("a chunk arriving after the cut for the cut id is ignored", async () => {
  const { a, calls, caps } = audioOf({ idleMs: 60_000 });
  a.play({ ...chunk(0, false, 24000), id: 1, text: "one." });
  a.play({ ...chunk(1, false, 24000), id: 1, text: "two." }); // its caption is due in 1 s
  await until(() => calls().length === 1, "the live pw-cat");
  a.cut();
  a.play({ ...chunk(2, true, 4), id: 1, text: "three." });
  await new Promise((r) => setTimeout(r, 1100));
  assert.strictEqual(calls().length, 1, "no new pw-cat for the cut utterance");
  assert.strictEqual(a.speaking, false);
  assert.deepStrictEqual(caps.map((c) => c.text), ["one."], "the pending caption of the cut words never shows");
});

test("cut also ignores the next utterance the worker had already started", async () => {
  const { a, calls } = audioOf({ idleMs: 60_000 });
  const plays = () => calls().filter((c) => c[0] === "-p");
  a.play({ ...chunk(0, false, 24000), id: 1 }); // A plays; the worker is already making B (id 2)
  await until(() => plays().length === 1, "A's pw-cat");
  a.cut(2);
  a.play({ ...chunk(0, false, 24000), id: 2, text: "B one." }); // B's first sentence lands after the cut
  a.play({ ...chunk(1, true, 4), id: 2, text: "B two." });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(plays().length, 1, "no stray sentence of B");
  assert.strictEqual(a.speaking, false);
  a.play({ ...chunk(0, true, 4), id: 3 });
  await until(() => plays().length === 2, "the utterance after the cut plays");
});

test("cut with nothing playing is a no-op", () => {
  const { a, speaking } = audioOf();
  a.cut();
  assert.deepStrictEqual(speaking, []);
});

// --- where the voice comes out (E23) ------------------------------------------------

const SINKS = [
  { index: 1, name: "alsa_output.pci-0000_00_1f.3.hdmi-stereo", state: "SUSPENDED" },
  { index: 2, name: "bluez_output.AC_80_0A_27_65_6C.1", state: "SUSPENDED" },
];
const input = (sink, name, extra = {}) => ({ sink, corked: false, properties: { "application.name": name }, ...extra });

test("the voice follows the media playing: on the TV it is the TV, on the buds the buds", () => {
  assert.strictEqual(pickSink([input(1, "Google Chrome")], SINKS, "default"), SINKS[0].name);
  assert.strictEqual(pickSink([input(2, "Spotify")], SINKS, "default"), SINKS[1].name);
});

test("with nothing playing the voice goes to the default sink", () => {
  assert.strictEqual(pickSink([], SINKS, "bluez_output.AC_80_0A_27_65_6C.1"), "bluez_output.AC_80_0A_27_65_6C.1");
});

test("the Eye's own mouth and the screen reader are not media", () => {
  const own = [input(1, "pw-cat"), input(1, "speech-dispatcher-dummy")];
  assert.strictEqual(pickSink(own, SINKS, "default"), "default");
});

test("a corked stream is paused, not playing", () => {
  assert.strictEqual(pickSink([input(1, "Spotify", { corked: true })], SINKS, "default"), "default");
});

test("a stream on a RUNNING sink wins over one that is merely uncorked", () => {
  const sinks = [SINKS[0], { ...SINKS[1], state: "RUNNING" }];
  assert.strictEqual(pickSink([input(1, "Chromium"), input(2, "Spotify")], sinks, "default"), SINKS[1].name);
});

test("a stream on a sink that is gone falls back to the default", () => {
  assert.strictEqual(pickSink([input(999, "Spotify")], SINKS, "default"), "default");
});

test("the pw-cat of an utterance is told the sink by name, and asks once per window", async () => {
  let looks = 0;
  const { a, calls, played } = audioOf({ readSink: () => (looks++, "bluez_output.AC_80_0A_27_65_6C.1"), sinkTtlMs: 60_000 });
  a.play(chunk(0, true, 4));
  await until(() => played().length === 16, "the utterance to drain");
  a.play({ ...chunk(0, true, 4), samples: Float32Array.from([9, 9, 9, 9]) });
  await until(() => played().length === 32, "the second utterance to drain");
  for (const c of calls()) assert.deepStrictEqual(c.slice(-3), ["--target", "bluez_output.AC_80_0A_27_65_6C.1", "-"]);
  assert.strictEqual(looks, 1, "one look at the graph per window, not per utterance");
});
