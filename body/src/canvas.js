/**
 * The canvas controller: pure node. It holds the gallery and, only when his
 * voice asks, spawns `canvas-app` — an Electron window that lives exactly as
 * long as he is looking. Items go down its stdin, verdicts come up its stdout.
 */
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createGallery } = require("./gallery");

const ELECTRON = path.join(__dirname, "..", "node_modules", ".bin", "electron");
const APP = path.join(__dirname, "canvas-app");
const MAX_W = 980;
const MAX_H = 720;
const INSET = 80;

/** Centred in the TV's work area, at most 980x720 with an 80 px inset. */
function canvasBounds(workArea) {
  const width = Math.min(MAX_W, workArea.width - INSET);
  const height = Math.min(MAX_H, workArea.height - INSET);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

/**
 * `{isVisible, hide, push, open}`. A verdict travels back through onEvent;
 * the last verdict closes the window. `bin`/`app` are for the tests.
 */
function createCanvas({ workArea, zoom, onEvent, log = () => {}, bin = ELECTRON, args = ["--ozone-platform=x11"], app = APP }) {
  const gallery = createGallery();
  let child = null;
  let openedAt = 0;

  const isVisible = () => child !== null;
  const send = (msg) => child?.stdin.write(`${JSON.stringify(msg)}\n`);
  const draw = () => send({ type: "item", item: gallery.current() });

  function hide() {
    if (!child) return;
    const c = child;
    child = null;
    c.kill("SIGTERM");
  }

  const fmt = (b) => `${b.x},${b.y} ${b.width}x${b.height}`;

  function onLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return; // Electron's own chatter
    }
    if (m.type === "bounds") {
      log(`canvas open in ${Date.now() - openedAt} ms — requested ${fmt(m.requested)}, got ${fmt(m.actual)}`);
    } else if (m.type === "close") {
      hide();
    } else if (m.type === "verdict") {
      const item = gallery.verdict(m.id);
      if (!item) return;
      log(`canvas: ${item.id} ${m.verdict} — ${item.title}`);
      if (m.verdict === "approved" || m.verdict === "rejected")
        onEvent({ event: `canvas-${m.verdict}`, detail: item.title });
      if (gallery.current()) draw();
      else hide();
    }
  }

  return {
    isVisible,
    hide,
    push(visual) {
      const item = gallery.push(visual);
      if (isVisible()) draw();
      return item;
    },
    open() {
      if (child) return;
      const b = canvasBounds(workArea);
      openedAt = Date.now();
      const c = spawn(
        bin,
        [...args, app, "--zoom", String(zoom), "--bounds", `${b.x},${b.y},${b.width},${b.height}`],
        { stdio: ["pipe", "pipe", "inherit"] }
      );
      child = c;
      c.stdin.on("error", () => {});
      c.stdout.setEncoding("utf8");
      let buf = "";
      c.stdout.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const l of lines) if (l.trim()) onLine(l);
      });
      c.on("error", (e) => {
        if (child === c) child = null;
        log(`canvas failed to start: ${e.message}`);
      });
      c.on("exit", (code) => {
        if (child === c) child = null;
        log(`canvas closed (${code})`);
      });
      draw();
    },
  };
}

module.exports = { createCanvas, canvasBounds, ELECTRON, APP };
