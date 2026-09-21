/** The config file and its channel table: the migration of a config with no table, and every malformed row. */
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, channelTable, DEFAULTS } = require("../src/config");
const { createBrains } = require("../src/brains");

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  file = path.join(dir, "config.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Every read and write of this suite is inside its own temp dir — never his config. */
const write = (cfg) => fs.writeFileSync(file, JSON.stringify(cfg));
const load = (cfg, log = () => {}) => {
  if (cfg !== undefined) write(cfg);
  return loadConfig({ file, log });
};
const roster = (cfg, log = () => {}) => {
  const full = load(cfg, log);
  return createBrains({
    channels: channelTable(full, log),
    defaultChannel: full.defaultChannel,
    file: path.join(dir, "active.json"),
    say: () => {},
    log,
  })
    .roster()
    .brains;
};

test("a config with no channel table is today's roster, field by field, and the table is written into it", () => {
  const rows = roster({ port: 8642, brainColor: "#b04dff", voiceSid: 17 });
  assert.deepEqual(rows, [
    { name: "main", label: "main", color: "#b04dff", voice: 17, connected: false, waiting: 0 },
    { name: "notes", label: "notes", color: "#4dd9ff", voice: 11, connected: false, waiting: 0 },
  ]);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(onDisk.channels, { main: { color: "#b04dff", voice: 17 }, notes: { mode: "notes" } }, "the legacy row is migrated with the mode it is for");
  assert.equal(onDisk.defaultChannel, "main");
  assert.equal(onDisk.defaultMode, "call");
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
});

test("a first run with no file at all is the same roster, and the defaults are written", () => {
  const full = load();
  assert.equal(full.defaultChannel, "main");
  assert.equal(full.voiceSid, DEFAULTS.voiceSid);
  assert.ok(full.secret, "a secret is minted once");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).channels), ["main", "notes"]);
});

test("a configured table is the roster, in his order, with his labels, colours, voices, modes and aliases", () => {
  const full = load({
    channels: {
      main: { label: "Main", color: "#b04dff", voice: 17 },
      notes: { label: "Notes", color: "#4dd9ff", voice: 12, mode: "notes", aliases: ["audio", "vault"] },
      brother: { label: "Diego", color: "#ff9a4d" },
      mom: {},
      scribe: { mode: "call" },
    },
  });
  const table = channelTable(full);
  assert.deepEqual(Object.keys(table), ["main", "notes", "brother", "mom", "scribe"]);
  assert.deepEqual(table.notes, { label: "Notes", color: "#4dd9ff", voice: 12, aliases: ["audio", "vault"], mode: "async" });
  assert.deepEqual(table.brother, { label: "Diego", color: "#ff9a4d" });
  assert.deepEqual(table.mom, {});
  assert.equal(table.scribe.mode, "call", "his word for a mode is kept as the body's own");
});

test("defaultChannel is the channel an unnamed listen and speak belong to, and where active starts", () => {
  const full = load({ defaultChannel: "brother", channels: { brother: {}, notes: {} } });
  assert.equal(full.defaultChannel, "brother");
  const brains = createBrains({
    channels: channelTable(full),
    defaultChannel: full.defaultChannel,
    file: path.join(dir, "active.json"),
    say: () => {},
  });
  assert.equal(brains.active, "brother");
  assert.equal(brains.register().name, "brother");
});

// -- the roster can never be empty or lose the default channel ---------------

test("a channels key that is not a table is logged and skipped, and leaves the default channel on the roster", () => {
  for (const channels of [{}, null, "notes", ["notes"], 7]) {
    const lines = [];
    const rows = roster({ channels }, (m) => lines.push(m));
    assert.deepEqual(
      rows.map((r) => r.name),
      ["main"],
      JSON.stringify(channels)
    );
    if (channels && typeof channels === "object" && !Array.isArray(channels)) continue; // {} is a table, just an empty one
    assert.ok(
      lines.some((m) => m.startsWith("channels:") && m.includes("is not a table")),
      `${JSON.stringify(channels)}: ${lines.join(" | ")}`
    );
  }
});

