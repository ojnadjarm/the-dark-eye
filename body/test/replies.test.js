/** The phone's reply ring: chunks in, one WAV out, long-poll, the ring and the TTL. */
const { test } = require("node:test");
const assert = require("node:assert");
const { createReplies, wavOf, EAGER_BYTES_ONE } = require("../src/replies");

const chunk = (id, seq, last, text, samples = [0, 0.5, -0.5]) => ({
  id,
  seq,
  last,
  text,
  sampleRate: 24000,
  samples: Float32Array.from(samples),
});

test("an utterance is published only when its last chunk lands", async () => {
  const r = createReplies();
  r.chunk(chunk(1, 0, false, "One sentence."));
  assert.equal(await r.poll(0, 20), null);
  r.chunk(chunk(1, 1, true, "And another."));
  const reply = await r.poll(0, 20);
  assert.equal(reply.seq, 1);
  assert.equal(reply.text, "One sentence. And another.");
  assert.match(reply.audio, /^\/remote\/audio\/[A-Za-z0-9_-]+\.wav$/);
});

test("the reply's audio is a mono 16-bit 24 kHz WAV of every chunk", async () => {
  const r = createReplies();
  r.chunk(chunk(1, 0, false, "a", [0, 1]));
  r.chunk(chunk(1, 1, true, "b", [-1, 0.5]));
  const id = (await r.poll(0, 20)).audio.match(/audio\/(.+)\.wav$/)[1];
  const w = r.wav(id);
  assert.equal(w.subarray(0, 4).toString(), "RIFF");
  assert.equal(w.subarray(8, 16).toString(), "WAVEfmt ");
  assert.equal(w.readUInt16LE(20), 1, "PCM");
  assert.equal(w.readUInt16LE(22), 1, "mono");
  assert.equal(w.readUInt32LE(24), 24000);
  assert.equal(w.readUInt32LE(28), 48000, "byte rate");
  assert.equal(w.readUInt16LE(32), 2, "block align");
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.subarray(36, 40).toString(), "data");
  assert.equal(w.readUInt32LE(40), 8);
  assert.equal(w.length, 52);
  assert.deepEqual([...new Int16Array(w.buffer, w.byteOffset + 44, 4)], [0, 32767, -32767, 16384]);
});

test("a full-scale sample never wraps round to the other end", () => {
  const w = wavOf([Float32Array.from([1, -1, 1.5, -1.5])], 16000);
  assert.deepEqual([...new Int16Array(w.buffer, w.byteOffset + 44, 4)], [32767, -32767, 32767, -32768]);
});

test("an utterance that produced no audio publishes nothing", async () => {
  const r = createReplies();
  r.chunk({ id: 1, last: true });
  assert.equal(await r.poll(0, 20), null);
});

test("poll answers the first reply after `since` and long-polls for the next", async () => {
  const r = createReplies();
  r.chunk(chunk(1, 0, true, "first"));
  r.chunk(chunk(2, 0, true, "second"));
  assert.equal((await r.poll(0, 20)).text, "first");
  assert.equal((await r.poll(1, 20)).text, "second");
  const waiting = r.poll(2, 2000);
  r.chunk(chunk(3, 0, true, "third"));
  assert.equal((await waiting).text, "third");
});

test("a poll with nothing to say ends at its timeout, not on a socket", async () => {
  const t0 = Date.now();
  assert.equal(await createReplies().poll(0, 60), null);
  assert.ok(Date.now() - t0 >= 55);
});

test("the ring is bounded and drops the oldest", async () => {
  const r = createReplies({ ring: 3 });
  for (let i = 1; i <= 5; i++) r.chunk(chunk(i, 0, true, `n${i}`));
  assert.equal((await r.poll(0, 20)).text, "n3", "the first two were dropped");
  assert.equal((await r.poll(4, 20)).text, "n5");
});

