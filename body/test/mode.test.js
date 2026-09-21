/** mode.js — one enum, written on every switch, read back at start; a bad file is call. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMode, fromWire, toWire } = require("../src/mode");
const { createBrains } = require("../src/brains");
const { createHold } = require("../src/hold");

const dirIn = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mode-")), "state");
const fileIn = () => path.join(dirIn(), "mode.json");

test("call with no file; async is written 0600 and read back by the next body", () => {
  const file = fileIn();
  const m = createMode({ file });
  assert.strictEqual(m.mode, "call");
  assert.strictEqual(m.async, false);
  assert.strictEqual(m.set("async"), "async");
  assert.strictEqual(m.async, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { default: "async", channels: {} });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(createMode({ file }).mode, "async");
  m.set("call");
  assert.strictEqual(createMode({ file }).mode, "call");
});

test("a corrupt, foreign or unknown mode reads as call", () => {
  for (const body of ["{", '{"mode":"loud"}', '{"on":true}', "[]", ""]) {
    const file = fileIn();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, body);
    assert.strictEqual(createMode({ file, quietFile: "/nonexistent" }).mode, "call", JSON.stringify(body));
  }
});

test("an unknown mode is refused and the file is not touched", () => {
  const file = fileIn();
  const m = createMode({ file });
  assert.strictEqual(m.set("loud"), "call");
  assert.strictEqual(m.set("call"), "call");
  assert.strictEqual(fs.existsSync(file), false);
});

test("quiet mode's old file comes back as async, once, and is left on disk", () => {
  const dir = dirIn();
  const file = path.join(dir, "mode.json");
  const quietFile = path.join(dir, "quiet.json");
  fs.mkdirSync(dir);
  fs.writeFileSync(quietFile, JSON.stringify({ on: true }));
  const m = createMode({ file, quietFile });
  assert.strictEqual(m.mode, "async");
  m.set("call");
  assert.strictEqual(createMode({ file, quietFile }).mode, "call", "mode.json wins once it exists");
  assert.strictEqual(fs.existsSync(quietFile), true, "his old file is never written or removed");
  fs.writeFileSync(quietFile, JSON.stringify({ on: false }));
  assert.strictEqual(createMode({ file: fileIn(), quietFile }).mode, "call");
});

test("his word is the wire's, the body's is `async`: a file holding `notes` is the same mode", () => {
  const file = fileIn();
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ mode: "notes" }));
  assert.strictEqual(createMode({ file }).mode, "async", "a file written before the mode had its own word");
  assert.strictEqual(fromWire("notes"), "async");
  assert.strictEqual(fromWire("call"), "call");
  for (const m of ["async", "loud", "constructor", "", undefined, 1]) assert.strictEqual(fromWire(m), undefined, String(m));
  assert.strictEqual(toWire("async"), "notes");
  assert.strictEqual(toWire("call"), "call");
});

test("DARK_EYE_MODE_FILE names the file; an unwritable one is logged, not thrown", () => {
  const file = fileIn();
  process.env.DARK_EYE_MODE_FILE = file;
  try {
    createMode().set("async");
    assert.strictEqual(fs.existsSync(file), true);
  } finally {
    delete process.env.DARK_EYE_MODE_FILE;
  }
  const lines = [];
  const notADir = path.join(path.dirname(dirIn()), "file");
  fs.writeFileSync(notADir, "");
  createMode({ file: path.join(notADir, "mode.json"), log: (m) => lines.push(m) }).set("async");
  assert.match(lines[0], /cannot persist/);
});

test("the body's wiring: one mode gate, and in audio notes both channels get the words", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(
    main,
    /mode = createMode\(\{ active: \(\) => brains\.active, channels, defaultMode: cfg\.defaultMode, log \}\)/,
    "read once at start, and its mode is whichever channel is active"
  );
  assert.match(main, /parked: \(\) => mode\.async/, "the hold's only park is the mode");
  const show = main.slice(main.indexOf("function show(text, to"), main.indexOf("function setMode"));
  assert.match(show, /const both = mode\.async;[\s\S]*both \|\| to !== "remote"[\s\S]*both \|\| to !== "local"/, "a turn taken in the room is a page line too, so the ▶ is always there");
  const setMode = main.slice(main.indexOf("function setMode"), main.indexOf("function onModeIntent"));
  assert.match(setMode, /whisper\("⟨ audio notes ⟩"\)/, "entering it is shown on the TV — with no page open that caption is all he gets");
  assert.match(setMode, /else hold\.heard\(\)/, "back in call the queue drains, in order");
  assert.match(
    setMode,
    /if \(channel !== brains\.active\) return m;\n\s*showMarks\(\);/,
    "a mode moved on a channel he is not on whispers nothing and releases nothing: he is never interrupted"
  );
  assert.match(main, /if \(mode\.async\) log\("mode: async \(kept\)"\)/, "a restart keeps it");
  assert.doesNotMatch(main, /createQuiet|quiet\.on|setQuiet|onQuietIntent/, "quiet mode is not a second concept");
});

// -- mode per channel: who he talks to and how the exchange runs are two questions ----

const table = { main: {}, notes: { mode: "notes" }, brother: {} };

/** `createMode` over a roster, with the active channel a test can move. */
const perChannel = (opts = {}) => {
  const at = { name: "main" };
  const m = createMode({ active: () => at.name, channels: table, file: fileIn(), ...opts });
  return { m, at };
};