test("a row that is not an object, and a key that is not a name, are logged and skipped — the rest stay", () => {
  const lines = [];
  const rows = roster(
    { channels: { main: {}, notes: 5, mom: null, scribe: ["x"], "Notes!": {}, "": {}, "toolonganametobeachannel": {} } },
    (m) => lines.push(m)
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ["main"],
    "every bad row is gone and the default channel is still there"
  );
  for (const bad of ["notes", "mom", "scribe"])
    assert.ok(
      lines.some((m) => m === `channel ${bad}: ${JSON.stringify(bad === "notes" ? 5 : bad === "mom" ? null : ["x"])} is not a row — skipped`),
      lines.join(" | ")
    );
  for (const bad of ['"Notes!"', '""', '"toolonganametobeachannel"'])
    assert.ok(
      lines.some((m) => m === `channel ${bad}: not a name — skipped`),
      lines.join(" | ")
    );
});

test("a bad colour, a bad voice, the Eye's voice on another channel, a bad mode, label and aliases are skipped, the channel is not", () => {
  const lines = [];
  const full = load(
    {
      channels: {
        main: { voice: 17 },
        notes: { color: "purple", voice: 17 },
        mom: { color: "#12345", voice: 99 },
        scribe: { voice: 1.5, mode: "whisper", label: 7, aliases: "audio" },
        brother: { aliases: ["ok", 3] },
      },
    },
    (m) => lines.push(m)
  );
  const table = channelTable(full, (m) => lines.push(m));
  assert.deepEqual(Object.keys(table), ["main", "notes", "mom", "scribe", "brother"], "no channel is dropped for a bad field");
  assert.deepEqual(table.main, { voice: 17 }, "the Eye's voice is the default channel's to keep");
  assert.deepEqual(table.notes, { mode: "async" }, "the migration gave the legacy row its mode; his bad colour and voice are still skipped");
  assert.deepEqual(table.mom, {});
  assert.deepEqual(table.scribe, {});
  assert.deepEqual(table.brother, {});
  for (const line of [
    'channel notes: color "purple" skipped',
    "channel notes: voice 17 skipped",
    'channel mom: color "#12345" skipped',
    "channel mom: voice 99 skipped",
    "channel scribe: voice 1.5 skipped",
    'channel scribe: mode "whisper" skipped',
    "channel scribe: label 7 skipped",
    'channel scribe: aliases "audio" skipped',
    'channel brother: aliases ["ok",3] skipped',
  ])
    assert.ok(lines.includes(line), `${line} — got ${lines.join(" | ")}`);
  const rows = createBrains({
    channels: table,
    defaultChannel: full.defaultChannel,
    file: path.join(dir, "active.json"),
    say: () => {},
  })
    .roster()
    .brains;
  assert.deepEqual(
    rows.map((r) => r.name),
    ["main", "notes", "mom", "scribe", "brother"]
  );
  assert.equal(rows[0].voice, 17);
  for (const r of rows.slice(1)) assert.notEqual(r.voice, 17, `${r.name} did not take the Eye's voice`);
});

test("a defaultChannel the table does not have is added to it; one that is no name is logged and falls back", () => {
  assert.deepEqual(Object.keys(channelTable({ defaultChannel: "brother", channels: { notes: {} } })), ["brother", "notes"]);
  const lines = [];
  const full = load({ defaultChannel: "Not A Name", channels: { notes: {} } }, (m) => lines.push(m));
  assert.equal(full.defaultChannel, "main");
  assert.ok(
    lines.some((m) => m === 'defaultChannel: "Not A Name" is not a name — main'),
    lines.join(" | ")
  );
  assert.deepEqual(Object.keys(channelTable(full)), ["main", "notes"]);
  assert.equal(
    JSON.parse(fs.readFileSync(file, "utf8")).defaultChannel,
    "Not A Name",
    "his file is left as he wrote it — only the roster falls back"
  );
  const rows = roster({ defaultChannel: "Not A Name", brainColor: "#b04dff", voiceSid: 17 });
  assert.deepEqual(
    rows,
    [
      { name: "main", label: "main", color: "#b04dff", voice: 17, connected: false, waiting: 0 },
      { name: "notes", label: "notes", color: "#4dd9ff", voice: 11, connected: false, waiting: 0 },
    ],
    "and the migration writes its row for the channel the roster fell back to"
  );
});

