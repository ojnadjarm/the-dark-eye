/** orbiters.js — the working set: TTL, persistence across a restart, replay. */
const { test, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createOrbiters } = require("../src/orbiters");

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orbiters-")), "orbiters.json");

test("working is kept, done and error drop it", () => {
  const o = createOrbiters({ file: tmpFile() });
  o.set({ id: "a", state: "working", label: "one" });
  o.set({ id: "b", state: "working", label: "two" });
  o.set({ id: "a", state: "done", label: "one" });
  assert.deepEqual(o.list().map((x) => x.id), ["b"]);
  o.set({ id: "b", state: "error", label: "two" });
  assert.deepEqual(o.list(), []);
  o.stop();
});

test("a restart restores the set, minus what expired while it was down", () => {
  const file = tmpFile();
  let clock = 1_000_000;
  const a = createOrbiters({ file, ttlMs: 1000, now: () => clock });
  a.set({ id: "a", state: "working", label: "short" });
  clock += 500;
  a.set({ id: "b", state: "working", label: "later" });
  a.stop();

  clock += 600; // "a" is over its ttl, "b" is not
  const b = createOrbiters({ file, ttlMs: 1000, now: () => clock });
  assert.deepEqual(b.list().map((x) => [x.id, x.label]), [["b", "later"]]);
  assert.equal(b.list()[0].until, 1_000_500 + 1000, "the expiry itself is persisted");
  b.stop();
});

test("replay re-sends the live set as working status messages", () => {
  const sent = [];
  const o = createOrbiters({ file: tmpFile(), send: (m) => sent.push(m) });
  o.set({ id: "a", state: "working", label: "one" });
  o.set({ id: "b", state: "working", label: "two" });
  o.replay();
  assert.deepEqual(sent, [
    { type: "status", id: "a", state: "working", label: "one" },
    { type: "status", id: "b", state: "working", label: "two" },
  ]);
  o.stop();
});

test("the refresh timer replays on its own, so the renderer ttl never lapses", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const sent = [];
    const o = createOrbiters({ file: tmpFile(), refreshMs: 5, send: (m) => sent.push(m) });
    o.set({ id: "a", state: "working", label: "one" });
    mock.timers.tick(15);
    o.stop();
    assert.ok(sent.length >= 2, `expected repeated replays, got ${sent.length}`);
    assert.ok(sent.every((m) => m.id === "a" && m.state === "working"));
  } finally {
    mock.timers.reset();
  }
});

test("an unreadable state file is an empty set, not a crash", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "not json");
  const o = createOrbiters({ file });
  assert.deepEqual(o.list(), []);
  o.stop();
});