test("a reply he has heard, and its wav, are gone once they are 5 minutes old", async () => {
  let clock = 1_000_000;
  const r = createReplies({ now: () => clock });
  r.chunk(chunk(1, 0, true, "stale"));
  const id = (await r.poll(0, 20)).audio.match(/audio\/(.+)\.wav$/)[1];
  r.ack(1);
  clock += 299_000;
  assert.ok(r.wav(id));
  clock += 2_000;
  assert.equal(r.wav(id), null);
  assert.equal(await r.poll(0, 20), null);
});

test("a held reply he has not played is still there, and still playable, hours later", async () => {
  let clock = 1_000_000;
  const r = createReplies({ now: () => clock });
  const seq = r.text("the kettle is on"); // parked in audio notes mode: his \u25b6 is all there is
  r.attach(seq, [Float32Array.from([0, 0.5])], 24000);
  const id = (await r.poll(0, 20)).audio.match(/audio\/(.+)\.wav$/)[1];
  clock += 4 * 3600_000;
  assert.equal(r.find(seq), "the kettle is on", "the tray dropped a reply he never heard");
  assert.ok(r.wav(id), "its voice went with it");
  assert.equal(r.cursor(), seq);
  assert.equal(r.repeat(seq), true, "his \u25b6 on an hours-old note was refused");
});

test("an unknown wav id is null, not a throw", () => {
  assert.equal(createReplies().wav("nope"), null);
});

test("the cursor is where a fresh page starts, so it is not sent the backlog", async () => {
  const r = createReplies();
  assert.equal(r.cursor(), 0, "nothing published yet");
  r.chunk(chunk(1, 0, true, "first"));
  r.chunk(chunk(2, 0, true, "second"));
  assert.equal(r.cursor(), 2);
  assert.equal(await r.poll(r.cursor(), 20), null, "the backlog is behind the cursor");
  r.chunk(chunk(3, 0, true, "third"));
  assert.equal((await r.poll(2, 20)).text, "third");
});

test("a cursor past a stale ring is 0", async () => {
  let t = 1000;
  const r = createReplies({ ttlMs: 100, now: () => t });
  r.chunk(chunk(1, 0, true, "old"));
  assert.equal(r.cursor(), 1);
  r.ack(1);
  t += 200;
  assert.equal(r.cursor(), 0);
});

test("an acked reply is never polled again, whatever since is asked for", async () => {
  const r = createReplies();
  r.chunk(chunk(1, 0, true, "first"));
  r.chunk(chunk(2, 0, true, "second"));
  r.ack(1);
  assert.equal((await r.poll(0, 20)).text, "second");
  r.ack(2);
  assert.equal(await r.poll(0, 20), null, "both have been heard");
});

test("acking an unknown seq changes nothing", async () => {
  const r = createReplies();
  r.chunk(chunk(1, 0, true, "first"));
  r.ack(99);
  assert.equal((await r.poll(0, 20)).text, "first");
});

test("an acked reply's wav is still served — the page may still be playing it", async () => {
  const r = createReplies();
  r.chunk(chunk(1, 0, true, "first"));
  const id = (await r.poll(0, 20)).audio.match(/audio\/(.+)\.wav$/)[1];
  r.ack(1);
  assert.ok(r.wav(id), "the audio outlives the ack");
});

test("an ack does not move the cursor or hide a partial", async () => {
  const r = createReplies();
  r.chunk(chunk(1, 0, true, "first"));
  r.ack(1);
  assert.equal(r.cursor(), 1);
  r.partial("u1", "still talking");
  assert.equal((await r.poll(0, 20)).partial, "still talking");
});

// -- his own words, growing on the same long-poll ---------------------------

test("a partial wakes the poll the page already has open", async () => {
  const r = createReplies();
  const waiting = r.poll(0, 200);
  r.partial("u1", "one two");
  assert.deepEqual(await waiting, { seq: 1, utt: "u1", partial: "one two" });
});

