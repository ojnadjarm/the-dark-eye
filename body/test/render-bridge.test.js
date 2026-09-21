/** render.js — the render socket, the messages both ways and the respawn. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { createRenderBridge, socketPath, ownerCaption } = require("../src/render");
const { createOrbiters } = require("../src/orbiters");
const { createHold } = require("../src/hold");
const { createMode } = require("../src/mode");

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

test("a brain switch reaches the eye as a session message, a whisper, the name — and never a bus", async () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const onTranscript = main.slice(main.indexOf("function onTranscript"), main.indexOf("function startVoice"));
  assert.match(onTranscript, /intent\.kind === "brain"\) return void onBrainIntent\(intent\.name, intent\.words, intent\.lang\)[\s\S]*brains\.push/, "the switch returns before his words are pushed");
  const end = main.indexOf("if (brains.active !== cfg.defaultChannel)");
  assert.ok(end > 0, "the anchor the wiring slice ends on is still in main.js");
  const wiring = main.slice(main.indexOf("setActive = createSwitch({"), end);
  assert.ok(wiring.length < 400, `the slice is the wiring alone, not the file's tail (${wiring.length} chars)`);
  assert.match(wiring, /onSwitch: \(r, name\) => \(showActive\(\), showMarks\(\), replies\.brains\(channelRoster\(\)\), showNotes\(name\)\)/, "session, the eye's ring, the phone's roster and the channel's waiting notes on every switch");
  const remote = main.slice(main.indexOf("startRemote({"), main.lastIndexOf("startVoice(cfg)"));
  assert.match(remote, /onBrains: \(\) => channelRoster\(\),\n\s*onActive: \(name\) => setActive\(name\),/, "the phone chips read and move the active brain");
  const showActive = main.slice(main.indexOf("function showActive"), main.indexOf("function activeColor"));
  assert.match(showActive, /render\?\.send\(\{ type: "session", active: b\.name, label: b\.label, color: b\.color \}\)/);
  const onBrain = main.slice(main.indexOf("function onBrainIntent"), main.indexOf("// -- the bridge"));
  assert.match(onBrain, /if \(name === null\) return void say\(labelOf\(brains\.active\)\)/, "who is listening: the label, no switch");
  assert.doesNotMatch(onBrain, /return void say\(`\$\{words \?\? name\} is not listening/, "a deaf mode is entered, not refused (plan §1.7)");
  assert.match(onBrain, /say\(words \?\? b\.label, b\.voice, lastSource, b\.color\);\n\s*setActive\(name, words \?\? b\.label, lang\)/, "the channel label, in its own voice and mark colour");
  assert.match(main.slice(main.indexOf('m.type === "ready"')), /^[\s\S]{0,300}showActive\(\)/, "a respawned renderer gets the active brain back");

  const { b, seen } = bridgeOf();
  try {
    await until(() => seen.some((m) => m.type === "ready"), "ready");
    b.send({ type: "session", active: "notes", label: "Notes", color: "#4dd9ff" });
    await until(() => seen.some((m) => m.of?.type === "session"), "the session at the renderer");
    assert.deepStrictEqual(seen.find((m) => m.of?.type === "session").of, {
      type: "session",
      active: "notes",
      label: "Notes",
      color: "#4dd9ff",
    });
  } finally {
    b.stop();
  }
});

test("the session payload the body now sends still parses under sched.rs's Msg::Session", () => {
  // H02a adds `label`; the renderer reads the colour alone. No Rust changes — this asserts the Rust it must fit.
  const sched = fs.readFileSync(path.join(__dirname, "..", "render", "src", "sched.rs"), "utf8");
  const variant = sched.match(/Session \{([^}]*)\}/)[1];
  const fields = [...variant.matchAll(/(\w+): String/g)].map((m) => m[1]);
  assert.deepStrictEqual(fields, ["active", "color"], "the two fields the renderer reads are unchanged");
  assert.doesNotMatch(sched, /deny_unknown_fields/, "an unknown field is ignored, not an error");
  const payload = { type: "session", active: "brother", label: "Diego", color: "#123456" };
  for (const f of fields) assert.equal(typeof payload[f], "string", `${f} is still a string in the payload`);
  assert.deepStrictEqual(
    Object.fromEntries(fields.map((f) => [f, payload[f]])),
    { active: "brother", color: "#123456" },
    "what the renderer takes from the payload"
  );
});

test("what waits is a marks row: held replies in their colour, unopened visuals in green, audio notes mode as a ring", async () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const showMarks = main.slice(main.indexOf("function showMarks"), main.indexOf("function openCanvas"));
  assert.match(showMarks, /hold\.list\(\)\.map\(\(\{ color \}\) => \(\{ color, kind: "held" \}\)\)/, "one mark per held reply, in its colour");
  assert.match(showMarks, /unseenShows[\s\S]*color: EYE_GREEN, kind: "show"/, "one green mark per unopened visual");
  assert.match(showMarks, /sendMarks\(\{ type: "marks", items: \[\.\.\.held, \.\.\.shows\], mode: mode\.mode \}\)/);
  assert.match(main, /onChange: \(\) => showMarks\(\)/, "the hold reports every change");
  const setMode = main.slice(main.indexOf("function setMode"), main.indexOf("function onModeIntent"));
  assert.match(setMode, /mode\.set\(m, channel\)[\s\S]*showMarks\(\)/, "either mode redraws the row");
  assert.match(main.slice(main.indexOf('m.type === "ready"')), /^[\s\S]{0,400}showMarks\(\)/, "a respawned renderer gets the row back");
  const onShow = main.slice(main.indexOf("onShow: (v) =>"), main.indexOf("return item.id"));
  assert.match(onShow, /if \(!canvas\.isVisible\(\)\) \{\n\s*unseenShows\+\+;\n\s*showMarks\(\);/, "a visual he has not opened is a mark");
  const openCanvas = main.slice(main.indexOf("function openCanvas"), main.indexOf("/**", main.indexOf("function openCanvas")));
  assert.match(openCanvas, /canvas\.open\(\);\n\s*unseenShows = 0;\n\s*showMarks\(\);/, "opening the canvas clears them");

  const { b, seen } = bridgeOf();
  try {
    await until(() => seen.some((m) => m.type === "ready"), "ready");
    const row = { type: "marks", items: [{ color: "#4dd9ff", kind: "held" }, { color: "#4dffa0", kind: "show" }], mode: "async" };
    b.sendMarks(row);
    await until(() => seen.some((m) => m.of?.type === "marks"), "the row at the renderer");
    assert.deepStrictEqual(seen.find((m) => m.of?.type === "marks").of, row);
  } finally {
    b.stop();
  }
});

test("the same marks row twice crosses the socket once, and again after a respawn", async () => {
  const row = { type: "marks", items: [{ color: "#4dd9ff", kind: "held" }], mode: "call" };
  const { b, seen } = bridgeOf();
  const rows = () => seen.filter((m) => m.of?.type === "marks").length;
  try {
    await until(() => seen.some((m) => m.type === "ready"), "ready");
    b.sendMarks(row);
    await until(() => rows() === 1, "the row at the renderer");
    b.sendMarks({ ...row });
    b.sendMarks({ ...row });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(rows(), 1, "an identical row sends nothing");
    b.sendMarks({ ...row, mode: "async" });
    await until(() => rows() === 2, "a changed row is sent");

    b.send({ type: "die" });
    await until(() => seen.filter((m) => m.type === "ready").length === 2, "the respawned renderer");
    b.sendMarks({ ...row, mode: "async" });
    await until(() => rows() === 3, "the row again after the respawn");
  } finally {
    b.stop();
  }
});

test("one funnel for the switch, and the body starts no session", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  // what setActive does is covered behaviourally in brains.test.js; here: that all three ways reach it
  const onBrain = main.slice(main.indexOf("function onBrainIntent"), main.indexOf("// -- the bridge"));
  assert.match(onBrain, /setActive\(name, words \?\? b\.label, lang\)/, "his voice");
  assert.equal(main.match(/onActive: \(name\) => setActive\(name\),/g).length, 2, "the bridge and the phone, the one funnel");
  assert.doesNotMatch(main, /systemctl|notes-brain/, "the body starts no session");
  assert.doesNotMatch(main, /MAIN_BRAIN|NOTES_BRAIN/, "no channel name is compiled into the body");
  assert.match(
    main,
    /const channels = channelTable\(cfg, log\);\n[\s\S]{0,200}?brains = createBrains\(\{ channels, defaultChannel: cfg\.defaultChannel/,
    "the roster is the config's channel table"
  );
  assert.doesNotMatch(main, /CHANNEL_ALIASES|channelOf/, "no second name for a channel");
});

test("the channel name he hears back is marked in the channel he switched to, not the one he left", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const onBrain = main.slice(main.indexOf("function onBrainIntent"), main.indexOf("// -- the bridge"));
  assert.match(onBrain, /say\(words \?\? b\.label, b\.voice, lastSource, b\.color\)/, "the new brain's colour, read before the switch, not `say`'s activeColor() default");
  assert.match(main, /function say\(text, sid, to = lastSource, color = activeColor\(\)(, again = false)?\)/, "the default is only for the body's own lines");
});

test("who is listening answers the label, and an unknown name reads back the route list of labels", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const src =
    main.slice(main.indexOf("function labelOf"), main.indexOf("/** The active brain's colour")) +
    main.slice(main.indexOf("function onBrainIntent"), main.indexOf("// -- the bridge"));
  // the shipped functions themselves, with the body around them stubbed
  const build = new Function("brains", "say", "setActive", "lastSource", `${src}\nreturn onBrainIntent;`);
  const rows = [
    { name: "main", label: "main", color: "#b04dff", voice: 17 },
    { name: "brother", label: "Diego", color: "#123456", voice: 12 },
  ];
  const run = (active = "brother") => {
    const said = [];
    const switched = [];
    const fn = build(
      { get active() { return active; }, roster: () => ({ active, brains: rows }) },
      (...a) => said.push(a),
      (...a) => switched.push(a),
      "local"
    );
    return { fn, said, switched };
  };

  let t = run("brother");
  t.fn(null);
  assert.deepStrictEqual(t.said, [["Diego"]], "who is listening: the label of the active channel");
  assert.deepStrictEqual(t.switched, [], "the question is not a switch");

  t = run();
  t.fn("ghost");
  assert.deepStrictEqual(t.said, [["I can route you to: main, Diego"]], "the route list is labels");
  assert.deepStrictEqual(t.switched, []);

  t = run("main");
  t.fn("brother");
  assert.deepStrictEqual(t.said, [["Diego", 12, "local", "#123456"]], "the label back, in that channel's voice and colour");
  assert.deepStrictEqual(t.switched, [["brother", "Diego", undefined]]);

  t = run("main");
  t.fn("brother", "my brother", "es");
  assert.deepStrictEqual(t.said, [["my brother", 12, "local", "#123456"]], "his own words still win over the label");
  assert.deepStrictEqual(t.switched, [["brother", "my brother", "es"]]);
});

test("his words for the mode: one line in the channel's voice, said before the mode takes effect", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const at = main.indexOf("function onModeIntent");
  // to its own closing brace, not to whatever comment happens to follow it
  const src = main.slice(at, main.indexOf("\n}\n", at) + 2);
  const NOTES = { name: "notes", voice: 42, color: "#4dd9ff" };
  // the shipped function itself, with the body around it stubbed: nothing is copied here
  const build = new Function("mode", "hold", "say", "setMode", "activeBrain", "cfg", "lastSource", `${src}\nreturn onModeIntent;`);
  const run = (start, held = 0) => {
    const state = { mode: start, get async() { return this.mode === "async"; } };
    const events = [];
    const fn = build(
      state,
      { get held() { return held; } },
      (text, sid, to, color, again) => events.push({ say: text, sid, to, color, again, parked: state.async && !again }),
      (m) => (state.mode = m, events.push({ mode: m })),
      () => NOTES,
      { voiceSid: 17 },
      "local",
    );
    return { fn, events, state };
  };

  // into audio notes mode: his own words, the channel's voice and colour, then the silence
  let { fn, events, state } = run("call");
  fn("async", "audio notes");
  assert.deepStrictEqual(events, [
    { say: "audio notes", sid: 42, to: "local", color: "#4dd9ff", again: true, parked: false },
    { mode: "async" },
  ], "spoken in the room first, the mode after it");
  assert.equal(state.mode, "async");

  // the way back: the confirmation goes ahead of the queue it releases, never parked
  ({ fn, events } = run("async", 3));
  fn("call", "talk to me");
  assert.deepStrictEqual(events, [
    { say: "talk to me", sid: 42, to: "local", color: "#4dd9ff", again: true, parked: false },
    { mode: "call" },
  ], "the bypass carries it past the park of the mode he is leaving");

  // a Spanish way in is answered in Spanish, and "quiet" in its own word
  for (const [name, words] of [["async", "notas de audio"], ["call", "modo llamada"], ["async", "quiet"]]) {
    ({ fn, events } = run(name === "async" ? "call" : "async"));
    fn(name, words);
    assert.equal(events[0].say, words, words);
  }

  // the mode he is in: no second confirmation, and in audio notes not a sound
  ({ fn, events } = run("async"));
  fn("async", "audio notes");
  assert.deepStrictEqual(events, [], "a repeat says nothing and switches nothing");
  ({ fn, events } = run("call", 2));
  fn("call", "talk to me");
  assert.deepStrictEqual(events, [], "with something waiting the queue drains on its own");
  ({ fn, events } = run("call"));
  fn("call", "talk to me");
  assert.deepStrictEqual(events, [{ say: "here", sid: 17, to: undefined, color: undefined, again: undefined, parked: false }], "nothing waiting: the Eye answers here, in its own voice");
});

test("a mode phrase is a mode and nothing else: no channel switch, no deaf notice, one notice window", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const onTranscript = main.slice(main.indexOf("function onTranscript"), main.indexOf("function startVoice"));
  assert.match(onTranscript, /if \(intent\.kind === "mode"\) return void onModeIntent\(intent\.name, intent\.words\);/, "the words he used are what is said back");
  assert.match(onTranscript, /kind === "mode"\)[\s\S]*brains\.push/, "a mode never reaches the brain, the roster or the deaf notice");
  assert.equal(main.match(/createNotice\(\)/g).length, 1, "one deaf-notice window, shared by the switch and his words");
  const onMode = main.slice(main.indexOf("function onModeIntent"));
  assert.doesNotMatch(onMode.slice(0, onMode.indexOf("\n}")), /setActive|brains\.setActive/, "a mode leaves the channel where it was");
});

/**
 * The shipped `say`, `setMode` and `onModeIntent` over the real `hold.js` and `mode.js`
 * on a fake clock: nothing about the parking rule is recomputed here, so the order he
 * hears is the body's own.
 */
