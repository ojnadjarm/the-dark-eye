/**
 * The config file and the channel table it carries: read once at boot. Every
 * row is validated here, and a bad field is logged and dropped rather than the
 * channel, so a malformed table can never take a channel off the roster.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { validName, EYE_SID } = require("./brains");
const { fromWire } = require("./mode");

const DEFAULTS = {
  port: 8642,
  voiceSid: 17,
  voiceSpeed: 1.0,
  // the fp32 Kokoro: the int8 one beside it is 200 MB smaller and 2x slower (EF05)
  voiceModelDir: "kokoro-multi-lang-v1_0",
  brain: "claude",
  brainColor: "#b04dff",
  canvasZoom: 1.5,
  /** The channel an unnamed `speak`/`listen` belongs to, and the body's fallback. */
  defaultChannel: "main",
  /** The mode a channel with none configured starts in. */
  defaultMode: "call",
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const SID_MAX = 52;
/**
 * The rows a config written before the table had one, and the mode each is for:
 * the migration writes them once, and they are his to change in the file after.
 * `notes` starts in audio-notes mode — its replies belong in the vault, not the
 * room (owner, 2026-09-15).
 */
const LEGACY_CHANNELS = { notes: { mode: "notes" } };

const configPath = () => {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "dark-eye", "config.json");
};

/** The default channel: his name for it if it is a name, else the body's — the one owner of that rule. */
const defaultChannelOf = (cfg = {}) => (validName(cfg.defaultChannel) ? cfg.defaultChannel : DEFAULTS.defaultChannel);

/** His word for a mode, or the body's own, to the body's word; undefined if it is neither. */
const modeOf = (m) => (m === "async" ? "async" : fromWire(m));

/** One configured row, each bad field logged and skipped: a channel is never dropped for one. */
function channelRow(name, row, defaultChannel, log) {
  const out = {};
  const keep = (key, ok, value) => {
    if (value === undefined) return;
    if (ok) out[key] = value;
    else log(`channel ${name}: ${key} ${JSON.stringify(value)} skipped`);
  };
  keep("label", typeof row.label === "string", row.label);
  keep("color", typeof row.color === "string" && HEX.test(row.color), row.color);
  // the Eye's own voice belongs to the default channel alone
  keep(
    "voice",
    Number.isInteger(row.voice) && row.voice >= 0 && row.voice <= SID_MAX && (row.voice !== EYE_SID || name === defaultChannel),
    row.voice
  );
  keep("aliases", Array.isArray(row.aliases) && row.aliases.every((a) => typeof a === "string"), row.aliases);
  if (row.mode !== undefined) {
    const m = modeOf(row.mode);
    if (m) out.mode = m;
    else log(`channel ${name}: mode ${JSON.stringify(row.mode)} skipped`);
  }
  return out;
}

/**
 * `cfg.channels` as a validated table, in his order, the default channel first
 * and always present — a table that is not one is logged and leaves the roster
 * that single row.
 */
function channelTable(cfg = {}, log = () => {}) {
  const def = defaultChannelOf(cfg);
  const raw = cfg.channels;
  const table = { [def]: {} };
  if (raw === undefined) return table;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    log(`channels: ${JSON.stringify(raw)} is not a table — ${def} only`);
    return table;
  }
  for (const [name, row] of Object.entries(raw)) {
    if (!validName(name)) {
      log(`channel ${JSON.stringify(name)}: not a name — skipped`);
      continue;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      log(`channel ${name}: ${JSON.stringify(row)} is not a row — skipped`);
      continue;
    }
    table[name] = channelRow(name, row, def, log);
  }
  return table;
}

/**
 * His file as JSON, and whether it may be written back: a file that is there
 * but unreadable or not JSON is his to keep — it is never the "first run" that
 * would mint a new `secret` over it.
 */
function readConfig(file, log) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { cfg: {}, writable: true };
    log(`config: cannot read ${file}: ${e.message} — kept as it is, defaults only`);
    return { cfg: {}, writable: false };
  }
  try {
    const cfg = JSON.parse(text);
    if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("not an object");
    return { cfg, writable: true };
  } catch (e) {
    log(`config: ${file} is not a config (${e.message}) — kept as it is, defaults only`);
    return { cfg: {}, writable: false };
  }
}

/**
 * The merged config back to his file, temp file + rename at mode 600 — no
 * half-written config can ever be read as a first run. Nothing is written when
 * nothing changed, so a hand edit is not undone by a boot that adds no key, and
 * a file he has taken the write bit off is his to keep.
 */
function writeConfig(file, full, log) {
  const text = JSON.stringify(full, null, 2);
  try {
    if (fs.readFileSync(file, "utf8") === text) return false;
  } catch {
    /* no file yet, or none this body can read: the write below decides */
  }
  try {
    fs.accessSync(file, fs.constants.W_OK);
  } catch (e) {
    if (e.code !== "ENOENT") {
      log(`config: cannot write ${file}: ${e.message} — the eye runs on what it read`);
      return false;
    }
  }
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    log(`config: cannot write ${file}: ${e.message} — the eye runs on what it read`);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    return false;
  }
}

/**
 * Read the config, fill the defaults and the secret, write it back at mode 600.
 * A config with no channel table gets today's two rows written into it, so the
 * table is there for him to edit the first time this body starts. It never
 * throws: a config it cannot read or write is a logged warning, not a dead body.
 */
function loadConfig({ file = configPath(), log = () => {} } = {}) {
  const { cfg, writable } = readConfig(file, log);
  const full = { ...DEFAULTS, ...cfg };
  if (!full.secret) full.secret = crypto.randomBytes(24).toString("hex");
  const def = defaultChannelOf(full);
  if (!Object.hasOwn(full, "channels")) {
    full.channels = { [def]: { color: full.brainColor, voice: full.voiceSid } };
    for (const name of Object.keys(LEGACY_CHANNELS)) if (name !== def) full.channels[name] = {};
  }
  // a legacy row written before the mode was per channel has no mode of its own;
  // his default channel is never given one — the channel he lands on answers out loud
  for (const [name, row] of Object.entries(LEGACY_CHANNELS)) {
    const have = name === def ? undefined : full.channels?.[name];
    if (have !== null && typeof have === "object" && !Array.isArray(have) && have.mode === undefined) Object.assign(have, row);
  }
  if (writable) writeConfig(file, full, log);
  if (def !== full.defaultChannel) {
    log(`defaultChannel: ${JSON.stringify(full.defaultChannel)} is not a name — ${def}`);
    full.defaultChannel = def;
  }
  if (!modeOf(full.defaultMode)) {
    log(`defaultMode: ${JSON.stringify(full.defaultMode)} is no mode — ${DEFAULTS.defaultMode}`);
    full.defaultMode = DEFAULTS.defaultMode;
  } else full.defaultMode = modeOf(full.defaultMode);
  return full;
}

module.exports = { loadConfig, channelTable, DEFAULTS };