test("two channels hold two modes at once, and `mode` is whichever one is active", () => {
  const { m, at } = perChannel();
  assert.strictEqual(m.of("main"), "call");
  assert.strictEqual(m.of("notes"), "async", "his decision: the notes channel starts in audio notes mode");
  assert.strictEqual(m.mode, "call");
  assert.strictEqual(m.async, false);
  at.name = "notes";
  assert.strictEqual(m.mode, "async", "the switch switched the mode of the exchange");
  assert.strictEqual(m.async, true);
  at.name = "main";
  assert.strictEqual(m.mode, "call", "and back");
  assert.strictEqual(m.of("brother"), "call", "a row with no mode of its own falls to the default");
  assert.strictEqual(m.of("joined-late"), "call", "so does a channel that is on no table at all");
});

test("a mode set on one channel moves that channel alone", () => {
  const { m, at } = perChannel();
  assert.strictEqual(m.set("async"), "async", "no channel means the active one");
  assert.strictEqual(m.of("main"), "async");
  assert.strictEqual(m.of("notes"), "async");
  assert.strictEqual(m.set("call", "notes"), "call");
  assert.strictEqual(m.of("notes"), "call");
  assert.strictEqual(m.of("main"), "async", "the channel he is on was not moved with it");
  at.name = "notes";
  assert.strictEqual(m.mode, "call");
  assert.strictEqual(m.set("async", "brother"), "async");
  assert.strictEqual(m.mode, "call", "a third channel's mode is not the mode of the exchange");
});

test("an unknown mode is refused for any channel, and the file is not touched", () => {
  const file = fileIn();
  const { m } = perChannel({ file });
  assert.strictEqual(m.set("loud", "notes"), "async", "the channel keeps the mode it had");
  assert.strictEqual(m.set("notes", "notes"), "async", "his word is the wire's, not the body's own: refused here");
  assert.strictEqual(fs.existsSync(file), false);
});

test("every channel's mode comes back after a restart, each its own", () => {
  const file = fileIn();
  const { m } = perChannel({ file });
  m.set("async", "brother");
  m.set("call", "notes");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    default: "call",
    channels: { brother: "async", notes: "call" },
  });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const { m: back } = perChannel({ file });
  assert.strictEqual(back.of("brother"), "async");
  assert.strictEqual(back.of("notes"), "call", "his choice outranks the row's configured mode");
  assert.strictEqual(back.of("main"), "call");
});

test("a mode file from before the mode was per channel is one mode for every channel", () => {
  for (const [saved, each] of [
    [{ mode: "notes" }, "async"],
    [{ mode: "async" }, "async"],
    [{ mode: "call" }, "call"],
  ]) {
    const file = fileIn();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(saved));
    // a table with no configured mode: the file's one mode is every channel's
    const m = createMode({ channels: { main: {}, notes: {} }, file, quietFile: "/nonexistent" });
    assert.strictEqual(m.of("main"), each, JSON.stringify(saved));
    assert.strictEqual(m.of("notes"), each, JSON.stringify(saved));
    assert.strictEqual(m.of("brother"), each, "and a channel the file never heard of");
  }
});

test("a quiet file from before the rename is still every channel in audio notes mode", () => {
  const dir = dirIn();
  const quietFile = path.join(dir, "quiet.json");
  fs.mkdirSync(dir);
  fs.writeFileSync(quietFile, JSON.stringify({ on: true }));
  const m = createMode({ channels: { main: {}, notes: {} }, file: path.join(dir, "mode.json"), quietFile });
  assert.strictEqual(m.of("main"), "async");
  assert.strictEqual(m.of("notes"), "async");
  assert.strictEqual(fs.existsSync(quietFile), true, "his old file is never written or removed");
});

