/** Voice intents: only the canvas commands are body commands, everything else is words. */
const { test } = require("node:test");
const assert = require("node:assert");
const { classify } = require("../src/intents");

test("English canvas commands open it", () => {
  for (const t of ["show me", "open canvas", "open the canvas", "canvas"])
    assert.deepEqual(classify(t), { kind: "canvas", close: false }, t);
});

test("English canvas commands close it", () => {
  for (const t of ["close canvas", "close the canvas"])
    assert.deepEqual(classify(t), { kind: "canvas", close: true }, t);
});

test("Spanish canvas commands", () => {
  for (const t of ["muestra", "muéstrame", "muestrame", "muéstramelo", "abre el lienzo", "abre el canvas"])
    assert.deepEqual(classify(t), { kind: "canvas", close: false }, t);
  for (const t of ["cierra el lienzo", "cierra el canvas"])
    assert.deepEqual(classify(t), { kind: "canvas", close: true }, t);
});

test("case and trailing punctuation do not matter", () => {
  for (const t of ["Show me.", "SHOW ME!", "  Close the Canvas?  ", "Muestra."])
    assert.equal(classify(t).kind, "canvas", t);
  assert.equal(classify("Close the Canvas?").close, true);
});

test("a command inside a sentence is just words", () => {
  for (const t of ["show me the file", "open the canvas please", "and then canvas", "muestra el archivo"])
    assert.deepEqual(classify(t), { kind: "words" }, t);
});

test("the TV switch, in both languages", () => {
  for (const t of ["tv off", "TV off.", "turn the tv off", "the tv is off", "apaga la tele", "apaga la pantalla"])
    assert.deepEqual(classify(t), { kind: "tv", mode: "off" }, t);
  for (const t of ["tv on", "turn the tv on", "the tv is on", "enciende la tele"])
    assert.deepEqual(classify(t), { kind: "tv", mode: "on" }, t);
  for (const t of ["tv auto", "tele auto"]) assert.deepEqual(classify(t), { kind: "tv", mode: "auto" }, t);
});

test("the TV words inside a sentence are just words", () => {
  for (const t of ["the tv is off tonight", "what is on tv", "can you turn the tv off later"])
    assert.deepEqual(classify(t), { kind: "words" }, t);
});

test("the brain switch, in both languages, names lowercased", () => {
  for (const t of ["talk to notes", "switch to notes", "notes, listen", "habla con notes", "cambia a notes", "Talk to Notes."])
    assert.deepEqual(classify(t), { kind: "brain", name: "notes" }, t);
  assert.deepEqual(classify("switch to main"), { kind: "brain", name: "main" });
});

test("who is listening asks, it does not switch", () => {
  for (const t of ["who is listening", "Who's listening?", "quién escucha", "quien me escucha"])
    assert.deepEqual(classify(t), { kind: "brain", name: null }, t);
});

test("the switch words inside a sentence are words, or the TV", () => {
  for (const t of ["talk to me about the plan", "please listen", "just listen", "switch the tv off", "can you switch to notes", "who is listening to music"])
    assert.deepEqual(classify(t), { kind: "words" }, t);
  assert.deepEqual(classify("turn the tv off"), { kind: "tv", mode: "off" });
});

test("the old quiet words are the modes, in both languages", () => {
  for (const t of ["quiet", "be quiet", "Quiet.", "BE QUIET!"])
    assert.deepEqual(classify(t), { kind: "mode", name: "async", words: "quiet", lang: "en" }, t);
  for (const t of ["silencio", "cállate", "callate", "Silencio."])
    assert.deepEqual(classify(t), { kind: "mode", name: "async", words: "silencio", lang: "es" }, t);
  for (const t of ["talk to me", "Talk to me."])
    assert.deepEqual(classify(t), { kind: "mode", name: "call", words: "talk to me", lang: "en" }, t);
  for (const t of ["háblame", "hablame", "Háblame!"])
    assert.deepEqual(classify(t), { kind: "mode", name: "call", words: "háblame", lang: "es" }, t);
});

