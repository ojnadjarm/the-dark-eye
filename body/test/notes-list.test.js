/** H09: what a channel said while he was elsewhere — the list, its file, and the switch that lays it out for him. */
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNotes, MAX, TEXT_MAX } = require("../src/notes-list");
const { createBrains, createSwitch } = require("../src/brains");

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-"));
  file = path.join(dir, "notes.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const make = (o = {}) => createNotes({ file, ...o });

test("a note is added per channel, oldest first, and counted", () => {
  const n = make();
  assert.equal(n.count("notes"), 0);
  assert.deepEqual(n.list("notes"), []);
  assert.equal(n.add("notes", "one"), 1);
  assert.equal(n.add("notes", "two"), 2);
  assert.equal(n.add("brother", "hey"), 1, "each channel counts its own");
  assert.deepEqual(n.list("notes").map((x) => x.text), ["one", "two"]);
  assert.deepEqual(n.list("brother").map((x) => x.text), ["hey"]);
  assert.equal(n.count("notes"), 2);
});

test("the list he is given back is a copy: nothing he holds can mutate it", () => {
  const n = make();
  n.add("notes", "one");
  n.list("notes").push({ text: "forged" });
  assert.equal(n.count("notes"), 1);
});

test("the cap is 20 per channel, the oldest dropped", () => {
  const n = make();
  assert.equal(MAX, 20);
  for (let i = 0; i < 25; i++) n.add("notes", `w${i}`);
  assert.equal(n.count("notes"), 20);
  assert.deepEqual(n.list("notes").map((x) => x.text), Array.from({ length: 20 }, (_, i) => `w${i + 5}`));
});

test("a reply longer than 2000 characters is stored clamped", () => {
  const n = make();
  assert.equal(TEXT_MAX, 2000);
  n.add("notes", "x".repeat(10_000));
  assert.equal(n.list("notes")[0].text.length, 2000);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).channels.notes[0].text.length, 2000);
});

test("a press takes one note out — the oldest of those words — and leaves the rest playable", () => {
  const n = make();
  for (const w of ["one", "two", "one"]) n.add("notes", w);
  assert.equal(n.played("notes", "two"), true);
  assert.deepEqual(n.list("notes").map((x) => x.text), ["one", "one"]);
  assert.equal(n.played("notes", "one"), true);
  assert.equal(n.count("notes"), 1);
  assert.equal(n.played("notes", "nothing like this"), false);
  assert.equal(n.played("ghost", "one"), false);
});

test("the file survives a restart: both channels come back in order, at mode 600", () => {
  const n = make();
  n.add("notes", "one");
  n.add("notes", "two");
  n.add("brother", "hey");
  n.add("brother", "you there");
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  const again = make();
  assert.deepEqual(again.list("notes").map((x) => x.text), ["one", "two"]);
  assert.deepEqual(again.list("brother").map((x) => x.text), ["hey", "you there"]);
  assert.equal(again.count("notes"), 2);
  const played = make();
  played.played("notes", "one");
  assert.deepEqual(make().list("notes").map((x) => x.text), ["two"], "the press is written through");
});

test("a corrupt, non-object or unknown-channel file is logged and leaves an empty list", () => {
  for (const body of ["garbage", "[]", '{"channels":[]}', '{"channels":null}', '{"channels":{"notes":"nope"}}']) {
    const lines = [];
    fs.writeFileSync(file, body);
    const n = make({ log: (m) => lines.push(m) });
    assert.equal(n.count("notes"), 0, body);
    assert.equal(lines.length, 1, `${body}: logged once`);
  }
  const lines = [];
  fs.writeFileSync(file, '{"channels":{"ghost":[{"text":"hi"}],"notes":[{"text":"kept"},7]}}');
  const n = make({ known: (name) => name === "notes", log: (m) => lines.push(m) });
  assert.equal(n.count("ghost"), 0, "a channel this body does not have shows nothing");
  assert.deepEqual(n.list("notes").map((x) => x.text), ["kept"]);
  assert.match(lines[0], /"ghost" is not a channel/);
  assert.match(lines[1], /channel notes: 1 of 2 are not notes/);
});

test("a missing file is silent; an unwritable one is logged and the lists still work", () => {
  const lines = [];
  make({ log: (m) => lines.push(m) });
  assert.deepEqual(lines, [], "no file yet is not a fault");
  const ro = path.join(dir, "ro");
  fs.mkdirSync(ro, { mode: 0o500 });
  const n = createNotes({ file: path.join(ro, "notes.json"), log: (m) => lines.push(m) });
  n.add("notes", "one");
  assert.equal(n.count("notes"), 1, "he still gets his note on the page");
  assert.match(lines[0], /cannot persist/);
});

