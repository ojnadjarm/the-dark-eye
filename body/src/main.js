/**
 * The Dark Eye — body: plain node. The bridge, the queue, the intents, the TV
 * watch, the audio children, `eye-render` as the eye and `voice.js` as a forked
 * child. No Electron until he says "show me".
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");
const queue = require("./queue");
const { startServer } = require("./server");
const { startRemote } = require("./remote");
const { classify } = require("./intents");
const { createCanvas } = require("./canvas");
const { createDisplayWatch, sysfsReader, ddcProbe } = require("./display");
const { createRenderBridge, ownerCaption } = require("./render");
const { createOrbiters } = require("./orbiters");
const { createPartialEar, captionDelta } = require("./partials");
const { createRemoteEars } = require("./remote-ear");
const { createAudio } = require("./audio");
const { createReplies } = require("./replies");
const { createRecycler } = require("./recycle");

const MODELS_DIR = path.join(__dirname, "..", "models");
const ASR_DIR = path.join(MODELS_DIR, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8");
const MIC_MAX_MS = 90_000;
const REMOTE_RATE = 16000;
const MIN_MIC_SAMPLES = 4000;
const NOTICE_MS = 30_000;
/** The voice worker's arena only grows: over this, and quiet, it is recycled. 0 disables it. */
const VOICE_RSS_MAX_MB = Number(process.env.DARK_EYE_VOICE_RSS_MAX_MB ?? 1600);
const VOICE_IDLE_MS = 600_000;
const VOICE_CHECK_MS = 300_000;
/** The growing caption of his own words; `DARK_EYE_PARTIALS=0` leaves only the one at mic close. */
const PARTIALS = process.env.DARK_EYE_PARTIALS !== "0";

// local time, so a body line and its journal line read the same
const stamp = () => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
const log = (m) => console.log(`[body ${stamp()}] ${m}`);
const redact = (t) => (process.env.DARK_EYE_DEBUG ? t : `[${t?.length ?? 0} chars]`);

const DEFAULTS = {
  port: 8642,
  voiceSid: 17,
  voiceSpeed: 1.0,
  // the fp32 Kokoro: the int8 one beside it is 200 MB smaller and 2x slower (EF05)
  voiceModelDir: "kokoro-multi-lang-v1_0",
  brain: "claude",
  brainColor: "#b04dff",
  canvasZoom: 1.5,
};

/** Read ~/.config/dark-eye/config.json, filling defaults and the secret; mode 600. */
function loadConfig() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const dir = path.join(base, "dark-eye");
  const file = path.join(dir, "config.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* first run */
  }
  const full = { ...DEFAULTS, ...cfg };
  if (!full.secret) full.secret = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(full, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return full;
}

let canvas = null;
let render = null;
let orbiters = null;
let audio = null;

// -- the TV: the renderer's RandR outputs are the only display list ----------
let outputs = null; // null until eye-render reports; [] means no display
// the canvas reads this object every time it opens, so it is updated in place
const tvArea = { x: 0, y: 0, width: 1366, height: 768 };

let lastOutputsLine = null;

/** The TV is the largest output, as `eye-render` places the eye. */
function onOutputs(list) {
  outputs = list;
  const tv = [...list].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (tv) Object.assign(tvArea, { x: tv.x, y: tv.y, width: tv.w, height: tv.h });
  const line = list.map((o) => `${o.name} ${o.w}x${o.h} at ${o.x},${o.y}`).join(", ") || "none";
  if (line !== lastOutputsLine) {
    log(`outputs: ${line}`);
    lastOutputsLine = line;
  }
  displayWatch?.poll();
}

