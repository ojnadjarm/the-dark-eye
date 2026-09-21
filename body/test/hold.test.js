/** hold.js — the mouth waits while he speaks, 1500 ms after, and through audio notes mode, then says everything in order. */
const { test } = require("node:test");
const assert = require("node:assert");
const { createHold } = require("../src/hold");

/** A hold on a fake clock: `tick(ms)` advances it and fires what is due. */
function holdOf(opts = {}) {
  let now = 0;
  const due = [];
  const sent = [];
  const lines = [];
  const timers = {
    setTimeout: (f, ms) => (due.push({ at: now + ms, f }), due[due.length - 1]),
    clearTimeout: (t) => t && due.splice(due.indexOf(t), 1),
  };
  const state = { mic: false, phone: false, notes: false };
  const h = createHold({
    send: (i) => sent.push(i),
    busy: () => state.mic || state.phone,
    parked: () => state.notes,
    now: () => now,
    timers,
    log: (m) => lines.push(m),
    ...opts,
  });
  const tick = (ms) => {
    now += ms;
    for (const t of due.filter((t) => t.at <= now)) {
      due.splice(due.indexOf(t), 1);
      t.f();
    }
  };
  return { h, state, sent, lines, tick, armed: () => due.length };
}

test("the queue reports what waits and says when it changes — never on a pass-through", () => {
  let changes = 0;
  const { h, state, tick } = holdOf({ onChange: () => changes++ });
  h.offer({ text: "now", sid: 17, to: "local", color: "#b04dff" });
  assert.strictEqual(changes, 0);
  state.mic = true;
  h.offer({ text: "one", sid: 17, to: "local", color: "#b04dff" });
  h.offer({ text: "two", sid: 3, to: "remote", color: "#4dd9ff" });
  assert.strictEqual(changes, 2);
  assert.deepStrictEqual(h.list().map((i) => i.color), ["#b04dff", "#4dd9ff"]);
  state.mic = false;
  h.heard();
  tick(1500);
  assert.strictEqual(h.held, 0);
  assert.strictEqual(changes, 3, "once more when it drained");
  tick(5000);
  assert.strictEqual(changes, 3, "an empty drain is not a change");
});

test("nothing to hold: sent at once, and no timer exists between his turns", () => {
  const { h, sent, armed } = holdOf();
  h.offer({ text: "hi", sid: 17, to: "local" });
  assert.deepStrictEqual(sent, [{ text: "hi", sid: 17, to: "local" }]);
  assert.strictEqual(armed(), 0);
  assert.strictEqual(h.held, 0);
});

test("mic open: queued; mic closed: sent exactly 1500 ms later, in order, sid and to intact", () => {
  const { h, state, sent, tick } = holdOf();
  state.mic = true;
  h.offer({ text: "one", sid: 17, to: "local" });
  h.offer({ text: "two", sid: 12, to: "both" });
  assert.strictEqual(h.held, 2);
  state.mic = false;
  h.heard();
  tick(1499);
  assert.deepStrictEqual(sent, [], "not a word before the window is out");
  tick(1);
  assert.deepStrictEqual(sent, [
    { text: "one", sid: 17, to: "local" },
    { text: "two", sid: 12, to: "both" },
  ]);
  assert.strictEqual(h.held, 0);
});

test("a re-open inside the window re-arms it and nothing is sent early", () => {
  const { h, state, sent, tick, armed } = holdOf();
  state.mic = true;
  h.offer({ text: "one" });
  state.mic = false;
  h.heard();
  tick(1000);
  state.mic = true; // he speaks again
  tick(500);
  assert.deepStrictEqual(sent, []);
  state.mic = false;
  h.heard();
  tick(1499);
  assert.deepStrictEqual(sent, []);
  tick(1);
  assert.deepStrictEqual(sent, [{ text: "one" }]);
  assert.strictEqual(armed(), 0);
});

test("just after the mic closed the mouth still waits, with no mic flag at all", () => {
  const { h, sent, tick } = holdOf();
  h.heard();
  h.offer({ text: "late" });
  assert.deepStrictEqual(sent, []);
  tick(1500);
  assert.deepStrictEqual(sent, [{ text: "late" }]);
});

test("the 21st item drops the oldest, with one log line", () => {
  const { h, state, sent, lines, tick } = holdOf();
  state.mic = true;
  for (let i = 1; i <= 21; i++) h.offer({ text: String(i) });
  assert.strictEqual(h.held, 20);
  assert.strictEqual(lines.length, 1, lines.join(" | "));
  state.mic = false;
  h.heard();
  tick(1500);
  assert.deepStrictEqual(sent.map((s) => s.text), Array.from({ length: 20 }, (_, i) => String(i + 2)));
});

test("a phone utterance in flight counts as busy", () => {
  const { h, state, sent, tick } = holdOf();
  state.phone = true;
  h.offer({ text: "one" });
  assert.strictEqual(h.held, 1);
  state.phone = false;
  h.heard();
  tick(1500);
  assert.deepStrictEqual(sent, [{ text: "one" }]);
});

