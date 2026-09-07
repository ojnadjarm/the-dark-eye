/** The phone's reply ring: chunks in, one WAV out, long-poll, the ring and the TTL. */
const { test } = require("node:test");
const assert = require("node:assert");
const { createReplies, wavOf } = require("../src/replies");

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

test("a reply and its wav are gone once they are 5 minutes old", async () => {
  let clock = 1_000_000;
  const r = createReplies({ now: () => clock });
  r.chunk(chunk(1, 0, true, "stale"));
  const id = (await r.poll(0, 20)).audio.match(/audio\/(.+)\.wav$/)[1];
  clock += 299_000;
  assert.ok(r.wav(id));
  clock += 2_000;
  assert.equal(r.wav(id), null);
  assert.equal(await r.poll(0, 20), null);
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