/** The eye: `eye-render` over the render socket, respawned when it dies. */
function startRender(cfg) {
  render = createRenderBridge({
    log,
    // a sandbox body runs its eye offscreen, or with no eye at all (body/scripts/body-sandbox)
    bin: process.env.DARK_EYE_RENDER_BIN || undefined,
    args: process.env.DARK_EYE_RENDER_ARGS ? process.env.DARK_EYE_RENDER_ARGS.split(/\s+/) : undefined,
    onMessage: (m) => {
      if (m.type === "ready") {
        log(`eye up at ${m.x},${m.y} (${m.w}x${m.h}) on ${m.output} (${m.backend})`);
        render.send({ type: "session", active: cfg.brain, color: cfg.brainColor });
        const back = orbiters?.replay(); // the working agents survive a renderer respawn
        if (back) log(`orbiters: ${back} put back`);
        if (micOpen) render.send({ type: "ptt", on: true });
        if (displayWatch?.on === false) render.send({ type: "display", on: false });
      } else if (m.type === "outputs") onOutputs(m.outputs);
      else if (m.type === "stats") log(`eye-render fps=${m.fps} msAvg=${m.msAvg} msMax=${m.msMax}`);
    },
  });
}

/** Speech and mic through `pw-cat` children. */
function startAudio() {
  audio = createAudio({
    log,
    // a sandbox body speaks into its own sink, never the owner's (DARK_EYE_SINK)
    readSink: process.env.DARK_EYE_SINK ? () => process.env.DARK_EYE_SINK : undefined,
    onSpeaking: (ms) => render?.send({ type: "speaking", ms }),
    // the caption follows the mouth: each sentence shows as its audio starts
    onCaption: (c) => render?.send({ type: "speak", ...c }),
  });
}

// -- the TV: a dark or absent display gets no frames ------------------------
let displayWatch = null;

/** `display{on:false}` disarms the renderer's timer entirely (PLAN-LOWRES §3.2). */
function startDisplayWatch() {
  // this TV answers no DDC/CI (E12: slave x37 unresponsive), so the rung is off
  const ddc = process.env.DARK_EYE_DDC === "1" ? ddcProbe() : null;
  displayWatch = createDisplayWatch({
    displays: () => outputs,
    readSysfs: sysfsReader(),
    ddc,
    log,
    onChange: ({ on, reason }) => {
      log(`display ${on ? "on" : "off"} (${reason})`);
      render?.send({ type: "display", on });
    },
  });
  if (displayWatch.override !== "auto") log(`tv override: ${displayWatch.override}`);
}

/**
 * His own switch over the ladder (E12): this TV keeps HPD, EDID and ELD up in
 * standby, so `off` is the only thing that can tell the eye the room is dark.
 */
function setTv(mode) {
  const before = displayWatch.override;
  const state = displayWatch.setOverride(mode);
  if (state.mode !== before) log(`tv override: ${state.mode}`);
  return state;
}

// -- the voice --------------------------------------------------------------
let voice = null;
let voiceReady = false;
const recycle = createRecycler({ maxMB: VOICE_RSS_MAX_MB, idleMs: VOICE_IDLE_MS, log });
let speakSeq = 0;
let micSeq = 0;
const pendingSpeech = [];
const partialWaiters = new Map();
/** A whole-clip decode someone is waiting on: `{source, done}` by request id. */
const finalWaiters = new Map();
/** Utterances that are not for the buds alone: speak id → `remote` or `both`. */
const speakTo = new Map();
/** Where the last thing heard came from — where an unaddressed reply goes back. */
let lastSource = "local";
const replies = createReplies({ log });

/** Decodes the ear asked for that are its final one, so they are not logged as partials. */
const earFinals = new Set();

/**
 * The words as they are said: the whole utterance so far, decoded again and
 * again as one growing window on the same recogniser, so every partial is read
 * with its context. Its settled head is frozen as it goes, which is also what
 * makes the transcript at mic close a short decode instead of the whole clip.
 */
