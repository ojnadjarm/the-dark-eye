/**
 * TV state: is a display there and awake? Pure node, no Electron.
 * Ladder (PLAN-LOWRES.md §4): zero displays, then the DRM connector's sysfs,
 * then DDC/CI power mode when ddcutil answers. Off after 2 consecutive off
 * reads, on at the first on read.
 * Above the ladder sits the owner's own switch (`eye tv off|on|auto`, E12): this
 * TV keeps HPD, EDID and ELD up in standby, so no rung can see it go dark.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SYSFS_ROOT = "/sys/class/drm";
const OFF_READS = 2;
const DDC_MISSES = 3;
const MODES = ["auto", "on", "off"];

/** `$XDG_RUNTIME_DIR/dark-eye/tv-override.json`, or `DARK_EYE_TV_OVERRIDE_FILE`. */
function overridePath() {
  return (
    process.env.DARK_EYE_TV_OVERRIDE_FILE ||
    path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "dark-eye", "tv-override.json")
  );
}

/** The connector dir: DARK_EYE_DISPLAY_SYSFS, else the first card*-HDMI-A-* under /sys. */
function connectorDir() {
  if (process.env.DARK_EYE_DISPLAY_SYSFS) return process.env.DARK_EYE_DISPLAY_SYSFS;
  try {
    const name = fs.readdirSync(SYSFS_ROOT).filter((n) => /^card\d+-HDMI-A-\d+$/.test(n)).sort()[0];
    return name ? path.join(SYSFS_ROOT, name) : null;
  } catch {
    return null;
  }
}

/** `() => {status, dpms, enabled}` for one connector dir; null when it cannot be read. */
function sysfsReader(dir = connectorDir()) {
  return () => {
    if (!dir) return null;
    const read = (f) => {
      try {
        return fs.readFileSync(path.join(dir, f), "utf8").trim();
      } catch {
        return null;
      }
    };
    const status = read("status");
    if (status === null) return null;
    return { status, dpms: read("dpms"), enabled: read("enabled") };
  };
}

