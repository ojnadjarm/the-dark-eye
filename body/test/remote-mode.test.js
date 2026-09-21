/**
 * The page's two controls, in a real browser: the mode word decides whether a
 * reply is heard as it lands, the channel word never moves it, and a 401 in the
 * middle of a turn leaves the page usable. `startRemote` runs in-process on a free
 * loopback port over the real ring, with the mode held in a stub — the live body,
 * the live port and the room's speaker are never touched — and a headless
 * Chromium taps the words, the ▶ and the eye.
 */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startRemote } = require("../src/remote");
const { createReplies } = require("../src/replies");

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
const SECRET = "mode-key";
const state = fs.mkdtempSync(path.join(os.tmpdir(), "de-mode-"));
after(() => fs.rmSync(state, { recursive: true, force: true }));

/** A tone, as the voice worker's chunk of one utterance; half a second unless a test wants longer. */
const tone = (secs = 0.5) =>
  Float32Array.from({ length: Math.round(24000 * secs) }, (_, i) => Math.sin((i / 24000) * 440 * 2 * Math.PI) * 0.3);

const CHANNELS = [
  { name: "main", color: "#b04dff" },
  { name: "notes", color: "#4dd9ff" },
];

/** The iPhone's lock, which headless Chromium has not got: a context reports itself
 *  suspended until a resume() inside one of his own gestures. */
function lock() {
  const Real = window.AudioContext;
  let open = false;
  window.AudioContext = class extends Real {
    get state() {
      return open ? super.state : "suspended";
    }
    resume() {
      if (navigator.userActivation === undefined || navigator.userActivation.isActive) open = true;
      return super.resume();
    }
  };
}

