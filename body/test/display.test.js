/** display.js — the TV-state ladder, the 2-read hysteresis and the ddc no-answer case. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDisplayWatch, sysfsReader, ddcBus } = require("../src/display");

const ON = { status: "connected", dpms: "On", enabled: "enabled" };

/** A watch with no timer, driven by `poll()`; returns it plus the transitions seen. */
function watchOf(opts) {
  const seen = [];
  const w = createDisplayWatch({ intervalMs: 0, onChange: (s) => seen.push(s), ...opts });
  return { w, seen };
}

test("the ladder: what each signal decides on a single read", () => {
  const cases = [
    { name: "all good", displays: [1], sysfs: ON, off: false },
    { name: "no display reported", displays: [], sysfs: ON, off: true, reason: /no display reported/ },
    { name: "connector disconnected", displays: [1], sysfs: { ...ON, status: "disconnected" }, off: true, reason: /status=disconnected/ },
    { name: "dpms off", displays: [1], sysfs: { ...ON, dpms: "Off" }, off: true, reason: /dpms=Off/ },
    { name: "connector disabled", displays: [1], sysfs: { ...ON, enabled: "disabled" }, off: true, reason: /enabled=disabled/ },
    { name: "no sysfs at all falls through to on", displays: [1], sysfs: null, off: false },
  ];
  for (const c of cases) {
    const { w, seen } = watchOf({ displays: () => c.displays, readSysfs: () => c.sysfs });
    w.poll(); // a second read, so the off cases pass the hysteresis
    assert.strictEqual(w.on, !c.off, c.name);
    if (c.reason) assert.match(w.reason, c.reason, c.name);
    assert.ok(seen.length >= 1, `${c.name}: a transition was reported`);
  }
});

test("off needs 2 consecutive off reads, on comes back on the first one", () => {
  let sysfs = ON;
  const { w, seen } = watchOf({ displays: () => [1], readSysfs: () => sysfs });
  assert.strictEqual(w.on, true);

  sysfs = { ...ON, dpms: "Off" };
  w.poll();
  assert.strictEqual(w.on, true, "one off read is not enough");
  w.poll();
  assert.strictEqual(w.on, false, "two consecutive off reads switch it off");

  sysfs = ON;
  w.poll();
  assert.strictEqual(w.on, true, "one on read is enough");
  assert.deepStrictEqual(seen.map((s) => s.on), [true, false, true]);
});

test("a single off read between on reads never flips it", () => {
  const seq = [ON, { ...ON, dpms: "Off" }, ON, { ...ON, status: "disconnected" }, ON];
  let i = 0;
  const { w, seen } = watchOf({ displays: () => [1], readSysfs: () => seq[Math.min(i, seq.length - 1)] });
  for (i = 1; i < seq.length; i++) w.poll();
  assert.strictEqual(w.on, true);
  assert.deepStrictEqual(seen.map((s) => s.on), [true]);
});

test("ddc: power mode != 1 is off, mode 1 is on", () => {
  let mode = 1;
  const { w } = watchOf({ displays: () => [1], readSysfs: () => ON, ddc: () => mode, ddcIntervalMs: 0 });
  assert.strictEqual(w.on, true);
  mode = 4;
  w.poll();
  w.poll();
  assert.strictEqual(w.on, false);
  assert.match(w.reason, /ddc power mode=4/);
  mode = 1;
  w.poll();
  assert.strictEqual(w.on, true);
});

test("ddc: no answer 3 times while sysfs still says connected is off", () => {
  let answer = 1;
  const { w } = watchOf({ displays: () => [1], readSysfs: () => ON, ddc: () => answer, ddcIntervalMs: 0 });
  answer = null;
  w.poll(); // miss 1
  w.poll(); // miss 2
  assert.strictEqual(w.on, true, "two misses are tolerated");
  w.poll(); // miss 3 — first off read
  assert.strictEqual(w.on, true, "the off read still needs the hysteresis");
  w.poll();
  assert.strictEqual(w.on, false);
  assert.match(w.reason, /ddc no answer x4, sysfs connected/);
});

test("ddc is only asked every ddcIntervalMs", () => {
  let calls = 0;
  const { w } = watchOf({ displays: () => [1], readSysfs: () => ON, ddc: () => (calls++, 1), ddcIntervalMs: 60_000 });
  w.poll();
  w.poll();
  assert.strictEqual(calls, 1, "one probe inside the interval");
});

test("sysfs wins over ddc: a disconnected connector is off without asking ddc", () => {
  let asked = 0;
  const { w } = watchOf({
    displays: () => [1],
    readSysfs: () => ({ ...ON, status: "disconnected" }),
    ddc: () => (asked++, 1),
    ddcIntervalMs: 0,
  });
  w.poll();
  assert.strictEqual(w.on, false);
  assert.strictEqual(asked, 0);
});

