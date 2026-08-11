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

// palette a session gets if it doesn't pick a color — no greens, green is the Eye
const PALETTE = [
  "#b04dff", "#4dd9ff", "#ff9a4d", "#ffe14d", "#ff4d88",
  "#ff4dd9", "#4d6bff", "#ff6b4d", "#9db4ff", "#ffb84d",
];
function hueOfHex(hex) {
  const [r, g2, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const mx = Math.max(r, g2, b), mn = Math.min(r, g2, b), d = mx - mn;
  if (!d) return 0;
  let h;
  if (mx === r) h = ((g2 - b) / d) % 6;
  else if (mx === g2) h = (b - r) / d + 2;
  else h = (r - g2) / d + 4;
  return (h * 60 + 360) % 360;
}
const GREEN_HUE = 152; // the Eye's identity — sessions may not wear it

const hub = {
  buses: new Map(),
  meta: new Map(), // name → { lastSeen, brief } — updated on every listen call
  reg: new Map([["deep", { color: "#b04dff" }], ["fast", { color: "#4dd9ff" }]]),
  active: "deep",
  bus(name) {
    if (!this.buses.has(name)) this.buses.set(name, makeBus());
    return this.buses.get(name);
  },
  names() {
    return [...new Set([...this.reg.keys(), ...this.buses.keys()])];
  },
  // any session may join: unique name, unique non-green color
  register(name, color) {
    const clean = String(name ?? "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "").slice(0, 16);
    if (!clean) return { error: "invalid name — use letters, digits, dashes" };
    const existing = this.reg.get(clean);
    const used = new Set(
      [...this.reg.entries()].filter(([n]) => n !== clean).map(([, r]) => r.color)
    );
    let chosen = null;
    let colorNote;
    if (color != null) {
      const want = String(color).toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(want)) colorNote = "invalid color format, auto-assigned";
      else if (Math.abs(hueOfHex(want) - GREEN_HUE) < 30) colorNote = "green belongs to the Eye, auto-assigned";
      else if (used.has(want)) colorNote = "color already taken, auto-assigned";
      else chosen = want;
    }
    if (!chosen) chosen = existing?.color && !used.has(existing.color) ? existing.color : null;
    if (!chosen) chosen = PALETTE.find((p) => !used.has(p)) ?? null;
    if (!chosen) {
      // palette exhausted — spread hues, skipping the Eye's green band
      let h = (this.reg.size * 47) % 360;
      if (Math.abs(h - GREEN_HUE) < 30) h = (h + 60) % 360;
      chosen = `hsl-${h}`; // placeholder replaced below
      const f = (n) => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (0.65 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
      };
      chosen = "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("");
    }
    this.reg.set(clean, { color: chosen });
    return { name: clean, color: chosen, ...(colorNote ? { note: colorNote } : {}) };
  },
  roster() {
    const now = Date.now();
    return this.names().map((name) => ({
      name,
      color: this.reg.get(name)?.color ?? null,
      connected:
        (this.buses.get(name)?.waiters.length ?? 0) > 0 ||
        now - (this.meta.get(name)?.lastSeen ?? 0) < 90_000,
      active: this.active === name,
      brief: this.meta.get(name)?.brief ?? null,
    }));
  },
  onConnect: null, // set once the Eye exists; fires the first time a session listens
  touch(name) {
    const known = this.meta.get(name);
    this.meta.set(name, { lastSeen: Date.now(), brief: known?.brief });
    if (!known) this.onConnect?.(name);
  },
  setBrief(name, brief) {
    const known = this.meta.get(name);
    // a brief alone is not a heartbeat — only listen() proves connection
    this.meta.set(name, { lastSeen: known?.lastSeen ?? 0, brief });
  },
  push(t) {
    this.bus(this.active).push(t);
  },
};

// a session's color always comes from the registry; unknown names auto-join
function sessionColor(name) {
  if (!hub.reg.has(name)) hub.register(name);
  return hub.reg.get(name)?.color ?? "#9db4ff";
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
  // no click action: the mic answers ONLY to the key shortcut (his rule)
  const dots = new Map(); // "<color>:<filled>" → nativeImage
  const dot = (color, filled) => {
    const key = `${color}:${filled}`;
    if (!dots.has(key)) dots.set(key, nativeImage.createFromBuffer(dotPng(color, filled)));
    return dots.get(key);
  };
  const rebuild = () => {
    const sessions = hub.roster();
    tray.setToolTip(`The Dark Eye — voice: ${hub.active}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Voice channel", enabled: false },
        ...sessions.map((s) => ({
          label:
            s.name +
            (s.active ? "  ⟨voice⟩" : "") +
            (s.brief ? `  ·  ${s.brief.slice(0, 44)}` : ""),
          icon: dot(s.color ?? sessionColor(s.name), s.connected),
          click: () => routeTo(s.name),
        })),
        { type: "separator" },
        { label: "Mic: Ctrl+Alt+Space (tap to open / tap to send)", enabled: false },
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
    onRegister: async ({ name, color, brief }) => {
      const r = hub.register(name, color);
      if (r.error) return r;
      if (brief) hub.setBrief(r.name, brief);
      log(`register: ${r.name} ${r.color}${r.note ? ` (${r.note})` : ""}`);
      whisper(`⟨ ${r.name} ⟩ joined${brief ? " · " + brief : ""}`);
      return { ...r, active: hub.active, sessions: hub.roster() };
    },
  });
});

app.on("will-quit", () => hook?.stop());
app.on("window-all-closed", () => {});
