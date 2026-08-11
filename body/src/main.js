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
// Kokoro speakers a session gets if it doesn't pick one — his ear-tested male
// set; sid 17 is the Eye's own voice and belongs to deep/DarkSaddler alone
const VOICE_POOL = [11, 12, 13, 14, 15, 16, 18, 19];
const EYE_SID = 17;
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
  reg: new Map([["deep", { color: "#b04dff", sid: EYE_SID }], ["fast", { color: "#4dd9ff", sid: 11 }]]),
  active: "deep",
  bus(name) {
    if (!this.buses.has(name)) this.buses.set(name, makeBus());
    return this.buses.get(name);
  },
  names() {
    return [...new Set([...this.reg.keys(), ...this.buses.keys()])];
  },
  // any session may join: unique name, unique non-green color, unique voice.
  // `adopt` is for the hub itself decorating a name that already exists as a
  // live bus (auto-join on speak/attention) — the liveness guard only stops
  // NEW registrants from stealing a live name, so adoption skips it.
  register(name, color, voice, adopt = false) {
    const clean = String(name ?? "").toLowerCase().trim().replace(/[^a-z0-9-]/g, "").slice(0, 16);
    if (!clean) return { error: "invalid name — use letters, digits, dashes" };
    // a name that is live right now belongs to someone — two pollers on one
    // bus would round-robin Oscar's words between them
    const live =
      (this.buses.get(clean)?.waiters.length ?? 0) > 0 ||
      Date.now() - (this.meta.get(clean)?.lastSeen ?? 0) < 90_000;
    if (live && !adopt) return { error: `name '${clean}' is connected right now — pick another` };
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
    // voice: explicit pick honored if free and not the Eye's; else kept from a
    // previous registration; else next free from the ear-tested pool
    const usedSid = new Set(
      [...this.reg.entries()].filter(([n]) => n !== clean).map(([, r]) => r.sid).filter((s) => s != null)
    );
    let sid = null;
    let voiceNote;
    if (voice != null) {
      const want = Number(voice);
      if (!Number.isInteger(want) || want < 0 || want > 52) voiceNote = "voice must be a sid 0-52, auto-assigned";
      else if (want === EYE_SID && clean !== "deep") voiceNote = "voice 17 belongs to the Eye, auto-assigned";
      else if (usedSid.has(want)) voiceNote = "voice already taken, auto-assigned";
      else sid = want;
    }
    if (sid == null) sid = existing?.sid != null && !usedSid.has(existing.sid) ? existing.sid : null;
    if (sid == null) sid = VOICE_POOL.find((s) => !usedSid.has(s)) ?? null;
    if (sid == null) for (let s = 0; s < 53 && sid == null; s++) if (s !== EYE_SID && !usedSid.has(s)) sid = s;
    this.reg.set(clean, { color: chosen, sid: sid ?? EYE_SID });
    const note = [colorNote, voiceNote].filter(Boolean).join("; ");
    return { name: clean, color: chosen, voice: sid ?? EYE_SID, ...(note ? { note } : {}) };
  },
  roster() {
    const now = Date.now();
    return this.names().map((name) => ({
      name,
      color: this.reg.get(name)?.color ?? null,
      voice: this.reg.get(name)?.sid ?? null,
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
  if (!hub.reg.has(name)) hub.register(name, undefined, undefined, true);
  return hub.reg.get(name)?.color ?? "#9db4ff";
}

// -- call waiting + the canvas gallery --------------------------------------
// His law: nothing ever interrupts his screen. A session that wants him while
// he's on another channel goes on hold; a visual to show him becomes a quiet
// mark by the eye. He opens things himself — by voice or from the tray.
const waiting = []; // calls on hold, oldest first: {session, why, ts}
const gallery = []; // visuals awaiting his eyes: {id, session, title, kind, data, ts}
const heldWords = new Map(); // session → [text] — speech parked while he's elsewhere
const HELD_WHY = "words on hold";
const GALLERY_MAX = 12;
let showSeq = 0;

// pasted images land here as files; brains get the WSL path and read them
const INBOX = path.join(__dirname, "..", "..", "inbox");
const wslPath = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_, d) => `/mnt/${d.toLowerCase()}/`);

// the eye shows: the FRONT caller tints the whole organism (the shipped
// attention look), everyone else is a small colored mark docked beside it
function sendDock() {
  const front = waiting[0] ?? null;
  eye?.webContents.send("dock", {
    marks: [
      ...waiting.map((w) => ({ session: w.session, kind: "call", color: sessionColor(w.session) })),
      ...gallery.map((s) => ({ session: s.session, kind: "show", color: sessionColor(s.session) })),
    ],
    front: front
      ? { session: front.session, label: front.why, color: sessionColor(front.session) }
      : null,
  });
}

function publicItem(s) {
  return {
    id: s.id,
    session: s.session,
    color: sessionColor(s.session),
    title: s.title,
    kind: s.kind,
    data: s.data,
    verdict: s.verdict,
    ts: s.ts,
    queued: gallery.length,
  };
}

const EYE_W = 340;
const EYE_H = 380;
const MARGIN = 16;
const PORT = 8642;

let eye;
let canvas = null;
let quitting = false;

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
      // Electron 42 defaults, pinned so a future default change can't loosen us
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  eye.setAlwaysOnTop(true, "screen-saver");
  eye.setIgnoreMouseEvents(true, { forward: true });
  eye.setContentProtection(true);
  eye.loadFile(path.join(__dirname, "eye", "index.html"));
}

