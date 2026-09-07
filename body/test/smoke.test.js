/** Smoke test: the kept files, the models, and the voice worker under plain node. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");

const root = path.join(__dirname, "..");

test("kept files are present", () => {
  for (const f of ["src/main.js", "src/voice.js", "src/canvas/index.html", "src/canvas/preload.js", "render/target/release/eye-render"]) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test("models are on disk", () => {
  assert.ok(fs.existsSync(path.join(root, "models/kokoro-multi-lang-v1_0/model.onnx")));
  assert.ok(fs.existsSync(path.join(root, "models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx")));
});

test("the body has no Electron left in it", () => {
  const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
  assert.ok(!/require\("electron"\)/.test(main), "main.js must load under plain node");
});

// the real models: ~5 s of loading, the only test that touches them
test("voice.js runs under a plain fork and answers init with ready", { timeout: 120_000 }, async () => {
  const child = fork(path.join(root, "src/voice.js"), [], { serialization: "advanced", execArgv: [], stdio: "ignore" });
  try {
    const ready = new Promise((resolve, reject) => {
      child.on("message", (m) => (m.type === "err" ? reject(new Error(m.message)) : resolve(m)));
      child.on("error", reject);
    });
    child.send({
      type: "init",
      modelDir: path.join(root, "models/kokoro-multi-lang-v1_0"),
      asrDir: path.join(root, "models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"),
      sid: 17,
    });
    const m = await ready;
    assert.equal(m.type, "ready");
    assert.ok(m.speakers > 0);
    assert.equal(m.sampleRate, 24000);
    assert.equal(m.asr, true);
  } finally {
    child.on("error", () => {}); // the channel can reset under the kill
    child.kill();
  }
});
