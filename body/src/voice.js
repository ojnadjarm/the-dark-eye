/**
 * The voice worker — a forked child of the body (or an Electron utilityProcess).
 * Loads Kokoro (sherpa-onnx) once, then turns speak requests into a stream
 * of audio chunks (one per sentence) so the first sound arrives fast.
 */
const sherpa = require("sherpa-onnx-node");
const fs = require("node:fs");
const path = require("node:path");
const chunks = require("./chunks");

// Electron's utilityProcess gives us `parentPort`; a plain `fork` child gives
// `process.send`/`process.on('message')`. One shim so this file runs under both.
// `postMessage(m, done)` calls `done` once the body actually has the message.
const port = process.parentPort ?? {
  on: (_, f) => process.on("message", (m) => f({ data: m })),
  postMessage: (m, done) => process.send(m, done),
};
/** Post a message; `done` fires once the body has it. */
function post(m, done) {
  if (process.parentPort) {
    port.postMessage(m);
    done?.();
  } else port.postMessage(m, done);
}

let tts = null;
let asr = null;
let sid = 17;
let speed = 1.0;

function initAsr(asrDir) {
  asr = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(asrDir, "encoder.int8.onnx"),
        decoder: path.join(asrDir, "decoder.int8.onnx"),
        joiner: path.join(asrDir, "joiner.int8.onnx"),
      },
      tokens: path.join(asrDir, "tokens.txt"),
      modelType: "nemo_transducer",
      // one thread: measured on this laptop it decodes a 5 s clip in the same
      // wall time as four and costs a tenth of the CPU, which is what makes a
      // partial decode every 1.5 s affordable while he is speaking
      numThreads: 1,
      provider: "cpu",
      debug: false,
    },
  });
}

/** The fp32 kokoro dirs ship `model.onnx`, the int8 ones `model.int8.onnx`. */
function modelFile(modelDir) {
  const plain = path.join(modelDir, "model.onnx");
  return fs.existsSync(plain) ? plain : path.join(modelDir, "model.int8.onnx");
}

function initTts(modelDir) {
  const config = {
    model: {
      kokoro: {
        model: modelFile(modelDir),
        voices: path.join(modelDir, "voices.bin"),
        tokens: path.join(modelDir, "tokens.txt"),
        dataDir: path.join(modelDir, "espeak-ng-data"),
        dictDir: path.join(modelDir, "dict"),
        lexicon: [
          path.join(modelDir, "lexicon-us-en.txt"),
          path.join(modelDir, "lexicon-zh.txt"),
        ].join(","),
      },
      numThreads: 4,
      debug: false,
      provider: "cpu",
    },
    maxNumSentences: 1,
  };
  tts = new sherpa.OfflineTts(config);
  return { speakers: tts.numSpeakers, sampleRate: tts.sampleRate };
}

/**
 * One sentence at a time: generate it, hand it over, and only then generate the
 * next — a synchronous run would hold every sentence in the pipe until the last
 * one was made, and the first sound is the whole point of chunking. Requests
 * queue, so two utterances cannot interleave their chunks.
 */
const speaking = [];
/** Bumped by `cancel`: a step from an older generation stops where it is. */
let gen = 0;

function speak(m) {
  const cs = chunks(m.text);
  const g = gen;
  // one message per sentence, `last` on the final one either way, so a
  // sentence that throws drops neither the ones after it nor the utterance
  const step = (i) => {
    const sentence = cs[i];
    const last = i === cs.length - 1;
    const next = () => {
      if (g !== gen) return;
      if (last) {
        speaking.shift();
        if (speaking.length) speak(speaking[0]);
      } else setImmediate(() => step(i + 1));
    };
    try {
      // enableExternalBuffer:false — Electron forbids napi external buffers,
      // so sherpa must hand us a V8-owned copy
      const audio = tts.generate({
        text: sentence,
        sid: m.sid ?? sid,
        speed,
        enableExternalBuffer: false,
      });
      const samples = new Float32Array(audio.samples);
      post(
        { type: "audio", id: m.id, seq: i, last, text: sentence, sampleRate: audio.sampleRate, samples },
        next
      );
    } catch (err) {
      post({ type: "err", id: m.id, seq: i, last, text: sentence, message: String(err.message || err) }, next);
    }
  };
  step(0);
}

port.on("message", (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      sid = m.sid ?? sid;
      speed = m.speed ?? speed;
      const info = initTts(m.modelDir);
      if (m.asrDir) initAsr(m.asrDir);
      port.postMessage({ type: "ready", ...info, asr: !!asr });
    } else if (m.type === "transcribe") {
      if (!asr) throw new Error("asr not initialized");
      const t0 = Date.now();
      const stream = asr.createStream();
      stream.acceptWaveform({
        sampleRate: m.sampleRate,
        samples: new Float32Array(m.samples),
      });
      asr.decode(stream);
      const result = asr.getResult(stream);
      port.postMessage({
        type: "transcript",
        id: m.id,
        partial: !!m.partial,
        text: (result.text || "").trim(),
        // per-token times: the partial ear needs them to know which words are
        // old enough to freeze and cut out of its decode window
        tokens: result.tokens ?? [],
        timestamps: result.timestamps ?? [],
        durations: result.durations ?? [],
        ms: Date.now() - t0,
      });
    } else if (m.type === "speak") {
      if (!tts) throw new Error("voice not initialized");
      speaking.push(m);
      if (speaking.length === 1) speak(m);
    } else if (m.type === "cancel") {
      // the one being made stops unless it is the phone's own; of those waiting only `keep` go on
      const keep = new Set(m.keep ?? []);
      const kept = speaking.slice(1).filter((x) => keep.has(x.id));
      if (speaking.length && keep.has(speaking[0].id)) {
        speaking.splice(1, Infinity, ...kept);
        return;
      }
      gen++;
      speaking.length = 0;
      speaking.push(...kept);
      if (kept.length) speak(kept[0]);
    } else if (m.type === "set-voice") {
      sid = m.sid ?? sid;
      speed = m.speed ?? speed;
    }
  } catch (err) {
    port.postMessage({ type: "err", message: String(err.message || err) });
  }
});