test("a defaultMode that is no mode of his is logged and falls back to call; his words become the body's", () => {
  const lines = [];
  assert.equal(load({ defaultMode: "notes" }).defaultMode, "async");
  assert.equal(load({ defaultMode: "call" }).defaultMode, "call");
  assert.equal(load({ defaultMode: "async" }).defaultMode, "async", "the body's own word is read too");
  assert.equal(load({ defaultMode: "loud" }, (m) => lines.push(m)).defaultMode, "call");
  assert.ok(
    lines.some((m) => m === 'defaultMode: "loud" is no mode — call'),
    lines.join(" | ")
  );
});

// -- his file is his: never re-minted, never lost, never half-written ---------

/** His config as it stands, with a secret of his own: every fixture below is a copy of it. */
const HIS = {
  port: 8642,
  voiceSid: 17,
  voiceSpeed: 1,
  voiceModelDir: "kokoro-multi-lang-v1_0",
  brain: "claude",
  brainColor: "#b04dff",
  canvasZoom: 1.5,
  defaultChannel: "main",
  defaultMode: "call",
  secret: "f".repeat(48),
  remotePort: 8644,
  channels: { main: { color: "#b04dff", voice: 17 }, notes: {} },
};

test("a truncated config is kept as it is: no new secret, no key lost, nothing written over it", () => {
  const text = JSON.stringify(HIS, null, 2);
  const half = text.slice(0, Math.floor(text.length * 0.6));
  fs.writeFileSync(file, half);
  const lines = [];
  const full = loadConfig({ file, log: (m) => lines.push(m) });
  assert.equal(fs.readFileSync(file, "utf8"), half, "his half-written file is untouched");
  assert.notEqual(full.secret, undefined, "the body still has a secret to run on");
  assert.ok(
    lines.some((m) => m.startsWith(`config: ${file} is not a config (`)),
    lines.join(" | ")
  );
  // and a second boot does not write a different one over it either
  const again = loadConfig({ file });
  assert.equal(fs.readFileSync(file, "utf8"), half);
  assert.notEqual(again.secret, HIS.secret, "his secret is unreadable — but it is still on disk");
});

test("a config that is not an object, and one the body cannot read, are kept too", () => {
  for (const text of ["[1,2]", "null", '"main"', "7"]) {
    fs.writeFileSync(file, text);
    const lines = [];
    loadConfig({ file, log: (m) => lines.push(m) });
    assert.equal(fs.readFileSync(file, "utf8"), text, text);
    assert.ok(
      lines.some((m) => m.includes("is not a config")),
      `${text}: ${lines.join(" | ")}`
    );
  }
  fs.writeFileSync(file, JSON.stringify(HIS, null, 2));
  fs.chmodSync(file, 0o000);
  const lines = [];
  const full = loadConfig({ file, log: (m) => lines.push(m) });
  assert.equal(fs.statSync(file).size, JSON.stringify(HIS, null, 2).length, "his file is untouched, byte count and all");
  assert.equal(full.defaultChannel, "main");
  assert.ok(
    lines.some((m) => m.startsWith(`config: cannot read ${file}:`)),
    lines.join(" | ")
  );
  fs.chmodSync(file, 0o600);
});

test("the write is a temp file and a rename at mode 600, never a truncation in place", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "config.js"), "utf8");
  const writer = src.slice(src.indexOf("function writeConfig"), src.indexOf("function loadConfig"));
  assert.match(writer, /fs\.writeFileSync\(tmp,[\s\S]*fs\.chmodSync\(tmp, 0o600\);[\s\S]*fs\.renameSync\(tmp, file\)/, "mode 600 before the rename");
  assert.doesNotMatch(writer, /fs\.writeFileSync\(file/, "his file is never written in place");
  const full = loadConfig({ file, log: () => {} });
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  assert.equal(fs.existsSync(`${file}.tmp`), false, "no temp file left behind");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), full);
});

