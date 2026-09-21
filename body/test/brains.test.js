/** Named brains: buses, the active one, colours, a channel's waiting notes, the switch file — alone and behind the bridge. */
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBrains, createSwitch, createNotice, cleanLabel, COLORS, EYE_SID } = require("../src/brains");
const { createHold } = require("../src/hold");
const { createMode } = require("../src/mode");
const { createNotes } = require("../src/notes-list");
const { startServer } = require("../src/server");

const MAIN = { color: "#b04dff", voice: 17 };
const SECRET = "s3cret-key";
let dir;
let file;
let said;
let notes;

const hue = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "brains-"));
  file = path.join(dir, "active.json");
  said = [];
  notes = createNotes({ file: path.join(dir, "notes.json") });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const make = (channels = {}, defaultChannel = "main") =>
  createBrains({ channels: { main: MAIN, ...channels }, defaultChannel, file, notes, say: (...a) => said.push(a) });

test("main is the only brain at start, active, with the config colour and voice", () => {
  const b = make();
  assert.equal(b.active, "main");
  assert.deepEqual(b.roster(), {
    active: "main",
    brains: [{ name: "main", label: "main", color: "#b04dff", voice: 17, connected: false, waiting: 0 }],
  });
});

test("an unknown name joins with a free colour and a free non-Eye voice; a wanted voice is honoured if free", () => {
  const b = make();
  b.register("notes");
  b.register("fast", 13);
  b.register("greedy", 17);
  b.register("copycat", 13);
  const by = Object.fromEntries(b.roster().brains.map((x) => [x.name, x]));
  assert.equal(by.notes.color, "#4dd9ff");
  assert.equal(by.fast.voice, 13);
  assert.notEqual(by.greedy.voice, EYE_SID);
  assert.notEqual(by.copycat.voice, 13);
  const colors = Object.values(by).map((x) => x.color);
  assert.equal(new Set(colors).size, colors.length, "no two brains share a colour");
  for (const c of colors) {
    assert.ok(COLORS.includes(c), c);
    assert.ok(Math.abs(hue(c) - 152) > 30, `${c} is not the Eye's green`);
  }
});

test("his words go to the active bus only", async () => {
  const b = make();
  b.register("notes");
  b.push({ text: "for main" });
  assert.deepEqual(await b.take("main", 20), { text: "for main" });
  assert.equal(await b.take("notes", 20), null);
  b.setActive("notes");
  b.push({ text: "for notes" });
  assert.equal(await b.take("main", 20), null);
  assert.deepEqual(await b.take("notes", 20), { text: "for notes" });
});

test("connected means a listen pending, or one within the grace window", async () => {
  const b = make();
  assert.equal(b.connected("main"), false);
  const pending = b.take("main", 200);
  assert.equal(b.connected("main"), true);
  b.push("x");
  await pending;
  assert.equal(b.connected("main"), true);
  assert.equal(b.connected("nobody"), false);
});

test("speech from the active brain is said in its voice; another brain's becomes a waiting note", () => {
  const b = make();
  assert.equal(b.speak(undefined, "hello", undefined, "remote"), 0);
  assert.deepEqual(said, [["hello", 17, "remote"]]);
  said = [];
  assert.equal(b.speak("notes", "one", undefined, undefined), 1);
  assert.equal(b.speak("notes", "two", 5, "local"), 2);
  assert.deepEqual(said, []);
  assert.equal(b.roster().brains.find((x) => x.name === "notes").waiting, 2);
  const roster = b.setActive("notes");
  assert.deepEqual(said, [], "the switch says nothing at all: H09 deleted the monologue");
  assert.equal(roster.active, "notes");
  assert.equal(roster.brains.find((x) => x.name === "notes").waiting, 2, "his \u25b6 is what empties the list, not the switch");
  assert.deepEqual(notes.list("notes").map((n) => n.text), ["one", "two"], "arrival order");
});

test("a channel's notes keep the newest 20", () => {
  const b = make();
  for (let i = 0; i < 25; i++) b.speak("notes", `w${i}`);
  assert.equal(b.roster().brains.find((x) => x.name === "notes").waiting, 20);
  assert.deepEqual(notes.list("notes").map((n) => n.text), Array.from({ length: 20 }, (_, i) => `w${i + 5}`));
  assert.deepEqual(said, []);
});

