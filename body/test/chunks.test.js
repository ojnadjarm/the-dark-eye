/** chunks(): sentence split, short fragments merged, never empty. */
const { test } = require("node:test");
const assert = require("node:assert");
const chunks = require("../src/chunks");

test("a short text is one chunk", () => {
  assert.deepEqual(chunks("The Eye is open."), ["The Eye is open."]);
});

test("whitespace is collapsed and trimmed", () => {
  assert.deepEqual(chunks("  a\n\n b  "), ["a b"]);
});

test("short sentences merge into one chunk", () => {
  assert.deepEqual(chunks("One. Two! Three?"), ["One. Two! Three?"]);
});

test("splits on . ! ? … ; :", () => {
  for (const p of [".", "!", "?", "…", ";", ":"]) {
    const long = "x".repeat(200);
    assert.deepEqual(chunks(`${long}${p} ${long}`), [`${long}${p}`, long]);
  }
});

test("a sentence of its own size is a chunk of its own — the ear waits for one, not for all", () => {
  const s = "a".repeat(50) + ".";
  assert.deepEqual(chunks([s, s, s].join(" ")), [s, s, s]);
});

test("a long sentence stays whole", () => {
  const s = "b".repeat(300) + ".";
  assert.deepEqual(chunks(s), [s]);
});

test("text with no sentence end is one chunk", () => {
  assert.deepEqual(chunks("no punctuation here"), ["no punctuation here"]);
});

test("empty text returns the text itself", () => {
  assert.deepEqual(chunks(""), [""]);
});
