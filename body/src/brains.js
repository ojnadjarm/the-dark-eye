/**
 * Named brains: one bus each, one active. His words go to the active brain;
 * speech from any other brain becomes one of that channel's notes, waiting for
 * his ▶ until he goes there — nothing is ever spoken on his behalf by a switch.
 * The active name survives a body restart in `active.json`.
 */
const fs = require("node:fs");
const path = require("node:path");
const { create: createBus } = require("./queue");
const { createNotes } = require("./notes-list");

const NAME = /^[a-z0-9-]{1,16}$/;
/** The renderer's orbiter palette (`render/src/orbit.rs`) — no green, green is the Eye's. */
const COLORS = ["#4dd9ff", "#ff4dd9", "#ff9a4d", "#b04dff", "#ffe14d", "#ff4d88"];
/** Kokoro speakers for a brain that picks none — his ear-tested set; 17 is the Eye's. */
const VOICE_POOL = [11, 12, 13, 14, 15, 16, 18, 19];
const EYE_SID = 17;
/** Past the palette, hues of the same saturation and lightness, the Eye's green skipped. */
const GREEN_HUE = 152;
const GREEN_KEEP = 30;
const GOLDEN = 137.508;
const HUE_TRIES = 4000;
const LABEL_MAX = 24;
const CONTROL = /[\u0000-\u001f\u007f]/;
const NOTICE_MS = 30_000;
const LISTENING_GRACE_MS = 90_000;

const validName = (n) => typeof n === "string" && NAME.test(n);

/** His display name for a channel: trimmed, at most 24 characters, no control characters — anything else is the id. */
function cleanLabel(name, label, log = () => {}) {
  if (label === undefined) return name;
  const t = typeof label === "string" ? label.trim() : "";
  if (t && t.length <= LABEL_MAX && !CONTROL.test(t)) return t;
  log(`channel ${name}: label ${JSON.stringify(label)} is not a label — ${name}`);
  return name;
}

/** The palette's own look — hsl(h, 100%, 65%) — as the hex of any hue. */
function hueColor(h) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const v = 0.65 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * A colour no channel on the roster has: the palette, then further hues. The
 * supply is finite — 302 distinct hexes — and past it the palette repeats in
 * order, which `register` logs.
 */
function freeColor(used) {
  const own = COLORS.find((c) => !used.has(c));
  if (own) return own;
  for (let i = 0; i < HUE_TRIES; i++) {
    const h = Math.round(i * GOLDEN) % 360;
    if (Math.abs(h - GREEN_HUE) <= GREEN_KEEP) continue;
    const c = hueColor(h);
    if (!used.has(c)) return c;
  }
  return COLORS[used.size % COLORS.length];
}

/** `$XDG_RUNTIME_DIR/dark-eye/active.json`, or `DARK_EYE_ACTIVE_FILE`. */
const activePath = () =>
  process.env.DARK_EYE_ACTIVE_FILE ||
  path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "dark-eye", "active.json");