function modeBody(start) {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  /** One shipped function, from its declaration to its own closing brace. */
  const cut = (from) => {
    const at = main.indexOf(from);
    return main.slice(at, main.indexOf("\n}\n", at) + 2);
  };
  const src = [cut("function say("), cut("function setMode"), cut("function onModeIntent")].join("\n");

  const file = path.join(dir, `mode-${Math.random().toString(36).slice(2)}.json`);
  // the harness is one channel: its mode is the active channel's, as the body reads it
  const mode = createMode({ file, quietFile: path.join(dir, "no-quiet.json"), active: () => "notes" });
  if (start !== mode.mode) mode.set(start);

  let now = 0;
  const due = [];
  const spoken = [];
  const state = { mic: false };
  const timers = {
    setTimeout: (f, ms) => (due.push({ at: now + ms, f }), due[due.length - 1]),
    clearTimeout: (t) => t && due.splice(due.indexOf(t), 1),
  };
  const sends = []; // the whole item, `to` included: `spoken` is the room's words alone
  const hold = createHold({
    send: (i) => (sends.push(i), spoken.push(i.text)),
    busy: () => state.mic,
    parked: () => mode.async,
    now: () => now,
    timers,
  });
  const NOTES = { name: "notes", voice: 42, color: "#4dd9ff" };
  const made = []; // the voices asked for at park time: eager work, never a release
  const fns = new Function(
    "mode", "hold", "show", "whisper", "log", "showMarks", "activeColor", "activeBrain",
    "cfg", "lastSource", "voiceReady", "pendingSpeech", "replies", "brains", "toWire", "eager",
    "channelRoster",
    `${src}\nreturn { say, setMode, onModeIntent };`,
  )(mode, hold, () => {}, () => {}, () => {}, () => {}, () => NOTES.color, () => NOTES,
    { voiceSid: 17 }, "local", true, [], { brains: () => {} }, { roster: () => ({}), active: "notes" }, (m) => m,
    { queue: (seq, text) => made.push(text) }, () => ({}));
  // `toWire` here is the identity: this harness tests ordering, not the wire words — a wrong
  // word published by `setMode` would pass. `remote-mode.test.js` is what covers the wire format.

  const tick = (ms) => {
    now += ms;
    for (const t of due.filter((t) => t.at <= now)) {
      due.splice(due.indexOf(t), 1);
      t.f();
    }
  };
  return { ...fns, mode, hold, state, spoken, sends, made, tick };
}

