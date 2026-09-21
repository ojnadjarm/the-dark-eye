/**
 * The one thing only a browser can prove: a turn survives the tab going hidden.
 * `startRemote` runs in-process on a free loopback port with a stub ear — the
 * live body and the live remote port are never touched — and a headless
 * Chromium with a fake mic taps, hides, keeps talking and taps again.
 */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startRemote } = require("../src/remote");

/** Playwright is a tool on this machine, not a dependency of the body. */
function playwright() {
  const roots = [];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {}
  for (const r of ["playwright", ...roots.map((g) => path.join(g, "@playwright/mcp/node_modules/playwright"))]) {
    try {
      return require(r);
    } catch {}
  }
  return null;
}

const pw = playwright();
const SECRET = "hidden-tab-key";
const state = fs.mkdtempSync(path.join(os.tmpdir(), "de-hidden-"));
after(() => fs.rmSync(state, { recursive: true, force: true }));

test(
  "a hidden tab keeps streaming his voice, and the tap on return sends one final clip",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 120_000 },
  async () => {
    const posts = { stream: [], final: [] };
    let hiding = false;
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions.json"),
      onStream: (utt, seq) => {
        posts.stream.push({ utt, seq, hidden: hiding });
        return true;
      },
      onFinal: (utt) => {
        posts.final.push(utt);
        return "the whole thing";
      },
      onAudio: () => "",
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const ctx = await browser.newContext({ permissions: ["microphone"] });
    const page = await ctx.newPage();
    try {
      // one override, both the flag and the event the browser would send with it
      await page.addInitScript(() => {
        let hidden = false;
        for (const [k, v] of [["hidden", () => hidden], ["visibilityState", () => (hidden ? "hidden" : "visible")]])
          Object.defineProperty(Document.prototype, k, { configurable: true, get: v });
        window.__hide = (h) => {
          hidden = h;
          document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
        };
      });
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      await page.click("#disc");
      await page.waitForFunction(() => document.title.startsWith("● listening"));
      await page.waitForFunction(() => window.__eyeStats !== undefined);
      const before = await wait(() => posts.stream.length >= 1);
      assert.ok(before, "nothing was streamed even before the hide — the fake mic never reached the worklet");

      // the hide, as a tab switch delivers it: the page is told, the mic is not touched
      hiding = true;
      const at = posts.stream.length;
      await page.evaluate(() => window.__hide(true));
      assert.ok(await wait(() => posts.stream.length >= at + 3), "the stream stopped when the tab went hidden");
      assert.ok(
        posts.stream.filter((p) => p.hidden).every((p) => p.utt === posts.stream[0].utt),
        "the hidden tab started a new utterance instead of continuing his",
      );
      const seqs = posts.stream.map((p) => p.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "the blocks did not keep rising in seq");

      await page.evaluate(() => window.__hide(false));
      hiding = false;
      await page.click("#disc"); // the tap on return
      assert.ok(await wait(() => posts.final.length >= 1), "the tap on return never sent the clip");
      await new Promise((r) => setTimeout(r, 1500));
      assert.deepEqual(posts.final, [posts.stream[0].utt], "the turn was finalised more than once");
      await page.waitForFunction(() => document.title === "The Dark Eye");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }

    /** Polls a condition for up to 20 s — the worklet posts about once a second. */
    async function wait(ok) {
      for (let i = 0; i < 200; i++) {
        if (ok()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    }
  },
);

test(
  "a mute the body outwaited ends the turn instead of offering the tail",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 120_000 },
  async () => {
    const posts = { stream: [], final: [] };
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-mute.json"),
      onStream: (utt, seq) => {
        posts.stream.push({ utt, seq });
        return true;
      },
      onFinal: (utt) => {
        posts.final.push(utt);
        return "the tail alone";
      },
      onAudio: () => "",
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const ctx = await browser.newContext({ permissions: ["microphone"] });
    const page = await ctx.newPage();
    try {
      // the two things the phone's absence does: the clock moves on, the timers do not
      await page.addInitScript(() => {
        const real = Date.now;
        window.__skew = 0;
        Date.now = () => real() + window.__skew;
        const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (c) => (window.__stream = await gum(c));
        window.__track = (kind) => window.__stream.getAudioTracks()[0].dispatchEvent(new Event(kind));
      });
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      await page.click("#disc");
      await page.waitForFunction(() => document.title.startsWith("● listening"));
      for (let i = 0; i < 200 && !posts.stream.length; i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(posts.stream.length, "nothing was streamed before the mute — the fake mic never reached the worklet");

      await page.evaluate(() => window.__track("mute")); // the phone, the moment he looks away
      await page.waitForFunction(() => $("status").textContent.includes("paused by the phone"));
      // minutes pass in a page whose timers are suspended: no deadline can have fired
      const past = await page.evaluate(() => (window.__skew = MUTE_MAX_MS + 1_000));
      assert.ok(past > 0, "the page's mute deadline was not readable");
      await page.evaluate(() => window.__track("unmute"));

      await page.waitForFunction(() => $("status").textContent.includes("let that turn go"));
      assert.match(await page.textContent("#status"), /paused too long/, "the page did not say what happened");
      await page.waitForFunction(() => document.title === "The Dark Eye");
      assert.equal(await page.getAttribute("#disc", "aria-pressed"), "false", "the turn is still open");
      await page.click("#disc"); // his next tap starts a new turn, it does not send the old tail
      await page.waitForFunction(() => document.title.startsWith("● listening"));
      assert.equal(await page.getAttribute("#disc", "aria-pressed"), "true", "the tap the page asked for did not open a turn");
      await new Promise((r) => setTimeout(r, 1000));
      assert.deepEqual(posts.final, [], "the tail of an abandoned turn was sent as his sentence");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "a second mute does not restart the deadline the first one began",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 120_000 },
  async () => {
    const posts = { stream: [], final: [] };
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-remute.json"),
      onStream: (utt, seq) => {
        posts.stream.push({ utt, seq });
        return true;
      },
      onFinal: (utt) => {
        posts.final.push(utt);
        return "the tail alone";
      },
      onAudio: () => "",
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const ctx = await browser.newContext({ permissions: ["microphone"] });
    const page = await ctx.newPage();
    try {
      await page.addInitScript(() => {
        const real = Date.now;
        window.__skew = 0;
        Date.now = () => real() + window.__skew;
        const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (c) => (window.__stream = await gum(c));
        window.__track = (kind) => window.__stream.getAudioTracks()[0].dispatchEvent(new Event(kind));
      });
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      await page.click("#disc");
      await page.waitForFunction(() => document.title.startsWith("● listening"));
      for (let i = 0; i < 200 && !posts.stream.length; i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(posts.stream.length, "nothing was streamed before the mute — the fake mic never reached the worklet");

      await page.evaluate(() => window.__track("mute"));
      await page.waitForFunction(() => $("status").textContent.includes("paused by the phone"));
      // the phone mutes again while still away: the elapsed time is measured from the first mute
      await page.evaluate(() => (window.__skew = MUTE_MAX_MS + 1_000));
      await page.evaluate(() => window.__track("mute"));
      await page.evaluate(() => window.__track("unmute"));

      await page.waitForFunction(() => $("status").textContent.includes("let that turn go"));
      await page.waitForFunction(() => document.title === "The Dark Eye");
      assert.equal(await page.getAttribute("#disc", "aria-pressed"), "false", "the turn is still open");
      await new Promise((r) => setTimeout(r, 1000));
      assert.deepEqual(posts.final, [], "the second mute restarted the clock and the stale tail was sent");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);