test("a note plays through the press path alone, and only that note stops waiting", () => {
  const b = make();
  for (const w of ["one", "two", "three"]) b.speak("notes", w);
  b.setActive("notes");
  assert.equal(notes.played("notes", "two"), true);
  assert.equal(b.roster().brains.find((x) => x.name === "notes").waiting, 2);
  assert.deepEqual(notes.list("notes").map((n) => n.text), ["one", "three"], "the other two are untouched, in any order");
  assert.equal(notes.played("notes", "two"), false, "a note plays once");
  assert.deepEqual(said, []);
});

test("an unknown name cannot become active", () => {
  const b = make();
  assert.equal(b.setActive("ghost"), null);
  assert.equal(b.active, "main");
  assert.ok(!fs.existsSync(file));
});

test("the switch is written to active.json and read back on start; a bad file means main", () => {
  const b = make({ notes: {} });
  b.setActive("notes");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { active: "notes" });
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  const again = make({ notes: {} });
  assert.equal(again.active, "notes");
  assert.ok(again.roster().brains.some((x) => x.name === "notes"));
  fs.writeFileSync(file, '{"active":"Not A Name"}');
  assert.equal(make({ notes: {} }).active, "main");
  fs.writeFileSync(file, "garbage");
  assert.equal(make({ notes: {} }).active, "main");
});

test("a file naming a channel this body does not have is main, and puts nobody on the roster", () => {
  const lines = [];
  for (const body of ['{"active":"ghost"}', '{"active":"vault"}', '{"active":""}', '{"active":42}', "{}"]) {
    fs.writeFileSync(file, body);
    const b = createBrains({
      channels: { main: MAIN, notes: {} },
      defaultChannel: "main",
      file,
      say: () => {},
      log: (m) => lines.push(m),
    });
    assert.equal(b.active, "main", body);
    assert.deepEqual(
      b.roster().brains.map((x) => x.name),
      ["main", "notes"],
      `${body}: a name from the file is never a channel of its own`
    );
  }
  const refused = lines.filter((m) => m.includes("is not a channel"));
  assert.equal(refused.length, 4, "the four named ones are logged, the empty object is not");
  assert.match(refused[0], /"ghost" is not a channel/);
});

// -- behind the bridge, wired as main.js wires it -----------------------------

async function body(defaultChannel = "main", channels = {}) {
  const brains = make(channels, defaultChannel);
  const whispers = [];
  const server = startServer({
    port: 0,
    secret: SECRET,
    onSpeak: ({ text, voice, to, brain = defaultChannel }) => {
      const parked = brains.speak(brain, text, voice, to);
      if (parked) whispers.push(`⟨ ${brain} ⟩ ${parked} waiting`);
    },
    onListen: (ms, brain = defaultChannel, voice) => brains.take(brain, ms, voice),
    onBrains: () => brains.roster(),
    onActive: (name) => brains.setActive(name),
    onMic: () => false,
    onMicOpen: () => false,
    onStatus: () => {},
    onShow: () => "1",
  });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p, { headers: { "x-dark-eye-key": SECRET } });
  const post = (p, b) =>
    fetch(base + p, { method: "POST", headers: { "x-dark-eye-key": SECRET }, body: JSON.stringify(b) });
  const json = async (r) => (await r).json();
  return { brains, whispers, get, post, json, close: () => server.close() };
}

test("an unnamed listen is main; a named one hears only while its brain is active", async () => {
  const t = await body();
  try {
    t.brains.push({ text: "first" });
    assert.deepEqual(await t.json(t.get("/bridge/listen?timeoutMs=50")), { transcript: "first", source: "local" });
    const notes = t.json(t.get("/bridge/listen?timeoutMs=300&brain=notes&voice=12"));
    t.brains.push({ text: "still main" });
    assert.deepEqual(await notes, { transcript: null, source: "local" });
    assert.deepEqual(await t.json(t.get("/bridge/listen?timeoutMs=50")), { transcript: "still main", source: "local" });
    assert.equal(t.brains.roster().brains.find((b) => b.name === "notes").voice, 12);
  } finally {
    t.close();
  }
});

