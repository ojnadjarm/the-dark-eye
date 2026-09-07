/**
 * The canvas window: an Electron app that exists only while he is looking.
 * Items arrive as JSON lines on stdin, verdicts and the bounds leave on stdout.
 */
const path = require("node:path");
const readline = require("node:readline");
const { app, BrowserWindow, ipcMain } = require("electron");

const CANVAS = path.join(__dirname, "..", "canvas");

/** `--zoom 1.5 --bounds x,y,w,h` */
function options(argv) {
  const at = (f) => argv[argv.indexOf(f) + 1];
  const [x, y, width, height] = (at("--bounds") || "0,0,980,720").split(",").map(Number);
  return { zoom: Number(at("--zoom")) || 1, bounds: { x, y, width, height } };
}

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

app.whenReady().then(() => {
  const { zoom, bounds } = options(process.argv);
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    resizable: true,
    show: false,
    backgroundColor: "#050807",
    webPreferences: {
      preload: path.join(CANVAS, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.loadFile(path.join(CANVAS, "index.html"));

  let item = null;
  let loaded = false;
  const draw = () => loaded && win.webContents.send("canvas-item", item);

  win.webContents.once("did-finish-load", () => {
    loaded = true;
    win.webContents.setZoomFactor(zoom);
    draw();
    win.show();
    win.moveTop();
    win.focus();
    // D7: what was asked for and what the compositor actually gave
    out({ type: "bounds", requested: bounds, actual: win.getBounds() });
  });

  ipcMain.on("canvas-verdict", (_e, v) => out({ type: "verdict", ...v }));
  ipcMain.on("canvas-close", () => out({ type: "close" }));

  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    try {
      const m = JSON.parse(line);
      if (m.type === "item") {
        item = m.item;
        draw();
      }
    } catch {
      /* not for us */
    }
  });
  // the body died: so does the window
  process.stdin.on("end", () => app.quit());
});

app.on("window-all-closed", () => app.quit());
