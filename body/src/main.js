/**
 * The Dark Eye — body, slice A2: the Eye + its MCP nervous system.
 * Voice worker (Kokoro/Parakeet) is the next step; until then, speak()
 * shows captions and the knot pulses as if speaking.
 */
const { app, BrowserWindow, screen, utilityProcess, ipcMain } = require("electron");

// audio must play without any user gesture — the Eye is never focused
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { startServer } = require("./server");

const MODEL_DIR = path.join(__dirname, "..", "models", "kokoro-multi-lang-v1_0");
const ASR_DIR = path.join(__dirname, "..", "models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8");

// transcripts flow: mic → voice worker → hub → the ACTIVE session's listen()
// calls. Each brain listens on a named bus; Oscar routes his voice by saying
// "switch to <name>" (intercepted here, never forwarded to a brain).
function makeBus() {
  return {
    waiters: [],
    queue: [],
    push(t) {
      const w = this.waiters.shift();
      if (w) w(t);
      else this.queue.push(t);
    },
    take(ms) {
      if (this.queue.length) return Promise.resolve(this.queue.shift());
      return new Promise((res) => {
        this.waiters.push(res);
        setTimeout(() => {
          const i = this.waiters.indexOf(res);
          if (i >= 0) {
            this.waiters.splice(i, 1);
            res(null);
          }
        }, ms);
      });
    },
  };
}

const hub = {
  buses: new Map(),
  meta: new Map(), // name → { lastSeen } — updated on every listen call
  active: "deep",
  bus(name) {
    if (!this.buses.has(name)) this.buses.set(name, makeBus());
    return this.buses.get(name);
  },
  names() {
    return [...new Set([...this.buses.keys(), "deep", "fast"])];
  },
  onConnect: null, // set once the Eye exists; fires the first time a session listens
  touch(name) {
    const known = this.meta.get(name);
    this.meta.set(name, { lastSeen: Date.now(), brief: known?.brief });
    if (!known) this.onConnect?.(name);
  },
  setBrief(name, brief) {
    const known = this.meta.get(name);
    this.meta.set(name, { lastSeen: known?.lastSeen ?? Date.now(), brief });
  },
  // connected = a brain is long-polling right now, or has within 90s
  info() {
    const now = Date.now();
    return this.names().map((name) => ({
      name,
      connected:
        (this.buses.get(name)?.waiters.length ?? 0) > 0 ||
        now - (this.meta.get(name)?.lastSeen ?? 0) < 90_000,
    }));
  },
  push(t) {
    this.bus(this.active).push(t);
  },
};

// session identity colors — never green, green is the Eye itself
const SESSION_COLORS = { deep: "#b04dff", fast: "#4dd9ff" };
const EXTRA_COLORS = ["#ff9a4d", "#ffe14d", "#ff4d88", "#ff4dd9"];
const assignedColors = new Map();
let extraColorI = 0;
function sessionColor(name) {
  if (SESSION_COLORS[name]) return SESSION_COLORS[name];
  if (!assignedColors.has(name))
    assignedColors.set(name, EXTRA_COLORS[extraColorI++ % EXTRA_COLORS.length]);
  return assignedColors.get(name);
}

const EYE_W = 340;
const EYE_H = 380;
const MARGIN = 16;
const PORT = 8642;

let eye;

function loadConfig() {
  const dir = path.join(app.getPath("appData"), "dark-eye");
  const file = path.join(dir, "config.json");
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* first run */
  }
  if (!cfg.secret) {
    cfg.secret = crypto.randomBytes(24).toString("hex");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  }
  return cfg;
}

function createEye() {
  const { workArea } = screen.getPrimaryDisplay();
  eye = new BrowserWindow({
    width: EYE_W,
    height: EYE_H,
    x: workArea.x + workArea.width - EYE_W - MARGIN,
    y: workArea.y + workArea.height - EYE_H - MARGIN,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "eye", "preload.js"),
    },
  });
  eye.setAlwaysOnTop(true, "screen-saver");
  eye.setIgnoreMouseEvents(true, { forward: true });
  eye.setContentProtection(true);
  eye.loadFile(path.join(__dirname, "eye", "index.html"));
}

const log = (m) => console.log(`[body] ${m}`);