test("a channels map in the file that is not one, or holds no mode, leaves the config's modes standing", () => {
  for (const channels of [null, "notes", ["notes"], 7, { notes: "loud" }, { notes: null }]) {
    const file = fileIn();
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ channels }));
    const m = createMode({ active: () => "main", channels: table, file, quietFile: "/nonexistent" });
    assert.strictEqual(m.of("notes"), "async", JSON.stringify(channels));
    assert.strictEqual(m.of("main"), "call", JSON.stringify(channels));
  }
});

test("defaultMode is what a channel with no mode of its own starts in, in his words or the body's", () => {
  for (const defaultMode of ["notes", "async"]) {
    const { m } = perChannel({ defaultMode });
    assert.strictEqual(m.of("main"), "async", defaultMode);
    assert.strictEqual(m.of("joined-late"), "async", defaultMode);
  }
  const { m } = perChannel({ defaultMode: "loud" });
  assert.strictEqual(m.of("main"), "call", "a defaultMode that is no mode is call");
});

/**
 * The real `brains.js`, `hold.js` and `mode.js` on a fake clock: `say` is the
 * mode gate main.js wires (`parked: () => mode.async`, asserted shipped in
 * render-bridge.test.js), so what the room hears here is the body's own order.
 */
function twoChannels() {
  const dir = dirIn();
  fs.mkdirSync(dir, { recursive: true });
  const mode = createMode({
    active: () => brains.active,
    channels: { main: {}, notes: { mode: "notes" } },
    file: path.join(dir, "mode.json"),
    quietFile: "/nonexistent",
  });
  let now = 0;
  const due = [];
  const spoken = [];
  const said = [];
  const hold = createHold({
    send: (i) => spoken.push(i.text),
    parked: () => mode.async,
    now: () => now,
    timers: {
      setTimeout: (f, ms) => (due.push({ at: now + ms, f }), due.at(-1)),
      clearTimeout: (t) => t && due.splice(due.indexOf(t), 1),
    },
  });
  const say = (text, sid) => (said.push(text), hold.offer({ text, sid }));
  const brains = createBrains({
    channels: { main: {}, notes: {} },
    defaultChannel: "main",
    say,
    file: path.join(dir, "active.json"),
  });
  const tick = (ms) => {
    now += ms;
    for (const t of due.filter((x) => x.at <= now)) {
      due.splice(due.indexOf(t), 1);
      t.f();
    }
  };
  return { mode, brains, hold, spoken, said, tick };
}

test("a live call on one channel while the other holds its replies: he is never interrupted", () => {
  const b = twoChannels();
  assert.strictEqual(b.brains.active, "main");
  assert.strictEqual(b.mode.mode, "call", "the channel he is on answers out loud");

  b.brains.speak("main", "your build is green");
  b.tick(0);
  assert.deepStrictEqual(b.spoken, ["your build is green"], "the active channel in call mode answers at once");

  const waiting = [b.brains.speak("notes", "note one"), b.brains.speak("notes", "note two")];
  b.tick(60_000);
  assert.deepStrictEqual(waiting, [1, 2], "the channel he is not on parked both");
  assert.deepStrictEqual(b.said, ["your build is green"], "a channel he is not on never reached the mouth at all");
  assert.deepStrictEqual(b.spoken, ["your build is green"], "and no timer ever let one out");
  assert.strictEqual(b.hold.held, 0);

  // the same two channels the other way round: audio notes mode holds what it answers
  b.brains.setActive("notes");
  assert.strictEqual(b.mode.mode, "async", "the switch switched the mode of the exchange");
  b.brains.speak("main", "a third thing");
  b.brains.speak("notes", "note three");
  b.tick(60_000);
  assert.deepStrictEqual(
    b.hold.list().map((i) => i.text),
    ["note three"],
    "only the channel he is on reaches the mouth at all — H09 deleted the joined blob the switch used to say"
  );
  const waits = Object.fromEntries(b.brains.roster().brains.map((x) => [x.name, x.waiting]));
  assert.deepStrictEqual(waits, { main: 1, notes: 2 }, "what each channel left him is still waiting for his \u25b6, per channel");
  assert.strictEqual(b.spoken.length, 1, "nothing more was spoken in the room");
  assert.strictEqual(b.mode.of("main"), "call", "and main is still a call, whatever the channel he is on does");
});