test("the switch routes later words, and the roster shows who is active and connected", async () => {
  const t = await body();
  try {
    await t.get("/bridge/listen?timeoutMs=10&brain=notes"); // the listen is what registers a brain
    const set = await t.json(t.post("/bridge/brains/active", { brain: "notes" }));
    assert.equal(set.ok, true);
    assert.equal(set.active, "notes");
    t.brains.push({ text: "now notes" });
    assert.deepEqual(await t.json(t.get("/bridge/listen?timeoutMs=50")), { transcript: null, source: "local" });
    assert.deepEqual(await t.json(t.get("/bridge/listen?timeoutMs=50&brain=notes")), { transcript: "now notes", source: "local" });
    const pending = t.get("/bridge/listen?timeoutMs=500&brain=notes");
    await new Promise((r) => setTimeout(r, 30));
    const roster = await t.json(t.get("/bridge/brains"));
    assert.equal(roster.active, "notes");
    assert.deepEqual(roster.brains.map((b) => [b.name, b.connected]), [["main", true], ["notes", true]]);
    const h = await t.json(t.get("/bridge/health"));
    assert.equal(h.active, "notes");
    assert.equal(h.brainListening, true);
    t.brains.push("bye");
    await pending;
  } finally {
    t.close();
  }
});

test("speak for a brain that is not active notes it and whispers the count; the switch says nothing", async () => {
  const t = await body();
  try {
    await t.json(t.post("/bridge/speak", { text: "noted", brain: "notes" }));
    assert.deepEqual(said, []);
    assert.deepEqual(t.whispers, ["⟨ notes ⟩ 1 waiting"]);
    assert.equal((await t.json(t.get("/bridge/brains"))).brains.find((b) => b.name === "notes").waiting, 1);
    const after = await t.json(t.post("/bridge/brains/active", { brain: "notes" }));
    assert.deepEqual(said, [], "the switch speaks nothing on his behalf");
    assert.equal(after.brains.find((b) => b.name === "notes").waiting, 1);
    await t.json(t.post("/bridge/speak", { text: "again", brain: "notes" }));
    assert.equal(said.length, 1, "that channel is active now: its next reply is said, not noted");
  } finally {
    t.close();
  }
});

test("bad names are 400 on listen, speak and active; an unknown name on active is 400", async () => {
  const t = await body();
  try {
    assert.equal((await t.get("/bridge/listen?timeoutMs=10&brain=Notes!")).status, 400);
    assert.equal((await t.post("/bridge/speak", { text: "x", brain: "Notes!" })).status, 400);
    assert.equal((await t.post("/bridge/brains/active", { brain: "Notes!" })).status, 400);
    assert.equal((await t.post("/bridge/brains/active", { brain: "ghost" })).status, 400);
    assert.equal((await t.post("/bridge/brains/active", {})).status, 400);
    assert.deepEqual(t.brains.roster().brains.map((b) => b.name), ["main"]);
  } finally {
    t.close();
  }
});

test("a mode nobody listens on is still switched to, and his words park on its bus (plan §1.7)", async () => {
  const b = make();
  b.register("notes");
  assert.equal(b.connected("notes"), false);
  const roster = b.setActive("notes");
  assert.equal(roster.active, "notes", "the switch he asked for happens on a deaf channel");
  assert.equal(roster.brains.find((x) => x.name === "notes").connected, false);
  b.push({ text: "the thought he dictated" });
  assert.equal(await b.take("main", 20), null, "it never reaches the other brain");
  assert.deepEqual(await b.take("notes", 20), { text: "the thought he dictated" }, "it waits on the notes bus");
});

// -- the switch funnel, wired as main.js wires it -----------------------------

/** `createSwitch` with the real mode and the real hold in front of the mouth. */
function switchOf({ asyncMode = false } = {}) {
  const brains = make();
  brains.register("notes");
  const mode = createMode({ file: path.join(dir, "mode.json"), quietFile: path.join(dir, "quiet.json") });
  mode.set(asyncMode ? "async" : "call");
  const spoken = [];
  const shown = [];
  const marks = [];
  const rosters = [];
  const hold = createHold({ send: (item) => spoken.push(item), parked: () => mode.async });
  const activeColor = () => brains.roster().brains.find((b) => b.name === brains.active).color;
  const say = (text, sid, to = "local", color = activeColor()) => {
    if (mode.async) shown.push(text);
    hold.offer({ text, sid, to, color });
  };
  const setActive = createSwitch({
    brains,
    say,
    whisper: (t) => marks.push(t),
    onSwitch: (r) => rosters.push(r),
    noticeDue: createNotice(),
  });
  return { brains, setActive, spoken, shown, marks, rosters, hold };
}

