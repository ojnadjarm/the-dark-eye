/** The transcript queue: FIFO, waiters served in order, take() times out to null. */
const { test } = require("node:test");
const assert = require("node:assert");
const queue = require("../src/queue");

test("take() returns an already queued item", async () => {
  queue.push("a");
  assert.equal(await queue.take(50), "a");
});

test("queued items come out FIFO", async () => {
  queue.push("one");
  queue.push("two");
  assert.equal(await queue.take(50), "one");
  assert.equal(await queue.take(50), "two");
});

test("take() resolves null after the timeout", async () => {
  const t0 = Date.now();
  assert.equal(await queue.take(60), null);
  assert.ok(Date.now() - t0 >= 55);
});

test("a waiter gets the next push", async () => {
  const p = queue.take(500);
  queue.push("late");
  assert.equal(await p, "late");
});

test("waiters are served in order", async () => {
  const a = queue.take(500);
  const b = queue.take(500);
  queue.push("first");
  queue.push("second");
  assert.equal(await a, "first");
  assert.equal(await b, "second");
});

test("a timed-out waiter does not eat a later push", async () => {
  assert.equal(await queue.take(20), null);
  queue.push("kept");
  assert.equal(await queue.take(50), "kept");
});

test("the held words are capped — the oldest go first", async () => {
  for (let i = 0; i < queue.MAX + 5; i++) queue.push(`w${i}`);
  assert.equal(await queue.take(50), "w5", "the first five were dropped");
  for (let i = 0; i < queue.MAX - 1; i++) await queue.take(50);
  assert.equal(await queue.take(20), null, "nothing else is held");
});

test("a tagged transcript rides through unchanged", async () => {
  queue.push({ text: "from the phone", source: "remote" });
  assert.deepEqual(await queue.take(50), { text: "from the phone", source: "remote" });
});

test("tagged and plain items share the one FIFO", async () => {
  queue.push("a string");
  queue.push({ text: "an object", source: "remote" });
  assert.equal(await queue.take(50), "a string");
  assert.deepEqual(await queue.take(50), { text: "an object", source: "remote" });
});
