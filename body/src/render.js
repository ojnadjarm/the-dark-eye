/**
 * The eye: node listens on the render socket, `eye-render` connects to it and
 * is respawned when it dies.
 * One JSON object per line, both ways.
 */
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BIN = path.join(__dirname, "..", "render", "target", "release", "eye-render");

/** `$XDG_RUNTIME_DIR/dark-eye/render.sock`, or `DARK_EYE_RENDER_SOCK` (a hand-run body). */
function socketPath() {
  return process.env.DARK_EYE_RENDER_SOCK || path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "dark-eye", "render.sock");
}

/**
 * `{send, stop, connected}`; `onMessage` gets every line the renderer sends
 * (`ready`, `outputs`, `stats`).
 */
function createRenderBridge({
  bin = BIN,
  args = [],
  sock = socketPath(),
  onMessage,
  log = () => {},
  respawnMs = 3000,
  onFatal = () => process.exit(1),
} = {}) {
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  fs.rmSync(sock, { force: true });
  let conn = null;
  let child = null;
  let timer = null;
  let stopped = false;

  const server = net.createServer((c) => {
    if (conn) {
      log("render socket: second eye-render refused");
      c.destroy();
      return;
    }
    conn = c;
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onMessage?.(JSON.parse(line));
        } catch {
          log(`eye-render sent a bad line: ${line.slice(0, 80)}`);
        }
      }
    });
    c.on("error", () => {});
    c.on("close", () => {
      if (conn === c) conn = null;
    });
  });
  let listening = false;
  server.on("error", (e) => {
    log(`render socket: ${e.message}`);
    // without the socket there is no eye at all: die and let systemd restart
    if (!listening && !stopped) onFatal(e);
  });
  server.listen(sock, () => {
    listening = true;
    fs.chmodSync(sock, 0o600);
    spawnRenderer();
  });

  function spawnRenderer() {
    child = spawn(bin, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", (e) => log(`eye-render failed to start: ${e.message}`));
    child.on("exit", (code, signal) => {
      child = null;
      if (stopped) return;
      log(`eye-render exited (${signal ? `signal ${signal}` : code}) — respawning in ${respawnMs}ms`);
      timer = setTimeout(spawnRenderer, respawnMs);
      timer.unref?.();
    });
  }

  return {
    send(msg) {
      conn?.write(`${JSON.stringify(msg)}\n`);
    },
    get connected() {
      return conn !== null;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      child?.kill();
      conn?.destroy();
      server.close();
      fs.rmSync(sock, { force: true });
    },
  };
}

/**
 * His transcript as a caption in his own voice: the same `speak` the Eye's
 * words use, so it decodes out of the katakana, sits on the same backdrop and
 * lingers the same — `who` only picks the gold palette. With no `ms` the
 * reveal runs at the reference's 38 characters a second.
 */
const ownerCaption = (text) => ({ type: "speak", text, who: "owner" });

module.exports = { createRenderBridge, socketPath, ownerCaption, BIN };