test("a repeat of the mode he is already in changes nothing: no write, no mark, no line", () => {
  const t = switchOf();
  assert.equal(t.setActive("notes", "audio notes").active, "notes");
  fs.rmSync(file); // the switch persisted; a repeat must not write again
  for (let i = 0; i < 2; i++) assert.equal(t.setActive("notes", "audio notes").active, "notes");
  assert.equal(fs.existsSync(file), false, "a repeat does not persist");
  assert.deepEqual(t.marks, ["⟨ notes ⟩"], "the mark is whispered once");
  assert.equal(t.rosters.length, 1, "the eye and the phone hear of one switch");
  assert.equal(t.spoken.length, 1, "one line: the notice of the first switch");
  assert.equal(t.setActive("nobody"), null, "an unknown mode is still no switch");
});

test("a deaf mode is announced once, however many times he switches", () => {
  const t = switchOf();
  t.setActive("notes", "audio notes");
  t.setActive("main", "call mode"); // a real switch, still deaf: inside the window, silent
  t.setActive("notes", "audio notes");
  assert.deepEqual(t.spoken.map((s) => s.text), ["audio notes is not listening. I'm holding your words."]);
  assert.equal(t.marks.length, 3, "each real switch still marks the eye");
});

test("in audio notes mode a run of switches parks one line and one mark, in the new channel's colour", () => {
  const t = switchOf({ asyncMode: true });
  for (let i = 0; i < 3; i++) t.setActive("notes", "audio notes");
  const notes = t.brains.roster().brains.find((b) => b.name === "notes").color;
  assert.equal(t.hold.held, 1, "one line waits for `talk to me`");
  assert.deepEqual(t.hold.list().map((h) => h.color), [notes], "the mark is the mode he switched to");
  assert.notEqual(notes, MAIN.color);
  assert.deepEqual(t.shown, ["audio notes is not listening. I'm holding your words."], "he reads it at once");
  assert.equal(t.spoken.length, 0, "audio notes mode says nothing out loud");
});

test("the notice in Spanish, and the mode's own words in the line", () => {
  const t = switchOf();
  t.setActive("notes", "notas de audio", "es");
  assert.deepEqual(t.spoken.map((s) => s.text), ["notas de audio no está escuchando. Guardo tus palabras."]);
});

// -- H01: the roster is the configured table ---------------------------------

test("a configured table seeds one row per entry with its colour and voice; a name that joins gets free ones", () => {
  const b = make({
    brother: { label: "Diego", color: "#123456", voice: 12 },
    mom: {},
    scribe: {},
    notes: {},
  });
  const by = Object.fromEntries(b.roster().brains.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(by), ["main", "brother", "mom", "scribe", "notes"]);
  assert.equal(by.main.color, "#b04dff");
  assert.equal(by.main.voice, 17);
  assert.equal(by.brother.color, "#123456");
  assert.equal(by.brother.voice, 12);
  b.register("sixth");
  const all = b.roster().brains;
  assert.equal(all.length, 6);
  const sixth = all.at(-1);
  assert.ok(COLORS.includes(sixth.color), sixth.color);
  assert.notEqual(sixth.voice, EYE_SID);
  const colors = all.map((x) => x.color);
  const voices = all.map((x) => x.voice);
  assert.equal(new Set(colors).size, colors.length, "no two channels share a colour");
  assert.equal(new Set(voices).size, voices.length, "no two channels share a voice");
  for (const c of colors) assert.ok(Math.abs(hue(c) - 152) > 30, `${c} is not the Eye's green`);
});

