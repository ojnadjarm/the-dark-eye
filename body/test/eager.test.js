/**
 * eager.js — the voice of a parked reply, made while it waits. One job in
 * flight, nothing started while the mouth is busy or the box is loaded, no
 * timer left behind, and the bytes never leave the ring.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const { createEager, BYTES_ONE, BYTES_PER_WORD } = require("../src/eager");
const { createBrains } = require("../src/brains");
const { createHold } = require("../src/hold");
const { createReplies } = require("../src/replies");

const tone = (n = 24) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 4) * 0.3);

/** An eager on a fake clock: `tick(ms)` advances it and fires what is due. */
function eagerOf(opts = {}) {
  let now = 0;
  const due = [];
  const spoken = [];
  const held = [];
  const lines = [];
  const timers = {
    setTimeout: (f, ms) => (due.push({ at: now + ms, f }), due[due.length - 1]),
    clearTimeout: (t) => t && due.splice(due.indexOf(t), 1),
  };
  const state = { idle: true, load: 0.9 };
  const e = createEager({
    speak: (m) => spoken.push(m),
    attach: (seq, parts, rate) => (held.push({ seq, samples: parts.reduce((n, p) => n + p.length, 0), rate }), true),
    idle: () => state.idle,
    load1: () => state.load,
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
  /** The worker answering the job it was given: one chunk a sentence, `last` on the final one. */
  const say = (job, sentences = 1) => {
    for (let i = 0; i < sentences; i++)
      e.chunk({ type: "audio", id: job.id, seq: i, last: i === sentences - 1, sampleRate: 24000, samples: tone() });
  };
  return { e, state, spoken, held, lines, tick, say, armed: () => due.length };
}

test("nothing is synthesised, and no timer armed, until a reply is parked", () => {
  const { spoken, armed } = eagerOf();
  assert.deepEqual(spoken, [], "a boot made a voice nobody asked for");
  assert.equal(armed(), 0, "a timer at idle: the eager queue is resident");
});

test("a parked reply is made once, and its bytes go onto the ring item it already has", () => {
  const { e, spoken, held, say } = eagerOf();
  assert.equal(e.queue(7, "the kettle is on", 17), true);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, "the kettle is on");
  assert.equal(spoken[0].sid, 17, "the reply was made in another channel's voice");
  say(spoken[0], 2);
  assert.deepEqual(held, [{ seq: 7, samples: 48, rate: 24000 }]);
  assert.equal(spoken.length, 1, "the one reply was synthesised twice");
  assert.equal(e.waiting, 0);
});

test("two replies landing together are made one at a time, never two", () => {
  const { e, spoken, held, say } = eagerOf();
  e.queue(1, "first note");
  e.queue(2, "second note");
  assert.equal(spoken.length, 1, "both jobs went to the worker at once");
  assert.equal(e.waiting, 1);
  say(spoken[0]);
  assert.equal(spoken.length, 2);
  say(spoken[1]);
  assert.deepEqual(
    held.map((h) => h.seq),
    [1, 2]
  );
});

test("nothing is started while the mouth has something of his to say, and the queue drains when it is idle", () => {
  const { e, state, spoken, armed, tick, say, held } = eagerOf();
  state.idle = false;
  e.queue(4, "a note");
  assert.deepEqual(spoken, [], "eager work was queued behind his own voice");
  assert.equal(armed(), 1, "nothing will ever look again");
  tick(5000);
  assert.deepEqual(spoken, [], "it started while the mouth was busy");
  state.idle = true;
  tick(5000);
  assert.equal(spoken.length, 1);
  say(spoken[0]);
  assert.deepEqual(held.map((h) => h.seq), [4]);
  assert.equal(armed(), 0, "the timer outlived the queue");
});

test("the load guard holds the queue and releases it, and leaves no timer behind", () => {
  const { e, state, spoken, armed, tick, say } = eagerOf();
  state.load = 8.1;
  e.queue(9, "a note");
  assert.deepEqual(spoken, [], "a loaded box was given more Kokoro");
  assert.equal(armed(), 1);
  tick(5000);
  assert.deepEqual(spoken, [], "the guard released at the same load");
  state.load = 7.9;
  tick(5000);
  assert.equal(spoken.length, 1);
  assert.equal(armed(), 0, "the re-check timer is still resident with an empty queue");
  say(spoken[0]);
  assert.equal(armed(), 0);
});

test("one re-check timer while a job waits, not one a reply", () => {
  const { e, state, armed } = eagerOf();
  state.idle = false;
  for (const seq of [1, 2, 3]) e.queue(seq, "a note");
  assert.equal(armed(), 1);
});

/**
 * main.js's own park path, with the real `hold.js` and nothing stubbed: the words
 * are published, the voice asked for, and the utterance parked in the hold, which
 * in audio notes mode holds it until his `heard()` — however many days later.
 */
function parkedBody() {
  let now = 0;
  const due = [];
  const spoken = [];
  const held = [];
  const room = [];
  const timers = {
    setTimeout: (f, ms) => (due.push({ at: now + ms, f }), due[due.length - 1]),
    clearTimeout: (t) => t && due.splice(due.indexOf(t), 1),
  };
  const state = { busy: false }; // his mic, or a phone utterance in flight
  const hold = createHold({
    send: (item) => room.push(item.text),
    parked: () => true,
    busy: () => state.busy,
    now: () => now,
    timers,
  });
  const e = createEager({
    speak: (m) => spoken.push(m),
    attach: (seq) => (held.push(seq), true),
    // main.js's `holdSpeaking()` in audio notes mode: a parked item is not the mouth's
    idle: () => !hold.list().some((item) => item.bypass),
    load1: () => 0.9,
    timers,
  });
  const park = (seq, text) => {
    e.queue(seq, text, 17);
    hold.offer({ text, sid: 17, to: "local" });
  };
  const tick = (ms) => {
    now += ms;
    for (const t of due.filter((t) => t.at <= now)) {
      due.splice(due.indexOf(t), 1);
      t.f();
    }
  };
  const say = (job) => e.chunk({ type: "audio", id: job.id, seq: 0, last: true, sampleRate: 24000, samples: tone() });
  return { e, hold, state, park, spoken, held, room, tick, say, armed: () => due.length };
}

test("every parked reply gets its voice made, not only the first, and no timer is left behind", () => {
  const b = parkedBody();
  b.park(1, "first reply");
  b.park(2, "second reply");
  b.park(3, "third reply");
  assert.equal(b.spoken.length, 1, "two jobs went to the worker at once");
  for (let i = 0; i < 3; i++) {
    assert.equal(b.spoken.length, i + 1, `the reply parked behind ${i} others was never made`);
    b.say(b.spoken[i]);
  }
  assert.deepEqual(b.held, [1, 2, 3], "a parked reply was left without the voice his \u25b6 needs");
  assert.equal(b.e.waiting, 0);
  assert.equal(b.armed(), 0, "a 5 s re-check timer is resident in the mode he lives in");
  assert.equal(b.hold.held, 3, "the mouth took a reply the mode parked");
  assert.deepEqual(b.room, [], "a parked reply was spoken into the room");
});

test("a replay waiting to be said is what stops the eager queue, and it starts again after it", () => {
  const b = parkedBody();
  b.park(1, "a note");
  b.say(b.spoken[0]);
  b.state.busy = true; // his mic is open, so his \u25b6 waits in the hold instead of going out
  b.hold.offer({ text: "a note", sid: 17, to: "remote", bypass: true });
  b.park(2, "another note");
  assert.equal(b.spoken.length, 1, "eager work was started over the reply he asked for");
  assert.equal(b.e.waiting, 1);
  b.tick(5000);
  assert.equal(b.spoken.length, 1, "the re-check started it while his own \u25b6 was still waiting");
  b.state.busy = false;
  b.hold.heard();
  b.tick(1500); // the hold says what he asked for, and the queue is the mouth's again
  assert.deepEqual(b.room, ["a note"], "his \u25b6 was not what the mouth said first");
  b.tick(5000);
  assert.equal(b.spoken.length, 2);
  b.say(b.spoken[1]);
  assert.deepEqual(b.held, [1, 2]);
  assert.equal(b.armed(), 0, "the timer outlived the queue");
});

test("a reply with no seq or no words is never made: there is nothing to put the bytes on", () => {
  const { e, spoken } = eagerOf();
  assert.equal(e.queue(0, "no ring item under it"), false, "it made a voice for a reply that is not on the ring");
  assert.equal(e.queue(null, "no ring item under it"), false);
  assert.equal(e.queue(7, ""), false, "it asked Kokoro for silence");
  assert.deepEqual(spoken, []);
  assert.equal(e.waiting, 0);
});

test("the sample rate is the one the first chunk carried, not whatever the last one left out", () => {
  const { e, spoken, held } = eagerOf();
  e.queue(1, "two sentences");
  e.chunk({ type: "audio", id: spoken[0].id, seq: 0, last: false, sampleRate: 24000, samples: tone() });
  e.chunk({ type: "audio", id: spoken[0].id, seq: 1, last: true, samples: tone() }); // no rate on the last message
  assert.deepEqual(held, [{ seq: 1, samples: 48, rate: 24000 }], "the bytes were held at a rate that is not his voice");
});

test("the load guard is the cap itself, not past it: at exactly the cap the queue still runs", () => {
  const { e, state, spoken } = eagerOf({ loadMax: 8 });
  state.load = 8;
  e.queue(1, "a note");
  assert.equal(spoken.length, 1, "a box at the cap was treated as a loaded box");
});

test("a reply too long to hold is never made eagerly — its press synthesises instead", () => {
  const { e, spoken, lines } = eagerOf();
  const words = Math.ceil(BYTES_ONE / BYTES_PER_WORD) + 1;
  assert.equal(e.queue(3, "word ".repeat(words)), false);
  assert.deepEqual(spoken, []);
  assert.match(lines.join(" "), /too long/);
  assert.equal(e.queue(4, "word ".repeat(words - 2)), true, "a reply inside the cap was refused");
});

test("the eager queue is bounded and drops the oldest waiting job, not the newest", () => {
  const { e, state, spoken } = eagerOf({ max: 2 });
  state.idle = false;
  for (const seq of [1, 2, 3]) e.queue(seq, `note ${seq}`);
  state.idle = true;
  e.queue(4, "note 4");
  assert.equal(spoken[0].text, "note 3", "the reply he just received was thrown away");
});

test("a press while the job runs waits on that one run — never a second", () => {
  const { e, spoken, held, say } = eagerOf();
  e.queue(5, "the kettle is on");
  const answers = [];
  assert.equal(e.press(5, (ok) => answers.push(ok)), true);
  assert.deepEqual(answers, [], "the press was answered before the voice existed");
  assert.equal(spoken.length, 1, "the press started the work again");
  say(spoken[0]);
  assert.deepEqual(answers, [true]);
  assert.equal(held.length, 1, "one press, one synthesis");
});

test("a press on a job still waiting takes it out of the queue, so the throttle never holds him", () => {
  const { e, state, spoken, armed } = eagerOf();
  state.idle = false;
  e.queue(6, "a note");
  assert.equal(armed(), 1);
  assert.equal(e.press(6, () => assert.fail("a job that never started answered a press")), false);
  assert.equal(e.waiting, 0, "the press left the job to run as well");
  assert.equal(armed(), 0, "the re-check timer outlived the queue the press emptied");
  state.idle = true;
  assert.deepEqual(spoken, []);
});

test("a press on a reply nobody is making is not this queue's business", () => {
  const { e, spoken, say } = eagerOf();
  assert.equal(e.press(99, () => assert.fail("it answered for a job it never had")), false);
  e.queue(1, "a note");
  assert.equal(e.press(99, () => assert.fail("another reply's job answered his press")), false);
  say(spoken[0]);
});

test("a press is told when the voice could not be held, so it can synthesise instead", () => {
  const { e, spoken, say } = eagerOf({ attach: () => false });
  e.queue(8, "a note");
  const answers = [];
  e.press(8, (ok) => answers.push(ok));
  say(spoken[0]);
  assert.deepEqual(answers, [false]);
});

test("an utterance the worker could not speak holds no bytes and does not block the queue", () => {
  const { e, spoken, held, say } = eagerOf();
  e.queue(1, "a note");
  e.queue(2, "another");
  e.chunk({ type: "err", id: spoken[0].id, seq: 0, last: true, text: "a note", message: "kokoro said no" });
  assert.deepEqual(held, [], "a failed utterance put bytes on the ring");
  assert.equal(spoken.length, 2, "the queue stopped at the failure");
  say(spoken[1]);
  assert.deepEqual(held.map((h) => h.seq), [2]);
});

test("a message of anyone else's is not the eager job's: the caller routes it as it always did", () => {
  const { e, spoken } = eagerOf();
  e.queue(1, "a note");
  assert.equal(e.chunk({ type: "audio", id: 42, last: true, samples: tone() }), false, "it swallowed the room's own voice");
  assert.equal(e.chunk({ type: "audio", id: spoken[0].id, last: false, sampleRate: 24000, samples: tone() }), true);
  assert.equal(e.jobId(), spoken[0].id, "a barge-in cannot tell which utterance to leave alone");
});

test("the job in flight is named, and no job means nothing to leave alone", () => {
  const { e, spoken, say } = eagerOf();
  assert.equal(e.jobId(), null);
  e.queue(1, "a note");
  assert.equal(e.jobId(), spoken[0].id);
  say(spoken[0]);
  assert.equal(e.jobId(), null);
});

test("only the active channel's replies are ever made: a channel he is not on holds text alone", () => {
  const { e, spoken } = eagerOf();
  const replies = createReplies();
  const brains = createBrains({
    channels: { main: {}, other: {} },
    // main.js's own wiring: a parked reply publishes its words and asks for its voice
    say: (text, sid) => e.queue(replies.text(text), text, sid),
    file: "/nonexistent/dark-eye-eager-test/active.json",
  });
  brains.speak("other", "not his channel", 20, "remote");
  assert.deepEqual(spoken, [], "a channel he is not on was given a voice");
  brains.speak("main", "his channel", 17, "remote");
  assert.deepEqual(
    spoken.map((m) => m.text),
    ["his channel"]
  );
});

test("the voice worker dying takes the queue with it, and every press is told to synthesise", () => {
  const { e, state, spoken, held, armed } = eagerOf();
  e.queue(1, "a note");
  state.idle = false;
  e.queue(2, "another");
  const answers = [];
  e.press(1, (ok) => answers.push(ok));
  e.lost();
  assert.deepEqual(answers, [false], "the press was left waiting on a worker that is gone");
  assert.equal(e.waiting, 0, "work was left queued for a dead worker");
  assert.equal(armed(), 0, "the re-check timer outlived the worker");
  assert.equal(e.jobId(), null);
  assert.equal(spoken.length, 1, "it spoke to the worker that had just died");
  assert.deepEqual(held, []);
  // a queue only the re-check timer was watching goes the same way
  e.queue(4, "waiting on the load");
  assert.equal(armed(), 1);
  e.lost();
  assert.equal(armed(), 0, "the re-check timer outlived the worker it was waiting for");
  assert.equal(e.waiting, 0);
  // and the next reply parked after the respawn is made like any other
  state.idle = true;
  e.queue(3, "after the respawn");
  assert.equal(spoken.length, 2);
  e.lost();
});

test("every reply eager takes is settled once — with bytes, refused, dropped or lost", () => {
  const seen = [];
  const { e, state, spoken, say } = eagerOf({ settled: (seq, ok) => seen.push([seq, ok]), max: 2 });
  assert.equal(e.queue(1, "the kettle is on"), true);
  assert.deepEqual(seen, [], "the reply was settled before its voice was made");
  say(spoken[0]);
  assert.deepEqual(seen, [[1, true]]);
  // too long to hold: nothing is ever made for it, so it is his to press at once
  assert.equal(e.queue(2, "word ".repeat(Math.ceil(BYTES_ONE / BYTES_PER_WORD) + 1)), false);
  assert.deepEqual(seen.at(-1), [2, false]);
  state.idle = false;
  e.queue(3, "three");
  e.queue(4, "four");
  e.queue(5, "five");
  assert.deepEqual(seen.at(-1), [3, false], "the reply dropped for a newer one waits for a voice for ever");
  e.lost();
  assert.deepEqual(seen.slice(-2), [
    [4, false],
    [5, false],
  ]);
});

test("a reply the worker answered with no bytes is settled too: its press synthesises", () => {
  const seen = [];
  const { e, spoken } = eagerOf({ settled: (seq, ok) => seen.push([seq, ok]) });
  e.queue(9, "a note");
  e.chunk({ type: "audio", id: spoken[0].id, seq: 0, last: true, sampleRate: 24000, samples: new Float32Array(0) });
  assert.deepEqual(seen, [[9, false]]);
});

test("the page draws no ▶ until the voice is in hand: pending on the lane, then a ready of its own", async () => {
  const replies = createReplies();
  // main.js's own wiring: the words are published as pending and eager answers when it is done
  const { e, spoken, say } = eagerOf({
    attach: (seq, parts, rate) => replies.attach(seq, parts, rate),
    settled: (seq) => replies.ready(seq),
  });
  const n = replies.text("the kettle is on", true);
  e.queue(n, "the kettle is on", 17);
  const first = await replies.poll(0, 20);
  assert.equal(first.seq, n);
  assert.equal(first.pending, true, "a ▶ was offered before the audio existed");
  assert.equal(await replies.poll(n, 20), null, "the ▶ went up before the voice landed");
  say(spoken[0]);
  const note = await replies.poll(n, 20);
  assert.equal(note.ready, n, "the line was never told its ▶ may go up");
  assert.ok(note.seq > n, "the notice took the reply's own seq instead of a new one");
  assert.equal(replies.repeat(n), true, "the press found no bytes after all it was told");
});
