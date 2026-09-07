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

test("anything else is words", () => {
  for (const t of ["", "hello there", "switch to deep", "who's waiting"])
    assert.deepEqual(classify(t), { kind: "words" }, t);
});