test("the quiet words inside a sentence are words, and a channel is a channel", () => {
  for (const t of ["talk to me about the plan", "quiet down the tv", "be quiet please", "silencio total"])
    assert.deepEqual(classify(t), { kind: "words" }, t);
  assert.deepEqual(classify("talk to notes"), { kind: "brain", name: "notes" });
});

test("anything else is words", () => {
  for (const t of ["", "hello there", "who's waiting"])
    assert.deepEqual(classify(t), { kind: "words" }, t);
});

test("the two modes, entered by their own words", () => {
  for (const t of ["audio notes", "audio note", "notes mode", "note mode", "audionotes", "Audio Notes."])
    assert.deepEqual(classify(t), { kind: "mode", name: "async", words: "audio notes", lang: "en" }, t);
  for (const t of ["notas de audio", "modo notas", "modo de notas", "audio notas"])
    assert.deepEqual(classify(t), { kind: "mode", name: "async", words: "notas de audio", lang: "es" }, t);
  for (const t of ["call mode", "back to call", "normal mode"])
    assert.deepEqual(classify(t), { kind: "mode", name: "call", words: "call mode", lang: "en" }, t);
  for (const t of ["modo llamada", "modo de llamada"])
    assert.deepEqual(classify(t), { kind: "mode", name: "call", words: "modo llamada", lang: "es" }, t);
});

test("filler before a mode is still a mode, a switch verb too", () => {
  for (const f of ["hey", "hi", "ok", "okay", "eye", "dark eye", "what's up", "whats up", "wake up", "oye", "hola", "qué tal", "que tal", "vale", "hey ok"])
    assert.deepEqual(classify(`${f} audio notes`), { kind: "mode", name: "async", words: "audio notes", lang: "en" }, f);
  for (const t of ["talk to audio notes", "switch to audio notes", "hey switch to audio notes", "cambia a notas de audio", "habla con modo llamada"])
    assert.deepEqual(classify(t).kind, "mode", t);
  assert.deepEqual(classify("oye call mode"), { kind: "mode", name: "call", words: "call mode", lang: "en" });
});

test("the mis-hearings he gets are accepted in those positions only", () => {
  for (const t of ["audio nodes", "odio notes", "audio no", "hey audio nodes", "what's up odio notes"])
    assert.deepEqual(classify(t), { kind: "mode", name: "async", words: "audio notes", lang: "en" }, t);
  for (const t of ["call mod", "called mode", "call more", "ok call more"])
    assert.deepEqual(classify(t), { kind: "mode", name: "call", words: "call mode", lang: "en" }, t);
  assert.deepEqual(classify("the audio nodes are fine"), { kind: "words" });
});

test("a mode named inside a sentence never switches", () => {
  for (const t of [
    "I want to write some audio notes about the plan",
    "send that to my audio notes folder",
    "he called mode switching a mess",
    "notes",
    "I read the notes mode section twice",
    "give me a call mode explanation",
    "call",
    "hey call",
    "eye call",
    "call me back",
  ])
    assert.deepEqual(classify(t), { kind: "words" }, t);
});

test("talk to me is call mode and never a channel; the notes collision holds both ways", () => {
  assert.deepEqual(classify("talk to me"), { kind: "mode", name: "call", words: "talk to me", lang: "en" });
  assert.deepEqual(classify("háblame"), { kind: "mode", name: "call", words: "háblame", lang: "es" });
  // the channel is `notes` and the mode is spoken "audio notes": neither ever answers for the other
  for (const t of ["audio notes", "notas de audio", "hey audio notes", "switch to audio notes", "audio nodes"]) {
    const got = classify(t);
    assert.deepEqual([got.kind, got.name], ["mode", "async"], t);
  }
  for (const t of ["talk to notes", "notes, listen", "switch to notes", "habla con notes", "cambia a notes"])
    assert.deepEqual(classify(t), { kind: "brain", name: "notes" }, t);
  assert.notEqual(classify("audio notes").name, "notes", "the mode's own word is never the channel's name");
});