test("a later poll gets the newest partial, not the one it already showed", async () => {
  const r = createReplies();
  r.partial("u1", "one");
  r.partial("u1", "one two");
  const got = await r.poll(1, 20);
  assert.deepEqual(got, { seq: 2, utt: "u1", partial: "one two" });
  assert.equal(await r.poll(2, 20), null, "nothing new to say");
});

test("a partial and a reply keep their order on the one seq line", async () => {
  const r = createReplies();
  r.partial("u1", "one");
  r.chunk(chunk(1, 0, true, "the answer"));
  assert.equal((await r.poll(0, 20)).partial, "one");
  assert.equal((await r.poll(1, 20)).text, "the answer");
});

test("clearing the partial ends the growing line: the final transcript takes over", async () => {
  const r = createReplies();
  r.partial("u1", "one two");
  r.partial("u1", null);
  assert.equal(await r.poll(0, 20), null);
});

// -- the roster, on the same long-poll ---------------------------------------

const roster = (active, mode = "call") => ({ active, mode, brains: [{ name: "main", color: "#b04dff" }, { name: "notes", color: "#4dd9ff" }] });

test("a switch wakes the poll the page already has open with the roster", async () => {
  const r = createReplies();
  const waiting = r.poll(0, 200);
  r.brains(roster("notes"));
  assert.deepEqual(await waiting, { seq: 1, ...roster("notes") });
});

test("the roster lane carries the mode, so the page redraws its caption from it", async () => {
  const r = createReplies();
  r.brains(roster("main", "notes"));
  assert.equal((await r.poll(0, 20)).mode, "notes");
});

test("a mode change publishes one item on the lane, not a second lane", async () => {
  const r = createReplies();
  r.brains(roster("main", "call"));
  r.brains(roster("main", "notes"));
  const first = await r.poll(0, 20);
  assert.equal(first.mode, "notes", "the newest roster replaced the last, as one lane must");
  assert.equal(await r.poll(first.seq, 20), null, "a mode change left more than one item behind");
});

test("a page behind on the seq line gets the roster before the next reply", async () => {
  const r = createReplies();
  r.brains(roster("notes"));
  r.chunk(chunk(1, 0, true, "the answer"));
  assert.equal((await r.poll(0, 20)).active, "notes");
  assert.equal((await r.poll(1, 20)).text, "the answer");
  assert.equal(r.cursor(), 2, "the cursor counts replies, not rosters");
});

test("a text-only reply polls through with no audio, sits on the ring and takes an ack", async () => {
  const r = createReplies();
  r.text("Shown, not said.");
  const reply = await r.poll(0, 20);
  assert.deepEqual(reply, { seq: 1, text: "Shown, not said." });
  assert.equal(r.cursor(), 1);
  r.ack(1);
  assert.equal(await r.poll(0, 20), null);
});

test("a text-only reply and a spoken one keep their order on the one seq line", async () => {
  const r = createReplies();
  r.text("first");
  r.chunk(chunk(1, 0, true, "second"));
  assert.equal((await r.poll(0, 20)).text, "first");
  const spoken = await r.poll(1, 20);
  assert.equal(spoken.text, "second");
  assert.match(spoken.audio, /\.wav$/);
});

test("only the newest roster is ever served, and never twice", async () => {
  const r = createReplies();
  r.brains(roster("notes"));
  r.brains(roster("main"));
  const got = await r.poll(0, 20);
  assert.equal(got.seq, 2);
  assert.equal(got.active, "main");
  assert.equal(await r.poll(2, 20), null);
});