// the canvas: a real window the brains draw into. It NEVER opens by itself —
// only openCanvas() (his voice, or the tray) makes it visible. Closing hides
// it; pending items survive until he gives a verdict.
function createCanvas() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = Math.min(980, workArea.width - 80);
  const H = Math.min(720, workArea.height - 80);
  canvas = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + Math.round((workArea.width - W) / 2),
    y: workArea.y + Math.round((workArea.height - H) / 2),
    frame: false,
    resizable: true,
    show: false,
    backgroundColor: "#050807",
    webPreferences: {
      preload: path.join(__dirname, "canvas", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  canvas.setContentProtection(cloaked); // the canvas cloaks with the Eye
  canvas.loadFile(path.join(__dirname, "canvas", "index.html"));
  canvas.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    canvas.hide();
  });
}

function openCanvas() {
  if (!canvas) createCanvas();
  const item = gallery[0] ?? null;
  const present = () => {
    canvas.webContents.send("session", { active: hub.active, color: sessionColor(hub.active) });
    canvas.webContents.send("canvas-item", item ? publicItem(item) : null);
    canvas.show();
  };
  if (canvas.webContents.isLoading()) canvas.webContents.once("did-finish-load", present);
  else present();
}

const log = (m) => console.log(`[body] ${m}`);

// one mouth for everyone: caption + Kokoro, used by brains and the body
// itself. A session's registered Kokoro speaker rides along so each brain
// can sound like itself; no sid = the Eye's own voice. Speech that arrives
// while the voice worker is still booting is held and played once it's
// ready — captions without audio broke his trust in the mouth.
const pendingSpeech = [];
function say(text, sid) {
  eye?.webContents.send("speak", text);
  if (voiceReady) voice.postMessage({ type: "speak", id: ++speakSeq, text, sid });
  else if (pendingSpeech.length < 10) pendingSpeech.push({ text, sid });
}

// a whisper: the caption decodes on screen but no voice — for connection
// notices and briefs, so the Eye never SPEAKS unprompted (the law holds)
function whisper(text) {
  eye?.webContents.send("speak", text);
}

// route Oscar's voice to a session: sigil recolors; if that session was on
// hold, its call is answered — the held reason is spoken and the session gets
// a channel-open event on its bus so it knows to re-ask its question
function routeTo(name, { announce = false } = {}) {
  hub.active = name;
  log(`voice routed to session: ${name}`);
  eye?.webContents.send("session", { active: name, color: sessionColor(name) });
  canvas?.webContents.send("session", { active: name, color: sessionColor(name) });
  const i = waiting.findIndex((w) => w.session === name);
  const held = i >= 0 ? waiting.splice(i, 1)[0] : null;
  if (held) hub.bus(name).push({ event: "channel-open", detail: held.why || "" });
  const words = heldWords.get(name);
  heldWords.delete(name);
  const shows = gallery.filter((s) => s.session === name).length;
  const why = held?.why && held.why !== HELD_WHY ? held.why : "";
  if (announce)
    say(
      `Channel open. ${name} has your voice.` +
        (why ? ` They were waiting: ${why}.` : "") +
        (shows ? ` ${shows === 1 ? "One visual" : shows + " visuals"} on the canvas.` : "")
    );
  else if (held) whisper(`⟨ ${name} ⟩ call answered${why ? " · " + why : ""}`);
  // opening the channel is the delivery moment: parked words play now,
  // in that session's own voice
  if (words?.length) say(words.join(" "), hub.reg.get(name)?.sid);
  sendDock();
}