test("a near miss off the list is words, and logged once", () => {
  const lines = [];
  const log = (m) => lines.push(m);
  assert.deepEqual(classify("audio nots", log), { kind: "words" });
  assert.deepEqual(lines, ['intents: near "audio nots" → async?']);
  lines.length = 0;
  assert.deepEqual(classify("hey call mede", log), { kind: "words" });
  assert.deepEqual(lines, ['intents: near "call mede" → call?']);
  lines.length = 0;
  assert.deepEqual(classify("hello there", log), { kind: "words" });
  assert.deepEqual(classify("talk to notes", log), { kind: "brain", name: "notes" });
  assert.deepEqual(lines, [], "only a near miss logs");
});

// -- the mode by voice (M15): every phrase, every position, both languages -----

/** The table as he says it: the first of each list is what the Eye says back. */
const SPOKEN = [
  { name: "async", lang: "en", phrases: ["audio notes", "audio note", "notes mode", "note mode", "audionotes", "audio nodes", "odio notes", "audio no"] },
  { name: "async", lang: "es", phrases: ["notas de audio", "modo notas", "modo de notas", "audio notas"] },
  { name: "call", lang: "en", phrases: ["call mode", "back to call", "normal mode", "call mod", "called mode", "call more"] },
  { name: "call", lang: "es", phrases: ["modo llamada", "modo de llamada"] },
];
const FILLERS = ["hey", "hi", "ok", "okay", "eye", "dark eye", "what's up", "whats up", "wake up", "oye", "hola", "qué tal", "que tal", "vale"];
const VERBS = ["talk to", "switch to", "habla con", "cambia a"];

test("every phrase of the table, in every allowed position, is that mode in that language", () => {
  for (const { name, lang, phrases } of SPOKEN) {
    const want = { kind: "mode", name, words: phrases[0], lang };
    for (const p of phrases) {
      assert.deepEqual(classify(p), want, p);
      assert.deepEqual(classify(`  ${p.toUpperCase()}!  `), want, p);
      for (const f of FILLERS) assert.deepEqual(classify(`${f} ${p}`), want, `${f} ${p}`);
      for (const v of VERBS) {
        assert.deepEqual(classify(`${v} ${p}`), want, `${v} ${p}`);
        assert.deepEqual(classify(`hey ${v} ${p}`), want, `hey ${v} ${p}`);
      }
    }
  }
});

test("a mode is never a channel and a channel is never a mode", () => {
  for (const { name, phrases } of SPOKEN)
    for (const p of phrases) {
      const got = classify(p);
      assert.equal(got.kind, "mode", p);
      assert.equal(got.name, name, p);
      assert.notEqual(got.name, "notes", `"${p}" must never name the channel`);
    }
  for (const t of ["talk to notes", "notes, listen", "switch to notes", "habla con notes", "cambia a notes", "talk to main", "main, listen"])
    assert.equal(classify(t).kind, "brain", t);
});

test("a mode inside a sentence never switches, in either language", () => {
  for (const t of [
    "I want to write some audio notes about the plan",
    "send that to my audio notes folder",
    "he called mode switching a mess",
    "the call mode you built is fine",
    "I read the notes mode section twice",
    "quiero escribir unas notas de audio sobre el plan",
    "manda eso a mi carpeta de notas de audio",
    "el modo llamada me parece raro",
    "notas",
    "modo",
    "notes",
    "call",
    "audio",
    "hey call",
    "talk to notes audio notes",
    "audio notes talk to notes",
  ])
    assert.deepEqual(classify(t), { kind: "words" }, t);
});

test("a near miss off the list is words in either language, and logs once", () => {
  for (const [t, name] of [
    ["notas de audia", "async"],
    ["modo llamado", "call"],
    ["audio nots", "async"],
  ]) {
    const lines = [];
    assert.deepEqual(classify(t, (m) => lines.push(m)), { kind: "words" }, t);
    assert.deepEqual(lines, [`intents: near "${t}" → ${name}?`], t);
  }
});
