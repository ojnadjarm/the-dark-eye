/* Standalone Kokoro test: node scripts/tts-test.js [sid] ["text"] */
const sherpa = require("sherpa-onnx-node");
const path = require("path");

const M = path.join(__dirname, "..", "models", "kokoro-multi-lang-v1_0");
const config = {
  model: {
    kokoro: {
      model: path.join(M, "model.onnx"),
      voices: path.join(M, "voices.bin"),
      tokens: path.join(M, "tokens.txt"),
      dataDir: path.join(M, "espeak-ng-data"),
      dictDir: path.join(M, "dict"),
      lexicon: [path.join(M, "lexicon-us-en.txt"), path.join(M, "lexicon-zh.txt")].join(","),
    },
    numThreads: 4,
    debug: false,
    provider: "cpu",
  },
  maxNumSentences: 1,
};

const t0 = Date.now();
const tts = new sherpa.OfflineTts(config);
console.log("init_ms:", Date.now() - t0, "speakers:", tts.numSpeakers, "rate:", tts.sampleRate);

const sid = parseInt(process.argv[2] ?? "17", 10);
const text =
  process.argv[3] ??
  "The Eye is open, Oscar. Say the word, and I will make things happen.";
const t1 = Date.now();
const audio = tts.generate({ text, sid, speed: 1.0 });
console.log("gen_ms:", Date.now() - t1, "samples:", audio.samples.length, "sampleRate:", audio.sampleRate);
const out = path.join(__dirname, `test-sid${sid}.wav`);
sherpa.writeWave(out, { samples: audio.samples, sampleRate: audio.sampleRate });
console.log("wrote:", out);
