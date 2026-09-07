/**
 * A bounded life for the voice worker. ORT's CPU arena never gives memory back,
 * so the worker only grows: 1.37 GB fresh, 1.7 GB after twenty utterances, more
 * by evening. There is no session option to cap it from the Node API, so the cap
 * is a kill — the body already respawns the worker in 3 s and queues speech that
 * arrives meanwhile, so a recycle taken while nothing is being said or heard is
 * invisible. Over `maxMB` **and** quiet for `idleMs` are both required.
 */
const fs = require("node:fs");

/** Resident set of a live pid in MB, 0 if it cannot be read. */
function rssMB(pid) {
  try {
    const m = /^Rss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  } catch {
    return 0;
  }
}

/**
 * `touch()` on every speak, decode and mic change; `check(worker)` decides.
 * `maxMB` of 0 disables the recycle entirely.
 */
function createRecycler({ maxMB, idleMs, readRss = rssMB, now = Date.now, log = () => {} }) {
  let lastActivity = now();
  return {
    touch() {
      lastActivity = now();
    },
    /** True if it killed the worker; the body's `exit` handler does the respawn. */
    check(worker) {
      if (!maxMB || !worker?.pid) return false;
      const idle = now() - lastActivity;
      if (idle < idleMs) return false;
      const mb = readRss(worker.pid);
      if (mb <= maxMB) return false;
      log(`voice worker recycled at ${mb} MB (idle ${Math.round(idle / 1000)}s)`);
      worker.kill();
      lastActivity = now();
      return true;
    },
  };
}

module.exports = { rssMB, createRecycler };