/** A partial decode on the voice worker — the ear's own `decode`, at `rate()`. */
const decodeAt = (rate) => (samples, final) =>
  new Promise((done) => {
    if (!voiceReady) return done(null);
    const id = ++micSeq;
    recycle.touch();
    if (final) earFinals.add(id);
    partialWaiters.set(id, done);
    voice.send({ type: "transcribe", id, partial: true, samples, sampleRate: rate() });
  });

const ear = createPartialEar({
  read: (from) => audio.capturedFrom(from),
  decode: decodeAt(() => audio.captureRate),
  onText: (text, append, ms) => render?.send({ ...ownerCaption(text), append, ms }),
});

/**
 * The same ear for the phone, over the blocks the page streams while he
 * records: his words grow on the page as he says them, and the transcript at
 * the final tap is that ear's stitched final. The eye shows none of it — he is
 * not in the room.
 */
const remoteEars = createRemoteEars({
  makeEar: ({ read, onText }) =>
    createPartialEar({ read, onText, decode: decodeAt(() => REMOTE_RATE), rate: REMOTE_RATE }),
  onPartial: (utt, text) => replies.partial(utt, text),
  log,
});

/**
 * Kokoro. The caption is not sent here — `audio.js` sends each sentence when
 * its own audio starts, so the words never run ahead of the voice.
 * Speech that arrives before the worker is ready is held (max 10).
 */
function say(text, sid, to = lastSource) {
  if (voiceReady) {
    const id = ++speakSeq;
    recycle.touch();
    if (to !== "local") speakTo.set(id, to);
    voice.send({ type: "speak", id, text, sid });
  } else if (pendingSpeech.length < 10) pendingSpeech.push({ text, sid, to });
}

/** Caption only — the Eye never speaks unprompted. */
function whisper(text) {
  render?.send({ type: "speak", text });
}

/**
 * His voice: the canvas commands are the body's own, everything else is words
 * for the brain. A deaf brain is announced — the one case where the Eye speaks
 * first, and at most once every 30 s.
 */
function onTranscript(text, source = "local") {
  lastSource = source;
  const intent = classify(text);
  if (intent.kind === "canvas") return void (intent.close ? canvas.hide() : canvas.open());
  if (intent.kind === "tv") return void setTv(intent.mode);
  // his words get a full caption in his own gold, not the one-line marker — and
  // the partials already on screen are the same words: finish them, never repeat them.
  // A turn from the phone is not in the room: the TV shows nothing (PLAN-REMOTE §8.2)
  if (source === "local") {
    const delta = captionDelta(ear.shown, text);
    if (delta) render?.send({ ...ownerCaption(delta.text), append: delta.append, ms: delta.ms });
  }
  queue.push({ text, source });
  if (bridge?.brainListening() || Date.now() - lastNotice < NOTICE_MS) return;
  lastNotice = Date.now();
  say("No one is listening. I'm holding your words.");
}