// one mouth for everyone: caption + Kokoro, used by brains and the body itself
function say(text) {
  eye?.webContents.send("speak", text);
  if (voiceReady) voice.postMessage({ type: "speak", id: ++speakSeq, text });
}

// a whisper: the caption decodes on screen but no voice — for connection
// notices and briefs, so the Eye never SPEAKS unprompted (the law holds)
function whisper(text) {
  eye?.webContents.send("speak", text);
}

// route Oscar's voice to a session: sigil recolors, stale attention clears
function routeTo(name, { announce = false } = {}) {
  hub.active = name;
  log(`voice routed to session: ${name}`);
  eye?.webContents.send("session", { active: name, color: sessionColor(name) });
  eye?.webContents.send("attention", { session: name, on: false });
  if (announce) say(`Channel open. ${name} has your voice.`);
}

// "switch to fast" is for the BODY, not the brain — route the mic, confirm out
// loud, and swallow the transcript. Everything else goes to the active session.
const SWITCH_RE = /\b(?:switch|change|cambia(?:r)?)\b/i;
function handleTranscript(text) {
  const words = text.trim().split(/\s+/);
  if (SWITCH_RE.test(text) && words.length <= 8) {
    const lower = text.toLowerCase();
    const target = hub.names().find((n) => lower.includes(n.toLowerCase()));
    if (target) routeTo(target, { announce: true });
    else say(`I can route you to: ${hub.names().join(", ")}. Say switch to, then the name.`);
    return;
  }
  hub.push(text);
  eye?.webContents.send("heard", text);
}

// -- the voice --------------------------------------------------------------
let voice = null;
let voiceReady = false;
function startVoice(cfg) {
  voice = utilityProcess.fork(path.join(__dirname, "voice.js"));
  voice.on("message", (m) => {
    if (m.type === "ready") {
      voiceReady = true;
      log(`voice ready — ${m.speakers} speakers @ ${m.sampleRate}Hz, sid ${cfg.voiceSid ?? 17}`);
      if (process.env.DARK_EYE_SAY) {
        const text = process.env.DARK_EYE_SAY;
        log(`self-test speak: ${text}`);
        eye?.webContents.send("speak", text);
        voice.postMessage({ type: "speak", id: ++speakSeq, text });
      }
    } else if (m.type === "audio") {
      log(`audio chunk seq=${m.seq} last=${m.last} n=${m.samples?.length ?? "?"}`);
      eye?.webContents.send("audio", {
        seq: m.seq,
        last: m.last,
        sampleRate: m.sampleRate,
        samples: m.samples,
      });
    } else if (m.type === "transcript") {
      log(`heard (${m.ms}ms): ${m.text}`);
      if (m.text) handleTranscript(m.text);
    } else if (m.type === "err") {
      log(`voice error: ${m.message}`);
    }
  });
  voice.on("exit", (code) => {
    voiceReady = false;
    log(`voice worker exited (${code}) — respawning in 3s`);
    setTimeout(() => startVoice(cfg), 3000);
  });
  voice.postMessage({
    type: "init",
    modelDir: MODEL_DIR,
    asrDir: ASR_DIR,
    sid: cfg.voiceSid ?? 17,
    speed: cfg.voiceSpeed ?? 1.0,
  });
}

// -- push-to-talk: TOGGLE — tap Ctrl+Alt+Space to open the mic, tap again to
// close and send. Failsafe closes a forgotten mic after 90s (the clip still
// gets transcribed). The listening rings on the Eye show the mic is open.
const MIC_MAX_MS = 90_000;
let micToggle = null; // set by startPtt; the tray shares it
let hook = null;
function startPtt() {
  const { uIOhook, UiohookKey } = require("uiohook-napi");
  hook = uIOhook;
  let pressed = false; // debounce the key's auto-repeat
  let open = false;
  let failsafe = null;
  const setMic = (on) => {
    open = on;
    eye?.webContents.send("ptt", on);
    clearTimeout(failsafe);
    if (on)
      failsafe = setTimeout(() => {
        log("mic failsafe: auto-closing after 90s");
        setMic(false);
      }, MIC_MAX_MS);
  };
  micToggle = () => setMic(!open);
  uIOhook.on("keydown", (e) => {
    if (e.keycode === UiohookKey.Space && e.ctrlKey && e.altKey && !pressed) {
      pressed = true;
      setMic(!open);
    }
  });
  uIOhook.on("keyup", (e) => {
    if (e.keycode === UiohookKey.Space) pressed = false;
  });
  uIOhook.start();
  log("push-to-talk armed: tap Ctrl+Alt+Space to open/close the mic");
}