// "switch to fast" is for the BODY, not the brain — route the mic, confirm out
// loud, and swallow the transcript. Everything else goes to the active session.
const SWITCH_RE = /\b(?:switch|change|cambia(?:r)?)\b/i;
// "show me" / "open the canvas" — the manual approval that lets a visual on
// screen. Full-utterance match only, so dictation like "show me the file"
// still reaches the brain untouched.
const CANVAS_RE = /^(?:show me|open (?:the )?canvas|canvas|close (?:the )?canvas|muestra|abre el lienzo|cierra el lienzo)[.!?]?$/i;
const WAITING_RE = /\b(?:who(?:'s| is)? waiting|qui[eé]n espera)\b/i;
function handleTranscript(text) {
  const words = text.trim().split(/\s+/);
  if (SWITCH_RE.test(text) && words.length <= 8) {
    const lower = text.toLowerCase();
    const target = hub.names().find((n) => lower.includes(n.toLowerCase()));
    if (target) routeTo(target, { announce: true });
    else say(`I can route you to: ${hub.names().join(", ")}. Say switch to, then the name.`);
    return;
  }
  if (CANVAS_RE.test(text.trim())) {
    // empty is fine now — the canvas is also the chat: type links, paste images
    if (/close|cierra/i.test(text)) canvas?.hide();
    else openCanvas();
    return;
  }
  if (WAITING_RE.test(text) && words.length <= 6) {
    if (!waiting.length && !gallery.length) {
      say("No one is waiting.");
      return;
    }
    const calls = waiting.length
      ? "On hold: " + waiting.map((w) => w.session + (w.why ? ", " + w.why : "")).join("; ")
      : "";
    const shows = gallery.length
      ? "On the canvas: " + gallery.map((s) => s.session + ", " + s.title).join("; ")
      : "";
    say([calls, shows].filter(Boolean).join(". ") + ".");
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
      for (const p of pendingSpeech.splice(0))
        voice.postMessage({ type: "speak", id: ++speakSeq, text: p.text, sid: p.sid });
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
      // voice content stays out of logs unless he opts in (DARK_EYE_DEBUG)
      log(`heard (${m.ms}ms): ${process.env.DARK_EYE_DEBUG ? m.text : `[${m.text?.length ?? 0} chars]`}`);
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
  canvas?.setContentProtection(on);
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
        {
          label: gallery.length
            ? `Canvas — ${gallery.length} waiting to be shown`
            : "Canvas (empty)",
          click: () => openCanvas(),
        },
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
  // the Eye's mic needs media permission — but only for the local eye page
  const { session } = require("electron");
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
    cb(permission === "media" && wc.getURL().startsWith("file://"))
  );
  // canvas verdicts: Approve/Reject travel back to the owning session's bus
  // as events; Later just hides the window and keeps the item pending
  ipcMain.on("canvas-verdict", (_e, { id, verdict }) => {
    const i = gallery.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [item] = gallery.splice(i, 1);
    log(`canvas: ${item.id} ${verdict} — ${item.title}`);
    if (verdict === "approved" || verdict === "rejected")
      hub.bus(item.session).push({ event: `canvas-${verdict}`, detail: item.title });
    const next = gallery[0] ?? null;
    if (next) canvas?.webContents.send("canvas-item", publicItem(next));
    else {
      canvas?.webContents.send("canvas-item", null);
      canvas?.hide();
    }
    sendDock();
  });
  ipcMain.on("canvas-close", () => canvas?.hide());
  // the chat bar: typed words are his words — straight to the active session,
  // echoed in gold on the eye exactly like something it heard
  ipcMain.on("canvas-chat", (_e, text) => {
    const clean = String(text ?? "").trim();
    if (!clean) return;
    log(`chat → ${hub.active}: ${process.env.DARK_EYE_DEBUG ? clean : `[${clean.length} chars]`}`);
    hub.push(clean);
    eye?.webContents.send("heard", clean);
  });
  // a pasted image: saved to the inbox, the active brain gets the WSL path
  // and reads the file itself (read-on-gesture — nothing is ever watched)
  ipcMain.on("canvas-paste", (_e, { bytes }) => {
    try {
      if (!bytes || bytes.byteLength > 20_000_000) throw new Error("image missing or over 20MB");
      fs.mkdirSync(INBOX, { recursive: true });
      const file = path.join(INBOX, `paste-${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(bytes));
      const wsl = wslPath(file);
      log(`paste → ${hub.active}: ${wsl} (${bytes.byteLength} bytes)`);
      hub.bus(hub.active).push({ event: "image", detail: wsl });
      eye?.webContents.send("heard", "⟨ image ⟩");
      canvas?.webContents.send("note", `image sent → ${hub.active}`);
    } catch (err) {
      log(`paste error: ${err.message}`);
      canvas?.webContents.send("note", `paste failed: ${err.message}`);
    }
  });
  // the dock is the one clickable spot on an otherwise click-through eye:
  // the renderer reports hover over a mark, we let clicks land just there
  ipcMain.on("dock-hover", (_e, over) => eye?.setIgnoreMouseEvents(!over, { forward: true }));
  ipcMain.on("dock-click", (_e, { kind, session }) => {
    log(`dock click: ${kind} ${session}`);
    if (kind === "chat") canvas?.isVisible() ? canvas.hide() : openCanvas();
    else if (kind === "show") openCanvas();
    else routeTo(session); // clicking a held call answers it
  });
  createEye();
  createCanvas(); // built hidden at boot — the first click must be as instant as the rest
  startVoice(cfg);
  startPtt();
  startTray();
  hub.onConnect = (name) => whisper(`⟨ ${name} ⟩ connected`);
  startServer({
    port: cfg.port || PORT,
    secret: cfg.secret,
    hub,
    log,
    onSpeak: async ({ text, session }) => {
      log(`speak${session ? ` as ${session}` : ""}: ${process.env.DARK_EYE_DEBUG ? text : `[${text.length} chars]`}`);
      if (session && !hub.reg.has(session)) hub.register(session, undefined, undefined, true);
      // his law: a background session overwrites NOTHING — not the voice,
      // not the caption. It waits, always. Its words are parked and it joins
      // the hold queue like a caller; the words play when he opens the channel.
      if (session && session !== hub.active) {
        const q = heldWords.get(session) ?? [];
        q.push(text);
        while (q.length > 5) q.shift();
        heldWords.set(session, q);
        if (!waiting.some((w) => w.session === session))
          waiting.push({ session, why: HELD_WHY, ts: Date.now() });
        sendDock();
        return;
      }
      say(text, session ? hub.reg.get(session)?.sid : undefined);
    },
    onStatus: async (s) => {
      log(`status: ${s.id} ${s.state} ${s.label}`);
      eye?.webContents.send("status", s);
    },
    onCloak: async (on) => {
      setCloak(on);
      // dropping the cloak remotely must be visible — never a silent unmasking
      if (!on) whisper("⟨ cloak off — visible to capture ⟩");
    },
    onAttention: async ({ session, on, label }) => {
      log(`attention: ${session} ${on ? "on" : "off"} ${label ?? ""}`);
      const i = waiting.findIndex((w) => w.session === session);
      if (on) {
        if (i >= 0) waiting[i].why = label || waiting[i].why;
        else {
          waiting.push({ session, why: label || "", ts: Date.now() });
          // the front caller gets the eye tint; anyone behind gets a whisper
          // so a queued call is still noticed without stealing anything
          if (waiting.length > 1)
            whisper(`⟨ ${session} ⟩ waiting${label ? " · " + label : ""}`);
        }
      } else if (i >= 0) waiting.splice(i, 1);
      sendDock();
    },
    onShow: async ({ session, title, kind, data, verdict }) => {
      const item = {
        id: "s" + ++showSeq,
        session,
        title: title || "untitled",
        kind,
        data,
        verdict: !!verdict,
        ts: Date.now(),
      };
      gallery.push(item);
      if (gallery.length > GALLERY_MAX) {
        const dropped = gallery.shift();
        log(`gallery full — dropped oldest: ${dropped.id} (${dropped.title})`);
      }
      log(`show: ${item.id} from ${session} — ${item.title} (${kind}, ${data.length} chars)`);
      if (session === hub.active && canvas?.isVisible()) {
        // he's already looking at the canvas and talking to this session —
        // rendering in place is not an interruption
        canvas.webContents.send("canvas-item", publicItem(item));
      } else {
        whisper(`⟨ ${session} ⟩ has something to show · ${item.title}`);
      }
      sendDock();
      return { ok: true, id: item.id };
    },
    onActive: async (session) => routeTo(session),
    onIntroduce: async ({ session, brief }) => {
      log(`introduce: ${session} — ${brief}`);
      hub.setBrief(session, brief);
      whisper(`⟨ ${session} ⟩ ${brief}`);
    },
    onRegister: async ({ name, color, voice, brief }) => {
      const r = hub.register(name, color, voice);
      if (r.error) return r;
      if (brief) hub.setBrief(r.name, brief);
      log(`register: ${r.name} ${r.color} voice=${r.voice}${r.note ? ` (${r.note})` : ""}`);
      whisper(`⟨ ${r.name} ⟩ joined${brief ? " · " + brief : ""}`);
      return { ...r, active: hub.active, sessions: hub.roster() };
    },
  });
});

app.on("before-quit", () => {
  quitting = true; // lets the canvas window actually die instead of hiding
});
app.on("will-quit", () => hook?.stop());
app.on("window-all-closed", () => {});