test("sysfsReader reads status/dpms/enabled from a directory (DARK_EYE_DISPLAY_SYSFS shape)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drm-"));
  fs.writeFileSync(path.join(dir, "status"), "connected\n");
  fs.writeFileSync(path.join(dir, "dpms"), "On\n");
  fs.writeFileSync(path.join(dir, "enabled"), "enabled\n");
  assert.deepStrictEqual(sysfsReader(dir)(), ON);
  fs.writeFileSync(path.join(dir, "status"), "disconnected\n");
  assert.strictEqual(sysfsReader(dir)().status, "disconnected");
  assert.strictEqual(sysfsReader(path.join(dir, "nope"))(), null, "an unreadable connector reads as null");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ddcBus reads the bus number from the ddc symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drm-"));
  fs.symlinkSync("../../../i2c-3", path.join(dir, "ddc"));
  assert.strictEqual(ddcBus(dir), 3);
  assert.strictEqual(ddcBus(path.join(dir, "nope")), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// -- the owner's own switch over the ladder (E12) ---------------------------

/** A watch with no timer whose override lives in a fresh temp file. */
function overrideWatchOf(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tv-override-"));
  const overrideFile = path.join(dir, "tv-override.json");
  const seen = [];
  const w = createDisplayWatch({
    intervalMs: 0,
    displays: () => [1],
    readSysfs: () => ON,
    onChange: (s) => seen.push(s),
    overrideFile,
    ...opts,
  });
  return { w, seen, overrideFile, dir };
}

test("override off forces the display off, on and auto bring it back", () => {
  const { w, seen, dir } = overrideWatchOf();
  assert.strictEqual(w.on, true);

  assert.deepStrictEqual(w.setOverride("off"), { mode: "off", on: false, reason: "override off" });
  assert.strictEqual(w.on, false, "one call is enough — no hysteresis on the switch");
  w.poll();
  w.poll();
  assert.strictEqual(w.on, false, "and the ladder saying on cannot undo it");

  w.setOverride("on");
  assert.strictEqual(w.on, true);
  assert.strictEqual(w.reason, "override on");

  w.setOverride("auto");
  assert.strictEqual(w.on, true);
  assert.match(w.reason, /status=connected/);
  assert.deepStrictEqual(seen.map((s) => s.on), [true, false, true]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("override on holds the display on while the ladder says off", () => {
  let sysfs = ON;
  const { w, dir } = overrideWatchOf({ readSysfs: () => sysfs });
  w.setOverride("on");
  sysfs = { ...ON, status: "disconnected" };
  w.poll();
  w.poll();
  assert.strictEqual(w.on, true);
  assert.strictEqual(w.reason, "override on");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a forced off steps aside once the ladder itself sees off then on", () => {
  let sysfs = ON;
  const { w, seen, dir } = overrideWatchOf({ readSysfs: () => sysfs });
  w.setOverride("off");
  assert.strictEqual(w.on, false);

  sysfs = { ...ON, status: "disconnected" }; // a real power cycle: the connector drops
  w.poll();
  assert.strictEqual(w.override, "off", "still forced while the ladder is off");
  sysfs = ON; // and comes back
  w.poll();
  assert.strictEqual(w.override, "auto");
  assert.strictEqual(w.on, true);
  assert.match(w.reason, /override off cleared/);
  assert.deepStrictEqual(seen.map((s) => s.on), [true, false, true]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the ladder saying on by itself never clears a forced off", () => {
  const { w, dir } = overrideWatchOf();
  w.setOverride("off");
  for (let i = 0; i < 5; i++) w.poll();
  assert.strictEqual(w.override, "off");
  assert.strictEqual(w.on, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the override is persisted, and a new watch starts from it", () => {
  const { w, overrideFile, dir } = overrideWatchOf();
  w.setOverride("off");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(overrideFile, "utf8")), { mode: "off" });

  const restarted = createDisplayWatch({
    intervalMs: 0,
    displays: () => [1],
    readSysfs: () => ON,
    overrideFile,
  });
  assert.strictEqual(restarted.override, "off");
  assert.strictEqual(restarted.on, false, "a restart with the TV off does not light the eye");
  restarted.setOverride("auto");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(overrideFile, "utf8")), { mode: "auto" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unreadable or nonsense override file reads as auto, and a bad mode throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tv-override-"));
  const overrideFile = path.join(dir, "tv-override.json");
  fs.writeFileSync(overrideFile, '{"mode":"sideways"}');
  const w = createDisplayWatch({ intervalMs: 0, displays: () => [1], readSysfs: () => ON, overrideFile });
  assert.strictEqual(w.override, "auto");
  assert.throws(() => w.setOverride("sideways"), /auto, on or off/);
  assert.strictEqual(w.override, "auto");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stop() clears the timer", () => {
  let polls = 0;
  const w = createDisplayWatch({ displays: () => [1], readSysfs: () => (polls++, ON), intervalMs: 1 });
  w.stop();
  const after = polls;
  return new Promise((r) => setTimeout(() => (assert.strictEqual(polls, after), r()), 20));
});
