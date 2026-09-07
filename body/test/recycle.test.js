/** recycle.js — the voice worker is killed only when it is both too big and quiet. */
const { test } = require("node:test");
const assert = require("node:assert");
const { createRecycler, rssMB } = require("../src/recycle");

const MAX = 1600;
const IDLE = 600_000;

/** A recycler on a fake clock and a fake `/proc`, plus the worker it watches. */
function rig({ maxMB = MAX, rss = 2000 } = {}) {
  const state = { t: 1_000_000, rss, killed: 0, logs: [] };
  const worker = { pid: 4242, kill: () => state.killed++ };
  const r = createRecycler({
    maxMB,
    idleMs: IDLE,
    readRss: (pid) => (assert.equal(pid, 4242), state.rss),
    now: () => state.t,
    log: (m) => state.logs.push(m),
  });
  return { r, worker, state };
}

test("too big and quiet long enough: killed once, logged with the size", () => {
  const { r, worker, state } = rig();
  state.t += IDLE;
  assert.equal(r.check(worker), true);
  assert.equal(state.killed, 1);
  assert.match(state.logs[0], /voice worker recycled at 2000 MB \(idle 600s\)/);
});

test("big but still busy: nothing happens", () => {
  const { r, worker, state } = rig();
  state.t += IDLE - 1;
  assert.equal(r.check(worker), false);
  assert.equal(state.killed, 0);
});

test("quiet but small: nothing happens", () => {
  const { r, worker, state } = rig({ rss: MAX });
  state.t += IDLE * 10;
  assert.equal(r.check(worker), false);
  assert.equal(state.killed, 0);
});

test("a touch resets the idle clock, so speech in the window saves the worker", () => {
  const { r, worker, state } = rig();
  state.t += IDLE - 1;
  r.touch();
  state.t += IDLE - 1;
  assert.equal(r.check(worker), false);
  state.t += 1;
  assert.equal(r.check(worker), true);
  assert.equal(state.killed, 1);
});

test("the next check after a kill waits a full idle window for the new worker", () => {
  const { r, worker, state } = rig();
  state.t += IDLE;
  assert.equal(r.check(worker), true);
  assert.equal(r.check(worker), false, "the respawn is not killed on the spot");
  state.t += IDLE;
  assert.equal(r.check(worker), true);
  assert.equal(state.killed, 2);
});

test("maxMB 0 disables the recycle, and a dead worker is never killed", () => {
  const off = rig({ maxMB: 0 });
  off.state.t += IDLE * 10;
  assert.equal(off.r.check(off.worker), false);
  const on = rig();
  on.state.t += IDLE * 10;
  assert.equal(on.r.check(null), false);
  assert.equal(on.r.check({ pid: null, kill: () => assert.fail("killed a dead worker") }), false);
});

test("rssMB reads a live process and 0 for one that is gone", () => {
  assert.ok(rssMB(process.pid) > 0);
  assert.equal(rssMB(0), 0);
});