test("a colour another channel has, and the Eye's voice on a channel that is not the default, are not taken", () => {
  const b = make({ twin: { color: "#b04dff" }, greedy: { voice: EYE_SID } });
  const by = Object.fromEntries(b.roster().brains.map((x) => [x.name, x]));
  assert.notEqual(by.twin.color, "#b04dff", "the default channel keeps the colour it was configured with");
  assert.notEqual(by.greedy.voice, EYE_SID, "the Eye's voice belongs to the default channel alone");
  assert.equal(by.main.voice, EYE_SID, "which the default channel does keep");
  // with the default channel on another voice, 17 is free — and still not another channel's
  const free = make({ main: { voice: 12 }, greedy: { voice: EYE_SID } });
  const byFree = Object.fromEntries(free.roster().brains.map((x) => [x.name, x]));
  assert.equal(byFree.main.voice, 12);
  assert.notEqual(byFree.greedy.voice, EYE_SID);
});

test("past the palette every channel still gets a colour of its own: 200 rows, 200 colours, no green", () => {
  const table = {};
  for (let i = 0; i < 200; i++) table[`c-${i}`] = {};
  const rows = make(table).roster().brains;
  assert.equal(rows.length, 201);
  const colors = rows.map((x) => x.color);
  assert.equal(new Set(colors).size, 201, "no two channels share a colour");
  for (const c of colors) {
    assert.match(c, /^#[0-9a-f]{6}$/);
    assert.ok(Math.abs(hue(c) - 152) > 30, `${c} is not the Eye's green`);
  }
});

test("the default channel is the unnamed one, is always on the roster, and is where a lost switch lands", () => {
  const b = make({ notes: {} }, "brother");
  assert.equal(b.active, "brother");
  assert.deepEqual(
    b.roster().brains.map((x) => x.name),
    ["brother", "main", "notes"],
    "the default channel is on the roster first, table or no table"
  );
  assert.equal(b.register().name, "brother", "an unnamed register is the default channel");
  assert.equal(b.speak(undefined, "unnamed reply"), 0, "an unnamed speak is the default channel's, and is spoken");
  const lines = [];
  fs.writeFileSync(file, '{"active":"ghost"}');
  const again = createBrains({ channels: { notes: {} }, defaultChannel: "brother", file, say: () => {}, log: (m) => lines.push(m) });
  assert.equal(again.active, "brother");
  assert.ok(
    lines.some((m) => m.includes('"ghost" is not a channel — brother')),
    lines.join(" | ")
  );
});

test("behind the bridge, an unnamed listen and an unnamed speak belong to the default channel, whatever it is", async () => {
  const t = await body("brother");
  try {
    assert.equal((await t.json(t.get("/bridge/health"))).active, "brother");
    t.brains.push({ text: "his words" });
    assert.deepEqual(await t.json(t.get("/bridge/listen?timeoutMs=50")), { transcript: "his words", source: "local" });
    await t.json(t.post("/bridge/speak", { text: "unnamed" }));
    assert.deepEqual(said.map((s) => s[0]), ["unnamed"], "spoken at once: the unnamed channel is the active one");
    assert.deepEqual(
      await t.json(t.get("/bridge/listen?timeoutMs=20&brain=main")),
      { transcript: null, source: "local" },
      "the channel that is not the default hears nothing"
    );
  } finally {
    t.close();
  }
});

test("both supplies are finite and say so: the palette's 302nd colour is its last, the 9th voice is the Eye's", () => {
  const table = {};
  for (let i = 0; i < 310; i++) table[`c-${i}`] = {};
  const lines = [];
  const rows = createBrains({ channels: { main: MAIN, ...table }, defaultChannel: "main", file, say: () => {}, log: (m) => lines.push(m) })
    .roster()
    .brains;
  const colors = rows.map((x) => x.color);
  assert.equal(new Set(colors.slice(0, 302)).size, 302, "302 channels, 302 colours");
  assert.equal(new Set(colors).size, 302, "and past that the palette repeats — the docblock says so");
  const repeats = lines.filter((m) => /colour #[0-9a-f]{6} is taken — the palette is spent$/.test(m));
  assert.equal(repeats.length, rows.length - 302, "every repeat is logged");
  assert.equal(repeats[0], `brain ${rows[302].name}: colour ${rows[302].color} is taken — the palette is spent`);
  // 8 pool voices: the 9th row on shares the Eye's own, and every one of them is logged
  assert.deepEqual(rows.slice(0, 9).map((x) => x.voice), [17, 11, 12, 13, 14, 15, 16, 18, 19]);
  assert.equal(rows[9].voice, EYE_SID);
  const spent = lines.filter((m) => m.endsWith(`no free voice left — the Eye's own ${EYE_SID}`));
  assert.equal(spent.length, rows.length - 9, "every channel past the pool is logged");
  assert.equal(spent[0], `brain ${rows[9].name}: no free voice left — the Eye's own ${EYE_SID}`);
});

test("a colour and a voice he configured himself are never logged as spent", () => {
  const lines = [];
  createBrains({
    channels: { main: MAIN, brother: { color: "#ff9a4d", voice: 13 } },
    defaultChannel: "main",
    file,
    say: () => {},
    log: (m) => lines.push(m),
  });
  assert.deepEqual(lines, ["brain main: #b04dff, voice 17", "brain brother: #ff9a4d, voice 13"]);
});

// -- H02a: the label is what he hears, the id is what the machine takes -------

test("the mark on a switch is the label, and the id when the row has none", () => {
  const brains = make({ brother: { label: "Diego" }, mom: {} });
  const marks = [];
  const setActive = createSwitch({ brains, say: () => {}, whisper: (t) => marks.push(t), noticeDue: () => false });
  setActive("brother");
  setActive("mom");
  assert.deepEqual(marks, ["⟨ Diego ⟩", "⟨ mom ⟩"]);
});

test("the deaf notice reads the label when he named no words of his own", () => {
  const brains = make({ brother: { label: "Diego" } });
  const spoken = [];
  const setActive = createSwitch({ brains, say: (t) => spoken.push(t), whisper: () => {}, noticeDue: () => true });
  setActive("brother");
  assert.deepEqual(spoken, ["Diego is not listening. I'm holding your words."]);
  const t2 = switchOf();
  t2.setActive("notes", "audio notes");
  assert.deepEqual(t2.spoken.map((x) => x.text), ["audio notes is not listening. I'm holding your words."], "his own words still win");
});

test("every roster row carries a label, the id when it has none", () => {
  const b = make({ brother: { label: "Diego" }, mom: {} });
  const by = Object.fromEntries(b.roster().brains.map((x) => [x.name, x.label]));
  assert.deepEqual(by, { main: "main", brother: "Diego", mom: "mom" });
  b.register("joined");
  assert.equal(b.roster().brains.find((x) => x.name === "joined").label, "joined", "a joined channel labels itself with its id");
});

test("a label that is not one is the id, and logged: blank, too long, a control character", () => {
  const logs = [];
  const b = createBrains({
    channels: { main: MAIN, blank: { label: "  " }, long: { label: "D".repeat(300) }, lines: { label: "Die\ngo" }, pad: { label: "  Diego  " } },
    defaultChannel: "main",
    file,
    say: () => {},
    log: (m) => logs.push(m),
  });
  const by = Object.fromEntries(b.roster().brains.map((x) => [x.name, x.label]));
  assert.deepEqual(by, { main: "main", blank: "blank", long: "long", lines: "lines", pad: "Diego" });
  const bad = logs.filter((m) => /is not a label/.test(m));
  assert.equal(bad.length, 3, "one line each for the three that were refused");
  for (const name of ["blank", "long", "lines"]) assert.ok(bad.some((m) => m.startsWith(`channel ${name}: label `)), name);
});

test("cleanLabel is the one gate: 24 characters pass, 25 do not, and a non-string is the id", () => {
  assert.equal(cleanLabel("brother", "D".repeat(24)), "D".repeat(24));
  assert.equal(cleanLabel("brother", "D".repeat(25)), "brother", "past 24 characters the id is used");
  assert.equal(cleanLabel("brother", undefined), "brother");
  assert.equal(cleanLabel("brother", 7), "brother");
  assert.equal(cleanLabel("brother", "Die\u0007go"), "brother", "a control character is refused whole");
  assert.equal(cleanLabel("brother", " Diego "), "Diego");
});

test("the id is what the route takes: the label is not a channel name", async () => {
  const t = await body("main", { brother: { label: "Diego" } });
  try {
    assert.equal((await t.post("/bridge/brains/active", { brain: "Diego" })).status, 400, "the label is not an id");
    assert.equal(t.brains.active, "main", "and nothing switched");
    const ok = await t.post("/bridge/brains/active", { brain: "brother" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).active, "brother");
    assert.equal((await t.json(t.get("/bridge/brains"))).brains.find((b) => b.name === "brother").label, "Diego");
  } finally {
    t.close();
  }
});