test("find is the words behind a reply the ring still holds, and null for anything else", async () => {
  let clock = 0;
  const r = createReplies({ now: () => clock });
  r.text("the kettle is on"); // a quiet-mode reply: no audio ever made
  r.chunk(chunk(1, 0, true, "and the toast"));
  assert.equal(r.find(1), "the kettle is on");
  assert.equal(r.find(2), "and the toast");
  assert.equal(r.find(99), null, "a seq the page made up");
  assert.equal(r.find(0), null);
  r.ack(1);
  assert.equal(r.find(1), "the kettle is on", "played is not gone — he may ask for it again");
  clock = 300_001;
  assert.equal(r.find(1), null, "past the TTL the ring is the authority: nothing to say again");
});

test("the eager voice goes onto the reply already on the ring, not onto a second one", async () => {
  const r = createReplies();
  const seq = r.text("the kettle is on");
  assert.equal((await r.poll(0, 20)).audio, undefined, "the words went out before the voice existed");
  assert.equal(r.attach(seq, [Float32Array.from([0, 0.5, -0.5])], 24000), true);
  const item = await r.poll(seq - 1, 20);
  assert.equal(item.seq, seq, "the voice made a second item");
  assert.match(item.audio, /^\/remote\/audio\/[A-Za-z0-9_-]+\.wav$/);
  assert.equal(r.wav(item.audio.match(/audio\/(.+)\.wav$/)[1]).length, 50);
  assert.equal(r.attach(seq, [Float32Array.from([1])], 24000), false, "a second voice for the same reply");
  assert.equal(r.attach(seq + 99, [Float32Array.from([1])], 24000), false, "a seq the ring never had");
});

test("his press on a made voice publishes those same bytes, with no synthesis", async () => {
  const r = createReplies();
  const seq = r.text("the kettle is on");
  r.attach(seq, [Float32Array.from([0, 0.5, -0.5])], 24000);
  const held = r.wav((await r.poll(seq - 1, 20)).audio.match(/audio\/(.+)\.wav$/)[1]);
  assert.equal(r.repeat(seq), true);
  const answer = await r.poll(seq, 20);
  assert.equal(answer.seq, seq + 1, "the answer to his press is its own item");
  assert.equal(answer.text, "the kettle is on");
  assert.deepEqual(r.wav(answer.audio.match(/audio\/(.+)\.wav$/)[1]), held, "the press did not play the bytes that were held");
  assert.equal(r.repeat(seq + 99), false, "a seq the ring never had");
});

test("his press marks the reply heard, so the tray never offers it a second time", async () => {
  const r = createReplies();
  const seq = r.text("the kettle is on");
  r.attach(seq, [Float32Array.from([0, 0.5, -0.5])], 24000);
  assert.equal(r.repeat(seq), true);
  const got = await r.poll(0, 20); // a page reading the tray from the beginning
  assert.equal(got.seq, seq + 1, "the pressed reply was offered again, as if he had never heard it");
});

test("a press on a reply with no voice behind it is not a replay of nothing", async () => {
  const r = createReplies();
  const seq = r.text("the kettle is on");
  assert.equal(r.repeat(seq), false);
  assert.equal(await r.poll(seq, 20), null, "a reply with no bytes published an answer anyway");
});

test("a reply whose voice is past the per-reply cap keeps its words and gets no bytes", async () => {
  const r = createReplies({ bytesOne: 1000 });
  const seq = r.text("far too long to hold");
  assert.equal(r.attach(seq, [new Float32Array(600)], 24000), false);
  const item = await r.poll(0, 20);
  assert.equal(item.text, "far too long to hold", "the words went with the bytes");
  assert.equal(item.audio, undefined);
  assert.equal(r.find(seq), "far too long to hold", "so his press can still ask for it");
});