function startVoice(cfg) {
  // advanced serialization keeps the Float32Array of samples a Float32Array
  voice = fork(path.join(__dirname, "voice.js"), [], { serialization: "advanced", execArgv: [] });
  voice.on("message", (m) => {
    if (m.type === "ready") {
      voiceReady = true;
      log(`voice ready — ${m.speakers} speakers @ ${m.sampleRate}Hz, sid ${cfg.voiceSid}, asr ${m.asr}`);
      for (const p of pendingSpeech.splice(0)) say(p.text, p.sid, p.to);
      if (process.env.DARK_EYE_SAY) {
        log(`self-test speak: ${redact(process.env.DARK_EYE_SAY)}`);
        say(process.env.DARK_EYE_SAY);
      }
    } else if (m.type === "audio") {
      log(`audio chunk seq=${m.seq} last=${m.last} n=${m.samples?.length ?? "?"}`);
      const to = speakTo.get(m.id) ?? "local";
      if (to !== "remote")
        audio.play({ seq: m.seq, last: m.last, text: m.text, sampleRate: m.sampleRate, samples: m.samples });
      if (to !== "local") replies.chunk(m);
      if (m.last) speakTo.delete(m.id);
    } else if (m.type === "transcript" && m.partial) {
      if (!earFinals.delete(m.id)) log(`partial (${m.ms}ms): ${redact(m.text)}`);
      partialWaiters.get(m.id)?.(m);
      partialWaiters.delete(m.id);
    } else if (m.type === "transcript") {
      log(`heard (${m.ms}ms): ${redact(m.text)}`);
      const waiter = finalWaiters.get(m.id);
      finalWaiters.delete(m.id);
      const source = waiter?.source ?? "local";
      // an empty transcript never throws away the partials he already watched appear,
      // but a clip from the phone has none behind it — it is whatever it decoded
      const text = m.text || (source === "remote" ? "" : ear.shown);
      if (text) onTranscript(text, source);
      waiter?.done(text || null);
    } else if (m.type === "err") {
      log(`voice error: ${m.message}`);
      // a sentence with no audio has no playback to follow: show it now
      if (m.text) render?.send({ type: "speak", text: m.text, append: m.seq > 0 });
      if (m.last && speakTo.delete(m.id)) replies.chunk({ id: m.id, last: true });
      audio.endOpen(); // a half-generated utterance must not hold the mouth
    }
  });
  voice.on("error", (e) => log(`voice worker error: ${e.message}`));
  voice.on("exit", (code, signal) => {
    voiceReady = false;
    for (const done of partialWaiters.values()) done(""); // no decode is coming
    partialWaiters.clear();
    for (const w of finalWaiters.values()) w.done(null);
    finalWaiters.clear();
    audio.endOpen(); // whatever it was saying will never be finished
    log(`voice worker exited (${signal ? `signal ${signal}` : code}) — respawning in 3s`);
    setTimeout(() => startVoice(cfg), 3000);
  });
  voice.send({
    type: "init",
    modelDir: path.resolve(MODELS_DIR, process.env.DARK_EYE_VOICE_MODEL_DIR || cfg.voiceModelDir),
    asrDir: ASR_DIR,
    sid: cfg.voiceSid,
    speed: cfg.voiceSpeed,
  });
}

// -- the mic: a toggle, with a failsafe for a mic left open ------------------
let micOpen = false;
let micFailsafe = null;

function setMic(on) {
  if (on === micOpen) return micOpen;
  micOpen = on;
  recycle.touch();
  render?.send({ type: "ptt", on });
  if (on) {
    audio.startCapture();
    if (PARTIALS) ear.start();
  } else {
    ear.stop();
    audio
      .stopCapture()
      .then((samples) => transcribe(samples, audio.captureRate, "local", PARTIALS ? ear : null),
        (e) => log(`mic capture failed: ${e.message}`));
  }
  clearTimeout(micFailsafe);
  if (on)
    micFailsafe = setTimeout(() => {
      log("mic failsafe: auto-closing after 90s");
      setMic(false);
    }, MIC_MAX_MS);
  log(`mic ${on ? "open" : "closed"}`);
  return micOpen;
}

/** One whole-clip decode, answering the text it heard (null if none came back). */
function decode(samples, sampleRate, source) {
  return new Promise((done) => {
    const id = ++micSeq;
    recycle.touch();
    finalWaiters.set(id, { source, done });
    voice.send({ type: "transcribe", id, samples, sampleRate });
  });
}

/**
 * A captured clip on its way to the ear: too short is dropped. A `ear` that has
 * been listening to it has already decoded and frozen everything but the last
 * seconds, so it settles the transcript from its own window — the whole clip is
 * decoded again only when there was no ear (`DARK_EYE_PARTIALS=0`, or a phone
 * clip that arrived in one piece) or it heard nothing. Either way the text is
 * answered to the caller as well as pushed to the queue.
 */
