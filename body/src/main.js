/**
 * The Dark Eye — body: plain node. The bridge, the queue, the intents, the TV
 * watch, the audio children, `eye-render` as the eye and `voice.js` as a forked
 * child. No Electron until he says "show me".
 */
const path = require("node:path");
const fs = require("node:fs");
const { fork } = require("node:child_process");
const { createBrains, createSwitch, createNotice } = require("./brains");
const { loadConfig, channelTable } = require("./config");
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
const { createHold } = require("./hold");
const { createReplies } = require("./replies");
const { createEager } = require("./eager");
const { createMode, fromWire, toWire } = require("./mode");
const { createNotes } = require("./notes-list");
const { createRecycler } = require("./recycle");

const MODELS_DIR = path.join(__dirname, "..", "models");
const ASR_DIR = path.join(MODELS_DIR, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8");
const MIC_MAX_MS = 90_000;
const REMOTE_RATE = 16000;
const MIN_MIC_SAMPLES = 4000;
/** The voice worker's arena only grows: over this, and silent, it is recycled. 0 disables it. */
const VOICE_RSS_MAX_MB = Number(process.env.DARK_EYE_VOICE_RSS_MAX_MB ?? 1600);
const VOICE_IDLE_MS = 600_000;
const VOICE_CHECK_MS = 300_000;
/** The growing caption of his own words; `DARK_EYE_PARTIALS=0` leaves only the one at mic close. */
const PARTIALS = process.env.DARK_EYE_PARTIALS !== "0";

// local time, so a body line and its journal line read the same
/** One deaf notice per 30 s, whether the switch or his next words raise it. */
const noticeDue = createNotice();

const stamp = () => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
const log = (m) => console.log(`[body ${stamp()}] ${m}`);
const redact = (t) => (process.env.DARK_EYE_DEBUG ? t : `[${t?.length ?? 0} chars]`);

let canvas = null;
let render = null;
let orbiters = null;
let audio = null;
let brains = null;

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
        showActive();
        showMarks();
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
/** Every speak id up to here was cut: its chunks are not for the local mouth. */
let cutBelow = 0;
const replies = createReplies({ log });
/** How the exchange runs, per channel: `mode`/`async` are the active channel's. Wired once `cfg` and `brains` exist. */
let mode = null;

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

/** The mouth waits while he speaks (mic open, phone utterance in flight), 1.5 s after, and all through audio notes mode (no timer). */
const hold = createHold({
  send: ({ text, sid, to }) => {
    const id = ++speakSeq;
    recycle.touch();
    if (to !== "local") speakTo.set(id, to);
    voice.send({ type: "speak", id, text, sid });
  },
  busy: () => micOpen || remoteEars.live !== null,
  parked: () => mode.async,
  onChange: () => showMarks(),
  log,
});

/**
 * The voice of a parked reply, made while it waits so his ▶ streams bytes that
 * already exist. Only ever the active channel's replies — a channel he is not on
 * never reaches `say()` at all — and only while the mouth has nothing of his to say.
 */
const eager = createEager({
  speak: (m) => (recycle.touch(), voice.send({ type: "speak", ...m })), // the worker is in use: not idle
  attach: (seq, parts, rate) => replies.attach(seq, parts, rate),
  settled: (seq) => replies.ready(seq), // bytes or none, that reply is his to press now: the page draws its ▶

  idle: () => !micOpen && remoteEars.live === null && !holdSpeaking() && !audio?.speaking && speakTo.size === 0,
  log,
});

/**
 * What the hold will say on its own: an item he asked for, and every item at all
 * in call mode. A parked reply waits for his ▶ however many days later, so it
 * competes with nothing and must not hold the voice it is waiting for.
 */
const holdSpeaking = () => hold.list().some((item) => item.bypass || !mode.async);

/** The Eye's own green: the mark of a visual he has not opened. */
const EYE_GREEN = "#4dffa0";
let unseenShows = 0;

/** The row under the eye: a mark per held reply in its brain's colour, per unopened visual, and the mode ring. */
function showMarks() {
  const held = hold.list().map(({ color }) => ({ color, kind: "held" }));
  const shows = Array.from({ length: unseenShows }, () => ({ color: EYE_GREEN, kind: "show" }));
  render?.sendMarks({ type: "marks", items: [...held, ...shows], mode: mode.mode });
}

/** The canvas up: he has looked, the show marks go. */
function openCanvas() {
  canvas.open();
  unseenShows = 0;
  showMarks();
}

/**
 * Kokoro, through the hold gate. The caption is not sent here — `audio.js`
 * sends each sentence when its own audio starts, so the words never run ahead
 * of the voice. Speech that arrives before the worker is ready is held (max 10).
 */
function say(text, sid, to = lastSource, color = activeColor(), again = false) {
  if (!voiceReady) return void (pendingSpeech.length < 10 && pendingSpeech.push({ text, sid, to, color, again }));
  const parked = mode.async && !again; // a replay is his own ask: the mode does not swallow it
  // parked: the words go out now and the voice is made while they wait for his ▶,
  // which is not drawn until eager says the voice is there — a ▶ that plays nothing is worse
  if (parked) eager.queue(show(text, to, true), text, sid);
  // a reply goes only where he spoke from, in either mode: an answer to something he
  // said on the phone is never put through the room's mouth
  hold.offer({ text, sid, to, color, bypass: again });
}

/**
 * ▶ on the page: the voice made when the reply was parked, published as the answer —
 * or, while that job is still running, the same run's bytes when it lands. With no
 * bytes at all the words are said again, to the page alone: the room is never made to
 * repeat itself, and in audio notes mode this is how he hears a reply at all.
 */
function onReplay(seq) {
  const text = replies.find(seq);
  if (!text) return false;
  // a note he has now heard stops waiting, and the roster row says so
  if (notes.played(brains.active, text)) replies.brains(channelRoster());
  const now = () => say(text, cfg.voiceSid, "remote", activeColor(), true);
  if (replies.repeat(seq)) return true; // the voice is already made: no synthesis at all
  if (!eager.press(seq, (ok) => (ok ? replies.repeat(seq) : now()))) now();
  return true;
}

/**
 * The words still reach him at once, as text, wherever the voice would have
 * gone — `pending` says a voice is being made for them, so the page holds the ▶ back
 * until it lands — and in audio notes mode to both channels, so a page he leaves open
 * holds the ▶ for everything the Eye has said, even a turn he took in the room.
 */
function show(text, to, pending = false) {
  const both = mode.async;
  if (both || to !== "remote") whisper(text);
  return both || to !== "local" ? replies.text(text, pending) : null;
}

/**
 * One channel's mode, his own by default; back in `call` the hold says what it
 * queued, in order. The mouth, the ring and the caption belong to the active
 * channel alone, so a mode moved on any other channel says and releases nothing.
 * Answers that channel's mode.
 */
function setMode(m, channel = brains.active) {
  if (mode.set(m, channel) !== m) return mode.of(channel);
  log(`mode: ${m}${channel === brains.active ? "" : ` (${channel})`}`);
  replies.brains(channelRoster()); // the page redraws its caption from the roster lane
  if (channel !== brains.active) return m;
  showMarks();
  if (mode.async) whisper("⟨ audio notes ⟩");
  else hold.heard();
  return mode.mode;
}

/**
 * His words for the mode, said back in the words he used and the active
 * channel's voice, and said *before* the mode takes effect: entering audio
 * notes mode the confirmation is the last thing the room hears, and coming back
 * it is spoken ahead of the queue it releases: `bypass` carries it past the park
 * of the mode he is leaving and waits at the head of the hold, not its tail, so
 * his way back is heard before what it lets go. The mode he is already in is no switch: it
 * confirms nothing a second time, and in `call` with nothing waiting the Eye
 * answers "here" as it has since M09a.
 */
function onModeIntent(name, words) {
  if (name === mode.mode) {
    if (name === "call" && !hold.held) say("here", cfg.voiceSid);
    return;
  }
  const b = activeBrain();
  say(words, b.voice, lastSource, b.color, true);
  setMode(name);
}

/**
 * He started speaking over the Eye: the live utterance dies and the rest of it is
 * dropped, along with anything queued for the local mouth. A reply that is the phone's
 * alone is kept; one going both ways is closed for the phone with what it has.
 */
function bargeIn() {
  if (!audio.speaking) return;
  log("cut — he is speaking");
  cutBelow = speakSeq;
  audio.cut(speakSeq);
  const keep = eager.jobId() ? [eager.jobId()] : []; // the eager job is not what he is speaking over
  for (const [id, to] of speakTo) {
    if (to === "remote") keep.push(id);
    else {
      speakTo.delete(id);
      replies.chunk({ id, last: true });
    }
  }
  voice.send({ type: "cancel", keep });
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
  const intent = classify(text, log);
  if (intent.kind === "canvas") return void (intent.close ? canvas.hide() : openCanvas());
  if (intent.kind === "tv") return void setTv(intent.mode);
  if (intent.kind === "brain") return void onBrainIntent(intent.name, intent.words, intent.lang);
  if (intent.kind === "mode") return void onModeIntent(intent.name, intent.words);
  // his words get a full caption in his own gold, not the one-line marker — and
  // the partials already on screen are the same words: finish them, never repeat them.
  // A turn from the phone is not in the room: the TV shows nothing (PLAN-REMOTE §8.2)
  if (source === "local") {
    const delta = captionDelta(ear.shown, text);
    if (delta) render?.send({ ...ownerCaption(delta.text), append: delta.append, ms: delta.ms });
  }
  brains.push({ text, source });
  if (brains.connected(brains.active) || !noticeDue()) return;
  say("No one is listening. I'm holding your words.");
}

function startVoice(cfg) {
  // advanced serialization keeps the Float32Array of samples a Float32Array
  voice = fork(path.join(__dirname, "voice.js"), [], { serialization: "advanced", execArgv: [] });
  voice.on("message", (m) => {
    // eager bytes are the ring's alone: never the room, never a second line
    if ((m.type === "audio" || m.type === "err") && eager.chunk(m)) return;
    if (m.type === "ready") {
      voiceReady = true;
      log(`voice ready — ${m.speakers} speakers @ ${m.sampleRate}Hz, sid ${cfg.voiceSid}, asr ${m.asr}`);
      for (const p of pendingSpeech.splice(0)) say(p.text, p.sid, p.to, p.color, p.again);
      if (process.env.DARK_EYE_SAY) {
        log(`self-test speak: ${redact(process.env.DARK_EYE_SAY)}`);
        say(process.env.DARK_EYE_SAY);
      }
    } else if (m.type === "audio") {
      const to = speakTo.get(m.id) ?? "local";
      if (m.id <= cutBelow && to === "local") return void log(`audio chunk seq=${m.seq} of a cut utterance — dropped`);
      log(`audio chunk seq=${m.seq} last=${m.last} n=${m.samples?.length ?? "?"}`);
      if (to !== "remote")
        audio.play({ id: m.id, seq: m.seq, last: m.last, text: m.text, sampleRate: m.sampleRate, samples: m.samples });
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
    eager.lost(); // the voice it was making is gone: the words stay, the press synthesises
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
    bargeIn();
    audio.startCapture();
    if (PARTIALS) ear.start();
  } else {
    hold.heard();
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
  hold.heard();
  const got = remoteEars.close(utt, tail);
  replies.partial(utt, null); // the growing line is about to become the real one
  if (!got) return tail.length ? transcribe(tail, REMOTE_RATE, "remote") : null;
  return transcribe(got.samples, REMOTE_RATE, "remote", got.ear);
}

// -- the brains: one bus each, his words to the active one -------------------
/** The iris takes the active brain's colour. */
function showActive() {
  const b = brains.roster().brains.find((x) => x.name === brains.active);
  render?.send({ type: "session", active: b.name, label: b.label, color: b.color });
}

/** The roster as the bridge and the page read it: every row its own mode, the active channel's on top. */
function channelRoster() {
  const r = brains.roster();
  return {
    ...r,
    brains: r.brains.map((b) => ({ ...b, mode: toWire(mode.of(b.name)) })),
    mode: toWire(mode.mode),
  };
}

/**
 * Arriving on a channel: every note it kept while he was away, oldest first, each
 * its own line with its own ▶. Nothing is synthesised here — the voice is made on
 * the press, so a channel he is not on costs nothing at all.
 */
function showNotes(name) {
  for (const n of notes.list(name)) replies.text(n.text);
}

/** The channel that hears him now — its own voice and mark colour. */
function activeBrain() {
  return brains.roster().brains.find((x) => x.name === brains.active);
}

/** His display name for a channel — the id when the row has no label. */
function labelOf(name) {
  return brains.roster().brains.find((x) => x.name === name)?.label ?? name;
}

/** The active brain's colour — what the body's own words are marked in. */
function activeColor() {
  return activeBrain().color;
}

/** Who hears him — `createSwitch`, wired at startup once `brains` exists. */
let setActive = () => null;

/**
 * His voice on the switch: the channel's name back in its own voice and mark
 * colour; `null` asks who hears him.
 */
function onBrainIntent(name, words, lang) {
  const { brains: roster } = brains.roster();
  if (name === null) return void say(labelOf(brains.active));
  const b = roster.find((x) => x.name === name);
  if (!b) return void say(`I can route you to: ${roster.map((x) => x.label).join(", ")}`);
  say(words ?? b.label, b.voice, lastSource, b.color);
  setActive(name, words ?? b.label, lang);
}

// -- the bridge: what a brain can do to this body ---------------------------

function startBridge(cfg) {
  startServer({
    port: cfg.port,
    secret: cfg.secret,
    onSpeak: ({ text, voice, to, brain = cfg.defaultChannel }) => {
      const parked = brains.speak(brain, text, voice, to);
      if (parked) whisper(`⟨ ${labelOf(brain)} ⟩ ${parked} waiting`);
    },
    onListen: (ms, brain = cfg.defaultChannel, voice) => brains.take(brain, ms, voice),
    onBrains: () => channelRoster(),
    onActive: (name) => setActive(name),
    onMic: (on) => setMic(on === undefined ? !micOpen : on),
    onMicOpen: () => micOpen,
    onHeld: () => hold.held,
    onMode: (m, channel) => (m === undefined ? mode.mode : setMode(m, channel)),
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
      if (!canvas.isVisible()) {
        unseenShows++;
        showMarks();
        whisper(`⟨ show ⟩ ${v.title}`);
      }
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
const cfg = loadConfig({ log });
orbiters = createOrbiters({ log, send: (m) => render?.send(m) });
// every configured channel is on the roster before its session exists
const channels = channelTable(cfg, log);
// what a channel said while he was elsewhere, kept for his ▶ across restarts
const notes = createNotes({ known: (n) => n === cfg.defaultChannel || Object.hasOwn(channels, n), log });
brains = createBrains({ channels, defaultChannel: cfg.defaultChannel, say, notes, log });
// each channel's own mode, the active one's being the mode of the exchange
mode = createMode({ active: () => brains.active, channels, defaultMode: cfg.defaultMode, log });
setActive = createSwitch({
  brains,
  say,
  whisper,
  // the eye's ring and the page's caption are the active channel's mode: a switch can change both
  onSwitch: (r, name) => (showActive(), showMarks(), replies.brains(channelRoster()), showNotes(name)),
  noticeDue,
  log,
});
if (brains.active !== cfg.defaultChannel) log(`active brain: ${brains.active} (kept)`);
if (mode.async) log("mode: async (kept)");
startRender(cfg);
startAudio();
startDisplayWatch();
canvas = createCanvas({ workArea: tvArea, zoom: cfg.canvasZoom, onEvent: (e) => brains.push(e), log });
startBridge(cfg);
// the phone: a second loopback listener, only when he has asked for one
if (cfg.remotePort)
  startRemote({
    port: cfg.remotePort,
    secret: cfg.secret,
    onAudio: (samples, rate) => (hold.heard(), transcribe(samples, rate, "remote")),
    onStream: (utt, seq, samples) => {
      if (remoteEars.live?.utt !== utt) bargeIn();
      return remoteEars.push(utt, seq, samples);
    },
    onFinal: (utt, tail) => remoteFinal(utt, tail),
    onPoll: (since) => replies.poll(since),
    onCursor: () => replies.cursor(),
    onAck: (seq) => replies.ack(seq),
    onReplay: (seq) => onReplay(seq),
    wav: (id) => replies.wav(id),
    onBrains: () => channelRoster(),
    onActive: (name) => setActive(name),
    onMode: (m, channel) => (m === undefined ? toWire(mode.mode) : toWire(setMode(fromWire(m), channel))),
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
