/** scripts/measure.sh against a fake /proc + /sys pair (MEASURE_PROC): the table numbers. */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "scripts", "measure.sh");
const CG = "sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice";

// pid → [cmdline, ticks at t0, ticks at t1, rss kB, pss kB, drm client, render ns t1]
const PROCS = {
  101: ["electron --type=renderer --enable-crash-reporter=x", 1000, 1210, 202752, 141312, 11, 222_000_000],
  102: ["electron --type=gpu-process --ozone-platform=x11", 4000, 4222, 173056, 64512, 12, 0],
  103: ["electron --type=utility --utility-sub-type=node.mojom.NodeService", 700, 700, 2290688, 2213888, 0, 0],
};

let dir;
let out;

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** One fake root: cgroup list, per-pid stat/smaps_rollup/cmdline/fdinfo, GPU sysfs. */
function makeRoot(root, t) {
  write(`${root}/${CG}/dark-eye.service/cgroup.procs`, "101\n102\n");
  write(`${root}/${CG}/app-dark-eye-body-99.scope/cgroup.procs`, "103\n");
  for (const [pid, [cmd, k0, k1, rss, pss, client, ns]] of Object.entries(PROCS)) {
    const ticks = t === 0 ? k0 : k1;
    write(`${root}/proc/${pid}/stat`, `${pid} (electron) S 1 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0\n`);
    write(`${root}/proc/${pid}/smaps_rollup`, `00010000-7ffe00000000 ---p 00000000 00:00 0 [rollup]\nRss: ${rss} kB\nPss: ${pss} kB\n`);
    write(`${root}/proc/${pid}/cmdline`, cmd.replace(/ /g, "\0"));
    if (client)
      write(
        `${root}/proc/${pid}/fdinfo/3`,
        `pos:\t0\ndrm-driver:\ti915\ndrm-client-id:\t${client}\ndrm-engine-render:\t${t === 0 ? 0 : ns} ns\n`
      );
  }
  write(`${root}/sys/class/drm/card1/power/rc6_residency_ms`, `${t === 0 ? 0 : 58200}\n`);
  write(`${root}/sys/class/drm/card1/gt_act_freq_mhz`, "0\n");
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "measure-"));
  makeRoot(path.join(dir, "t0"), 0);
  makeRoot(path.join(dir, "t1"), 1);
  fs.writeFileSync(
    path.join(dir, "journal.txt"),
    "renderer: fps=8.0 ms=4.2/9.1\nrenderer: fps=8.0 ms=4.6/7.0\n"
  );
  out = execFileSync("bash", [SCRIPT, "--seconds", "60"], {
    encoding: "utf8",
    env: { ...process.env, MEASURE_PROC: dir },
  });
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("one row per process, CPU from the tick delta, RSS and PSS in MB", () => {
  assert.match(out, /^\| renderer \(101\) \| 3\.5 \| 198 \| 138 \|$/m);
  assert.match(out, /^\| gpu-process \(102\) \| 3\.7 \| 169 \| 63 \|$/m);
  assert.match(out, /^\| voice worker \(103\) \| 0\.0 \| 2237 \| 2162 \|$/m);
});

test("totals, with and without the voice worker", () => {
  assert.match(out, /^\| \*\*body total\*\* \| \*\*7\.2\*\* \| 2604 \| 2363 \|$/m);
  assert.match(out, /^\| \*\*body total \(excl\. voice worker\)\*\* \| \*\*7\.2\*\* \| 367 \| 201 \|$/m);
});

test("GPU busy from the fdinfo delta, RC6 from sysfs, fps from the renderer lines", () => {
  assert.match(out, /^gpu render busy: 0\.37 %$/m);
  assert.match(out, /^rc6: 97 %$/m);
  assert.match(out, /^gt_act_freq: 0 MHz$/m);
  assert.match(out, /^fps: 8\.0 \(ms 4\.4 avg, 9\.1 max\)$/m);
});

test("a table, and states that need sound refuse without --allow-sound", () => {
  assert.strictEqual(out.split("\n").filter((l) => l.startsWith("|")).length, 7); // header, rule, 3 processes, 2 totals
  assert.throws(
    () =>
      execFileSync("bash", [SCRIPT, "--state", "mic"], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, MEASURE_PROC: dir },
      }),
    /allow-sound/
  );
});