test("a phone utterance abandoned without a close does not park the queue for good", () => {
  const { h, state, sent, tick, armed } = holdOf();
  state.phone = true;
  h.offer({ text: "one" });
  assert.strictEqual(armed(), 1, "queuing arms the look-again timer");
  tick(1500);
  assert.deepStrictEqual(sent, [], "still busy: looks again");
  state.phone = false; // the stream went idle and was dropped, no close ever came
  tick(1500);
  assert.deepStrictEqual(sent, [{ text: "one" }]);
  assert.strictEqual(armed(), 0);
});

test("audio notes mode with the mic closed: nothing is sent and no timer runs; call drains in order, the Eye's own words too", () => {
  const { h, state, sent, tick, armed } = holdOf();
  state.notes = true;
  h.offer({ text: "a reply", sid: 12, to: "both" });
  h.offer({ text: "notes", sid: 17, to: "local" }); // the switch's own confirmation
  assert.strictEqual(armed(), 0, "audio notes mode arms nothing — it can last days");
  tick(60_000);
  assert.deepStrictEqual(sent, [], "audio notes mode holds everything, however long");
  assert.strictEqual(h.held, 2);
  h.heard(); // a mic close in audio notes mode: the window runs out and nothing re-arms
  tick(1500);
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(armed(), 0);
  state.notes = false;
  h.heard();
  tick(1500);
  assert.deepStrictEqual(sent, [
    { text: "a reply", sid: 12, to: "both" },
    { text: "notes", sid: 17, to: "local" },
  ]);
  assert.strictEqual(h.held, 0);
});

test("a replay he pressed for is not parked by the mode, and the parked ones stay behind", () => {
  const { h, state, sent, tick, armed } = holdOf();
  state.notes = true;
  h.offer({ text: "a reply", to: "local" });
  h.offer({ text: "again", to: "remote", bypass: true });
  assert.deepStrictEqual(sent, [{ text: "again", to: "remote", bypass: true }], "the replay went straight out");
  assert.strictEqual(h.held, 1, "the parked reply is still waiting");
  assert.strictEqual(armed(), 0, "and the mode still arms nothing");
  tick(60_000);
  assert.strictEqual(h.held, 1);
});

test("a replay still waits for his voice, whatever the mode, and goes out when he stops", () => {
  const { h, state, sent, tick, armed } = holdOf();
  state.notes = true;
  state.mic = true;
  h.offer({ text: "a reply", to: "local" });
  h.offer({ text: "again", to: "remote", bypass: true });
  assert.strictEqual(armed(), 1, "the replay's own look-again timer");
  tick(1500);
  assert.deepStrictEqual(sent, [], "he is still talking");
  state.mic = false;
  h.heard();
  tick(1499);
  assert.deepStrictEqual(sent, [], "and for 1.5 s after he stops");
  tick(1);
  assert.deepStrictEqual(sent, [{ text: "again", to: "remote", bypass: true }]);
  assert.strictEqual(h.held, 1, "the mode still holds the reply he did not ask for");
  assert.strictEqual(armed(), 0, "nothing is armed once the replay is out");
});

test("at the cap the oldest ordinary item goes, never the one he asked for", () => {
  const { h, state, sent, lines, tick } = holdOf();
  state.mic = true;
  for (let i = 1; i <= 5; i++) h.offer({ text: String(i) });
  h.offer({ text: "keep", bypass: true }); // his own confirmation, or a play press
  for (let i = 6; i <= 19; i++) h.offer({ text: String(i) });
  assert.strictEqual(h.held, 20);
  h.offer({ text: "21" });
  assert.strictEqual(h.held, 20);
  assert.strictEqual(lines.length, 1, lines.join(" | "));
  state.mic = false;
  h.heard();
  tick(1500);
  assert.deepStrictEqual(
    sent.map((s) => s.text),
    ["keep", ...Array.from({ length: 18 }, (_, i) => String(i + 2)), "21"],
    "the oldest ordinary item is what was dropped, and the bypass item still leads",
  );

  // everything waiting is his own ask: then the head is the oldest and goes
  const all = holdOf();
  all.state.mic = true;
  for (let i = 1; i <= 21; i++) all.h.offer({ text: String(i), bypass: true });
  assert.strictEqual(all.h.held, 20);
  all.state.mic = false;
  all.h.heard();
  all.tick(1500);
  assert.deepStrictEqual(
    all.sent.map((s) => s.text),
    Array.from({ length: 20 }, (_, i) => String(i + 2)),
  );

  // and the cap is a cap: 30 offers still leave 20 waiting
  const many = holdOf();
  many.state.mic = true;
  for (let i = 1; i <= 30; i++) many.h.offer({ text: String(i) });
  assert.strictEqual(many.h.held, 20);
});
