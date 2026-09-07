/**
 * The orbiters the body remembers: which agents are working, so a renderer
 * respawn or a body restart puts the same rings back around the eye.
 * The renderer drops a working orbiter 10 min after its last message, so the
 * live set is re-sent every REFRESH_MS. What ends an orbiter is its `done` —
 * TTL_MS is only the safety net for one whose `done` never came (a killed
 * session); a stale one goes with `eye status <id> done`.
 */
const fs = require("node:fs");
const path = require("node:path");

const TTL_MS = Number(process.env.DARK_EYE_ORBIT_TTL_MS) || 12 * 3600_000;
const REFRESH_MS = Number(process.env.DARK_EYE_ORBIT_REFRESH_MS) || 240_000;

/** `$XDG_RUNTIME_DIR/dark-eye/orbiters.json`, or `DARK_EYE_ORBIT_FILE`. */
function statePath() {
  return (
    process.env.DARK_EYE_ORBIT_FILE ||
    path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "dark-eye", "orbiters.json")
  );
}

/** `{set, list, replay, stop}` — the working set, persisted with its expiries. */
function createOrbiters({ file = statePath(), ttlMs = TTL_MS, refreshMs = REFRESH_MS, send = () => {}, now = Date.now, log = () => {} } = {}) {
  let live = load();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const list = (Array.isArray(raw) ? raw : raw?.orbiters) || [];
      return list
        .filter((o) => o && typeof o.id === "string" && Number(o.until) > now())
        .map((o) => ({ id: o.id, label: String(o.label ?? ""), until: Number(o.until) }));
    } catch {
      return [];
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ orbiters: live }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      log(`orbiters: cannot persist ${file}: ${e.message}`);
    }
  }

  /** One `status` message: `working` keeps the orbiter, anything else drops it. */
  function set({ id, state, label = "" }) {
    live = live.filter((o) => o.id !== id && o.until > now());
    if (state === "working") live.push({ id, label, until: now() + ttlMs });
    save();
  }

  /** The live set, expired entries dropped. */
  function list() {
    const kept = live.filter((o) => o.until > now());
    if (kept.length !== live.length) {
      live = kept;
      save();
    }
    return live.map((o) => ({ ...o }));
  }

  /** Put the whole live set back on the renderer (a `ready`, or the refresh); how many. */
  function replay() {
    const live = list();
    for (const o of live) send({ type: "status", id: o.id, state: "working", label: o.label });
    return live.length;
  }

  const timer = setInterval(replay, refreshMs);
  timer.unref?.();

  return { set, list, replay, stop: () => clearInterval(timer) };
}

module.exports = { createOrbiters, statePath, TTL_MS, REFRESH_MS };
