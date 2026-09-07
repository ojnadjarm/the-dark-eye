/** voice.js — one `last` or `err` per sentence, so one failing sentence drops no others. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");

const VOICE = path.join(__dirname, "..", "src", "voice.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-test-"));

// a Kokoro that answers four samples per sentence and throws on "boom"
const FAKE = path.join(dir, "fake-sherpa.js");
fs.writeFileSync(
  FAKE,
  `class OfflineTts {
     constructor() { this.numSpeakers = 2; this.sampleRate = 24000; }
     generate({ text }) {
       if (text.includes("boom")) throw new Error("kokoro exploded");
       return { samples: new Float32Array(4), sampleRate: 24000 };
     }
   }
   class OfflineRecognizer {}
   module.exports = { OfflineTts, OfflineRecognizer };`
);
const PRELOAD = path.join(dir, "preload.js");
fs.writeFileSync(
  PRELOAD,
  `const Module = require("node:module");
   const load = Module._load;
   Module._load = function (req, ...rest) {
     return req === "sherpa-onnx-node" ? require(process.env.FAKE_SHERPA) : load.call(this, req, ...rest);
   };`
);

// chunks() merges short sentences, so each one here is long enough to stand alone
const S = (word) => `${word} ${"la".repeat(110)}.`;

/** Wait until `f()` is true, or fail after 5 s. */
async function until(f, what) {
  for (let i = 0; i < 500; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A voice worker on the fake Kokoro, with everything it has posted. */
async function workerOf() {
  const child = fork(VOICE, [], {
    serialization: "advanced",
    execArgv: ["--require", PRELOAD],
    stdio: "ignore",
    env: { ...process.env, FAKE_SHERPA: FAKE },
  });
  const msgs = [];
  child.on("message", (m) => msgs.push(m));
  child.send({ type: "init", modelDir: dir, sid: 1 });
  await until(() => msgs.some((m) => m.type === "ready"), "ready");
  return { child, msgs, said: () => msgs.filter((m) => m.type !== "ready").map((m) => [m.type, m.seq, m.last]) };
}

test("a sentence that fails posts err and the sentences after it still speak", async () => {
  const { child, msgs, said } = await workerOf();
  try {
    child.send({ type: "speak", id: 1, text: [S("one"), S("boom"), S("three")].join(" ") });
    await until(() => msgs.some((m) => m.last === true), "the last chunk");
    assert.deepStrictEqual(said(), [
      ["audio", 0, false],
      ["err", 1, false],
      ["audio", 2, true],
    ]);
    assert.deepStrictEqual(
      msgs.filter((m) => m.seq !== undefined).map((m) => m.text),
      [S("one"), S("boom"), S("three")],
      "every chunk carries its own sentence, so the caption can follow it"
    );
  } finally {
    child.kill();
  }
});

test("a failing last sentence still closes the utterance", async () => {
  const { child, msgs, said } = await workerOf();
  try {
    child.send({ type: "speak", id: 1, text: [S("one"), S("boom")].join(" ") });
    await until(() => msgs.some((m) => m.last === true), "the last chunk");
    assert.deepStrictEqual(said(), [
      ["audio", 0, false],
      ["err", 1, true],
    ]);
  } finally {
    child.kill();
  }
});

test("two utterances back to back keep their chunks apart — one mouth", async () => {
  const { child, msgs } = await workerOf();
  try {
    child.send({ type: "speak", id: 1, text: [S("one"), S("two")].join(" ") });
    child.send({ type: "speak", id: 2, text: [S("three"), S("four")].join(" ") });
    await until(() => msgs.filter((m) => m.last === true).length === 2, "both utterances");
    assert.deepStrictEqual(
      msgs.filter((m) => m.seq !== undefined).map((m) => [m.id, m.seq]),
      [
        [1, 0],
        [1, 1],
        [2, 0],
        [2, 1],
      ],
      "the second utterance waits for the first to finish"
    );
  } finally {
    child.kill();
  }
});
