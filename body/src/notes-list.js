/**
 * The notes a channel left while he was somewhere else: one list per channel,
 * oldest first, kept across restarts in `~/.local/state/dark-eye/notes.json`
 * (`DARK_EYE_NOTES_FILE` overrides). A note leaves the list when he presses its
 * ▶. Nothing here reaches the mouth and nothing here routes his words — a file
 * it cannot read is an empty list, logged.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Per channel, so one busy channel cannot crowd out another. */
const MAX = 20;
/** A note is a line he reads before he presses it — past this it is a wall, and the file grows without bound. */
const TEXT_MAX = 2000;

const notesPath = () =>
  process.env.DARK_EYE_NOTES_FILE ||
  path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "dark-eye",
    "notes.json"
  );

const clamp = (text) => String(text).slice(0, TEXT_MAX);

/**
 * `{add, list, count, played}`: read once here, written on every change.
 * `known(name)` is this body's roster — a list naming a channel it does not have
 * could never show him its ▶, so it is logged and dropped. `file: null` keeps the
 * lists in memory alone.
 */
function createNotes({ file = notesPath(), max = MAX, known = () => true, log = () => {} } = {}) {
  /** channel id → `[{text, at}]`, oldest first. */
  const lists = new Map();

  if (file) read();

  function read() {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") log(`notes: cannot read ${file}: ${e.message} — no notes`);
      return;
    }
    const rows = saved?.channels;
    if (rows === null || typeof rows !== "object" || Array.isArray(rows))
      return void log(`notes: ${file} holds no channels — no notes`);
    for (const [name, list] of Object.entries(rows)) {
      if (!known(name)) {
        log(`notes: ${JSON.stringify(name)} is not a channel — its notes are dropped`);
        continue;
      }
      if (!Array.isArray(list)) {
        log(`notes: channel ${name} holds no list of notes — none`);
        continue;
      }
      const kept = list
        .filter((n) => typeof n?.text === "string")
        .map((n) => ({ text: clamp(n.text), at: Number(n.at) || 0 }))
        .slice(-max);
      if (kept.length !== list.length) log(`notes: channel ${name}: ${list.length - kept.length} of ${list.length} are not notes`);
      if (kept.length) lists.set(name, kept);
    }
  }

  function save() {
    if (!file) return;
    try {
      const channels = Object.fromEntries([...lists].filter(([, l]) => l.length));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ channels }), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      log(`notes: cannot persist ${file}: ${e.message}`);
    }
  }

  return {
    /** One more note for a channel he is not on; past the cap the oldest goes. Answers how many wait. */
    add(channel, text, at = Date.now()) {
      const list = lists.get(channel) ?? [];
      lists.set(channel, list);
      list.push({ text: clamp(text), at });
      while (list.length > max) list.shift();
      save();
      return list.length;
    },
    /** That channel's notes, oldest first. */
    list: (channel) => [...(lists.get(channel) ?? [])],
    count: (channel) => (lists.get(channel) ?? []).length,
    /** He pressed one: the oldest note of those words stops waiting. */
    played(channel, text) {
      const list = lists.get(channel);
      const want = clamp(text);
      const i = list?.findIndex((n) => n.text === want) ?? -1;
      if (i < 0) return false;
      list.splice(i, 1);
      save();
      return true;
    },
  };
}

module.exports = { createNotes, MAX, TEXT_MAX };