test("`file: null` keeps the lists in memory and writes nothing", () => {
  const n = createNotes({ file: null });
  n.add("notes", "one");
  assert.equal(n.count("notes"), 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// -- wired as main.js wires it: the switch lays the notes out, and says nothing --

/** `createSwitch` + the notes list, with `onSwitch` publishing as main.js's `showNotes` does. */
function bodyOf() {
  const notes = createNotes({ file });
  const said = [];
  const offered = [];
  const published = [];
  const brains = createBrains({
    channels: { main: { voice: 17 }, notes: {} },
    defaultChannel: "main",
    file: path.join(dir, "active.json"),
    notes,
    say: (...a) => (said.push(a), offered.push(a)),
  });
  const setActive = createSwitch({
    brains,
    say: (...a) => said.push(a),
    whisper: () => {},
    onSwitch: (r, name) => {
      for (const n of notes.list(name)) published.push(n.text);
    },
    noticeDue: () => false,
  });
  const waiting = (name) => brains.roster().brains.find((b) => b.name === name).waiting;
  return { brains, notes, setActive, said, offered, published, waiting };
}

test("three replies from a channel he is not on: nothing is said or offered, the roster says 3 waiting", () => {
  const t = bodyOf();
  for (const w of ["one", "two", "three"]) t.brains.speak("notes", w);
  assert.deepEqual(t.said, [], "say was never called");
  assert.deepEqual(t.offered, [], "nothing reached the mouth");
  assert.equal(t.waiting("notes"), 3);
  assert.equal(t.waiting("main"), 0);
});

test("switching there lays out three lines in arrival order and still says nothing", () => {
  const t = bodyOf();
  for (const w of ["one", "two", "three"]) t.brains.speak("notes", w);
  t.setActive("notes", "audio notes");
  assert.deepEqual(t.published, ["one", "two", "three"], "each its own line, oldest first");
  assert.deepEqual(t.said, [], "the deleted monologue: a switch speaks nothing on his behalf");
  assert.equal(t.waiting("notes"), 3, "a line he has not pressed is still waiting");
});

test("nothing is laid out for a channel he does not go to", () => {
  const t = bodyOf();
  t.brains.speak("notes", "one");
  t.setActive("main");
  assert.deepEqual(t.published, []);
  assert.deepEqual(t.said, []);
});

test("pressing one note leaves the other two waiting and playable in any order", () => {
  const t = bodyOf();
  for (const w of ["one", "two", "three"]) t.brains.speak("notes", w);
  t.setActive("notes");
  assert.equal(t.notes.played("notes", "three"), true);
  assert.equal(t.waiting("notes"), 2);
  assert.equal(t.notes.played("notes", "one"), true);
  assert.equal(t.waiting("notes"), 1);
  assert.deepEqual(t.notes.list("notes").map((x) => x.text), ["two"]);
  assert.deepEqual(t.said, []);
});

test("nothing in the list is resident: no timer, no watcher, no interval", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "notes-list.js"), "utf8");
  assert.doesNotMatch(src, /setInterval|setTimeout|watch|unref/, "the list is read once and written on change");
});

test("`setActive` in brains.js calls no mouth at all", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "brains.js"), "utf8");
  const body = src.slice(src.indexOf("setActive(name) {"), src.indexOf("roster() {"));
  assert.ok(body.length > 0 && body.length < 400, `the slice is setActive alone (${body.length} chars)`);
  assert.doesNotMatch(body, /say\(/, "H09: the switch never speaks");
  assert.doesNotMatch(body, /parked/, "the parked array is gone");
});

test("main.js publishes a switched-to channel's notes as text, and a press stops one waiting", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const show = main.slice(main.indexOf("function showNotes"), main.indexOf("/** The channel that hears him now"));
  assert.match(show, /for \(const n of notes\.list\(name\)\) replies\.text\(n\.text\);/, "text-only lines, oldest first");
  assert.doesNotMatch(show, /say\(|eager\./, "nothing is synthesised on arrival");
  const replay = main.slice(main.indexOf("function onReplay"), main.indexOf("function show("));
  assert.match(replay, /if \(notes\.played\(brains\.active, text\)\) replies\.brains\(channelRoster\(\)\)/, "the count drops on the press");
  assert.match(main, /const notes = createNotes\(\{ known: /, "a file naming a channel this body does not have shows him nothing");
});
