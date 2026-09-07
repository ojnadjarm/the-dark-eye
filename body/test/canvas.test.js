/** canvas.js — the bounds maths and the on-demand child: items down, verdicts up. */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCanvas, canvasBounds } = require("../src/canvas");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-test-"));
// a fake canvas-app: reports its bounds, then answers every item with a verdict
const FAKE = path.join(dir, "fake-canvas-app.js");
fs.writeFileSync(
  FAKE,
  `const readline = require("node:readline");
   const at = (f) => process.argv[process.argv.indexOf(f) + 1];
   const zoom = at("--zoom"), bounds = at("--bounds");
   const [x, y, width, height] = bounds.split(",").map(Number);
   process.stdout.write(JSON.stringify({ type: "bounds", requested: { x, y, width, height }, actual: { x: x + 34, y, width, height }, zoom: Number(zoom) }) + "\\n");
   readline.createInterface({ input: process.stdin }).on("line", (l) => {
     const m = JSON.parse(l);
     if (m.type !== "item") return;
     if (!m.item) return void process.stdout.write(JSON.stringify({ type: "close" }) + "\\n");
     const id = m.item.title === "ghost" ? "999" : m.item.id;
     process.stdout.write(JSON.stringify({ type: "verdict", id, verdict: m.item.title === "no" ? "rejected" : "approved" }) + "\\n");
   });`
);

const visual = (title) => ({ title, kind: "html", data: "<b>x</b>", verdict: true });

/** A canvas whose "Electron" is node running the fake app. */
function canvasOf(workArea = { x: 0, y: 0, width: 1366, height: 768 }) {
  const events = [];
  const logs = [];
  const c = createCanvas({
    workArea,
    zoom: 1.5,
    onEvent: (e) => events.push(e),
    log: (m) => logs.push(m),
    bin: process.execPath,
    args: [],
    app: FAKE,
  });
  return { c, events, logs };
}

/** Wait until `f()` is true, or fail after 5 s. */
async function until(f, what) {
  for (let i = 0; i < 500; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("the window is centred in the work area, capped at 980x720", () => {
  assert.deepEqual(canvasBounds({ x: 0, y: 0, width: 1366, height: 768 }), { x: 193, y: 40, width: 980, height: 688 });
  assert.deepEqual(canvasBounds({ x: 0, y: 27, width: 1920, height: 1053 }), { x: 470, y: 194, width: 980, height: 720 });
  assert.deepEqual(canvasBounds({ x: 100, y: 0, width: 800, height: 600 }), { x: 140, y: 40, width: 720, height: 520 });
});

test("nothing is spawned until he asks", () => {
  const { c } = canvasOf();
  c.push(visual("held"));
  assert.equal(c.isVisible(), false);
  c.hide();
});

test("open spawns the app, sends the item, and logs both bounds", async () => {
  const { c, logs } = canvasOf();
  c.push(visual("one"));
  c.open();
  assert.equal(c.isVisible(), true);
  await until(() => logs.some((l) => l.startsWith("canvas open in")), "the open log");
  const line = logs.find((l) => l.startsWith("canvas open in"));
  assert.match(line, /requested 193,40 980x688/);
  assert.match(line, /got 227,40 980x688/);
  c.hide();
  await until(() => !c.isVisible(), "the child to go");
});

test("a verdict reaches onEvent and the last one closes the window", async () => {
  const { c, events } = canvasOf();
  c.push(visual("one"));
  c.push(visual("no"));
  c.open();
  await until(() => !c.isVisible(), "the gallery to empty and the window to close");
  assert.deepEqual(events, [
    { event: "canvas-approved", detail: "one" },
    { event: "canvas-rejected", detail: "no" },
  ]);
});

test("a verdict on an id the gallery lost changes nothing", async () => {
  const { c, events } = canvasOf();
  c.push(visual("ghost"));
  c.open();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(events, []);
  assert.equal(c.isVisible(), true);
  c.hide();
});

test("hide kills the child, open after it starts a new one", async () => {
  const { c } = canvasOf();
  c.push(visual("one"));
  c.push(visual("two"));
  c.open();
  await until(() => c.isVisible(), "the child");
  c.hide();
  await until(() => !c.isVisible(), "the child to go");
  c.open();
  assert.equal(c.isVisible(), true);
  c.hide();
});
