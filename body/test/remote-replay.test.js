/**
 * The one thing only a browser can prove: ▶ on an audio-notes reply is heard on
 * the page and nowhere else. `startRemote` runs in-process on a free loopback
 * port over the real ring and the real hold in audio notes mode — the live body,
 * live port and the room's speaker are never touched — and a headless Chromium
 * taps the glyph on a reply that was never spoken.
 */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startRemote } = require("../src/remote");
const { createReplies } = require("../src/replies");
const { createHold } = require("../src/hold");
const { createEager } = require("../src/eager");
const chunks = require("../src/chunks");

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
const SECRET = "replay-key";
const state = fs.mkdtempSync(path.join(os.tmpdir(), "de-replay-"));
after(() => fs.rmSync(state, { recursive: true, force: true }));

/** Half a second of a tone, as the voice worker's chunk of one utterance. */
const tone = () => Float32Array.from({ length: 12000 }, (_, i) => Math.sin((i / 24000) * 440 * 2 * Math.PI) * 0.3);

test(
  "▶ on an audio-notes reply is said again to the page, and the room stays silent",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 120_000 },
  async () => {
    const room = []; // what the local mouth was asked to say — must stay empty
    const acked = [];
    const fetched = [];
    const replies = createReplies();
    let spoken = 0;
    // main.js's own wiring: the mode parks the mouth, a replay carries the bypass
    const hold = createHold({
      send: ({ text, to }) => {
        if (to !== "remote") room.push(text);
        if (to !== "local") replies.chunk({ id: `r${++spoken}`, last: true, text, sampleRate: 24000, samples: tone() });
      },
      parked: () => true,
    });

    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onMode: () => "notes",
      onReplay: (seq) => {
        const text = replies.find(seq);
        if (!text) return false;
        hold.offer({ text, sid: 17, to: "remote", bypass: true });
        return true;
      },
      wav: (id) => {
        fetched.push(id);
        return replies.wav(id);
      },
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");
      assert.equal(await page.getAttribute("#mode", "data-mode"), "notes", "the page did not read the mode off the body");
      assert.equal(await page.textContent("#mode"), "audio notes", "the mode word is his, not the body's");

      // an audio notes reply: something to press, and not a word of it before he does (M20)
      replies.text("the kettle is on");
      await page.waitForSelector(".line.eye button.play");
      assert.equal(await page.locator(".line.eye").count(), 1);
      assert.equal((await page.locator(".line.eye").first().textContent()).trim(), "", "a held reply showed its words before the press");
      assert.equal(await page.locator(".line.eye").first().getAttribute("data-text"), "the kettle is on");
      assert.deepEqual(room, []);
      assert.deepEqual(fetched, [], "a reply nobody has asked to hear has no bytes to fetch");

      await page.click(".line.eye button.play");
      // the words come back on the same line, on the voice's own clock — never a second copy
      await page.waitForFunction(
        () => document.querySelector(".line.eye").textContent.includes("the kettle is on"),
        null,
        { timeout: 20_000 },
      );
      assert.equal(await page.locator(".line.eye").count(), 1, "the replay put a second copy of the words on the page");

      // it played through in the browser: the ack only leaves when the WAV ends
      for (let i = 0; i < 200 && !acked.includes(2); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(acked.includes(2), "the re-synthesised reply never played on the page");
      assert.equal(fetched.length, 1, "the page fetched exactly the one new WAV");
      assert.deepEqual(room, [], "the mode was broken: the words went to the room");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "in audio notes mode, ▶ plays the reply he pressed and not one that landed first",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 120_000 },
  async () => {
    const room = [];
    const acked = [];
    const fetched = [];
    const replies = createReplies();
    let spoken = 0;
    const hold = createHold({
      send: ({ text, to }) => {
        if (to !== "remote") room.push(text);
        if (to !== "local") replies.chunk({ id: `r${++spoken}`, last: true, text, sampleRate: 24000, samples: tone() });
      },
      parked: () => true,
    });

    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onMode: () => "notes",
      onReplay: (seq) => {
        const text = replies.find(seq);
        if (!text) return false;
        // the race: a reply he never asked for lands between the press and its answer
        replies.chunk({ id: "intruder", last: true, text: "someone is at the door", sampleRate: 24000, samples: tone() });
        hold.offer({ text, sid: 17, to: "remote", bypass: true });
        return true;
      },
      wav: (id) => {
        fetched.push(id);
        return replies.wav(id);
      },
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");
      assert.equal(await page.getAttribute("#mode", "data-mode"), "notes", "this test is about audio notes mode");

      replies.text("the kettle is on"); // seq 1: words only, so ▶ must re-synthesise
      await page.waitForSelector(".line.eye button.play");
      await page.click(".line.eye button.play");

      // seq 2 is the intruder — its own line, held — and seq 3 the words he pressed for, on his
      await page.waitForFunction(() => document.querySelectorAll(".line.eye").length === 2, null, { timeout: 20_000 });
      for (let i = 0; i < 200 && !acked.includes(3); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(acked.includes(3), "the reply he pressed for never played");
      assert.ok(!acked.includes(2), "a reply he never asked for took his turn");
      assert.equal(fetched.length, 1, "the page fetched bytes it was not asked to play");
      assert.deepEqual(room, []);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "his sequence: a page left open, the body restarted under it, five presses on one reply",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const room = [];
    const acked = [];
    const fetched = [];
    const asked = []; // every seq the body was asked to say again
    const sessionsFile = path.join(state, "sessions-restart.json");
    let replies = createReplies();
    let spoken = 0;
    // the real notes-mode wiring, sentence by sentence as the voice worker hands it over
    const hold = createHold({
      send: ({ text, to }) => {
        if (to !== "remote") room.push(text);
        if (to === "local") return;
        const id = `r${++spoken}`;
        const cs = chunks(text);
        cs.forEach((c, i) =>
          replies.chunk({ id, seq: i, last: i === cs.length - 1, text: c, sampleRate: 24000, samples: tone() }),
        );
      },
      parked: () => true,
    });
    const listen = (port) =>
      startRemote({
        port,
        secret: SECRET,
        sessionsFile,
        onAudio: () => "",
        onPoll: (since) => replies.poll(since, 2000),
        onCursor: () => replies.cursor(),
        onAck: (seq) => acked.push(seq),
        onMode: () => "notes",
        onReplay: (seq) => {
          const text = replies.find(seq);
          asked.push(seq);
          if (!text) return false;
          // the voice takes seconds on the real body: his next press lands while it is working
          setTimeout(() => hold.offer({ text, sid: 17, to: "remote", bypass: true }), 1500);
          return true;
        },
        wav: (id) => {
          fetched.push(id);
          return replies.wav(id);
        },
      });

    let server = listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(base);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      replies.text("the one from before"); // a held reply, its ▶ still waiting
      await page.waitForSelector(".line.eye button.play");

      // the body restarts under his open page: the same port, the same cookie, a ring from 0
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      replies = createReplies();
      server = listen(port);
      await new Promise((r) => server.once("listening", r));

      // the page reconnects, sees another life of the body and lets the dead ▶ go
      await page.waitForFunction(() => document.querySelectorAll(".line.eye button.play").length === 0, null, {
        timeout: 30_000,
      });
      assert.match(await page.textContent("#status"), /restarted/, "the page never said the replies were gone");
      // its words are all that is left of it, so they are given back
      await page.waitForFunction(
        () => document.querySelector(".line.eye").textContent.includes("the one from before"),
        null,
        { timeout: 20_000 },
      );

      // a reply of this life, held for his press
      replies.text("the kettle is on");
      await page.waitForSelector(".line.eye button.play");
      assert.equal(await page.locator(".line.eye button.play").count(), 1);
      assert.equal(await page.textContent("#status"), "1 waiting \u00b7 \u25b6 to play");

      // five presses on that one ▶, his own rhythm, while the voice is still working
      let presses = 0;
      for (let i = 0; i < 5; i++) {
        presses += await page.evaluate(() => {
          const b = document.querySelector(".line.eye button.play");
          if (!b) return 0;
          b.click(); // a glyph whose replay is in flight is disabled, so this reaches nothing
          return 1;
        });
        await new Promise((r) => setTimeout(r, 300));
      }
      assert.equal(presses, 5, "the ▶ left the page while his presses were still landing");
      for (let i = 0; i < 200 && !acked.includes(2); i++) await new Promise((r) => setTimeout(r, 100));

      assert.deepEqual(asked, [1], "five presses asked the body for more than one synthesis");
      assert.equal(await page.locator(".line.eye").count(), 2, "a press put another copy of the words on the page");
      assert.ok(acked.includes(2), "the press never started the audio");
      assert.deepEqual(
        acked.filter((n) => n === 2),
        [2],
        "the reply was played, and acked, more than once",
      );
      assert.equal(fetched.length, 1, "the page fetched the reply's bytes more than once");
      assert.ok(
        (await page.locator(".line.eye").last().textContent()).includes("the kettle is on"),
        "the words never came back on the line he pressed",
      );
      assert.deepEqual(room, [], "the mode was broken: the words went to the room");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

/** The tab his phone backgrounds: the loop leaves *cleanly*, so `offline` is never set. */
const hide = (page, on) =>
  page.evaluate((h) => {
    window.__hidden = h;
    if (!Object.getOwnPropertyDescriptor(document, "hidden")) {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__hidden });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (window.__hidden ? "hidden" : "visible") });
    }
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }, on);