test(
  "the mode word decides what is heard, and the channel word never moves it",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const acked = [];
    const modes = []; // every mode the page asked the body for
    const replies = createReplies();
    let mode = "call";
    let active = "main";
    let spoken = 0;

    const speak = (text) =>
      replies.chunk({ id: `s${++spoken}`, last: true, text, sampleRate: 24000, samples: tone() });

    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onBrains: () => ({ brains: CHANNELS, active }),
      onActive: (name) => {
        active = name;
        return { brains: CHANNELS, active }; // the roster alone: a switch carries no mode
      },
      onMode: (m) => {
        if (m !== undefined) {
          modes.push(m);
          mode = m;
        }
        return mode;
      },
      onReplay: (seq) => {
        const text = replies.find(seq);
        if (!text) return false;
        speak(text);
        return true;
      },
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    const waitFor = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 30_000 });
    try {
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");
      assert.equal(await page.textContent("#mode"), "call", "the page did not read the mode off the body");
      assert.equal(await page.textContent("#chan"), "main");

      // (a) in call mode a reply with a voice plays as it lands, and has nothing left to play
      speak("the kettle is on");
      await waitFor(() => document.querySelectorAll(".line.eye").length === 1);
      for (let i = 0; i < 300 && !acked.includes(1); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(acked.includes(1), "a call-mode reply did not play on arrival");
      assert.equal(await page.locator(".line.eye button.play").count(), 0, "a reply he has heard still offers a ▶");

      // (b) one tap on the word, and the next reply lands silent, unacked, with its ▶
      await page.click("#mode");
      await waitFor(() => document.querySelector("#mode").textContent === "audio notes");
      assert.deepEqual(modes, ["notes"], "the tap did not reach the body, or reached it twice");
      assert.equal(await page.getAttribute("#mode", "data-mode"), "notes");

      speak("someone is at the door");
      await waitFor(() => document.querySelectorAll(".line.eye").length === 2);
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 1);
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(!acked.includes(2), "an audio notes reply played by itself");

      // (f) it reads as a full tray, counted — never as anything held back
      assert.equal(await page.textContent("#status"), "1 waiting · ▶ to play");

      // (c) ▶ is the way he hears it, when he wants it
      await page.click(".line.eye button.play");
      for (let i = 0; i < 300 && !acked.includes(2); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(acked.includes(2), "▶ did not play the reply that was waiting for him");
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 0);

      // (d) a mode the body settled elsewhere — his voice, the TV, the CLI — redraws the word
      mode = "call";
      replies.brains({ brains: CHANNELS, active, mode });
      await waitFor(() => document.querySelector("#mode").textContent === "call");
      assert.deepEqual(modes, ["notes"], "a mode pushed by the body was posted back to it");

      // (e) the channel word opens the halo, a mark switches, and the mode word does not move
      await page.click("#chan");
      await page.waitForSelector('#halo .arcmark[aria-current="false"]');
      await page.click('#halo .arcmark[aria-current="false"]');
      await waitFor(() => document.querySelector("#chan").textContent === "notes");
      assert.equal(active, "notes", "the tap on the channel mark never reached the body");
      assert.equal(await page.textContent("#mode"), "call", "a channel switch moved the mode");
      assert.equal(await page.getAttribute("#chan", "aria-label"), "notes hears you · choose another channel");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "a 401 in the middle of a turn ends it, so his next tap opens a new one without a reload",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    let refuse = false; // the cookie going stale under an open turn, as a restarted body does it
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-401.json"),
      onAudio: () => "",
      onStream: () => true,
      onFinal: () => "the whole thing",
      onPoll: () => new Promise(() => {}),
      onCursor: () => 0,
      onBrains: () => ({ brains: CHANNELS, active: "main" }),
      onMode: () => "call",
    });
    // the 401 the page must survive: the session is gone, the turn is not
    server.prependListener("request", (req, res) => {
      if (refuse && req.url.startsWith("/remote/stream")) res.writeHead(401).end();
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const ctx = await browser.newContext({ permissions: ["microphone"] });
    const page = await ctx.newPage();
    try {
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      await page.click("#disc");
      await page.waitForFunction(() => document.title.startsWith("\u25cf listening"), null, { timeout: 30_000 });
      refuse = true;
      // the next block of his voice is refused: the key field comes back and the turn ends with it
      await page.waitForSelector("#gate:not(.hide)", { timeout: 30_000 });
      assert.equal(await page.getAttribute("#disc", "aria-pressed"), "false", "the turn is still open after the 401");
      assert.equal(await page.title(), "The Dark Eye", "the tab still says a turn is running");

      refuse = false;
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");
      await page.click("#disc"); // and this is the tap that used to do nothing until a reload
      await page.waitForFunction(() => document.title.startsWith("\u25cf listening"), null, { timeout: 30_000 });
      assert.equal(await page.getAttribute("#disc", "aria-pressed"), "true", "a re-login left the page stuck until a reload");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "a call-mode reply that arrives on a locked audio context gets a ▶, and the press plays it",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const acked = [];
    const replies = createReplies();
    let spoken = 0;
    let pageMode = "call";
    const speak = (text) =>
      replies.chunk({ id: `s${++spoken}`, last: true, text, sampleRate: 24000, samples: tone() });

    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-locked.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onBrains: () => ({ brains: CHANNELS, active: "main" }),
      onMode: () => pageMode,
      onReplay: (seq) => {
        const text = replies.find(seq);
        if (!text) return false;
        speak(text);
        return true;
      },
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    const waitFor = (fn) => page.waitForFunction(fn, null, { timeout: 30_000 });
    try {
      await page.addInitScript(lock);
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");
      assert.equal(await page.textContent("#mode"), "call");

      // the case he hits: a turn from the room republished to a phone just opened
      speak("the kettle is on");
      await waitFor(() => document.querySelectorAll(".line.eye").length === 1);
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 1);
      assert.ok(!acked.includes(1), "the reply was acked without ever being heard");
      assert.equal(await page.textContent("#status"), "Tap ▶ on the reply to hear it");

      await page.click(".line.eye button.play");
      for (let i = 0; i < 300 && !acked.includes(1); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(acked.includes(1), "▶ did not play the reply the locked context had left unheard");
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 0);

      // audio notes mode on a page he has not touched yet: no context exists, so the press
      // has to open one as well as resume it — one press, not two
      pageMode = "notes";
      await page.close(); // its context is open now, and it would ack the next reply itself
      const fresh = await (await browser.newContext()).newPage();
      await fresh.addInitScript(lock);
      await fresh.goto(base);
      await fresh.fill("#key", SECRET);
      await fresh.click("#keyform button");
      await fresh.waitForSelector("#disc:not([disabled])");
      speak("the window is open");
      await fresh.waitForFunction(() => document.querySelectorAll(".line.eye button.play").length === 1, null, { timeout: 30_000 });
      await fresh.click(".line.eye button.play");
      for (let i = 0; i < 300 && !acked.includes(2); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(acked.includes(2), "one ▶ press was not enough on a page whose context was never opened");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "two replies a locked context could not play each carry a ▶, and one press drains both",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const acked = [];
    const replies = createReplies();
    let spoken = 0;
    const speak = (text) =>
      replies.chunk({ id: `s${++spoken}`, last: true, text, sampleRate: 24000, samples: tone() });

    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-pair.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onBrains: () => ({ brains: CHANNELS, active: "main" }),
      onMode: () => "call",
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    const waitFor = (fn) => page.waitForFunction(fn, null, { timeout: 30_000 });
    try {
      await page.addInitScript(lock);
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      // two turns from the room land on a phone whose context he has never touched
      speak("the kettle is on");
      speak("someone is at the door");
      await waitFor(() => document.querySelectorAll(".line.eye").length === 2);
      // the count is the glyphs, so the page can only be honest if every unheard line has one
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 2);
      assert.equal(acked.length, 0, "a reply was acked without ever being heard");
      assert.equal(await page.textContent("#status"), "Tap ▶ on the replies to hear them");

      await page.click(".line.eye button.play"); // one press: the queue drains behind it
      for (let i = 0; i < 300 && acked.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(acked, [1, 2], "one press did not drain both replies");
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 0);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "a device that cannot open an audio context says so and leaves the ▶ pressable",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const replies = createReplies();
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-noaudio.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: () => {},
      onBrains: () => ({ brains: CHANNELS, active: "main" }),
      onMode: () => "notes",
      onReplay: () => false,
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      // the browser that refuses an audio context at all — one press used to kill the button
      await page.addInitScript(() => {
        const no = function () {
          throw new Error("no audio on this device");
        };
        window.AudioContext = no;
        window.webkitAudioContext = no;
      });
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      replies.chunk({ id: "n1", last: true, text: "the kettle is on", sampleRate: 24000, samples: tone() });
      await page.waitForSelector(".line.eye button.play", { timeout: 30_000 });
      await page.click(".line.eye button.play");
      await page.waitForFunction(() => document.querySelector("#status").textContent === "This device will not play sound", null, {
        timeout: 30_000,
      });
      assert.equal(await page.getAttribute(".line.eye button.play", "disabled"), null, "the press left the ▶ dead for ever");
      assert.equal(await page.locator("#status.warn").count(), 1, "the failure did not read as a warning");
      await page.click(".line.eye button.play"); // and a second press is possible at all
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "a voice cut off mid-buffer hands its reply back with a ▶, and the press plays it",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const acked = [];
    const replies = createReplies();
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-cut.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onBrains: () => ({ brains: CHANNELS, active: "main" }),
      onMode: () => "call",
      onReplay: () => false,
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    const waitFor = (fn) => page.waitForFunction(fn, null, { timeout: 30_000 });
    try {
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      // ten seconds of voice, so there is a middle to interrupt
      replies.chunk({ id: "c1", last: true, text: "a long answer", sampleRate: 24000, samples: tone(10) });
      await waitFor(() => document.querySelector("#disc").dataset.state === "speaking");
      await page.evaluate(() => ctx.suspend()); // the phone call, the other tab, the interruption

      // no `onended` while the context is stopped: the paused line must say it is unheard
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 1);
      assert.equal(acked.length, 0, "a reply cut off mid-voice was acked as heard");
      assert.equal(await page.textContent("#status"), "Tap ▶ on the reply to hear it");

      await page.click(".line.eye button.play"); // the glyph is what resumes it
      for (let i = 0; i < 400 && !acked.includes(1); i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(acked, [1], "▶ did not play the reply the interruption had left unheard");
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 0);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "a reply arriving while the context is stopped shows its own ▶ and its words, and one press drains both",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const acked = [];
    const replies = createReplies();
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-behind.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onBrains: () => ({ brains: CHANNELS, active: "main" }),
      onMode: () => "call",
      onReplay: () => false,
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    const waitFor = (fn) => page.waitForFunction(fn, null, { timeout: 30_000 });
    try {
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      // ten seconds of voice, interrupted in the middle — and then a second reply lands
      replies.chunk({ id: "b1", last: true, text: "a long answer", sampleRate: 24000, samples: tone(10) });
      await waitFor(() => document.querySelector("#disc").dataset.state === "speaking");
      await page.evaluate(() => ctx.suspend());
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 1);
      replies.chunk({ id: "b2", last: true, text: "the kettle is on", sampleRate: 24000, samples: tone() });

      // it queues behind a voice nothing is sounding: unheard, so a ▶ and the words, not "1 more waiting"
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 2);
      await waitFor(() => document.querySelectorAll(".line.eye")[1].textContent.includes("the kettle is on"));
      assert.equal(await page.textContent("#status"), "Tap ▶ on the replies to hear them");
      assert.deepEqual(acked, [], "a reply nothing could sound was acked as heard");

      await page.click(".line.eye button.play"); // one press drains the whole tray
      for (let i = 0; i < 400 && acked.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(acked, [1, 2], "the press did not drain both, in order");
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 0);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "a device that cannot open an audio context says so when he taps to talk, and the eye goes out",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const replies = createReplies();
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-notalk.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: () => {},
      onBrains: () => ({ brains: CHANNELS, active: "main" }),
      onMode: () => "call",
      onReplay: () => false,
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    try {
      await page.addInitScript(() => {
        const no = function () {
          throw new Error("no audio on this device");
        };
        window.AudioContext = no;
        window.webkitAudioContext = no;
      });
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      await page.click("#disc"); // the tap to talk, on a device with no audio at all
      await page.waitForFunction(
        () => document.querySelector("#status").textContent === "This device will not open audio · it cannot hear or speak",
        null,
        { timeout: 30_000 },
      );
      assert.equal(await page.locator("#status.warn").count(), 1, "the failure did not read as a warning");
      assert.equal(await page.getAttribute("#disc", "aria-pressed"), "false", "the eye stayed gold over a turn that never opened");
      assert.equal(await page.title(), await page.evaluate(() => TITLE), "the tab still claimed it was listening");
      assert.deepEqual(errs, [], "the tap left an unhandled error on the page");
      await page.click("#disc"); // and a second tap is possible at all
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "his tap to talk cuts the voice, and the reply comes back whole with its ▶",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const acked = [];
    const replies = createReplies();
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-barge.json"),
      onAudio: () => "",
      onStream: () => true,
      onFinal: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onBrains: () => ({ brains: CHANNELS, active: "main" }),
      onMode: () => "call",
      onReplay: () => false,
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
    const waitFor = (fn) => page.waitForFunction(fn, null, { timeout: 30_000 });
    try {
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      // ten seconds of voice, so his own turn lands in the middle of it
      replies.chunk({ id: "g1", last: true, text: "a long answer", sampleRate: 24000, samples: tone(10) });
      await waitFor(() => document.querySelector("#disc").dataset.state === "speaking");

      await page.click("#disc"); // the gesture: the page's voice stops instead of playing into the mic
      await waitFor(() => document.title.startsWith("● listening"));
      assert.equal(await page.evaluate(() => playing), null, "the voice is still sounding into the open mic");
      assert.equal(await page.evaluate(() => queue.length), 1, "the interrupted reply was not handed back");
      assert.equal(await page.locator(".line.eye button.play").count(), 1, "the interrupted reply lost its ▶");
      assert.deepEqual(acked, [], "a reply he never heard out was acked as heard");
      assert.equal(await page.textContent("#status"), "Tap again to send", "the tray took the live turn's line");

      // and its words stop unscrambling at once, instead of resolving on the dead ten-second buffer's clock
      await page.waitForFunction(() => document.querySelector(".line.eye").textContent === "a long answer", null, {
        timeout: 2500,
      });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(await page.textContent(".line.eye"), "a long answer", "the interrupted line kept scrambling");

      await page.click("#disc"); // the turn goes
      await waitFor(() => document.querySelector("#disc").getAttribute("aria-pressed") === "false");
      assert.deepEqual(acked, [], "the turn ending acked the reply he interrupted");

      await page.click(".line.eye button.play"); // the next press plays it from the start, all ten seconds
      await waitFor(() => document.querySelector("#disc").dataset.state === "speaking");
      assert.ok(await page.evaluate(() => playing?.buf.duration > 9), "the replay started from an offset, not the beginning");
      assert.deepEqual(acked, [], "the stopped reply was acked before it was heard out");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "a reply landing during an open turn joins the tray instead of playing into the mic",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const acked = [];
    const replies = createReplies();
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-during.json"),
      onAudio: () => "",
      onStream: () => true,
      onFinal: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onBrains: () => ({ brains: CHANNELS, active: "main" }),
      onMode: () => "call",
      onReplay: () => false,
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
    const waitFor = (fn) => page.waitForFunction(fn, null, { timeout: 30_000 });
    try {
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      await page.click("#disc"); // his turn is open, in call mode
      await waitFor(() => document.title.startsWith("● listening"));

      replies.chunk({ id: "d1", last: true, text: "the kettle is on", sampleRate: 24000, samples: tone() });
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 1);
      await new Promise((r) => setTimeout(r, 1500));
      assert.deepEqual(acked, [], "a reply played into his open mic and was acked");
      assert.equal(await page.evaluate(() => playing), null, "the page spoke while it was listening");
      assert.equal(await page.textContent("#status"), "Tap again to send", "the tray took the live turn's line");
      assert.ok((await page.textContent(".line.eye")).includes("the kettle is on"), "the waiting reply hid its words");

      await page.click("#disc"); // the turn goes, and the reply is still his to play
      await waitFor(() => document.querySelector("#disc").getAttribute("aria-pressed") === "false");
      await page.click(".line.eye button.play");
      for (let i = 0; i < 300 && !acked.length; i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(acked, [1], "▶ did not play the reply that waited out his turn");
      await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 0);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

/**
 * One press, one barge-in, one press again — in both modes. M20's idempotence keeps the ▶
 * down while the replay sounds, and M19's cut hands that item back to the tray: the glyph it
 * carries has to come back up with it, or the reply is unreachable for good (in audio notes
 * mode every playback starts from a press, so that is the normal path, not an edge).
 */
for (const m of ["call", "notes"]) {
  test(
    `in ${m === "call" ? "call" : "audio notes"} mode, a barge-in on a reply he pressed ▶ for leaves it pressable`,
    { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
    async () => {
      const acked = [];
      const replies = createReplies();
      const server = startRemote({
        port: 0,
        secret: SECRET,
        sessionsFile: path.join(state, `sessions-barge-${m}.json`),
        onAudio: () => "",
        onStream: () => true,
        onFinal: () => "",
        onPoll: (since) => replies.poll(since, 2000),
        onCursor: () => replies.cursor(),
        onAck: (seq) => acked.push(seq),
        onBrains: () => ({ brains: CHANNELS, active: "main" }),
        onMode: () => m,
        onReplay: () => false, // the bytes are already on the page: no synthesis is asked for
        wav: (id) => replies.wav(id),
      });
      await new Promise((r) => server.once("listening", r));
      const base = `http://127.0.0.1:${server.address().port}`;

      const browser = await pw.chromium.launch({
        args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
      });
      const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
      const waitFor = (fn) => page.waitForFunction(fn, null, { timeout: 30_000 });
      const glyph = () => page.evaluate(() => document.querySelector(".line.eye button.play")?.disabled);
      try {
        await page.goto(base);
        await page.fill("#key", SECRET);
        await page.click("#keyform button");
        await page.waitForSelector("#disc:not([disabled])");

        replies.chunk({ id: "b1", last: true, text: "a long answer", sampleRate: 24000, samples: tone(3) });
        if (m === "call") {
          // call mode speaks it on arrival: his tap cuts it and the ▶ comes back
          await waitFor(() => document.querySelector("#disc").dataset.state === "speaking");
          await page.click("#disc");
          await waitFor(() => document.title.startsWith("● listening"));
          await page.click("#disc");
          await waitFor(() => document.querySelector("#disc").getAttribute("aria-pressed") === "false");
        }
        await page.waitForSelector(".line.eye button.play");

        await page.click(".line.eye button.play"); // the press that plays it
        await waitFor(() => playing !== null);
        assert.equal(await glyph(), true, "M20's guard is gone: the ▶ took a second press while it sounded");

        await page.click("#disc"); // he barges in on the reply he asked to hear
        await waitFor(() => document.title.startsWith("● listening"));
        assert.equal(await page.evaluate(() => playing), null, "the voice sounded on into his open mic");
        assert.equal(await page.evaluate(() => queue.length), 1, "the cut reply was not handed back to the tray");
        assert.deepEqual(acked, [], "a reply he never heard out was acked");
        assert.equal(await glyph(), false, "the barged reply's ▶ stayed disabled: the reply is unreachable");

        await page.click("#disc"); // the turn goes
        await waitFor(() => document.querySelector("#disc").getAttribute("aria-pressed") === "false");
        assert.equal(await glyph(), false, "the turn closing left the ▶ down");

        await page.click(".line.eye button.play"); // and the second press plays the whole buffer
        await waitFor(() => playing !== null);
        assert.ok(await page.evaluate(() => playing?.buf.duration > 2.9), "the second press replayed from an offset");
        for (let i = 0; i < 200 && !acked.length; i++) await new Promise((r) => setTimeout(r, 100));
        assert.deepEqual(acked, [1], "the reply was acked more than once, or never heard out");
        await waitFor(() => document.querySelectorAll(".line.eye button.play").length === 0);
      } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    },
  );
}