/** The connector's DDC bus number, from `<dir>/ddc -> ../../../i2c-3`. */
function ddcBus(dir = connectorDir()) {
  try {
    const m = /i2c-(\d+)$/.exec(fs.readlinkSync(path.join(dir, "ddc")));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * `() => power mode | null` from `ddcutil getvcp d6 --brief` on that bus.
 * null means no answer — the caller counts those.
 */
function ddcProbe(bus = ddcBus()) {
  const bin = process.env.DARK_EYE_DDCUTIL || "ddcutil";
  if (bus === null) return null;
  return () => {
    try {
      const out = execFileSync(bin, ["--bus", String(bus), "getvcp", "d6", "--brief"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // VCP D6 SNC x01
      const m = /x0*([0-9a-f]+)\s*$/i.exec(out.trim());
      return m ? parseInt(m[1], 16) : null;
    } catch {
      return null;
    }
  };
}

/**
 * The watch. `displays()` returns the current display list (zero = off),
 * `readSysfs()` and `ddc()` as above (either may be null/absent).
 * `onChange({on, reason})` fires on the first read and on every transition.
 */
function createDisplayWatch({
  displays,
  readSysfs,
  ddc,
  onChange,
  intervalMs = 1000,
  ddcIntervalMs = 10_000,
  overrideFile = overridePath(),
  log = () => {},
} = {}) {
  let on = null;
  let reason = "not read yet";
  let offReads = 0;
  let ddcMisses = 0;
  let ddcVerdict = null; // {off, reason} — sticky between ddc ticks
  let lastDdc = 0;
  let last = { ds: null, s: null }; // the raw values of the last evaluate(), for the log line
  let timer = null;
  let override = loadOverride();
  let sawLadderOff = false; // while forced off: has the ladder itself seen it go off?
  let cleared = false; // that off→on happened, and the override stepped aside

  /** The persisted `auto`/`on`/`off`; anything else reads as `auto`. */
  function loadOverride() {
    try {
      const mode = JSON.parse(fs.readFileSync(overrideFile, "utf8"))?.mode;
      return MODES.includes(mode) ? mode : "auto";
    } catch {
      return "auto";
    }
  }

  function saveOverride() {
    try {
      fs.mkdirSync(path.dirname(overrideFile), { recursive: true, mode: 0o700 });
      const tmp = `${overrideFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ mode: override }), { mode: 0o600 });
      fs.renameSync(tmp, overrideFile);
    } catch (e) {
      log(`tv override: cannot persist ${overrideFile}: ${e.message}`);
    }
  }

  /** One read of the whole ladder → null when on, a reason string when off. */
  function evaluate() {
    const ds = displays ? displays() : null;
    last = { ds, s: null };
    if (ds && ds.length === 0) return "no display reported";

    const s = readSysfs ? readSysfs() : null;
    last.s = s;
    if (s) {
      const raw = `status=${s.status} dpms=${s.dpms} enabled=${s.enabled}`;
      if (s.status !== "connected") return `sysfs ${raw}`;
      if (s.dpms !== null && s.dpms !== "On") return `sysfs ${raw}`;
      if (s.enabled !== null && s.enabled !== "enabled") return `sysfs ${raw}`;
    }

    if (ddc) {
      const now = Date.now();
      if (lastDdc === 0 || now - lastDdc >= ddcIntervalMs) {
        lastDdc = now;
        const mode = ddc();
        if (mode === null) {
          ddcMisses += 1;
          ddcVerdict = ddcMisses >= DDC_MISSES ? `ddc no answer x${ddcMisses}, sysfs connected` : null;
        } else {
          ddcMisses = 0;
          ddcVerdict = mode !== 1 ? `ddc power mode=${mode}` : null;
        }
      }
      if (ddcVerdict) return ddcVerdict;
    }
    return null;
  }

  /** Apply the override and the hysteresis to one read; fire `onChange` on a transition. */
  function poll() {
    const off = evaluate();
    // a forced `off` steps aside by itself once the ladder has seen the TV go off and come back
    if (override === "off") {
      if (off) sawLadderOff = true;
      else if (sawLadderOff) {
        override = "auto";
        sawLadderOff = false;
        cleared = true;
        watch.override = override;
        saveOverride();
      }
    }
    let next = on;
    let why = reason;
    if (override !== "auto") {
      offReads = 0;
      next = override === "on";
      why = `override ${override}`;
    } else if (off) {
      offReads += 1;
      if (offReads >= OFF_READS) {
        next = false;
        why = off;
      } else if (on === null) {
        why = off; // first read: keep waiting, but remember why
      }
    } else {
      offReads = 0;
      next = true;
      why = cleared ? `${describeOn()}, override off cleared by a real off→on` : describeOn();
    }
    reason = why; // the current cause, transition or not: `eye tv` and health read it
    watch.reason = reason;
    if (next !== on && next !== null) {
      cleared = false;
      on = next;
      watch.on = on;
      onChange?.({ on, reason });
    }
    return on;
  }

  /** The raw values behind an "on" verdict, for the log line. */
  function describeOn() {
    const parts = [];
    const { ds, s } = last;
    if (ds) parts.push(`displays=${ds.length}`);
    if (s) parts.push(`status=${s.status} dpms=${s.dpms} enabled=${s.enabled}`);
    if (ddc) parts.push(ddcVerdict === null && ddcMisses === 0 ? "ddc ok" : `ddc misses=${ddcMisses}`);
    return parts.join(", ") || "no signal";
  }

  /** The owner's switch: `off` forces the eye dark, `on` forces it awake, `auto` is the ladder. */
  function setOverride(mode) {
    if (!MODES.includes(mode)) throw new Error(`tv override must be auto, on or off, got '${mode}'`);
    override = mode;
    sawLadderOff = false;
    cleared = false;
    watch.override = override;
    saveOverride();
    poll();
    return state();
  }

  const state = () => ({ mode: override, on: watch.on, reason: watch.reason });

  const watch = {
    on,
    reason,
    override,
    setOverride,
    state,
    poll,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  poll();
  if (intervalMs > 0) {
    timer = setInterval(poll, intervalMs);
    timer.unref?.();
  }
  return watch;
}

module.exports = { createDisplayWatch, sysfsReader, ddcProbe, ddcBus, connectorDir, overridePath, MODES };
