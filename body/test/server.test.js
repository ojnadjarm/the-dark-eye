/** The bridge contract: auth, every route, coercions, clamps, body cap, health. */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { startServer } = require("../src/server");

const SECRET = "s3cret-key";
let server;
let base;
let calls;
let listenNext;
let micOn;
let held = 0;
let tvMode;
let roster;
let modeNow;

before(async () => {
  server = startServer({
    port: 0,
    secret: SECRET,
    onSpeak: (a) => calls.push(["speak", a]),
    onListen: (ms, brain, voice) => {
      calls.push(["listen", ms, brain, voice]);
      return listenNext;
    },
    onBrains: () => roster,
    onActive: (name) => {
      calls.push(["active", name]);
      return name === "notes" ? { active: "notes", brains: roster.brains } : null;
    },
    onMic: (on) => {
      calls.push(["mic", on]);
      micOn = on === undefined ? !micOn : on;
      return micOn;
    },
    onMicOpen: () => micOn,
    onHeld: () => held,
    onMode: (m, channel) => {
      calls.push(channel === undefined ? ["mode", m] : ["mode", m, channel]);
      if (m !== undefined) modeNow = m;
      return modeNow;
    },
    onStatus: (a) => calls.push(["status", a]),
    onOrbiters: () => [{ id: "a", label: "one", until: 42 }],
    onShow: (a) => {
      calls.push(["show", a]);
      return "show-1";
    },
    onTv: (mode) => {
      calls.push(["tv", mode]);
      if (mode) tvMode = mode;
      return { mode: tvMode, on: tvMode !== "off", reason: `override ${tvMode}` };
    },
  });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  calls = [];
  listenNext = "hello";
  micOn = false;
  tvMode = "auto";
  modeNow = "call";
  roster = { active: "main", brains: [{ name: "main", color: "#b04dff", voice: 17, connected: false, parked: 0 }] };
});

