/**
 * Speech and mic through PipeWire children — the only audio path since E19:
 * one `pw-cat -p` per utterance, one `pw-cat -r` while push-to-talk is down.
 * The mic is whatever the default source is, which is what the PTT sidecar
 * switches; the voice follows the media the owner is listening to (E23).
 */
const { spawn: nodeSpawn, execFileSync } = require("node:child_process");

const BIN = "pw-cat";
const CAPTURE_RATE = 16000;
/** Grace after the audio already handed over before an utterance is called dead. */
const IDLE_MS = 3000;
const MAX_PENDING = 8_000_000;
/** How long one look at the graph is trusted for. */
const SINK_TTL_MS = 2000;
/** Streams that are not the owner's media: the Eye's own mouth and the screen reader. */
const NOT_MEDIA = /^(pw-cat|speech-dispatcher)/i;
/**
 * WirePlumber keys its stream memory on `media.role`, which `pw-cat` sets to `music`,
 * so one stray `pactl move-sink-input` on a test would pin every later utterance to
 * that sink (E23: the TV) and a stray volume would follow it too. Opting out of both
 * halves of `restore-stream` leaves `--target` the only thing that decides.
 */
const NO_RESTORE = "{ state.restore-target = false, state.restore-props = false }";

/** `--target` by name, never by id: the bluez sink is a new node after every HFP switch. */
const playArgs = (rate, target) => [
  "-p", "--raw", "--format", "f32", "--rate", String(rate), "--channels", "1",
  "-P", NO_RESTORE,
  ...(target ? ["--target", target] : []),
  "-",
];
const recordArgs = (rate) => ["-r", "--raw", "--format", "f32", "--rate", String(rate), "--channels", "1", "-"];

/**
 * The sink of whatever media is playing right now — an uncorked stream that is neither
 * the Eye nor the screen reader, one already on a RUNNING sink first — else `fallback`.
 * The voice goes where he is listening.
 */
function pickSink(inputs, sinks, fallback) {
  const byIndex = new Map(sinks.map((s) => [s.index, s]));
  const playing = inputs.filter((i) => !i.corked && !NOT_MEDIA.test(i.properties?.["application.name"] || ""));
  const on = playing.find((i) => byIndex.get(i.sink)?.state === "RUNNING") || playing[0];
  return (on && byIndex.get(on.sink)?.name) || fallback;
}

/** `pickSink` over the live graph; null if pactl cannot be read, which means `auto`. */
function pactlSink() {
  try {
    const run = (args) => execFileSync("pactl", args, { encoding: "utf8", timeout: 1000 });
    const list = (what) => JSON.parse(run(["-f", "json", "list", what]));
    return pickSink(list("sink-inputs"), list("sinks"), run(["get-default-sink"]).trim());
  } catch {
    return null;
  }
}