// -- cloak (hidden from screen capture) -------------------------------------
let cloaked = true; // createEye() boots with content protection on
function setCloak(on) {
  cloaked = on;
  eye?.setContentProtection(on);
  log(`cloak: ${on ? "on — hidden from capture" : "off — visible to capture"}`);
}

// -- tray: the eye by the Windows clock -------------------------------------
// Right-click: session list (● connected / ○ silent, click = route voice),
// mic toggle, cloak toggle, quit. Left-click: toggle the mic.
let tray = null;
function startTray() {
  const { Tray, Menu, nativeImage } = require("electron");
  const { dotPng } = require("./png");
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "tray.png"));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.on("click", () => micToggle?.());
  const dots = new Map(); // "<color>:<filled>" → nativeImage
  const dot = (color, filled) => {
    const key = `${color}:${filled}`;
    if (!dots.has(key)) dots.set(key, nativeImage.createFromBuffer(dotPng(color, filled)));
    return dots.get(key);
  };
  const rebuild = () => {
    const sessions = hub.info();
    tray.setToolTip(`The Dark Eye — voice: ${hub.active}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Voice channel", enabled: false },
        ...sessions.map((s) => {
          const brief = hub.meta.get(s.name)?.brief;
          return {
            label:
              s.name +
              (hub.active === s.name ? "  ⟨voice⟩" : "") +
              (brief ? `  ·  ${brief.slice(0, 44)}` : ""),
            icon: dot(sessionColor(s.name), s.connected),
            click: () => routeTo(s.name),
          };
        }),
        { type: "separator" },
        { label: "Toggle mic  (Ctrl+Alt+Space)", click: () => micToggle?.() },
        {
          label: "Cloaked from capture",
          type: "checkbox",
          checked: cloaked,
          click: (item) => setCloak(item.checked),
        },
        { type: "separator" },
        { label: "Quit the Eye", click: () => app.quit() },
      ])
    );
  };
  rebuild();
  setInterval(rebuild, 5000);
}

let micSeq = 0;

let speakSeq = 0;
app.whenReady().then(() => {
  const cfg = loadConfig();
  ipcMain.on("debug", (_e, m) => log(`renderer: ${m}`));
  ipcMain.on("mic-audio", (_e, { samples, sampleRate }) => {
    log(`mic audio: ${samples.length} samples @ ${sampleRate}Hz`);
    if (voiceReady && samples.length > 4000)
      voice.postMessage({ type: "transcribe", id: ++micSeq, samples, sampleRate });
  });
  // the Eye's mic needs blanket media permission — it has no permission UI
  const { session } = require("electron");
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === "media")
  );
  createEye();
  startVoice(cfg);
  startPtt();
  startTray();
  hub.onConnect = (name) => whisper(`⟨ ${name} ⟩ connected`);
  startServer({
    port: cfg.port || PORT,
    secret: cfg.secret,
    hub,
    log,
    onSpeak: async (text) => {
      log(`speak: ${text}`);
      say(text);
    },
    onStatus: async (s) => {
      log(`status: ${s.id} ${s.state} ${s.label}`);
      eye?.webContents.send("status", s);
    },
    onCloak: async (on) => setCloak(on),
    onAttention: async ({ session, on, label }) => {
      log(`attention: ${session} ${on ? "on" : "off"} ${label ?? ""}`);
      eye?.webContents.send("attention", {
        session,
        on,
        label: label ?? "",
        color: sessionColor(session),
      });
    },
    onActive: async (session) => routeTo(session),
    onIntroduce: async ({ session, brief }) => {
      log(`introduce: ${session} — ${brief}`);
      hub.setBrief(session, brief);
      whisper(`⟨ ${session} ⟩ ${brief}`);
    },
  });
});

app.on("will-quit", () => hook?.stop());
app.on("window-all-closed", () => {});