const req = (path, opts = {}) =>
  fetch(base + path, {
    ...opts,
    headers: { "x-dark-eye-key": SECRET, "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
const post = (path, body) => req(path, { method: "POST", body: JSON.stringify(body) });

test("refuses to start without a secret", () => {
  assert.throws(() => startServer({ port: 0 }), /secret/);
});

test("no key is 401", async () => {
  const r = await fetch(base + "/bridge/health");
  assert.equal(r.status, 401);
});

test("a wrong key is 401, whatever its length", async () => {
  for (const key of ["nope", SECRET + "x", SECRET.slice(0, -1)]) {
    const r = await req("/bridge/health", { headers: { "x-dark-eye-key": key } });
    assert.equal(r.status, 401);
  }
});

test("an unknown path is 404 and a wrong method is 405", async () => {
  assert.equal((await req("/bridge/nope")).status, 404);
  assert.equal((await req("/mcp")).status, 404);
  const r = await post("/bridge/health", {});
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET");
});

test("speak passes text and voice through", async () => {
  const r = await post("/bridge/speak", { text: "bridge is up", voice: 17 });
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(calls, [["speak", { text: "bridge is up", voice: 17, to: undefined, brain: undefined }]]);
});

test("speak without a voice leaves it undefined", async () => {
  await post("/bridge/speak", { text: "plain" });
  assert.deepEqual(calls[0][1], { text: "plain", voice: undefined, to: undefined, brain: undefined });
});

test("speak passes a brain name through and refuses a bad one", async () => {
  await post("/bridge/speak", { text: "noted", brain: "notes" });
  assert.equal(calls[0][1].brain, "notes");
  calls = [];
  assert.equal((await post("/bridge/speak", { text: "x", brain: "Notes!" })).status, 400);
  assert.deepEqual(calls, []);
});

test("speak passes a valid --to through and drops anything else", async () => {
  for (const to of ["local", "remote", "both"]) {
    calls = [];
    await post("/bridge/speak", { text: "here", to });
    assert.equal(calls[0][1].to, to);
  }
  for (const to of ["phone", "", 3, null]) {
    calls = [];
    await post("/bridge/speak", { text: "here", to });
    assert.equal(calls[0][1].to, undefined, String(to));
  }
});

test("listen returns a transcript for a string", async () => {
  const r = await req("/bridge/listen?timeoutMs=10");
  assert.deepEqual(await r.json(), { transcript: "hello", source: "local" });
});

test("a tagged transcript carries its source", async () => {
  listenNext = { text: "from the phone", source: "remote" };
  assert.deepEqual(await (await req("/bridge/listen?timeoutMs=10")).json(), {
    transcript: "from the phone",
    source: "remote",
  });
});

test("an object item without a source is local, and an unknown source is not believed", async () => {
  for (const item of [{ text: "here" }, { text: "here", source: "mars" }]) {
    listenNext = item;
    assert.deepEqual(await (await req("/bridge/listen?timeoutMs=10")).json(), {
      transcript: "here",
      source: "local",
    });
  }
});

test("listen returns an event object as transcript:null", async () => {
  listenNext = { event: "canvas-approved", detail: "login mockup" };
  const r = await req("/bridge/listen?timeoutMs=10");
  assert.deepEqual(await r.json(), {
    transcript: null,
    event: "canvas-approved",
    detail: "login mockup",
    source: "local",
  });
});

test("an event without a detail still answers", async () => {
  listenNext = { event: "canvas-rejected" };
  assert.deepEqual(await (await req("/bridge/listen?timeoutMs=10")).json(), {
    transcript: null,
    event: "canvas-rejected",
    detail: "",
    source: "local",
  });
});

test("a silent window returns transcript:null", async () => {
  listenNext = null;
  assert.deepEqual(await (await req("/bridge/listen?timeoutMs=10")).json(), { transcript: null, source: "local" });
});

test("listen passes the brain and its voice through, and refuses a bad name", async () => {
  await req("/bridge/listen?timeoutMs=10&brain=notes&voice=12");
  assert.deepEqual(calls[0], ["listen", 10, "notes", 12]);
  calls = [];
  await req("/bridge/listen?timeoutMs=10");
  assert.deepEqual(calls[0], ["listen", 10, undefined, undefined]);
  calls = [];
  assert.equal((await req("/bridge/listen?timeoutMs=10&brain=Notes!")).status, 400);
  assert.deepEqual(calls, []);
});

test("brains lists the roster; active switches or is 400", async () => {
  assert.deepEqual(await (await req("/bridge/brains")).json(), { ok: true, ...roster });
  const r = await post("/bridge/brains/active", { brain: "notes" });
  assert.equal((await r.json()).active, "notes");
  assert.deepEqual(calls, [["active", "notes"]]);
  calls = [];
  for (const brain of ["ghost", "Notes!", "", undefined]) {
    const bad = await post("/bridge/brains/active", { brain });
    assert.equal(bad.status, 400, String(brain));
  }
  assert.deepEqual(calls, [["active", "ghost"]]);
});

test("the listen timeout is clamped and defaulted", async () => {
  for (const [q, want] of [["", 50000], ["?timeoutMs=999999", 55000], ["?timeoutMs=abc", 50000], ["?timeoutMs=-5", 50000], ["?timeoutMs=1200", 1200]]) {
    calls = [];
    await req("/bridge/listen" + q);
    assert.equal(calls[0][1], want, q);
  }
});

test("mic without a body toggles, with one it sets", async () => {
  assert.deepEqual(await (await post("/bridge/mic", {})).json(), { ok: true, on: true });
  assert.deepEqual(await (await post("/bridge/mic", {})).json(), { ok: true, on: false });
  assert.deepEqual(await (await post("/bridge/mic", { on: true })).json(), { ok: true, on: true });
  assert.deepEqual(await (await post("/bridge/mic", { on: true })).json(), { ok: true, on: true });
  assert.deepEqual(await (await post("/bridge/mic", { on: false })).json(), { ok: true, on: false });
  assert.deepEqual(calls.map((c) => c[1]), [undefined, undefined, true, true, false]);
});

test("status coerces the state and fills the id", async () => {
  await post("/bridge/status", { id: "t1", state: "working", label: "e03" });
  await post("/bridge/status", { state: "done" });
  await post("/bridge/status", { id: "t2", state: "hallucinating", label: 7 });
  await post("/bridge/status", { id: "t3", state: "error" });
  assert.deepEqual(calls.map((c) => c[1]), [
    { id: "t1", state: "working", label: "e03" },
    { id: "task", state: "done", label: "" },
    { id: "t2", state: "working", label: "7" },
    { id: "t3", state: "error", label: "" },
  ]);
});

test("show stores and returns an id", async () => {
  const r = await post("/bridge/show", { title: "mock", kind: "image", data: "data:image/png;base64,AA", verdict: true });
  assert.deepEqual(await r.json(), { ok: true, id: "show-1" });
  assert.deepEqual(calls[0][1], { title: "mock", kind: "image", data: "data:image/png;base64,AA", verdict: true });
});

test("show defaults kind to html and verdict to false", async () => {
  await post("/bridge/show", { data: "<p>hi</p>", kind: "pdf" });
  assert.deepEqual(calls[0][1], { title: "", kind: "html", data: "<p>hi</p>", verdict: false });
});

test("show without data is 400", async () => {
  const r = await post("/bridge/show", { title: "empty" });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test("a malformed body is 500, not a crash", async () => {
  const r = await req("/bridge/speak", { method: "POST", body: "{not json" });
  assert.equal(r.status, 500);
});

test("a body over the cap is answered 413, not dropped", async () => {
  const status = await new Promise((resolve, reject) => {
    const r = http.request(base + "/bridge/speak", {
      method: "POST",
      headers: { "x-dark-eye-key": SECRET, "Content-Type": "application/json" },
    });
    r.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on("error", (e) => (["ECONNRESET", "EPIPE"].includes(e.code) ? null : reject(e)));
    r.end('{"text":"' + "x".repeat(34_000_000) + '"}');
  });
  assert.equal(status, 413);
  assert.equal(calls.length, 0);
});

test("a declared length over the cap is answered 413 before a byte is read", { timeout: 10_000 }, async () => {
  const status = await new Promise((resolve, reject) => {
    const r = http.request(base + "/bridge/speak", {
      method: "POST",
      headers: { "x-dark-eye-key": SECRET, "Content-Type": "application/json", "Content-Length": 34_000_000 },
    });
    r.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on("error", (e) => (["ECONNRESET", "EPIPE"].includes(e.code) ? null : reject(e)));
    r.write(Buffer.alloc(16)); // the rest of the body is never sent — the cap is already known
  });
  assert.equal(status, 413);
  assert.equal(calls.length, 0);
});

test("tv reads the override, and posting a mode sets it", async () => {
  const got = await (await req("/bridge/tv")).json();
  assert.deepEqual(got, { ok: true, mode: "auto", on: true, reason: "override auto" });
  assert.deepEqual(calls, [["tv", undefined]]);

  const set = await post("/bridge/tv", { mode: "off" });
  assert.deepEqual(await set.json(), { ok: true, mode: "off", on: false, reason: "override off" });
  assert.deepEqual(calls[1], ["tv", "off"]);
});

test("tv refuses a mode it does not know, and never calls the body", async () => {
  for (const mode of ["sideways", "", undefined, 1]) {
    const r = await post("/bridge/tv", { mode });
    assert.equal(r.status, 400, String(mode));
    assert.match((await r.json()).error, /auto, on or off/);
  }
  assert.deepEqual(calls, []);
});

test("health carries the tv override", async () => {
  tvMode = "off";
  assert.equal((await (await req("/bridge/health")).json()).tv, "off");
});

test("health reports the mic, the active brain and whether it is listening", async () => {
  assert.deepEqual(await (await req("/bridge/health")).json(), {
    ok: true,
    active: "main",
    brainListening: false,
    micOpen: false,
    held: 0,
    mode: "call",
    quiet: false,
    tv: "auto",
  });
  await post("/bridge/mic", { on: true });
  roster.brains[0].connected = true;
  const h = await (await req("/bridge/health")).json();
  assert.equal(h.micOpen, true);
  assert.equal(h.brainListening, true);
  roster.active = "notes"; // connected, but not the one he is talking to
  assert.equal((await (await req("/bridge/health")).json()).brainListening, false);
});

test("health carries how many utterances the mouth is holding", async () => {
  held = 3;
  assert.equal((await (await req("/bridge/health")).json()).held, 3);
  held = 0;
});

test("mode reads it, posting sets it, health carries it — his word out, the body's word in", async () => {
  assert.deepEqual(await (await req("/bridge/mode")).json(), { ok: true, mode: "call" });
  assert.deepEqual(calls, [["mode", undefined]]);
  assert.deepEqual(await (await post("/bridge/mode", { mode: "notes" })).json(), { ok: true, mode: "notes" });
  assert.deepEqual(calls[1], ["mode", "async"], "the wire's `notes` reaches the body as `async`");
  assert.equal((await (await req("/bridge/health")).json()).mode, "notes");
  assert.deepEqual(await (await post("/bridge/mode", { mode: "call" })).json(), { ok: true, mode: "call" });
  assert.equal((await (await req("/bridge/health")).json()).mode, "call");
});

test("a mode may name one channel; a name nobody has is refused and never reaches the body", async () => {
  roster.brains.push({ name: "notes", color: "#4dd9ff", voice: 12, connected: false, parked: 0, mode: "notes" });
  assert.deepEqual(await (await post("/bridge/mode", { mode: "notes", channel: "notes" })).json(), { ok: true, mode: "notes" });
  assert.deepEqual(calls.at(-1), ["mode", "async", "notes"], "his word in, the channel with it");
  const r = await post("/bridge/mode", { mode: "notes", channel: "nope" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /unknown brain/);
  assert.deepEqual(calls.at(-1), ["mode", "async", "notes"], "the body was never asked about a channel it has not got");
  await post("/bridge/mode", { mode: "call" });
  assert.deepEqual(calls.at(-1), ["mode", "call"], "no channel at all is the active one");
});

test("the roster carries each channel's own mode, health the active channel's", async () => {
  roster.brains[0].mode = "call";
  roster.brains.push({ name: "notes", color: "#4dd9ff", voice: 12, connected: false, parked: 0, mode: "notes" });
  const rows = (await (await req("/bridge/brains")).json()).brains;
  assert.deepEqual(rows.map((r) => [r.name, r.mode]), [["main", "call"], ["notes", "notes"]]);
  assert.equal((await (await req("/bridge/health")).json()).mode, "call", "health is the mode of the exchange he is in");
});

test("mode refuses anything but call or notes, and never calls the body", async () => {
  for (const mode of ["quiet", "async", "constructor", "", 1, undefined, null]) {
    const r = await post("/bridge/mode", { mode });
    assert.equal(r.status, 400, String(mode));
    assert.match((await r.json()).error, /call or notes/);
  }
  assert.deepEqual(calls, []);
});

test("quiet is the old name of audio notes mode: the alias maps both ways, health keeps both", async () => {
  assert.deepEqual(await (await req("/bridge/quiet")).json(), { ok: true, on: false });
  assert.deepEqual(await (await post("/bridge/quiet", { on: true })).json(), { ok: true, on: true });
  assert.deepEqual(calls.at(-1), ["mode", "async"]);
  const h = await (await req("/bridge/health")).json();
  assert.equal(h.quiet, true);
  assert.equal(h.mode, "notes");
  assert.deepEqual(await (await post("/bridge/quiet", { on: false })).json(), { ok: true, on: false });
  assert.deepEqual(calls.at(-1), ["mode", "call"]);
  assert.equal((await (await req("/bridge/health")).json()).quiet, false);
});

test("quiet still refuses anything but a boolean, and never calls the body", async () => {
  for (const on of ["on", 1, undefined, null]) {
    const r = await post("/bridge/quiet", { on });
    assert.equal(r.status, 400, String(on));
    assert.match((await r.json()).error, /true or false/);
  }
  assert.deepEqual(calls, []);
});

test("GET status lists the orbiters the body is holding", async () => {
  const r = await req("/bridge/status");
  assert.deepEqual(await r.json(), { ok: true, orbiters: [{ id: "a", label: "one", until: 42 }] });
});