test("nothing is written when nothing changed", () => {
  loadConfig({ file });
  const before = fs.statSync(file);
  fs.utimesSync(file, 0, 0);
  loadConfig({ file });
  assert.equal(fs.statSync(file).mtimeMs, 0, "a boot that adds no key does not touch his file");
  assert.equal(fs.readFileSync(file, "utf8"), fs.readFileSync(file, "utf8"));
  assert.ok(before.size > 0);
});

test("a config it cannot write is a logged warning, not a dead body", () => {
  // a read-only file that wants a key added: kept as he left it, mode and all
  const older = JSON.stringify({ ...HIS, canvasZoom: undefined }, null, 2);
  fs.writeFileSync(file, older);
  fs.chmodSync(file, 0o400);
  const ro = [];
  let full;
  assert.doesNotThrow(() => (full = loadConfig({ file, log: (m) => ro.push(m) })));
  assert.equal(full.remotePort, 8644, "the eye comes up on what it read");
  assert.equal(full.secret, HIS.secret);
  assert.equal(full.canvasZoom, DEFAULTS.canvasZoom, "the key it wanted is there in memory");
  assert.equal(fs.readFileSync(file, "utf8"), older, "and his file is untouched");
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "400", "the write bit he took off stays off");
  assert.ok(
    ro.some((m) => m.startsWith(`config: cannot write ${file}:`)),
    ro.join(" | ")
  );
  fs.chmodSync(file, 0o600);
  // an unwritable directory, with a file of his in it that wants a key added, and without
  for (const keep of [true, false]) {
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-ro-"));
    const sub = path.join(ro, "dark-eye");
    fs.mkdirSync(sub);
    const f = path.join(sub, "config.json");
    if (keep) fs.writeFileSync(f, older);
    fs.chmodSync(sub, 0o500);
    const lines = [];
    let out;
    assert.doesNotThrow(() => (out = loadConfig({ file: f, log: (m) => lines.push(m) })), `keep=${keep}`);
    assert.equal(out.defaultChannel, "main");
    assert.equal(out.remotePort, keep ? 8644 : undefined);
    assert.ok(out.secret, "the body has a secret to run on");
    assert.ok(
      lines.some((m) => m.startsWith(`config: cannot write ${f}:`)),
      `keep=${keep}: ${lines.join(" | ")}`
    );
    if (keep) assert.equal(fs.readFileSync(f, "utf8"), older, "his file is exactly as he left it");
    fs.chmodSync(sub, 0o700);
    fs.rmSync(ro, { recursive: true, force: true });
  }
});

// -- the three guards no test defended --------------------------------------

test("a negative voice is skipped, like any other that is no speaker", () => {
  const lines = [];
  const table = channelTable({ channels: { main: {}, mom: { voice: -1 } } }, (m) => lines.push(m));
  assert.deepEqual(table.mom, {}, "a negative speaker id is not a voice");
  assert.ok(lines.includes("channel mom: voice -1 skipped"), lines.join(" | "));
});

test("channelTable falls back to the same default channel loadConfig does, on a cfg it is handed raw", () => {
  for (const defaultChannel of ["Not A Name", "", "toolonganametobeachannel", 7, null, undefined])
    assert.deepEqual(
      Object.keys(channelTable({ defaultChannel, channels: { notes: {} } })),
      ["main", "notes"],
      JSON.stringify(defaultChannel)
    );
  const raw = { defaultChannel: "Not A Name", channels: { notes: {} } };
  assert.equal(Object.keys(channelTable(raw))[0], loadConfig({ file, log: () => {} }).defaultChannel, "one rule, one answer");
});

test("the migration never overwrites the default channel's own row with a legacy blank", () => {
  const full = loadConfig({ file: (write({ defaultChannel: "notes", brainColor: "#4dd9ff", voiceSid: 12 }), file) });
  assert.deepEqual(full.channels, { notes: { color: "#4dd9ff", voice: 12 } }, "his default channel keeps its colour and voice");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).channels, { notes: { color: "#4dd9ff", voice: 12 } });
});
