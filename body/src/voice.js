/**
 * The voice worker — runs as an Electron utilityProcess.
 * Loads Kokoro (sherpa-onnx) once, then turns speak requests into a stream
 * of audio chunks (one per sentence) so the first sound arrives fast.
 */
const sherpa = require("sherpa-onnx-node");
const path = require("node:path");

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
      numThreads: 4,
      provider: "cpu",
      debug: false,
    },
  });
}

function initTts(modelDir) {
  const config = {
    model: {
      kokoro: {
        model: path.join(modelDir, "model.onnx"),
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

// split into speakable chunks: sentence-ish, merged up to ~240 chars
function chunks(text) {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…;:])\s+/)
    .filter(Boolean);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + " " + p).length > 240) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? cur + " " + p : p;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
}

process.parentPort.on("message", (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      sid = m.sid ?? sid;
      speed = m.speed ?? speed;
      const info = initTts(m.modelDir);
      if (m.asrDir) initAsr(m.asrDir);
      process.parentPort.postMessage({ type: "ready", ...info, asr: !!asr });
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
      process.parentPort.postMessage({
        type: "transcript",
        id: m.id,
        text: (result.text || "").trim(),
        ms: Date.now() - t0,
      });
    } else if (m.type === "speak") {
      if (!tts) throw new Error("voice not initialized");
      const cs = chunks(m.text);
      cs.forEach((sentence, i) => {
        // enableExternalBuffer:false — Electron forbids napi external buffers,
        // so sherpa must hand us a V8-owned copy
        const audio = tts.generate({
          text: sentence,
          sid: m.sid ?? sid,
          speed,
          enableExternalBuffer: false,
        });
        const samples = new Float32Array(audio.samples);
        process.parentPort.postMessage({
          type: "audio",
          id: m.id,
          seq: i,
          last: i === cs.length - 1,
          sampleRate: audio.sampleRate,
          samples,
        });
      });
    } else if (m.type === "set-voice") {
      sid = m.sid ?? sid;
      speed = m.speed ?? speed;
    }
  } catch (err) {
    process.parentPort.postMessage({ type: "err", message: String(err.message || err) });
  }
});
