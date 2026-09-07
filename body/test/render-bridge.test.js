/** render.js — the render socket, the messages both ways and the respawn. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { createRenderBridge, socketPath, ownerCaption } = require("../src/render");
const { createOrbiters } = require("../src/orbiters");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-test-"));
// a fake eye-render: connects, says ready, echoes what it is told, dies on `die`
const FAKE = path.join(dir, "fake-render.js");
fs.writeFileSync(
  FAKE,
  `const net = require("node:net");
   const c = net.connect(process.argv[2], () => c.write(JSON.stringify({ type: "ready", x: 1010, y: 372, w: 340, h: 380 }) + "\\n"));
   let buf = "";
   c.on("data", (d) => {
     buf += d;
     const lines = buf.split("\\n");
     buf = lines.pop();
     for (const l of lines) {
       if (!l.trim()) continue;
       const m = JSON.parse(l);
       if (m.type === "die") process.exit(7);
       c.write(JSON.stringify({ type: "echo", of: m }) + "\\n");
     }
   });`
);

/** A bridge on its own socket, with every message it received. */
function bridgeOf(extra = {}) {
  const sock = path.join(dir, `${Math.random().toString(36).slice(2)}.sock`);
  const seen = [];
  const b = createRenderBridge({
    bin: process.execPath,
    args: [FAKE, sock],
    sock,
    onMessage: (m) => seen.push(m),
    respawnMs: 50,
    ...extra,
  });
  return { b, seen, sock };
}

/** Wait until `f()` is true, or fail after 5 s. */
async function until(f, what) {
  for (let i = 0; i < 500; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("the socket path is under XDG_RUNTIME_DIR", () => {
  assert.strictEqual(socketPath(), path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "dark-eye", "render.sock"));
});

test("the renderer connects, its ready arrives, and what main sends reaches it", async () => {
  const { b, seen, sock } = bridgeOf();
  try {
    await until(() => seen.some((m) => m.type === "ready"), "ready");
    assert.strictEqual((fs.statSync(sock).mode & 0o777).toString(8), "600");
    b.send({ type: "ptt", on: true });
    await until(() => seen.some((m) => m.type === "echo" && m.of.type === "ptt" && m.of.on === true), "the echo");
  } finally {
    b.stop();
  }
});

test("a renderer that dies is respawned", async () => {
  const { b, seen } = bridgeOf();
  try {
    await until(() => seen.filter((m) => m.type === "ready").length === 1, "the first ready");
    b.send({ type: "die" });
    await until(() => seen.filter((m) => m.type === "ready").length === 2, "the second ready");
  } finally {
    b.stop();
  }
});

test("stop kills the renderer and removes the socket", async () => {
  const { b, seen, sock } = bridgeOf();
  await until(() => seen.some((m) => m.type === "ready"), "ready");
  b.stop();
  assert.strictEqual(fs.existsSync(sock), false);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(seen.filter((m) => m.type === "ready").length, 1, "no respawn after stop");
});

test("a second eye-render is refused, not swapped in — the storm fix", async () => {
  const logs = [];
  const { b, seen, sock } = bridgeOf({ log: (m) => logs.push(m) });
  try {
    await until(() => seen.some((m) => m.type === "ready"), "the real renderer's ready");
    const second = net.connect(sock);
    await until(() => logs.includes("render socket: second eye-render refused"), "the refusal log");
    await until(() => second.destroyed || second.readyState === "closed", "the second socket closed");
    seen.length = 0;
    b.send({ type: "ptt", on: true });
    await until(() => seen.some((m) => m.type === "echo" && m.of.type === "ptt"), "the first renderer still served");
  } finally {
    b.stop();
  }
});

test("a render socket that cannot be listened on is fatal — no eye, no unit", async () => {
  const ro = fs.mkdtempSync(path.join(dir, "ro-"));
  fs.chmodSync(ro, 0o500);
  const fatals = [];
  const b = createRenderBridge({
    bin: process.execPath,
    args: [FAKE],
    sock: path.join(ro, "render.sock"),
    onFatal: (e) => fatals.push(e),
    log: () => {},
  });
  try {
    await until(() => fatals.length === 1, "the fatal");
  } finally {
    fs.chmodSync(ro, 0o700);
    b.stop();
  }
});

test("what he says becomes a full caption in his own voice, not a one-line marker", async () => {
  assert.deepStrictEqual(ownerCaption("que estas haciendo"), {
    type: "speak",
    text: "que estas haciendo",
    who: "owner",
  });
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const onTranscript = main.slice(main.indexOf("function onTranscript"), main.indexOf("function startVoice"));
  assert.match(
    onTranscript,
    /captionDelta\(ear\.shown, text\)[\s\S]*render\?\.send\(\{ \.\.\.ownerCaption\(delta\.text\)/,
    "a transcript finishes his caption instead of repeating the partials"
  );
  assert.doesNotMatch(onTranscript, /type: "heard"/, "and not as the truncated heard line");

  const { b, seen } = bridgeOf();
  try {
    await until(() => seen.some((m) => m.type === "ready"), "ready");
    b.send(ownerCaption("que estas haciendo"));
    await until(() => seen.some((m) => m.type === "echo" && m.of.who === "owner"), "the caption at the renderer");
    const echo = seen.find((m) => m.type === "echo" && m.of.who === "owner").of;
    assert.strictEqual(echo.type, "speak");
    assert.strictEqual(echo.text, "que estas haciendo");
    assert.strictEqual(echo.ms, undefined, "no audio behind it: it decodes at the default 38 cps");
  } finally {
    b.stop();
  }
});

test("a renderer respawn gets the working orbiters back, as main puts them back", async () => {
  const orbiters = createOrbiters({ file: path.join(dir, "orbiters.json"), send: (m) => b.send(m) });
  orbiters.set({ id: "e31", state: "working", label: "auto orbiters" });
  const { b, seen } = bridgeOf({});
  const echoes = () => seen.filter((m) => m.of?.id === "e31").length;
  await until(() => seen.some((m) => m.type === "ready"), "the first ready");
  orbiters.replay();
  await until(() => echoes() === 1, "the first orbiter");
  b.send({ type: "die" });
  await until(() => seen.filter((m) => m.type === "ready").length === 2, "the respawned renderer");
  orbiters.replay(); // what main.js does on every `ready`
  await until(() => echoes() === 2, "the orbiter after the respawn");
  b.stop();
  orbiters.stop();
});