/** Samples as raw little-endian f32 bytes. */
function toBuffer(samples) {
  const f = samples instanceof Float32Array ? samples : Float32Array.from(samples);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

/** Raw little-endian f32 bytes back to samples. */
function toSamples(buf) {
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/**
 * `{play, startCapture, stopCapture, captureRate, speaking}`. `play(chunk)`
 * takes the voice worker's `{seq, last, text, sampleRate, samples}`; a chunk with
 * `seq 0` opens an utterance, `last` closes it, and a second utterance waits
 * for the first to drain — one mouth. `onSpeaking(ms)` is the milliseconds
 * still to play when the chunk is handed over, and `onCaption({text, append,
 * ms})` fires when that chunk's own audio starts, so the words follow the
 * mouth instead of running ahead of it. An utterance whose chunks stop
 * without a `last` is closed by its own idle timer, so a lost `last` cannot
 * wedge the queue; `endOpen()` closes it at once.
 */
function createAudio({
  spawn = nodeSpawn,
  onSpeaking = () => {},
  onCaption = () => {},
  log = () => {},
  bin = BIN,
  readSink = pactlSink,
  sinkTtlMs = SINK_TTL_MS,
  captureRate = CAPTURE_RATE,
  idleMs = IDLE_MS,
  maxPendingBytes = MAX_PENDING,
} = {}) {
  const queue = [];
  let open = null; // the utterance still receiving chunks
  let capture = null;
  let speakUntil = 0;
  let sink = null;
  let sinkAt = 0;

  /** The sink for the utterance about to start, one look at the graph per `sinkTtlMs`. */
  function target() {
    const now = Date.now();
    if (now - sinkAt >= sinkTtlMs) {
      sink = readSink();
      sinkAt = now;
    }
    return sink;
  }

  function pump() {
    const utt = queue[0];
    if (!utt) return;
    if (!utt.proc) {
      utt.proc = spawn(bin, playArgs(utt.rate, target()), { stdio: ["pipe", "ignore", "ignore"] });
      utt.proc.stdin.on("error", () => {});
      utt.proc.on("error", (e) => {
        log(`pw-cat playback failed: ${e.message}`);
        finish(utt);
      });
      utt.proc.on("exit", () => finish(utt));
    }
    for (const b of utt.pending.splice(0)) utt.proc.stdin.write(b);
    utt.bytes = 0;
    if (utt.closed) utt.proc.stdin.end();
  }

  /** No more chunks are coming: end its stdin so the child can exit. */
  function close(utt) {
    if (utt.closed) return;
    clearTimeout(utt.idle);
    utt.closed = true;
    if (open === utt) open = null;
    pump();
  }

  function finish(utt) {
    clearTimeout(utt.idle);
    if (queue[0] !== utt) return;
    queue.shift();
    pump();
  }

  return {
    captureRate,

    play({ seq = 0, last = false, text = "", sampleRate, samples }) {
      const buf = toBuffer(samples);
      let dropped = false;
      if (seq === 0 || !open) {
        open = { rate: sampleRate, pending: [], bytes: 0, closed: false, proc: null, idle: null };
        queue.push(open);
      }
      const utt = open;
      if (utt.bytes + buf.length > maxPendingBytes) {
        dropped = true;
        log(`audio buffer full — dropped ${buf.length} bytes`);
      } else {
        utt.pending.push(buf);
        utt.bytes += buf.length;
      }
      clearTimeout(utt.idle);
      if (last) {
        utt.closed = true;
        open = null;
      }
      const now = Date.now();
      const startsIn = Math.max(0, speakUntil - now);
      const ms = Math.round((buf.length / 4 / sampleRate) * 1000);
      speakUntil = Math.max(now, speakUntil) + ms;
      onSpeaking(Math.round(speakUntil - now));
      // the caption of a chunk is due when the chunk itself starts sounding
      if (text && !dropped) {
        const show = () => onCaption({ text, append: seq > 0, ms });
        if (startsIn) setTimeout(show, startsIn);
        else show();
      }
      // the grace runs from the end of what is already buffered, not from now
      if (!last)
        utt.idle = setTimeout(() => {
          log("utterance went quiet — closing the mouth");
          close(utt);
        }, idleMs + Math.max(0, speakUntil - now));
      pump();
    },

    /** The voice worker died or errored mid-utterance: end the open one. */
    endOpen() {
      if (open) close(open);
    },

    startCapture() {
      if (capture) return;
      const proc = spawn(bin, recordArgs(captureRate), { stdio: ["ignore", "pipe", "ignore"] });
      const bufs = [];
      proc.stdout.on("data", (d) => bufs.push(d));
      proc.on("error", (e) => log(`pw-cat capture failed: ${e.message}`));
      capture = { proc, bufs, done: new Promise((r) => proc.on("close", r)) };
    },

    /** Samples captured since sample `from` — the partial ear reads the clip as it grows. */
    capturedFrom(from) {
      if (!capture) return new Float32Array(0);
      const start = from * 4;
      const parts = [];
      let seen = 0;
      for (const b of capture.bufs) {
        const end = seen + b.length;
        if (end > start) parts.push(seen >= start ? b : b.subarray(start - seen));
        seen = end;
      }
      return toSamples(Buffer.concat(parts));
    },

    /** SIGINT, then the whole clip once the child is gone. */
    async stopCapture() {
      if (!capture) return new Float32Array(0);
      const { proc, bufs, done } = capture;
      capture = null;
      proc.kill("SIGINT");
      await done;
      const samples = toSamples(Buffer.concat(bufs));
      log(`mic captured ${(samples.length / captureRate).toFixed(1)}s`);
      return samples;
    },

    get speaking() {
      return Date.now() < speakUntil;
    },
  };
}

module.exports = { createAudio, pickSink, playArgs, recordArgs, BIN, CAPTURE_RATE, IDLE_MS };
