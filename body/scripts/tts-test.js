/**
 * Kokoro by hand, outside the body: render one WAV, or run the EF05 bench.
 *
 *   node scripts/tts-test.js [sid] ["text"]         one WAV, prints `wrote: <path>`
 *   node scripts/tts-test.js --bench [options]      the EF05 table for one model dir
 *
 * Bench options: --model <dir> (default the fp32 kokoro), --sid 17, --out <wav>,
 * --utterances 20, --transcriptions 20. It reports time-to-first-chunk and total
 * ms for the 45-word `measure.sh` paragraph and its own RSS fresh, after the
 * utterances and after the transcriptions. It never plays anything.
 */
const sherpa = require("sherpa-onnx-node");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const chunks = require("../src/chunks");

const MODELS = path.join(__dirname, "..", "models");
const FP32 = path.join(MODELS, "kokoro-multi-lang-v1_0");
const ASR_DIR = path.join(MODELS, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8");
// the paragraph `measure.sh` says in its `speaking` state, so the two agree
const PARAGRAPH =
  "The eye keeps watch over a quiet room while the house sleeps and the screens go dark one by one. " +
  "It counts the frames it draws and the cycles it burns so that later someone can read the numbers " +
  "and decide what must be made smaller.";
const CLIP = "what time is it";

/** The model file sherpa should load: fp32 dirs ship `model.onnx`, int8 ones `model.int8.onnx`. */
function modelFile(dir) {
  const plain = path.join(dir, "model.onnx");
  return fs.existsSync(plain) ? plain : path.join(dir, "model.int8.onnx");
}

function makeTts(modelDir) {
  return new sherpa.OfflineTts({
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
  });
}

function makeAsr() {
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(ASR_DIR, "encoder.int8.onnx"),
        decoder: path.join(ASR_DIR, "decoder.int8.onnx"),
        joiner: path.join(ASR_DIR, "joiner.int8.onnx"),
      },
      tokens: path.join(ASR_DIR, "tokens.txt"),
      modelType: "nemo_transducer",
      numThreads: 1,
      provider: "cpu",
      debug: false,
    },
  });
}

const rssMB = () =>
  Math.round(
    Number(/^Rss:\s+(\d+) kB/m.exec(fs.readFileSync("/proc/self/smaps_rollup", "utf8"))?.[1] ?? 0) / 1024
  );

/** One utterance the way `voice.js` makes it: sentence by sentence, first one timed. */
function utter(tts, text, sid) {
  const cs = chunks(text);
  const t0 = Date.now();
  let first = 0;
  const parts = [];
  let sampleRate = 0;
  for (const sentence of cs) {
    const audio = tts.generate({ text: sentence, sid, speed: 1.0, enableExternalBuffer: false });
    if (!first) first = Date.now() - t0;
    parts.push(new Float32Array(audio.samples));
    sampleRate = audio.sampleRate;
  }
  const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    samples.set(p, at);
    at += p.length;
  }
  return { firstMs: first, totalMs: Date.now() - t0, sentences: cs.length, samples, sampleRate };
}

/** The clip the ASR decodes: a WAV resampled to the mic's 16 kHz mono float, as `e2e-voice.sh` does. */
function clipAt16k(wav) {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", wav, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
    { maxBuffer: 1 << 28 }
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

function bench(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i === -1 ? dflt : argv[i + 1];
  };
  const modelDir = path.resolve(arg("--model", FP32));
  const sid = parseInt(arg("--sid", "17"), 10);
  const out = path.resolve(arg("--out", path.join(__dirname, `bench-sid${sid}.wav`)));
  const utterances = parseInt(arg("--utterances", "20"), 10);
  const transcriptions = parseInt(arg("--transcriptions", "20"), 10);

  console.log(`model: ${modelDir}`);
  console.log(`pid: ${process.pid}`);
  const t0 = Date.now();
  const tts = makeTts(modelDir);
  const ttsInitMs = Date.now() - t0;
  const t1 = Date.now();
  const asr = makeAsr();
  const asrInitMs = Date.now() - t1;
  console.log(`init_ms: tts=${ttsInitMs} asr=${asrInitMs} speakers=${tts.numSpeakers} rate=${tts.sampleRate}`);
  console.log(`rss_fresh_mb: ${rssMB()}`);

  const first = utter(tts, PARAGRAPH, sid);
  sherpa.writeWave(out, { samples: first.samples, sampleRate: first.sampleRate });
  console.log(
    `paragraph: sentences=${first.sentences} first_chunk_ms=${first.firstMs} total_ms=${first.totalMs}` +
      ` samples=${first.samples.length} audio_s=${(first.samples.length / first.sampleRate).toFixed(2)}`
  );
  console.log(`wrote: ${out}`);

  const firsts = [first.firstMs];
  const totals = [first.totalMs];
  for (let i = 1; i < utterances; i++) {
    const u = utter(tts, PARAGRAPH, sid);
    firsts.push(u.firstMs);
    totals.push(u.totalMs);
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(
    `after ${utterances} utterances: first_chunk_ms median=${med(firsts)} min=${Math.min(...firsts)}` +
      ` max=${Math.max(...firsts)} · total_ms median=${med(totals)}`
  );
  console.log(`rss_after_utterances_mb: ${rssMB()}`);

  const clipWav = path.join(path.dirname(out), `clip-${path.basename(out)}`);
  const c = utter(tts, CLIP, sid);
  sherpa.writeWave(clipWav, { samples: c.samples, sampleRate: c.sampleRate });
  const samples = clipAt16k(clipWav);
  const decodeMs = [];
  let text = "";
  for (let i = 0; i < transcriptions; i++) {
    const d0 = Date.now();
    const stream = asr.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    asr.decode(stream);
    text = (asr.getResult(stream).text || "").trim();
    decodeMs.push(Date.now() - d0);
  }
  fs.rmSync(clipWav, { force: true });
  console.log(
    `after ${transcriptions} transcriptions of "${text}" (${(samples.length / 16000).toFixed(2)}s):` +
      ` decode_ms median=${med(decodeMs)}`
  );
  console.log(`rss_after_transcriptions_mb: ${rssMB()}`);
}

if (process.argv.includes("--bench")) {
  bench(process.argv.slice(2));
} else {
  const sid = parseInt(process.argv[2] ?? "17", 10);
  const text = process.argv[3] ?? "The Eye is open, Oscar. Say the word, and I will make things happen.";
  const modelDir = process.env.DARK_EYE_VOICE_MODEL_DIR
    ? path.resolve(process.env.DARK_EYE_VOICE_MODEL_DIR)
    : FP32;
  const t0 = Date.now();
  const tts = makeTts(modelDir);
  console.log("init_ms:", Date.now() - t0, "speakers:", tts.numSpeakers, "rate:", tts.sampleRate);
  const t1 = Date.now();
  const audio = tts.generate({ text, sid, speed: 1.0 });
  console.log("gen_ms:", Date.now() - t1, "samples:", audio.samples.length, "sampleRate:", audio.sampleRate);
  const out = path.join(__dirname, `test-sid${sid}.wav`);
  sherpa.writeWave(out, { samples: audio.samples, sampleRate: audio.sampleRate });
  console.log("wrote:", out);
}