test("the way back is heard before the queue it releases, and the way in takes nothing with it", () => {
  // into audio notes mode: the confirmation drains alone, what was waiting stays waiting
  let b = modeBody("call");
  b.state.mic = true;
  b.say("reply one", 17);
  b.say("reply two", 17);
  b.state.mic = false;
  b.hold.heard();
  b.onModeIntent("async", "audio notes");
  b.tick(1500);
  assert.deepStrictEqual(b.spoken, ["audio notes"], "his confirmation, and not one parked reply with it");
  assert.deepStrictEqual(b.hold.list().map((i) => i.text), ["reply one", "reply two"]);
  b.tick(60_000);
  assert.deepStrictEqual(b.spoken, ["audio notes"], "no timer ever lets a parked reply out");

  // the way back: the confirmation first, then what it releases, in order
  b = modeBody("async");
  b.say("reply one", 17);
  b.say("reply two", 17);
  // parked: each reply's voice is asked for where it is parked, and nothing is released by asking
  assert.deepStrictEqual(b.made, ["reply one", "reply two"]);
  assert.deepStrictEqual(b.spoken, [], "asking for the voice let a parked reply out to the room");
  b.state.mic = true;
  b.state.mic = false;
  b.hold.heard();
  b.onModeIntent("call", "talk to me");
  b.tick(1500);
  assert.deepStrictEqual(b.spoken, ["talk to me", "reply one", "reply two"], "the way back is spoken ahead of the queue, not behind it");
  assert.strictEqual(b.mode.mode, "call");
});

test("an answer to something he said on the phone never reaches the room's mouth, in either mode", () => {
  for (const start of ["async", "call"]) {
    const b = modeBody(start);
    b.say("your build is green", 17, "remote");
    const item = b.hold.list()[0] ?? b.sends[0];
    assert.strictEqual(item.to, "remote", `${start}: a remote-sourced reply is offered to the phone, not the room`);
  }
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const say = main.slice(main.indexOf("function say("), main.indexOf("function onReplay"));
  assert.match(say, /hold\.offer\(\{ text, sid, to, color, bypass: again \}\)/, "the mode no longer rewrites `to` to the room");
  const audio = main.slice(main.indexOf('} else if (m.type === "audio")'), main.indexOf('} else if (m.type === "transcript" && m.partial)'));
  assert.match(audio, /if \(to !== "remote"\)\n\s*audio\.play\(/, "a reply bound for the phone is never played in the room");
});

test("his \u25b6 in audio notes mode is said, not parked and not made a second time", () => {
  const b = modeBody("async");
  b.say("reply one", 17, "remote", "#4dd9ff", true);
  assert.deepStrictEqual(b.made, [], "the replay was queued as if it were a new note");
  assert.deepStrictEqual(b.spoken, ["reply one"], "what he asked for was parked");
});
