/** The canvas gallery: push, cap at 12, verdict removes, next advances. */
const { test } = require("node:test");
const assert = require("node:assert");
const { createGallery, MAX_ITEMS } = require("../src/gallery");

const visual = (title) => ({ title, kind: "html", data: "<b>x</b>", verdict: false });

test("push returns the stored item with an id and a timestamp", () => {
  const g = createGallery();
  const item = g.push(visual("one"));
  assert.equal(item.title, "one");
  assert.equal(item.kind, "html");
  assert.ok(item.id);
  assert.ok(item.ts > 0);
  assert.equal(g.current().queued, 1);
});

test("current() is the oldest item and carries how many are held", () => {
  const g = createGallery();
  g.push(visual("one"));
  g.push(visual("two"));
  assert.equal(g.current().title, "one");
  assert.equal(g.current().queued, 2);
});

test("current() is null on an empty gallery", () => {
  assert.equal(createGallery().current(), null);
});

test("ids are unique", () => {
  const g = createGallery();
  assert.notEqual(g.push(visual("a")).id, g.push(visual("b")).id);
});

test(`the gallery holds at most ${MAX_ITEMS}, dropping the oldest`, () => {
  const g = createGallery();
  for (let i = 1; i <= MAX_ITEMS + 3; i++) g.push(visual(`v${i}`));
  assert.equal(g.current().queued, MAX_ITEMS);
  assert.equal(g.current().title, "v4");
});

test("verdict removes that item and returns it", () => {
  const g = createGallery();
  const one = g.push(visual("one"));
  g.push(visual("two"));
  assert.equal(g.verdict(one.id).title, "one");
  assert.equal(g.current().title, "two");
  assert.equal(g.current().queued, 1);
});

test("a verdict on an unknown id changes nothing", () => {
  const g = createGallery();
  g.push(visual("one"));
  assert.equal(g.verdict("nope"), null);
  assert.equal(g.current().title, "one");
});

test("the last verdict empties the gallery", () => {
  const g = createGallery();
  const one = g.push(visual("one"));
  g.verdict(one.id);
  assert.equal(g.current(), null);
});