async function transcribe(samples, sampleRate, source = "local", ear = null) {
  log(`${source === "remote" ? "remote" : "mic"} audio: ${samples.length} samples @ ${sampleRate}Hz`);
  if (!voiceReady || samples.length <= MIN_MIC_SAMPLES) return null;
  if (ear) {
    const t0 = Date.now();
    const done = await ear.finalize(samples).catch((e) => (log(`ear finalize failed: ${e.message}`), null));
    if (done) {
      log(`heard (${Date.now() - t0}ms${done.reused ? ", from the last window" : ""}): ${redact(done.text)}`);
      if (done.text) onTranscript(done.text, source);
      return done.text || null;
    }
  }
  return decode(samples, sampleRate, source);
}

/**
 * The final tap on the phone: the streamed clip settled by the ear that was
 * already reading it, the tail (if any) appended first. A `utt` nobody streamed
 * falls back to the whole-clip decode, which is what a page with no stream does.
 */
async function remoteFinal(utt, tail) {
  const got = remoteEars.close(utt, tail);
  replies.partial(utt, null); // the growing line is about to become the real one
  if (!got) return tail.length ? transcribe(tail, REMOTE_RATE, "remote") : null;
  return transcribe(got.samples, REMOTE_RATE, "remote", got.ear);
}

// -- the bridge: what a brain can do to this body ---------------------------
let bridge = null;
let lastNotice = 0;

function startBridge(cfg) {
  bridge = startServer({
    port: cfg.port,
    secret: cfg.secret,
    onSpeak: ({ text, voice, to }) => say(text, voice, to),
    onListen: (ms) => queue.take(ms),
    onMic: (on) => setMic(on === undefined ? !micOpen : on),
    onMicOpen: () => micOpen,
    onStatus: (s) => {
      orbiters.set(s);
      render?.send({ type: "status", ...s });
    },
    onOrbiters: () => orbiters.list(),
    onTv: (mode) => (mode ? setTv(mode) : displayWatch.state()),
    onShow: (v) => {
      const item = canvas.push(v);
      log(`show: ${v.kind} "${v.title}"${v.verdict ? " (verdict)" : ""}`);
      // it never opens by itself — a mark by the eye is all he gets
      if (!canvas.isVisible()) whisper(`⟨ show ⟩ ${v.title}`);
      return item.id;
    },
    log,
  });
}

/** Take the renderer and the voice worker down with the body. */
function shutdown(sig) {
  log(`${sig} — closing the eye`);
  render?.stop();
  voice?.kill();
  process.exit(0);
}

// the eye first (first frame ≤3 s), then the ear, then the 5 s of model loading
const cfg = loadConfig();
orbiters = createOrbiters({ log, send: (m) => render?.send(m) });
startRender(cfg);
startAudio();
startDisplayWatch();
canvas = createCanvas({ workArea: tvArea, zoom: cfg.canvasZoom, onEvent: (e) => queue.push(e), log });
startBridge(cfg);
// the phone: a second loopback listener, only when he has asked for one
if (cfg.remotePort)
  startRemote({
    port: cfg.remotePort,
    secret: cfg.secret,
    onAudio: (samples, rate) => transcribe(samples, rate, "remote"),
    onStream: (utt, seq, samples) => remoteEars.push(utt, seq, samples),
    onFinal: (utt, tail) => remoteFinal(utt, tail),
    onPoll: (since) => replies.poll(since),
    onCursor: () => replies.cursor(),
    onAck: (seq) => replies.ack(seq),
    wav: (id) => replies.wav(id),
    log,
  });
startVoice(cfg);
setInterval(() => recycle.check(voice), VOICE_CHECK_MS).unref();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => shutdown(sig));
// nothing here is worth staying up half-dead for: log it and let systemd restart
process.on("unhandledRejection", (e) => {
  log(`unhandled rejection: ${e?.stack || e}`);
  process.exit(1);
});
process.on("uncaughtException", (e) => {
  log(`uncaught exception: ${e?.stack || e}`);
  process.exit(1);
});