function createBrains({
  channels = {},
  defaultChannel = "main",
  say,
  file = activePath(),
  notes = createNotes({ file: null }),
  log = () => {},
}) {
  const brains = new Map();
  let active = defaultChannel;

  const make = (name, color, voice, row) => {
    const b = { name, color, voice, label: cleanLabel(name, row.label, log), mode: row.mode, aliases: row.aliases, bus: createBus(), lastSeen: 0 };
    brains.set(name, b);
    return b;
  };
  // the configured table is on the roster before the file is read, the default channel first
  for (const name of new Set([defaultChannel, ...Object.keys(channels)]))
    register(name, channels[name]?.voice, channels[name]);

  /** An unknown name joins with the next free colour and voice; a free `color`/`voice` of its own is honoured. */
  function register(name = defaultChannel, voice, row = {}) {
    const known = brains.get(name);
    if (known) return known;
    const used = (k) => new Set([...brains.values()].map((b) => b[k]));
    const colors = used("color");
    const voices = used("voice");
    const wantColor = typeof row.color === "string" && !colors.has(row.color);
    // the Eye's own voice belongs to the default channel alone
    const wantVoice =
      Number.isInteger(voice) &&
      voice >= 0 &&
      voice <= 52 &&
      (voice !== EYE_SID || name === defaultChannel) &&
      !voices.has(voice);
    const freeVoice = VOICE_POOL.find((s) => !voices.has(s));
    const b = make(name, wantColor ? row.color : freeColor(colors), wantVoice ? voice : freeVoice ?? EYE_SID, row);
    log(`brain ${name}: ${b.color}, voice ${b.voice}`);
    // both supplies are finite: past them a row shares, and the roster says so
    if (!wantColor && colors.has(b.color)) log(`brain ${name}: colour ${b.color} is taken — the palette is spent`);
    if (!wantVoice && freeVoice === undefined) log(`brain ${name}: no free voice left — the Eye's own ${EYE_SID}`);
    return b;
  }

  const connected = (name) => {
    const b = brains.get(name);
    return !!b && (b.bus.waiting > 0 || Date.now() - b.lastSeen < LISTENING_GRACE_MS);
  };

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ active }), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      log(`active brain: cannot persist ${file}: ${e.message}`);
    }
  }

  // a name nobody listens on would swallow his words: only a channel of this
  // body's own roster comes back from the file
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"))?.active;
    if (brains.has(saved)) active = saved;
    else if (saved !== undefined)
      log(`active brain: ${JSON.stringify(saved)} is not a channel — ${defaultChannel}`);
  } catch {
    /* no saved switch: the default channel */
  }

  return {
    get active() {
      return active;
    },
    register,
    connected,
    /** His words, to whoever is active. */
    push(item) {
      brains.get(active).bus.push(item);
    },
    /** A brain's long-poll — its heartbeat. */
    async take(name, ms, voice) {
      const b = register(name, voice);
      try {
        return await b.bus.take(ms);
      } finally {
        b.lastSeen = Date.now();
      }
    },
    /** Spoken now if the brain is active; one of that channel's notes otherwise. Answers how many wait. */
    speak(name, text, voice, to) {
      const b = register(name);
      if (b.name === active) {
        say(text, voice ?? b.voice, to);
        return 0;
      }
      return notes.add(b.name, text);
    },
    /**
     * The switch: nothing is said. The channel's notes stay its own, each waiting
     * for the one press that plays it. Unknown → null.
     */
    setActive(name) {
      const b = brains.get(name);
      if (!b) return null;
      if (name === active) return this.roster(); // a repeat changes nothing: no write, no replay
      active = name;
      save();
      return this.roster();
    },
    roster() {
      return {
        active,
        brains: [...brains.values()].map((b) => ({
          name: b.name,
          label: b.label,
          color: b.color,
          voice: b.voice,
          connected: connected(b.name),
          waiting: notes.count(b.name),
        })),
      };
    },
  };
}

/** The deaf-channel line, in the language he switched in. */
const DEAF = {
  en: (words) => `${words} is not listening. I'm holding your words.`,
  es: (words) => `${words} no está escuchando. Guardo tus palabras.`,
};

/** One deaf notice per window at most, whoever raises it: the switch, or his next words. */
function createNotice(ms = NOTICE_MS, now = Date.now) {
  let last = 0;
  return () => (now() - last < ms ? false : ((last = now()), true));
}

/**
 * The one way in to a switch — his voice, `eye talk-to`, the phone's chips. The
 * eye shows the name, `onSwitch` is given the roster and the name he arrived on
 * so its notes can be laid out for him, and a brain nobody listens on is
 * announced, at most once per notice window; the body starts no session
 * (plan §1.7). A switch to the brain already active is not one: nothing is
 * written, said or marked.
 */
function createSwitch({ brains, say, whisper, onSwitch = () => {}, noticeDue = () => true, log = () => {} }) {
  return function setActive(name, words, lang = "en") {
    const was = brains.active;
    const roster = brains.setActive(name);
    if (!roster || name === was) return roster;
    const label = roster.brains.find((b) => b.name === name)?.label ?? name;
    log(`active brain: ${name}`);
    onSwitch(roster, name);
    whisper(`⟨ ${label} ⟩`);
    if (!brains.connected(name) && noticeDue()) say(DEAF[lang](words ?? label));
    return roster;
  };
}

module.exports = { createBrains, createSwitch, createNotice, validName, cleanLabel, COLORS, EYE_SID };