test("past the total budget the oldest unheard audio goes and its words, line and \u25b6 stay", async () => {
  const r = createReplies({ bytesMax: 300 });
  const seqs = [1, 2, 3].map((n) => r.text(`note ${n}`));
  for (const seq of seqs) assert.equal(r.attach(seq, [new Float32Array(50)], 24000), true);
  const shapes = await Promise.all(seqs.map((seq) => r.poll(seq - 1, 20)));
  assert.deepEqual(
    shapes.map((it) => !!it.audio),
    [false, true, true],
    "the oldest unheard audio was not the one dropped"
  );
  assert.deepEqual(
    shapes.map((it) => it.text),
    ["note 1", "note 2", "note 3"],
    "dropping the bytes took the words with them"
  );
  assert.equal(r.find(seqs[0]), "note 1", "its \u25b6 has nothing to ask for");
  assert.equal(r.repeat(seqs[0]), false, "it played bytes that were dropped");
});

test("the budget never drops the bytes his press is fetching right now", async () => {
  const r = createReplies({ bytesMax: 400 }); // three 144-byte replies do not fit
  const first = r.text("note 1");
  r.attach(first, [new Float32Array(50)], 24000);
  assert.equal(r.repeat(first), true);
  const id = (await r.poll(first, 20)).audio.match(/audio\/(.+)\.wav$/)[1]; // published for his press, not played yet
  const rest = [2, 3].map((n) => r.text(`note ${n}`));
  for (const seq of rest) r.attach(seq, [new Float32Array(50)], 24000);
  assert.ok(r.wav(id), "the budget took the bytes out from under a live press — his \u25b6 would 404");
  const shapes = await Promise.all(rest.map((seq) => r.poll(seq - 1, 20)));
  assert.deepEqual(
    shapes.map((it) => !!it.audio),
    [false, true],
    "the oldest unheard audio was not what went for the press's sake"
  );
});

test("his press republishes the same bytes, and the budget counts them once", async () => {
  const r = createReplies({ bytesMax: 300 }); // two 144-byte replies fit; a press's copy is not a third
  const first = r.text("note 1");
  r.attach(first, [new Float32Array(50)], 24000);
  assert.equal(r.repeat(first), true);
  const id = (await r.poll(first, 20)).audio.match(/audio\/(.+)\.wav$/)[1];
  const second = r.text("note 2");
  assert.equal(r.attach(second, [new Float32Array(50)], 24000), true, "the press's own copy cost a reply its voice");
  assert.ok(r.wav(id), "the press's bytes went for a budget they were counted in twice");
  assert.equal(r.repeat(first), true, "the reply's own bytes went: the same Buffer was charged twice");
});

test("past the budget the audio he has heard goes before the audio he has not", async () => {
  const r = createReplies({ bytesMax: 150 });
  const heard = r.text("note 1");
  r.attach(heard, [new Float32Array(50)], 24000);
  r.ack(heard); // he has heard it: its bytes are the TTL's, not his \u25b6's
  const fresh = r.text("note 2");
  assert.equal(r.attach(fresh, [new Float32Array(50)], 24000), true, "a reply he has not heard was refused its voice");
  assert.equal(r.repeat(heard), false, "audio he had already heard outlived the budget");
  assert.equal(r.find(heard), "note 1", "dropping the bytes took the words with them");
});

test("the caps are the plan's: 4 MB a reply", () => {
  assert.equal(EAGER_BYTES_ONE, 4 * 1024 * 1024);
});

test("a reply whose voice is still being made is pending, and is told once when it is his to press", async () => {
  const r = createReplies();
  const plain = r.text("no voice is coming for this one");
  assert.equal((await r.poll(0, 20)).pending, undefined, "a reply nobody is making was drawn without its ▶");
  const n = r.text("his voice is on the way", true);
  const parked = await r.poll(plain, 20);
  assert.equal(parked.seq, n);
  assert.equal(parked.pending, true);
  r.ack(n); // a words-only reply is acked the moment the page draws it
  assert.equal(await r.poll(n, 20), null);
  r.ready(n);
  assert.deepEqual(await r.poll(n, 20), { seq: n + 1, ready: n }, "the notice never reached an acked reply");
  r.ready(n);
  assert.equal(await r.poll(n + 1, 20), null, "the page was told twice about one reply");
});