test(
  "the body restarts under a backgrounded tab: on his return the dead ▶ goes and the new life is heard",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const sessionsFile = path.join(state, "sessions-hidden.json");
    let replies = createReplies();
    const listen = (port) =>
      startRemote({
        port,
        secret: SECRET,
        sessionsFile,
        onAudio: () => "",
        onPoll: (since) => replies.poll(since, 2000),
        onCursor: () => replies.cursor(),
        onAck: () => {},
        onMode: () => "notes",
        onReplay: () => false,
        wav: (id) => replies.wav(id),
      });

    let server = listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      replies.text("the one from before"); // a held reply, its ▶ waiting
      await page.waitForSelector(".line.eye button.play");

      await hide(page, true); // his phone goes to another app: the loop exits on its own
      await page.waitForFunction(() => !polling, null, { timeout: 30_000 });
      assert.equal(await page.evaluate(() => offline), false, "the hidden tab's clean exit was taken for a dropped tunnel");

      // the body restarts while nothing is polling: the same port and cookie, a ring from 0
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      replies = createReplies();
      server = listen(port);
      await new Promise((r) => server.once("listening", r));

      await hide(page, false); // he comes back to the page
      await page.waitForFunction(() => document.querySelectorAll(".line.eye button.play").length === 0, null, {
        timeout: 30_000,
      });
      assert.match(await page.textContent("#status"), /restarted/, "the page never noticed the new life");
      // its words are all that is left of it, so they come back — on the reveal's own clock
      await page.waitForFunction(
        () => document.querySelector(".line.eye").textContent.includes("the one from before"),
        null,
        { timeout: 20_000 },
      );

      // and the reply this life holds for him arrives, instead of falling under a dead cursor
      replies.text("the kettle is on");
      await page.waitForFunction(() => document.querySelectorAll(".line.eye").length === 2, null, { timeout: 30_000 });
      assert.equal(await page.locator(".line.eye button.play").count(), 1, "the new life's reply carries no ▶");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "the body restarts while his mic is open: the dead ▶ goes and the new life is heard",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const sessionsFile = path.join(state, "sessions-recording.json");
    let replies = createReplies();
    const listen = (port) =>
      startRemote({
        port,
        secret: SECRET,
        sessionsFile,
        onAudio: () => "",
        onStream: () => true,
        onFinal: () => "",
        onPoll: (since) => replies.poll(since, 2000),
        onCursor: () => replies.cursor(),
        onAck: () => {},
        onMode: () => "notes",
        onReplay: () => false,
        wav: (id) => replies.wav(id),
      });

    let server = listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;
    const browser = await pw.chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      replies.text("the one from before");
      await page.waitForSelector(".line.eye button.play");

      await page.click("#disc"); // his turn is open, so a failing poll never sets `offline`
      await page.waitForFunction(() => document.title.startsWith("● listening"), null, { timeout: 30_000 });
      // `offline` is read back below, and the word it would have put on the status line is watched for here
      await page.evaluate(() => {
        window.__offline = false;
        const st = document.querySelector("#status");
        new MutationObserver(() => {
          if (/Offline/.test(st.textContent)) window.__offline = true;
        }).observe(st, { childList: true, subtree: true, characterData: true });
      });

      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      replies = createReplies();
      server = listen(port);
      await new Promise((r) => server.once("listening", r));

      await page.waitForFunction(() => document.querySelectorAll(".line.eye button.play").length === 0, null, {
        timeout: 30_000,
      });
      assert.deepEqual(
        await page.evaluate(() => [offline, window.__offline]),
        [false, false],
        "the poll failing under his open turn was taken for a dropped tunnel",
      );
      replies.text("the kettle is on");
      await page.waitForFunction(() => document.querySelectorAll(".line.eye").length === 2, null, { timeout: 30_000 });
      assert.equal(await page.locator(".line.eye button.play").count(), 1, "the new life's reply carries no ▶");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

test(
  "a replay the body refuses gives the words back, and its one-second gap keeps the press",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const replies = createReplies();
    let accept = false; // the first test half: the body cannot say it again
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-refused.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: () => {},
      onMode: () => "notes",
      onReplay: () => accept,
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      replies.text("the kettle is on"); // words only: the ▶ has to ask the body
      await page.waitForSelector(".line.eye button.play");
      assert.equal((await page.textContent(".line.eye")).trim(), "", "a held reply showed its words before the press");

      await page.click(".line.eye button.play");
      await page.waitForFunction(() => /cannot be said again/.test(document.querySelector("#status").textContent), null, {
        timeout: 30_000,
      });
      await page.waitForFunction(
        () => document.querySelector(".line.eye").textContent.includes("the kettle is on"),
        null,
        { timeout: 20_000 },
      ); // hidden for a voice that never came, and given back on the refusal
      assert.equal(
        await page.evaluate(() => document.querySelector(".line.eye button.play").disabled),
        false,
        "a refused replay left the ▶ down",
      );

      // two ▶ inside the body's one-second gap: the second is told to wait, not that it is impossible
      accept = true;
      replies.text("the door is open");
      await page.waitForFunction(() => document.querySelectorAll(".line.eye button.play").length === 2, null, {
        timeout: 30_000,
      });
      await page.evaluate(() => {
        const [a, b] = document.querySelectorAll(".line.eye button.play");
        a.click();
        b.click();
      });
      await page.waitForFunction(() => /One moment/.test(document.querySelector("#status").textContent), null, {
        timeout: 30_000,
      });
      assert.equal(
        await page.evaluate(() => document.querySelectorAll(".line.eye button.play")[1].disabled),
        false,
        "the gap consumed the press it refused",
      );
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

/** Three seconds of a tone: long enough to barge in on while it is still sounding. */
const longTone = () => Float32Array.from({ length: 72000 }, (_, i) => Math.sin((i / 24000) * 440 * 2 * Math.PI) * 0.3);

/**
 * His own duplication bug, back through the barge: a claimed replay is played onto the
 * pressed line under a **new** seq, so that line sits in the tray while its glyph still
 * carries the old one. `offer()` re-enables that glyph after a barge, and a press keyed
 * by seq missed the item it belongs to and queued a second copy of the same buffer —
 * one press, two fetches, the whole reply heard twice. Both barge gestures, both modes.
 */
async function bargeThenPress({ mode, barge }) {
  const room = [];
  const acked = [];
  const fetched = [];
  const replies = createReplies();
  let spoken = 0;
  const hold = createHold({
    send: ({ text, to }) => {
      if (to !== "remote") room.push(text);
      if (to !== "local") replies.chunk({ id: `r${++spoken}`, last: true, text, sampleRate: 24000, samples: longTone() });
    },
    parked: () => mode === "notes",
  });

  const server = startRemote({
    port: 0,
    secret: SECRET,
    sessionsFile: path.join(state, `sessions-barge-${mode}-${barge}.json`),
    onAudio: () => "",
    onStream: () => true,
    onFinal: () => "",
    onPoll: (since) => replies.poll(since, 2000),
    onCursor: () => replies.cursor(),
    onAck: (seq) => acked.push(seq),
    onMode: () => mode,
    onReplay: (seq) => {
      const text = replies.find(seq);
      if (!text) return false;
      hold.offer({ text, sid: 17, to: "remote", bypass: true });
      return true;
    },
    wav: (id) => {
      fetched.push(id);
      return replies.wav(id);
    },
  });
  await new Promise((r) => server.once("listening", r));

  const browser = await pw.chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.fill("#key", SECRET);
    await page.click("#keyform button");
    await page.waitForSelector("#disc:not([disabled])");

    // a reply with no voice behind it: the glyph is seq 1, and the replay will be seq 2
    replies.text("the kettle is on");
    await page.waitForSelector(".line.eye button.play");

    await page.click(".line.eye button.play");
    await page.waitForFunction(() => playing !== null, null, { timeout: 30_000 });
    assert.equal(await page.evaluate(() => playing.n), 2, "the replay did not come back under a new seq");

    // his voice takes the page's, mid-buffer
    if (barge === "space") await page.keyboard.press("Space");
    else await page.click("#disc");
    await page.waitForFunction(() => recording && playing === null, null, { timeout: 30_000 });
    assert.deepEqual(await page.evaluate(() => queue.map((q) => q.n)), [2], "the barged reply left the head of the tray");

    await page.click("#disc"); // his turn ends
    await page.waitForFunction(() => !recording, null, { timeout: 30_000 });

    // and the press on the line he barged plays what is waiting there — once
    await page.click(".line.eye button.play");
    for (let i = 0; i < 300 && !acked.includes(2); i++) await new Promise((r) => setTimeout(r, 100));

    assert.equal(fetched.length, 1, "the press after the barge asked for a second copy of the bytes");
    assert.deepEqual(await page.evaluate(() => [queue.length, playing]), [0, null], "a copy was left in the tray");
    assert.deepEqual(acked, [1, 2], "one press played the reply more than once");
    assert.equal(await page.locator(".line.eye").count(), 1, "the replay put a second line on the page");
    assert.equal(await page.locator(".line.eye button.play").count(), 0, "the reply was heard out and kept its glyph");
    assert.deepEqual(room, [], "the words went to the room");
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test(
  "in audio notes mode, one press after a barge plays the replay once — space and tap",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 240_000 },
  async () => {
    await bargeThenPress({ mode: "notes", barge: "space" });
    await bargeThenPress({ mode: "notes", barge: "tap" });
  },
);

test(
  "in call mode, one press after a barge plays the replay once",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 240_000 },
  async () => {
    await bargeThenPress({ mode: "call", barge: "space" });
  },
);

/**
 * `restarted()` keeps the glyph of a line the page can still play itself: a reply decoded
 * and waiting behind his open mic is unheard, and its bytes are already here, so the new
 * life of the body takes nothing from it. Every other stale ▶ goes.
 */
test(
  "a restart leaves the ▶ of a reply still in the tray, and takes the rest",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const sessionsFile = path.join(state, "sessions-tray-restart.json");
    let replies = createReplies();
    let spoken = 0;
    let hold;
    const listen = (port) =>
      startRemote({
        port,
        secret: SECRET,
        sessionsFile,
        onAudio: () => "",
        onStream: () => true,
        onFinal: () => "",
        onPoll: (since) => replies.poll(since, 2000),
        onCursor: () => replies.cursor(),
        onAck: () => {},
        onMode: () => "notes",
        onReplay: (seq) => {
          const text = replies.find(seq);
          if (!text) return false;
          hold.offer({ text, sid: 17, to: "remote", bypass: true });
          return true;
        },
        wav: (id) => replies.wav(id),
      });
    const wire = () => {
      hold = createHold({
        send: ({ text, to }) => {
          if (to !== "local") replies.chunk({ id: `r${++spoken}`, last: true, text, sampleRate: 24000, samples: longTone() });
        },
        parked: () => true,
      });
    };
    wire();

    let server = listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;
    const browser = await pw.chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      replies.text("the kettle is on");
      await page.waitForSelector(".line.eye button.play");

      await page.click("#disc"); // his turn is open: the reply behind it never sounds into the mic
      await page.waitForFunction(() => document.title.startsWith("● listening"), null, { timeout: 30_000 });

      // the replay he pressed for lands during the turn: decoded, in the tray, its ▶ pressable
      await page.click(".line.eye button.play");
      await page.waitForFunction(() => queue.map((q) => q.n).join() === "2", null, { timeout: 30_000 });

      replies.text("the door is open"); // a second held reply, nothing of it on this page but words
      await page.waitForFunction(() => document.querySelectorAll(".line.eye button.play").length === 2, null, {
        timeout: 30_000,
      });

      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      replies = createReplies();
      spoken = 0;
      wire();
      server = listen(port);
      await new Promise((r) => server.once("listening", r));

      // the dead ▶ goes; the one whose bytes are in the tray stays, on the line it belongs to
      await page.waitForFunction(
        () => !document.querySelectorAll(".line.eye")[1]?.querySelector("button.play"),
        null,
        { timeout: 30_000 },
      );
      assert.match(await page.textContent("#status"), /restarted/, "the page never noticed the new life");
      assert.equal(
        await page.evaluate(() => !!document.querySelectorAll(".line.eye")[0].querySelector("button.play")),
        true,
        "the restart took the ▶ of a reply the page can still play from its own tray",
      );
      assert.deepEqual(await page.evaluate(() => queue.map((q) => q.n)), [2], "the queued reply left the tray");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

/**
 * `claim()` consumes the press it answers: the words tie a replay to its press, so a press
 * left in `wanted` would let the *next* reply with the same words take its turn — played on
 * the old line, in audio notes mode, with no press of its own.
 */
test(
  "a press is answered once: a later reply with the same words still waits for its own ▶",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const acked = [];
    const fetched = [];
    const replies = createReplies();
    let spoken = 0;
    const hold = createHold({
      send: ({ text, to }) => {
        if (to !== "local") replies.chunk({ id: `r${++spoken}`, last: true, text, sampleRate: 24000, samples: tone() });
      },
      parked: () => true,
    });

    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-claim-once.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onMode: () => "notes",
      onReplay: (seq) => {
        const text = replies.find(seq);
        if (!text) return false;
        hold.offer({ text, sid: 17, to: "remote", bypass: true });
        return true;
      },
      wav: (id) => {
        fetched.push(id);
        return replies.wav(id);
      },
    });
    await new Promise((r) => server.once("listening", r));
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      replies.text("the kettle is on");
      await page.waitForSelector(".line.eye button.play");
      await page.click(".line.eye button.play"); // the replay comes back as seq 2 and is heard out
      for (let i = 0; i < 300 && !acked.includes(2); i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(acked, [1, 2], "the replay he pressed for never played");

      // the same words arrive again, this time with a voice already made: his mode holds them
      replies.chunk({ id: "again", last: true, text: "the kettle is on", sampleRate: 24000, samples: tone() });
      const lines = () => page.locator(".line.eye").count();
      for (let i = 0; i < 100 && (await lines()) < 2; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 1000)); // long enough for a claim to have played it

      assert.equal(await lines(), 2, "the spent press claimed the new reply onto the line he had pressed");
      assert.equal(
        (await page.locator(".line.eye").nth(1).textContent()).trim(),
        "",
        "the new reply showed its words before any press",
      );
      assert.equal(fetched.length, 1, "the spent press claimed the new reply and fetched its bytes");
      assert.deepEqual(acked, [1, 2], "the new reply was heard without a press of its own");
      assert.equal(await page.locator(".line.eye button.play").count(), 1, "the waiting reply has no ▶ of its own");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

/**
 * The hole under all of it: `enter()` reads the cursor once, and a first request that fails
 * on mobile data left the page with no life at all — restart detection off for as long as he
 * left it open, a ▶ still there and nothing behind it. The page takes the next life it reads.
 */
test(
  "the cursor read at login fails: the page takes a life of its own and still sees the restart",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const sessionsFile = path.join(state, "sessions-no-boot.json");
    let replies = createReplies();
    const listen = (port) =>
      startRemote({
        port,
        secret: SECRET,
        sessionsFile,
        onAudio: () => "",
        onPoll: (since) => replies.poll(since, 2000),
        onCursor: () => replies.cursor(),
        onAck: () => {},
        onMode: () => "notes",
        onReplay: () => false,
        wav: (id) => replies.wav(id),
      });

    let server = listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      let reads = 0; // his flaky first request: only the one `enter()` makes is lost
      await page.route("**/remote/cursor", (route) => (reads++ ? route.continue() : route.abort()));
      await page.goto(`http://127.0.0.1:${port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");
      assert.ok(reads > 0, "the login never read the cursor, so this test proves nothing");

      // with no life at login the page reads one for itself, without him reloading
      await page.waitForFunction(() => boot !== null, null, { timeout: 20_000 });

      replies.text("the one from before"); // a held reply of this life, its ▶ waiting
      await page.waitForSelector(".line.eye button.play");

      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      replies = createReplies();
      server = listen(port);
      await new Promise((r) => server.once("listening", r));

      // the dead ▶ goes and he is told, on a page whose login read never answered
      await page.waitForFunction(() => document.querySelectorAll(".line.eye button.play").length === 0, null, {
        timeout: 30_000,
      });
      assert.match(await page.textContent("#status"), /restarted/, "the page never noticed the new life");
      await page.waitForFunction(
        () => document.querySelector(".line.eye").textContent.includes("the one from before"),
        null,
        { timeout: 20_000 },
      );

      // and the reply this life holds arrives, instead of falling under a dead cursor
      replies.text("the kettle is on");
      await page.waitForFunction(() => document.querySelectorAll(".line.eye").length === 2, null, { timeout: 30_000 });
      assert.equal(await page.locator(".line.eye button.play").count(), 1, "the new life's reply carries no ▶");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

/**
 * That read is made with `polling` held, so a cursor request that never answers — the
 * tunnel half-open, which is what a phone does off Wi-Fi — used to stop the loop for good:
 * no poll, no reply, no word to him. It is bounded, and the loop goes on without it.
 */
test(
  "a cursor read that never answers does not hold the loop",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const replies = createReplies();
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-hung-cursor.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: () => {},
      onMode: () => "notes",
      onReplay: () => false,
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      replies.text("the one from before");
      await page.waitForSelector(".line.eye button.play");

      await page.route("**/remote/cursor", () => {}); // answered by nothing, ever
      await hide(page, true); // the loop leaves cleanly, so his return is what reads the cursor
      await page.waitForFunction(() => !polling, null, { timeout: 30_000 });
      await hide(page, false);
      await page.waitForFunction(() => polling, null, { timeout: 30_000 });

      // the read is still hanging; the loop is past it and the next reply reaches him
      replies.text("the kettle is on");
      await page.waitForFunction(() => document.querySelectorAll(".line.eye").length === 2, null, { timeout: 30_000 });
      assert.equal(await page.locator(".line.eye button.play").count(), 2, "a waiting reply lost its ▶");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

/**
 * The body as main.js wires it for T2: the mode parks every reply, the parked
 * reply's voice is made while it waits, and his ▶ plays bytes that already
 * exist. `voice` counts every Kokoro run asked for, eager or on the press.
 */
function eagerBody({ delayMs = 0, sentences = 1 } = {}) {
  const room = [];
  const acked = [];
  const fetched = [];
  const runs = [];
  const replies = createReplies();
  let spoken = 0;
  const worker = ({ id, text }) => {
    runs.push(text);
    setTimeout(() => {
      for (let i = 0; i < sentences; i++)
        pump({ id, seq: i, last: i === sentences - 1, text, sampleRate: 24000, samples: tone() });
    }, delayMs);
  };
  let pump = () => {};
  const hold = createHold({
    send: ({ text, to }) => {
      runs.push(text);
      if (to !== "remote") room.push(text);
      if (to !== "local")
        setTimeout(
          () => replies.chunk({ id: `r${++spoken}`, last: true, text, sampleRate: 24000, samples: tone() }),
          delayMs
        );
    },
    parked: () => true,
  });
  const eager = createEager({
    speak: worker,
    attach: (seq, parts, rate) => replies.attach(seq, parts, rate),
    // main.js's `holdSpeaking()` in audio notes mode: only what he asked for is what the mouth will say
    idle: () => !hold.list().some((item) => item.bypass),
    load1: () => 0, // the box another agent is loading is not what these tests are about
  });
  pump = (m) => eager.chunk(m);
  /** main.js's `say()` in audio notes mode: the words out now, the utterance parked, the voice made while it waits. */
  const park = (text, sid = 17) => {
    const seq = replies.text(text);
    eager.queue(seq, text, sid);
    hold.offer({ text, sid, to: "local" }); // the park itself — what the old harness left out
    return seq;
  };
  /** main.js's `onReplay`. */
  const onReplay = (seq) => {
    const text = replies.find(seq);
    if (!text) return false;
    const now = () => hold.offer({ text, sid: 17, to: "remote", bypass: true });
    if (replies.repeat(seq)) return true;
    if (!eager.press(seq, (ok) => (ok ? replies.repeat(seq) : now()))) now();
    return true;
  };
  const opts = {
    onAudio: () => "",
    onPoll: (since) => replies.poll(since, 2000),
    onCursor: () => replies.cursor(),
    onAck: (seq) => acked.push(seq),
    onMode: () => "notes",
    onReplay,
    wav: (id) => (fetched.push(id), replies.wav(id)),
  };
  return { replies, eager, hold, park, opts, room, acked, fetched, runs };
}

test("every parked reply gets its voice made, not only the first", async () => {
  const b = eagerBody();
  const notes = ["first reply", "second reply", "third reply"];
  const seqs = notes.map((t) => b.park(t));
  for (let i = 0; i < 600 && !(b.runs.length === notes.length && b.eager.jobId() === null); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(b.runs, notes, "a reply parked behind the first was left without a voice");
  for (const seq of seqs) assert.ok((await b.replies.poll(seq - 1, 20))?.audio, `reply ${seq} has no bytes for his \u25b6`);
  assert.equal(b.eager.waiting, 0, "the eager queue never drained");
  assert.equal(b.hold.held, notes.length, "the mouth took a parked reply the mode had parked");
  assert.deepEqual(b.room, [], "the mode was broken: the words went to the room");
});

/** A page ready to press, with the moment of the first sound and every replay it posts on it. */
async function pressable(browser, base) {
  const asked = [];
  const page = await (await browser.newContext()).newPage();
  page.on("request", (r) => r.url().endsWith("/remote/replay") && asked.push(r.url()));
  await page.addInitScript(() => {
    window.__sound = null;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      window.__sound ??= performance.now();
      return start.apply(this, a);
    };
  });
  await page.goto(base);
  await page.fill("#key", SECRET);
  await page.click("#keyform button");
  await page.waitForSelector("#disc:not([disabled])");
  return { page, asked };
}

test(
  "a reply whose voice was already made plays on the press with no synthesis and nothing asked of the body",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 120_000 },
  async () => {
    const b = eagerBody();
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions.json"),
      ...b.opts,
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const { page, asked } = await pressable(browser, base);
    try {
      // his phone is on another app: the reply is parked and its voice made while he is away
      await hide(page, true);
      await page.waitForFunction(() => !polling, null, { timeout: 30_000 });
      const seq = b.park("the kettle is on");
      for (let i = 0; i < 300; i++) {
        if ((await b.replies.poll(seq - 1, 20))?.audio) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(b.runs.length, 1, "the parked reply was not made exactly once");

      // he comes back to the tray: the note is there, with its voice already on it
      await hide(page, false);
      await page.waitForSelector(".line.eye button.play");
      assert.equal(
        (await page.locator(".line.eye").first().textContent()).trim(),
        "",
        "a held reply showed its words before the press, even with its voice made"
      );

      const pressed = await page.evaluate(() => performance.now());
      await page.click(".line.eye button.play");
      await page.waitForFunction(() => window.__sound !== null, null, { timeout: 30_000 });
      const wait = (await page.evaluate(() => window.__sound)) - pressed;
      assert.ok(wait < 500, `press → first sound was ${Math.round(wait)} ms`);
      await page.waitForFunction(
        () => document.querySelector(".line.eye").textContent.includes("the kettle is on"),
        null,
        { timeout: 30_000 }
      );

      for (let i = 0; i < 300 && !b.acked.includes(seq); i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(b.acked, [seq], "the one press did not end in exactly one ack");
      assert.deepEqual(asked, [], "the page asked the body for a reply whose voice it already had");
      assert.equal(b.runs.length, 1, "the press cost a synthesis");
      assert.equal(b.fetched.length, 1, "the page fetched the one WAV, once");
      assert.equal(await page.locator(".line.eye").count(), 1, "the press put a second line on the page");
      assert.deepEqual(b.room, [], "the mode was broken: the words went to the room");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }
);

test(
  "the press on a page that was watching costs no synthesis either: the held bytes come back as the answer",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 120_000 },
  async () => {
    // the voice lands 300 ms after the park, so the page is certain to have the line before the bytes
    // exist — which is the case this test is about, and was a race under load while it was 0 ms
    const b = eagerBody({ delayMs: 300 });
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions.json"),
      ...b.opts,
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const { page, asked } = await pressable(browser, base);
    try {
      const seq = b.park("the kettle is on");
      await page.waitForSelector(".line.eye button.play");
      assert.equal((await page.locator(".line.eye").first().textContent()).trim(), "", "the words came before the press");
      for (let i = 0; i < 300; i++) {
        if ((await b.replies.poll(seq - 1, 20))?.audio) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(b.runs.length, 1, "the voice was not made while the reply waited");

      await page.click(".line.eye button.play");
      await page.waitForFunction(
        () => document.querySelector(".line.eye").textContent.includes("the kettle is on"),
        null,
        { timeout: 30_000 }
      );
      for (let i = 0; i < 300 && !b.acked.length; i++) await new Promise((r) => setTimeout(r, 100));

      assert.equal(b.runs.length, 1, "the press synthesised what was already made");
      assert.deepEqual(asked, [`${base}/remote/replay`], "a page that was watching asks once, and once only");
      assert.equal(b.acked.length, 1, "one press, one ack");
      assert.equal(await page.locator(".line.eye").count(), 1, "the answer landed on a second line");
      assert.equal(b.fetched.length, 1, "the page fetched the one WAV, once");
      assert.deepEqual(b.room, []);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }
);

test(
  "a press while the voice is still being made waits on that one run — one synthesis, one playback, one ack",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 120_000 },
  async () => {
    const b = eagerBody({ delayMs: 1500 });
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions.json"),
      ...b.opts,
    });
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const { page, asked } = await pressable(browser, base);
    try {
      b.park("the kettle is on");
      await page.waitForSelector(".line.eye button.play");
      assert.equal(b.runs.length, 1, "the parked reply was not being made yet");

      await page.click(".line.eye button.play"); // mid-job: the press is a waiter, not a second run
      await page.waitForFunction(
        () => document.querySelector(".line.eye").textContent.includes("the kettle is on"),
        null,
        { timeout: 30_000 }
      );
      for (let i = 0; i < 300 && !b.acked.length; i++) await new Promise((r) => setTimeout(r, 100));

      assert.equal(b.runs.length, 1, "the press started the work again");
      assert.equal(b.acked.length, 1, "one press, one ack");
      assert.equal(await page.locator(".line.eye").count(), 1, "the press put a second line on the page");
      await page.waitForFunction(() => !document.querySelector(".line.eye button.play"), null, { timeout: 30_000 });
      assert.deepEqual(asked, [`${base}/remote/replay`]);
      assert.deepEqual(b.room, []);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }
);

/**
 * The header is only half of noticing a restart: the answer that carries it carries a reply
 * too, and that reply is the one he is waiting for. Read after the resync it was already
 * gone — the new life's cursor is past it — so the page said "The Eye restarted" and nothing
 * else, which is his original symptom: an answer that never appears.
 */
test(
  "the reply in the answer that changed the life still reaches him",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const sessionsFile = path.join(state, "sessions-life-change.json");
    let replies = createReplies();
    const listen = (port) =>
      startRemote({
        port,
        secret: SECRET,
        sessionsFile,
        onAudio: () => "",
        onPoll: (since) => replies.poll(since, 2000),
        onCursor: () => replies.cursor(),
        onAck: () => {},
        onMode: () => "notes",
        onReplay: () => false,
        wav: (id) => replies.wav(id),
      });
    let server = listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");
      await page.waitForFunction(() => boot !== null, null, { timeout: 30_000 });
      const first = await page.evaluate(() => boot);

      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      replies = createReplies();
      server = listen(port);
      await new Promise((r) => server.once("listening", r));
      replies.text("the kettle is on"); // the new life answers him before the page has noticed it

      await page.waitForFunction(() => document.querySelectorAll(".line.eye").length === 1, null, { timeout: 60_000 });
      assert.equal(
        await page.locator(".line.eye").first().getAttribute("data-text"),
        "the kettle is on",
        "the reply the new life answered with never appeared",
      );
      assert.equal(await page.locator(".line.eye button.play").count(), 1, "the reply came with no ▶ to hear it by");
      assert.notEqual(await page.evaluate(() => boot), first, "the page never took the new life");
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

/**
 * A poll answer that names a life no cursor read can name — a cached `/remote/cursor`, a read
 * that never answers — used to leave the page polling as fast as the radio allowed: 3699 polls
 * in 25 s on the reviewer's measurement, every reply swallowed and the status line normal. On
 * his phone that is battery and data, so the branch that makes no progress waits, and doubles.
 */
test(
  "a life no cursor read can name cannot spin the page, and it still recovers",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const replies = createReplies();
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-no-spin.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: () => {},
      onMode: () => "notes",
      onReplay: () => false,
      wav: (id) => replies.wav(id),
    });
    await new Promise((r) => server.once("listening", r));
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");
      await page.waitForFunction(() => boot !== null, null, { timeout: 30_000 });

      // every poll answers at once for a life the page does not hold, and no cursor read answers
      await page.route("**/remote/poll*", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", "x-eye-boot": "a-newer-life" },
          body: "null",
        }),
      );
      await page.route("**/remote/cursor", (route) => route.abort());
      let polls = 0;
      page.on("request", (r) => r.url().includes("/remote/") && polls++);
      await new Promise((r) => setTimeout(r, 12_000));
      const spun = polls;
      assert.ok(spun < 40, `the page spun: ${spun} requests in 12 s`);

      // the poll lane comes back while the cursor read still never answers: the reply rides an
      // answer naming a life no read can name, so the answer in hand is his only copy of it
      await page.unroute("**/remote/poll*");
      replies.text("the kettle is on");
      await page.waitForFunction(() => document.querySelectorAll(".line.eye").length === 1, null, { timeout: 90_000 });
      assert.equal(
        await page.locator(".line.eye").first().getAttribute("data-text"),
        "the kettle is on",
        "the page never came back from the mismatch",
      );
      await page.unrouteAll({ behavior: "ignoreErrors" });
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

/**
 * A reply decoded into the tray outlives a restart — its bytes are here, so its ▶ stays — and
 * the seq it acks when he finally hears it out names a *different* reply in the new life. The
 * ack carries the life it belongs to, and the body refuses it, or that number takes a live
 * reply of the new life off the ring before he ever hears it.
 */
test(
  "an ack from a life that is gone is refused by the body",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const sessionsFile = path.join(state, "sessions-cross-life-ack.json");
    let replies = createReplies();
    let acked = [];
    const listen = (port) =>
      startRemote({
        port,
        secret: SECRET,
        sessionsFile,
        onAudio: () => "",
        onStream: () => true,
        onFinal: () => "",
        onPoll: (since) => replies.poll(since, 2000),
        onCursor: () => replies.cursor(),
        onAck: (seq) => acked.push(seq),
        onMode: () => "call",
        onReplay: () => false,
        wav: (id) => replies.wav(id),
      });
    let server = listen(0);
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;
    const browser = await pw.chromium.launch({
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
    });
    const page = await (await browser.newContext({ permissions: ["microphone"] })).newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      await page.click("#disc"); // his turn is open, so the reply behind it waits in the tray
      await page.waitForFunction(() => document.title.startsWith("● listening"), null, { timeout: 30_000 });
      replies.chunk({ id: "r1", last: true, text: "the kettle is on", sampleRate: 24000, samples: tone() });
      await page.waitForFunction(() => queue.map((q) => q.n).join() === "1", null, { timeout: 30_000 });

      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      replies = createReplies(); // the new life counts from 0 again: its seq 1 is another reply
      acked = [];
      server = listen(port);
      await new Promise((r) => server.once("listening", r));
      await page.waitForFunction(() => boot !== null, null, { timeout: 30_000 });

      await page.click("#disc"); // his turn ends
      await page.waitForFunction(() => !recording, null, { timeout: 30_000 });
      await page.click(".line.eye button.play"); // and his press plays the tray out
      await page.waitForFunction(() => queue.length === 0 && playing === null, null, { timeout: 60_000 });
      await new Promise((r) => setTimeout(r, 2000)); // long enough for the ack to have landed

      assert.deepEqual(acked, [], "a seq from the life that is gone was acked into the new one");
      assert.equal(
        await page.locator(".line.eye button.play").count(),
        0,
        "the reply he heard out of the tray kept its ▶",
      );
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);

/**
 * The JSON lanes are answers about this second — which life is up, what the body just said.
 * A cached `/remote/cursor` is a dead life's cursor, and one cached `/remote/poll` is a reply
 * arriving over and over; both are how the page ends up polling for a life nobody holds.
 */
test("the JSON lanes are never cached", { timeout: 30_000 }, async () => {
  const replies = createReplies();
  const server = startRemote({
    port: 0,
    secret: SECRET,
    sessionsFile: path.join(state, "sessions-no-store.json"),
    onAudio: () => "",
    onPoll: (since) => replies.poll(since, 200),
    onCursor: () => replies.cursor(),
    onMode: () => "notes",
    wav: () => null,
  });
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/remote/login`, { method: "POST", body: JSON.stringify({ key: SECRET }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    replies.text("the kettle is on");
    for (const lane of ["/remote/cursor", "/remote/mode", "/remote/poll?since=0"]) {
      const r = await fetch(base + lane, { headers: { cookie } });
      assert.equal(r.headers.get("cache-control"), "no-store", `${lane} may be cached`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

/**
 * The replay is published while the POST that asked for it is still in the air: under load the
 * poll carrying it comes back first, and a press not yet on the books claimed nothing — the
 * reply took a second line, showed its words and never played, and his ▶ stayed down. This is
 * the 1-in-10 flake of "one press after a barge"; the press is written down before the ask.
 */
test(
  "a replay that comes back before the answer to the press is still played on his line",
  { skip: pw ? false : "playwright is not installed on this machine", timeout: 180_000 },
  async () => {
    const acked = [];
    const fetched = [];
    const replies = createReplies();
    let spoken = 0;
    const hold = createHold({
      send: ({ text, to }) => {
        if (to !== "local") replies.chunk({ id: `r${++spoken}`, last: true, text, sampleRate: 24000, samples: tone() });
      },
      parked: () => true,
    });
    const server = startRemote({
      port: 0,
      secret: SECRET,
      sessionsFile: path.join(state, "sessions-press-race.json"),
      onAudio: () => "",
      onPoll: (since) => replies.poll(since, 2000),
      onCursor: () => replies.cursor(),
      onAck: (seq) => acked.push(seq),
      onMode: () => "notes",
      onReplay: (seq) => {
        const text = replies.find(seq);
        if (!text) return false;
        hold.offer({ text, sid: 17, to: "remote", bypass: true });
        return true;
      },
      wav: (id) => {
        fetched.push(id);
        return replies.wav(id);
      },
    });
    await new Promise((r) => server.once("listening", r));
    const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.fill("#key", SECRET);
      await page.click("#keyform button");
      await page.waitForSelector("#disc:not([disabled])");

      // the answer to the press is held back until the poll has already brought the replay
      await page.route("**/remote/replay", async (route) => {
        const r = await route.fetch();
        await new Promise((go) => setTimeout(go, 1500));
        await route.fulfill({ response: r, body: await r.body() });
      });

      replies.text("the kettle is on");
      await page.waitForSelector(".line.eye button.play");
      await page.click(".line.eye button.play");

      await page.waitForFunction(() => playing !== null, null, { timeout: 30_000 });
      assert.equal(await page.evaluate(() => playing.n), 2, "the replay was not claimed by the press it answers");
      for (let i = 0; i < 300 && !acked.includes(2); i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(acked, [1, 2], "the replay he pressed for never played out");
      assert.equal(await page.locator(".line.eye").count(), 1, "the replay put a second line on the page");
      assert.equal(fetched.length, 1, "one press asked for the bytes more than once");
      assert.equal(await page.locator(".line.eye button.play").count(), 0, "the reply was heard out and kept its glyph");
      await page.unrouteAll({ behavior: "wait" }); // the held answer lands before the page goes
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  },
);
