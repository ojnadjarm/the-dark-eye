/**
 * The mode of a channel: `call` is live, `async` leaves every reply waiting for
 * his ▶. Mode is per channel — `mode`/`async` are the **active** channel's —
 * because who he talks to and how the exchange runs are two questions. `async`
 * is the body's own word for it; every word he says, types or reads is "audio
 * notes" / `notes`, so the bridge translates at its edge (`fromWire`/`toWire`)
 * and the file keeps the body's word. Kept across restarts in
 * `~/.local/state/dark-eye/mode.json` (`DARK_EYE_MODE_FILE` overrides).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MODES = ["call", "async"];
/** His word for each mode, outside the body: the CLI, the page, `eye quiet`. */
const WIRE = { call: "call", notes: "async" };
/** His word → the body's, or undefined if it is no mode of his. */
const fromWire = (m) => (Object.hasOwn(WIRE, m) ? WIRE[m] : undefined);
/** The body's word → his. */
const toWire = (m) => (m === "async" ? "notes" : m);

const stateDir = () =>
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "dark-eye");

const modePath = () => process.env.DARK_EYE_MODE_FILE || path.join(stateDir(), "mode.json");

/** Quiet mode was this mode under another name: an old `{on:true}` comes back as `async`. */
const quietPath = () => process.env.DARK_EYE_QUIET_FILE || path.join(stateDir(), "quiet.json");

const valid = (m) => MODES.includes(m);
/** The body's word, his own, or undefined: what a file, a config row or a caller may hold. */
const asMode = (m) => (valid(m) ? m : fromWire(m));

/**
 * `{mode, async, of, set}`: read once here. `mode`/`async` are `active()`'s
 * channel; `of(name)` is any channel's; `set(m, channel = active())` persists
 * and answers that channel's mode. A channel with no choice of his falls to its
 * configured row, then to the file's default, then to `defaultMode` — so a
 * channel can only be silent because he or its config asked for it.
 */
function createMode({
  active = () => undefined,
  channels = {},
  defaultMode = "call",
  file = modePath(),
  quietFile = quietPath(),
  log = () => {},
} = {}) {
  const fallback = asMode(defaultMode) || "call";
  /** Each channel's configured mode: under his own choices, over the file's default. */
  const configured = new Map();
  for (const [name, row] of Object.entries(channels || {})) {
    const m = asMode(row?.mode);
    if (m) configured.set(name, m);
  }
  /** What he has chosen for a channel, this run or an earlier one. */
  const chosen = new Map();
  let fileDefault;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    // a file written before the mode was per channel holds one `mode` for all of them,
    // and one written before `async` had that name says `notes`: the same mode
    const d = asMode(saved?.default ?? saved?.mode);
    const rows = saved?.channels;
    if (rows !== null && typeof rows === "object" && !Array.isArray(rows))
      for (const [name, m] of Object.entries(rows)) {
        const v = asMode(m);
        if (v) chosen.set(name, v);
      }
    if (d) fileDefault = d;
    else if (!chosen.size) throw new Error("no mode");
  } catch {
    try {
      // the quiet file is left where it is: read once, never written again
      if (JSON.parse(fs.readFileSync(quietFile, "utf8"))?.on === true) fileDefault = "async";
    } catch {
      /* neither file: the configured default */
    }
  }

  const of = (name) => chosen.get(name) ?? configured.get(name) ?? fileDefault ?? fallback;

  function save() {
    try {
      const data = { default: fileDefault ?? fallback, channels: Object.fromEntries(chosen) };
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      log(`mode: cannot persist ${file}: ${e.message}`);
    }
  }

  return {
    get mode() {
      return of(active());
    },
    get async() {
      return of(active()) === "async";
    },
    of,
    set(m, channel = active()) {
      const was = of(channel);
      if (!valid(m) || m === was) return was;
      // no channel at all is the default: one mode for every channel, as before M14
      if (channel === undefined) fileDefault = m;
      else chosen.set(channel, m);
      save();
      return m;
    },
  };
}

module.exports = { createMode, WIRE, fromWire, toWire };
