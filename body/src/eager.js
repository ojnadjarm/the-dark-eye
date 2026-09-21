/**
 * The voice of a parked reply, made while it waits: in audio notes mode his ▶
 * must stream bytes that already exist, not start the work. One job in flight,
 * started only while the mouth is idle and the box is not loaded, and no timer
 * at all once the queue is empty — nothing here is resident.
 */
const os = require("node:os");

const MAX = 20; // the ring's own bound
const CHECK_MS = 5000;
const LOAD_MAX = 8; // half of this box's threads: past that Kokoro is slower than real time
const BYTES_ONE = 4 * 1024 * 1024;
const BYTES_PER_WORD = 19_200; // 0.4 s a word, 24 kHz 16-bit mono

/**
 * `idle()` is the caller's "the mouth has something of *his* to say": a reply parked
 * for his ▶ is not that — it waits for a press, competes with nothing, and must not
 * hold back the voice it is waiting for (T2-fix; counting it was what left every reply
 * after the first without a voice).
 *
 * `{queue, chunk, press, jobId}`. `queue(seq, text, sid)` asks for the voice of the
 * reply already on the ring at `seq`; `chunk(m)` takes a voice worker message and
 * answers whether it belonged to an eager job, so the caller routes it nowhere else —
 * these bytes never reach the room and never make a second line. `press(seq, done)`
 * is his ▶ arriving mid-job: `done(ok)` fires when that one run finishes, and a job
 * still waiting in the queue is given up so the press is never held by the throttle.
 * `jobId()` is the worker id of the run in flight, which a barge-in leaves alone, and
 * `lost()` is that worker dying: the queue goes with it and every press is told to synthesise.
 *
 * `settled(seq, ok)` fires exactly once for every seq eager took, the moment that reply
 * stops being eager's — with its bytes attached, refused, dropped or lost. It is what tells
 * the page a ▶ may go up: until then the reply has a voice on the way and no press to make.
 */
function createEager({
  speak,
  attach,
  settled = () => {},
  idle = () => true,
  max = MAX,
  checkMs = CHECK_MS,
  loadMax = LOAD_MAX,
  bytesOne = BYTES_ONE,
  load1 = () => os.loadavg()[0],
  timers = { setTimeout, clearTimeout },
  log = () => {},
} = {}) {
  const queue = [];
  let job = null; // {seq, text, sid, id, parts, rate, waiters}
  let ids = 0;
  let timer = null;

  const words = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

  /** The one timer, and only while something waits: it is cleared the moment the queue empties. */
  function later() {
    if (!timer) timer = timers.setTimeout(() => ((timer = null), pump()), checkMs);
  }

  function pump() {
    if (job) return;
    if (!queue.length) {
      if (timer) timers.clearTimeout(timer);
      timer = null;
      return;
    }
    if (!idle() || load1() > loadMax) return void later();
    job = { ...queue.shift(), id: `eager-${++ids}`, parts: [], rate: 0, waiters: [] };
    log(`eager ${job.seq}: making the voice`);
    speak({ id: job.id, text: job.text, sid: job.sid });
  }

  return {
    queue(seq, text, sid) {
      if (!seq || !text) return false;
      if (words(text) * BYTES_PER_WORD > bytesOne) {
        log(`eager ${seq}: too long to hold — the press will synthesise`);
        settled(seq, false);
        return false;
      }
      // the reply he just received is the one he presses
      if (queue.length >= max) settled(queue.shift().seq, false);
      queue.push({ seq, text, sid });
      pump();
      return true;
    },

    chunk(m) {
      if (!job || m.id !== job.id) return false;
      if (m.samples?.length) {
        job.parts.push(m.samples);
        job.rate ||= m.sampleRate;
      }
      if (!m.last) return true;
      const done = job;
      job = null;
      const ok = done.parts.length ? attach(done.seq, done.parts, done.rate) : false;
      log(`eager ${done.seq}: ${ok ? "ready" : "no bytes held"}`);
      settled(done.seq, ok);
      for (const w of done.waiters) w(ok);
      pump();
      return true;
    },

    press(seq, done) {
      if (job?.seq === seq) {
        job.waiters.push(done);
        return true;
      }
      const i = queue.findIndex((q) => q.seq === seq);
      if (i >= 0) {
        queue.splice(i, 1);
        pump(); // the queue may be empty now: the re-check timer goes with it
      }
      return false;
    },

    /**
     * The voice worker died: whatever it was making is gone and nothing waiting can be
     * sent to it, so the queue goes with it and every press waiting is told to synthesise.
     * The words are untouched — they are on the ring, and a reply parked after the
     * respawn asks for its voice like any other.
     */
    lost() {
      const done = job;
      job = null;
      const dropped = queue.splice(0);
      if (done) settled(done.seq, false);
      for (const q of dropped) settled(q.seq, false);
      if (timer) timers.clearTimeout(timer);
      timer = null;
      for (const w of done?.waiters ?? []) w(false);
    },

    jobId() {
      return job?.id ?? null;
    },

    /** What waits, for a test and for the log: the run in flight is not in it. */
    get waiting() {
      return queue.length;
    },
  };
}

module.exports = { createEager, MAX, CHECK_MS, LOAD_MAX, BYTES_ONE, BYTES_PER_WORD };
