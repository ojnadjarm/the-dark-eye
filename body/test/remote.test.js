/** The remote contract: the page, cookie login, the rate limit, PCM in, replies out. */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { startRemote, AUDIO_MAX } = require("../src/remote");
const { IDLE_MS } = require("../src/remote-ear");
const OVER = AUDIO_MAX + 1;

const SECRET = "s3cret-key";
const servers = [];
/** Never the owner's own session file: every server gets its own under a temp dir. */
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "de-sessions-"));
let sessionsNo = 0;
const tempSessions = () => path.join(stateDir, `s${++sessionsNo}.json`);
let calls;
let audioNext;
let pollNext;
let cursorNext;
let wavNext;
let streamNext;
let finalNext;
let rosterNext;
let replayNext;
let modeNext;

/** A server of its own — the login rate limit is per address, so tests must not share one. */
async function start(opts = {}) {
  const s = startRemote({
    port: 0,
    secret: SECRET,
    onAudio: (samples, rate) => {
      calls.push(["audio", samples, rate]);
      return audioNext;
    },
    onStream: (utt, seq, samples) => {
      calls.push(["stream", utt, seq, samples]);
      return streamNext;
    },
    onFinal: (utt, tail) => {
      calls.push(["final", utt, tail]);
      return finalNext;
    },
    onPoll: (since) => {
      calls.push(["poll", since]);
      return pollNext;
    },
    onAck: (seq) => {
      calls.push(["ack", seq]);
    },
    onReplay: (seq) => {
      calls.push(["replay", seq]);
      return replayNext;
    },
    onCursor: () => {
      calls.push(["cursor"]);
      return cursorNext;
    },
    wav: (id) => {
      calls.push(["wav", id]);
      return wavNext;
    },
    onBrains: () => {
      calls.push(["brains"]);
      return rosterNext;
    },
    onActive: (brain) => {
      calls.push(["active", brain]);
      return brain === "notes" ? rosterNext : null;
    },
    onMode: (m) => {
      calls.push(["mode", m]);
      return m ?? modeNext;
    },
    sessionsFile: tempSessions(),
    ...opts,
  });
  servers.push(s);
  await new Promise((r) => s.once("listening", r));
  return `http://127.0.0.1:${s.address().port}`;
}

/** Stops the server that `start` most recently opened — a restart, as systemd would do it. */
const stop = () => {
  const s = servers[servers.length - 1];
  s.closeAllConnections();
  return new Promise((r) => s.close(r));
};

const login = (base, key = SECRET) =>
  fetch(base + "/remote/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });

/** The `de=` value out of a Set-Cookie, or null. */
const cookieOf = (res) => (res.headers.getSetCookie()[0] ?? "").match(/^de=([^;]+)/)?.[1] ?? null;

let base;
let cookie;

before(async () => {
  calls = [];
  base = await start();
  cookie = cookieOf(await login(base));
});

after(() => {
  servers.forEach((s) => s.close());
  fs.rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  audioNext = "heard you";
  streamNext = true;
  finalNext = "the whole thing";
  pollNext = null;
  cursorNext = 0;
  wavNext = null;
  replayNext = true;
  rosterNext = { active: "notes", brains: [{ name: "main", color: "#b04dff" }, { name: "notes", color: "#4dd9ff" }] };
});

/** A replay on a server of its own — the login rate limit is per address, so tests must not share one. */
const replayOn = (b, c, seq) =>
  fetch(b + "/remote/replay", {
    method: "POST",
    headers: { cookie: `de=${c}`, "Content-Type": "application/json" },
    body: JSON.stringify({ seq }),
  });

/** A fresh listener and a cookie for it. */
const ownServer = async () => {
  const own = await start();
  return [own, cookieOf(await login(own))];
};

const authed = (path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie: `de=${cookie}`, ...(opts.headers ?? {}) } });

test("refuses to start without a secret", () => {
  assert.throws(() => startRemote({ port: 0 }), /secret/);
});

// -- the page ---------------------------------------------------------------

test("the page is served without a cookie — it is where the key is pasted", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.match(await r.text(), /Dark Eye/);
});

test("the worklet is served without a cookie — the page cannot open the mic without it", async () => {
  const r = await fetch(base + "/worklet.js");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /javascript/);
  assert.match(await r.text(), /registerProcessor/);
});

/** Every word and picture he sees or hears read aloud: labels, titles and the status line. */
const pageWords = (src) => [
  ...src.matchAll(/(?:aria-label|title|placeholder)="([^"]*)"/g),
  ...src.matchAll(/(?:aria-label|title)",\s*\n?\s*"([^"]*)"/g),
  ...src.matchAll(/\b(?:state|warn)\(\s*(?:"[a-z]+",\s*)?"([^"]*)"/g),
  ...src.matchAll(/>([^<>{}]*?)</g),
].map((m) => m[1]);

test("nothing on the page claims to block anything: no mute, as a word or as a picture", async () => {
  const page = await (await fetch(base + "/")).text();
  for (const w of pageWords(page))
    assert.doesNotMatch(w, /\b(mute|muted|muting|silenced|suppressed)\b/i, `he is shown "${w.trim()}"`);
  // the control he rejected by name, and every key it was remembered under
  for (const gone of ['id="auto"', "autoPlay", "autoDefault", "readAuto", "drawAuto", "autoplay:", 'class="mute"', 'class="wave"', "#glyphs"])
    assert.ok(!page.includes(gone), `the auto-play toggle is back: ${gone}`);
  assert.ok(!/localStorage/.test(page), "a per-device setting is back: the mode is the only one");
  // the two words he uses are the two words on it
  assert.match(page, /MODE_WORD = \{ call: "call", notes: "audio notes" \}/);
  assert.ok(!/"async"/.test(page), "the body's own word for the mode reached the page");
});

test("the page never ends a turn behind his back: no stop on hide, no timer to flush", async () => {
  const page = await (await fetch(base + "/")).text();
  assert.ok(!/document\.hidden\)\s*\{\s*stop\(\)/.test(page), "a hidden tab must not stop the turn");
  assert.ok(!/setInterval\(flush/.test(page), "the flush is counted off the worklet, never clamped");
  assert.match(page, /blocks\.length >= FLUSH_BLOCKS/);
  assert.match(page, /while \(!document\.hidden \|\| recording \|\| thinking \|\| pip\)/);
  assert.match(page, /addEventListener\("mute"/);
  assert.match(page, /listening \\u00b7 \$\{TITLE\}/);
});

/** The page's own top-level constants, arithmetic and all, read out of the served source. */
const pageConsts = (src, names) =>
  vm.runInNewContext(
    names.map((n) => new RegExp(`^const ${n} = [^;]+;`, "m").exec(src)[0]).join("\n") +
      `\n({ ${names.join(", ")} })`,
  );

test("a mute ends the turn before the body lets the buffer go, never at the same second", async () => {
  const page = await (await fetch(base + "/")).text();
  const { EAR_IDLE_MS, MUTE_GRACE_MS, MUTE_MAX_MS } = pageConsts(page, ["EAR_IDLE_MS", "MUTE_GRACE_MS", "MUTE_MAX_MS"]);
  assert.equal(EAR_IDLE_MS, IDLE_MS, "the page's mirror of the ear's idle window has drifted");
  assert.ok(MUTE_GRACE_MS >= 15_000, `the grace is only ${MUTE_GRACE_MS} ms — a slow tail would still lose the turn`);
  assert.ok(
    MUTE_MAX_MS <= IDLE_MS - MUTE_GRACE_MS,
    `the page waits ${MUTE_MAX_MS} ms on a mute but the body drops the stream at ${IDLE_MS} ms: everything said before the mute is lost`,
  );
});

test("the page and the worklet are never cached stale: no-cache, an ETag, and a cheap 304", async () => {
  for (const p of ["/", "/worklet.js"]) {
    const r = await fetch(base + p);
    assert.equal(r.headers.get("cache-control"), "no-cache");
    assert.match(r.headers.get("etag"), /^"[0-9a-z]+"$/);
    assert.ok(!Number.isNaN(Date.parse(r.headers.get("last-modified"))));
    const again = await fetch(base + p, { headers: { "if-none-match": r.headers.get("etag") } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), "");
  }
});

test("an unknown path is 404 and a wrong method is 405", async () => {
  assert.equal((await authed("/remote/nope")).status, 404);
  assert.equal((await authed("/bridge/health")).status, 404);
  assert.equal((await authed("/manifest.json")).status, 404); // there is no PWA, by his call
  const r = await authed("/remote/poll", { method: "POST" });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET");
});

// -- login ------------------------------------------------------------------

test("the right key gives a 30-day HttpOnly Secure SameSite=Strict cookie", async () => {
  const b = await start();
  const r = await login(b);
  assert.equal(r.status, 200);
  const set = r.headers.getSetCookie()[0];
  assert.match(set, /^de=[A-Za-z0-9_-]{43}/); // 32 random bytes, base64url
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) {
    assert.ok(set.includes(attr), `${attr} in ${set}`);
  }
});

test("a wrong key is 401 with no cookie and no body, whatever its length", async () => {
  const b = await start();
  for (const key of ["nope", SECRET + "x", SECRET.slice(0, -1), ""]) {
    const r = await login(b, key);
    assert.equal(r.status, 401, key);
    assert.equal(r.headers.getSetCookie().length, 0);
    assert.equal(await r.text(), "");
  }
});

test("a malformed login body is 401, not a 500", async () => {
  const b = await start();
  const r = await fetch(b + "/remote/login", { method: "POST", body: "{not json" });
  assert.equal(r.status, 401);
});

test("two logins give two different tokens and both work", async () => {
  const b = await start();
  const [a1, a2] = [cookieOf(await login(b)), cookieOf(await login(b))];
  assert.notEqual(a1, a2);
  for (const c of [a1, a2]) {
    assert.equal((await fetch(b + "/remote/poll", { headers: { cookie: `de=${c}` } })).status, 200);
  }
});

test("the rate limit trips after 5 attempts and answers an indistinguishable 401", async () => {
  const b = await start();
  for (let i = 0; i < 5; i++) assert.equal((await login(b, "wrong")).status, 401, `attempt ${i}`);
  const r = await login(b); // the right key, but the window is spent
  assert.equal(r.status, 401);
  assert.equal(r.headers.getSetCookie().length, 0);
  assert.equal(await r.text(), "");
});

test("the rate limit counts per remote address, and a good key inside the window works", async () => {
  const b = await start();
  for (let i = 0; i < 4; i++) await login(b, "wrong");
  assert.equal((await login(b)).status, 200);
});

// -- sessions that outlive the body ------------------------------------------

test("a session survives a restart of the body — the cookie is still good", async () => {
  const file = tempSessions();
  const b1 = await start({ sessionsFile: file });
  const c = cookieOf(await login(b1));
  await stop();
  const b2 = await start({ sessionsFile: file });
  assert.equal((await fetch(b2 + "/remote/poll", { headers: { cookie: `de=${c}` } })).status, 200);
});

test("two browsers keep their own session across a restart", async () => {
  const file = tempSessions();
  const b1 = await start({ sessionsFile: file });
  const [phone, pc] = [cookieOf(await login(b1)), cookieOf(await login(b1))];
  await stop();
  const b2 = await start({ sessionsFile: file });
  for (const c of [phone, pc]) {
    assert.equal((await fetch(b2 + "/remote/poll", { headers: { cookie: `de=${c}` } })).status, 200);
  }
});

test("an expired entry is dropped at load and its cookie is 401", async () => {
  const file = tempSessions();
  const b1 = await start({ sessionsFile: file });
  const c = cookieOf(await login(b1));
  await stop();
  const [digest] = Object.keys(JSON.parse(fs.readFileSync(file, "utf8")));
  fs.writeFileSync(file, JSON.stringify({ [digest]: Date.now() - 1000 }));
  const b2 = await start({ sessionsFile: file });
  assert.equal((await fetch(b2 + "/remote/poll", { headers: { cookie: `de=${c}` } })).status, 401);
  // the next login rewrites the file without it
  cookieOf(await login(b2));
  assert.ok(!(digest in JSON.parse(fs.readFileSync(file, "utf8"))));
});

test("the file is 0600 in a 0700 dir and holds no plaintext token", async () => {
  const file = path.join(stateDir, "nested", "remote-sessions.json");
  const b = await start({ sessionsFile: file });
  const c = cookieOf(await login(b));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(c), "the token itself must never be on disk");
  assert.ok(!raw.includes(SECRET));
  const [digest, exp] = Object.entries(JSON.parse(raw))[0];
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.ok(exp > Date.now() + 29 * 86_400_000); // the cookie's own 30 days
});

test("an unreadable sessions file is no sessions, not a crash", async () => {
  const file = path.join(stateDir, "garbage.json");
  fs.writeFileSync(file, "{not json");
  const b = await start({ sessionsFile: file });
  assert.equal((await fetch(b + "/remote/poll", { headers: { cookie: "de=whatever" } })).status, 401);
  assert.equal((await login(b)).status, 200);
});

// -- the cookie gate --------------------------------------------------------

test("every route but the page and login is 401 without a cookie, with no body", async () => {
  for (const [path, opts] of [
    ["/remote/poll", {}],
    ["/remote/audio", { method: "POST", body: new Uint8Array(4) }],
    ["/remote/stream?utt=u1&seq=0", { method: "POST", body: new Uint8Array(4) }],
    ["/remote/audio/abc.wav", {}],
  ]) {
    const r = await fetch(base + path, opts);
    assert.equal(r.status, 401, path);
    assert.equal(await r.text(), "", path);
  }
  assert.deepEqual(calls, []);
});

test("a bogus or empty cookie is 401", async () => {
  for (const c of ["de=nope", "de=", "other=x", `de=${cookie}x`]) {
    assert.equal((await fetch(base + "/remote/poll", { headers: { cookie: c } })).status, 401, c);
  }
});

// -- audio ------------------------------------------------------------------

test("Int16 PCM reaches onAudio as 16 kHz Float32 in [-1,1)", async () => {
  const pcm = new Int16Array([0, 32767, -32768, 16384, -16384]);
  const r = await authed("/remote/audio", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(pcm.buffer),
  });
  assert.deepEqual(await r.json(), { transcript: "heard you" });
  const [kind, samples, rate] = calls[0];
  assert.equal(kind, "audio");
  assert.equal(rate, 16000);
  assert.ok(samples instanceof Float32Array);
  assert.equal(samples.length, 5);
  assert.deepEqual([...samples], [0, 32767 / 32768, -1, 0.5, -0.5]);
});

test("an odd trailing byte is dropped rather than read past the end", async () => {
  await authed("/remote/audio", { method: "POST", body: Buffer.from([0, 0, 0, 0, 7]) });
  assert.equal(calls[0][1].length, 2);
});

test("an empty clip answers a null transcript without calling the ear", async () => {
  const r = await authed("/remote/audio", { method: "POST", body: Buffer.alloc(0) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { transcript: null });
  assert.deepEqual(calls, []);
});

test("a transcript the ear did not produce answers null, not undefined", async () => {
  audioNext = undefined;
  const r = await authed("/remote/audio", { method: "POST", body: Buffer.from([1, 0]) });
  assert.deepEqual(await r.json(), { transcript: null });
});

test("a declared length over the turn cap is answered 413 before a byte is read", { timeout: 10_000 }, async () => {
  const status = await new Promise((resolve, reject) => {
    const r = http.request(base + "/remote/audio", {
      method: "POST",
      headers: { cookie: `de=${cookie}`, "Content-Type": "application/octet-stream", "Content-Length": OVER },
    });
    r.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on("error", (e) => (["ECONNRESET", "EPIPE"].includes(e.code) ? null : reject(e)));
    r.write(Buffer.alloc(16)); // the rest of the clip is never sent — the cap is already known
  });
  assert.equal(status, 413);
  assert.deepEqual(calls, []);
});

test("a chunked upload over the cap never reaches the ear", { timeout: 10_000 }, async () => {
  await new Promise((resolve, reject) => {
    const r = http.request(base + "/remote/audio", {
      method: "POST",
      headers: { cookie: `de=${cookie}`, "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked" },
    });
    r.on("response", (res) => (res.resume(), res.on("end", resolve)));
    // the socket dies under us once the cap trips; that is the point of the cap
    r.on("error", (e) => (["ECONNRESET", "EPIPE"].includes(e.code) ? resolve() : reject(e)));
    r.end(Buffer.alloc(OVER));
  });
  assert.deepEqual(calls, []);
});

// -- the stream while he talks ----------------------------------------------

test("a streamed block reaches the ear as its utterance, its number and Float32", async () => {
  const pcm = new Int16Array([0, 32767, -32768]);
  const r = await authed("/remote/stream?utt=abc_1-2&seq=3", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(pcm.buffer),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const [kind, utt, seq, samples] = calls[0];
  assert.equal(kind, "stream");
  assert.equal(utt, "abc_1-2");
  assert.equal(seq, 3);
  assert.deepEqual([...samples], [0, 32767 / 32768, -1]);
});

test("blocks keep their order: the body is told the number, never the arrival", async () => {
  for (const n of [2, 0, 1]) await authed(`/remote/stream?utt=u1&seq=${n}`, { method: "POST", body: Buffer.from([n, 0]) });
  assert.deepEqual(calls.map((c) => c[2]), [2, 0, 1]);
});

test("a stream with no usable utt or seq is 400, and the ear is never called", async () => {
  for (const q of ["", "?seq=0", "?utt=u1", "?utt=u1&seq=x", "?utt=u1&seq=-1", "?utt=u1&seq=1.5", "?utt=u1&seq=", "?utt=a/b&seq=0", "?utt=&seq=0"]) {
    const r = await authed("/remote/stream" + q, { method: "POST", body: Buffer.from([0, 0]) });
    assert.equal(r.status, 400, q);
  }
  assert.deepEqual(calls, []);
});

test("an utterance past its cap is 413 — the ear said no more", async () => {
  streamNext = false;
  const r = await authed("/remote/stream?utt=u1&seq=0", { method: "POST", body: Buffer.from([0, 0]) });
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: "utterance too long" });
});

test("a single block over the turn cap is 413 before the ear sees a byte", async () => {
  const status = await new Promise((resolve, reject) => {
    const r = http.request(base + "/remote/stream?utt=u1&seq=0", {
      method: "POST",
      headers: { cookie: `de=${cookie}`, "Content-Length": OVER },
    });
    r.on("response", (res) => (res.resume(), resolve(res.statusCode)));
    r.on("error", (e) => (["ECONNRESET", "EPIPE"].includes(e.code) ? null : reject(e)));
    r.write(Buffer.alloc(16));
  });
  assert.equal(status, 413);
  assert.deepEqual(calls, []);
});

test("a wrong method on the stream is 405", async () => {
  const r = await authed("/remote/stream?utt=u1&seq=0");
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "POST");
});

// -- the final tap ----------------------------------------------------------

test("an empty body with an utt means 'finalize what you have'", async () => {
  const r = await authed("/remote/audio?utt=u1", { method: "POST", body: Buffer.alloc(0) });
  assert.deepEqual(await r.json(), { transcript: "the whole thing" });
  const [kind, utt, tail] = calls[0];
  assert.equal(kind, "final");
  assert.equal(utt, "u1");
  assert.equal(tail.length, 0);
});

test("a tail on the final tap goes to the same utterance, not to a clip of its own", async () => {
  const r = await authed("/remote/audio?utt=u1", { method: "POST", body: Buffer.from(new Int16Array([16384]).buffer) });
  assert.deepEqual(await r.json(), { transcript: "the whole thing" });
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0][2]], [0.5]);
});

test("a final that heard nothing answers null, and the empty probe still has no utt", async () => {
  finalNext = null;
  assert.deepEqual(await (await authed("/remote/audio?utt=u1", { method: "POST", body: Buffer.alloc(0) })).json(), {
    transcript: null,
  });
  calls = [];
  // the page's own "am I still logged in?" — no utt, no body, nothing decoded
  const r = await authed("/remote/audio", { method: "POST", body: Buffer.alloc(0) });
  assert.equal(r.status, 200);
  assert.deepEqual(calls, []);
});

// -- poll -------------------------------------------------------------------

test("poll passes since through and answers null when nothing is waiting", async () => {
  const r = await authed("/remote/poll?since=7");
  assert.equal(r.status, 200);
  assert.equal(await r.json(), null);
  assert.deepEqual(calls, [["poll", 7]]);
});

test("an unusable since is 0", async () => {
  for (const q of ["?since=", "?since=abc", "?since=-3"]) {
    calls = [];
    await authed("/remote/poll" + q);
    assert.deepEqual(calls, [["poll", 0]], q);
  }
});

test("no since at all starts from the head, so a reloaded page skips the ring", async () => {
  cursorNext = 9;
  await authed("/remote/poll");
  assert.deepEqual(calls, [["cursor"], ["poll", 9]]);
});

test("poll answers the reply it is given", async () => {
  pollNext = { seq: 4, text: "I hear you", audio: "/remote/audio/a1.wav" };
  assert.deepEqual(await (await authed("/remote/poll?since=3")).json(), pollNext);
});

// -- the caption: the channel and the mode ----------------------------------

test("the roster is served to a page that has the cookie", async () => {
  const r = await authed("/remote/brains");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), rosterNext);
  assert.deepEqual(calls, [["brains"]]);
});

test("a tap on a chip forwards the name and answers the roster", async () => {
  const r = await authed("/remote/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brain: "notes" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), rosterNext);
  assert.deepEqual(calls, [["active", "notes"]]);
});

test("a name nobody has, or no name at all, is 400", async () => {
  for (const body of [JSON.stringify({ brain: "ghost" }), JSON.stringify({ brain: 7 }), "{", ""]) {
    calls = [];
    const r = await authed("/remote/active", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(r.status, 400, body);
    assert.deepEqual((await r.json()).error, "unknown brain");
  }
});

test("the roster and the switch need the cookie", async () => {
  assert.equal((await fetch(base + "/remote/brains")).status, 401);
  const r = await fetch(base + "/remote/active", { method: "POST", body: JSON.stringify({ brain: "notes" }) });
  assert.equal(r.status, 401);
  assert.deepEqual(calls, []);
});

const postMode = (mode) =>
  authed("/remote/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });

test("the mode is served in his own word, whatever the body calls it", async () => {
  modeNext = "notes";
  const r = await authed("/remote/mode");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { mode: "notes" });
  assert.deepEqual(calls, [["mode", undefined]]);
});

test("a tap on the mode word forwards it once and answers the mode the body settled on", async () => {
  for (const mode of ["notes", "call"]) {
    calls = [];
    const r = await postMode(mode);
    assert.equal(r.status, 200, mode);
    assert.deepEqual(await r.json(), { mode });
    assert.deepEqual(calls, [["mode", mode]], "one tap, one setMode");
  }
});

test("only his two words are a mode here — the body's `async` never comes back through the page", async () => {
  for (const body of [JSON.stringify({ mode: "async" }), JSON.stringify({ mode: "quiet" }), JSON.stringify({ mode: 7 }), "{", ""]) {
    calls = [];
    const r = await authed("/remote/mode", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(r.status, 400, body);
    assert.equal((await r.json()).error, "unknown mode");
    assert.deepEqual(calls, [], "a mode the page may not send still reached the body");
  }
});

test("the mode needs the cookie, both ways", async () => {
  assert.equal((await fetch(base + "/remote/mode")).status, 401);
  const r = await fetch(base + "/remote/mode", { method: "POST", body: JSON.stringify({ mode: "notes" }) });
  assert.equal(r.status, 401);
  assert.deepEqual(calls, []);
});

/** A listener of its own whose `onMode` records the channel too, which the shared one cannot. */
const modeServer = async () => {
  const moved = [];
  const own = await start({
    onMode: (m, channel) => {
      moved.push([m, channel]);
      return m;
    },
  });
  return [own, cookieOf(await login(own)), moved];
};

const postModeOn = (b, c, body) =>
  fetch(b + "/remote/mode", {
    method: "POST",
    headers: { cookie: `de=${c}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("a tap on the mode icon carries the channel it moves, and the answer names it", async () => {
  const [own, c, moved] = await modeServer();
  const r = await postModeOn(own, c, { mode: "notes", channel: "main" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { mode: "notes", channel: "main" });
  assert.deepEqual(moved, [["notes", "main"]], "the channel never reached the body");
});

test("a channel nobody has cannot move a mode — the roster is the only list", async () => {
  const [own, c, moved] = await modeServer();
  for (const channel of ["ghost", "", 7, null]) {
    const r = await postModeOn(own, c, { mode: "notes", channel });
    assert.equal(r.status, 400, JSON.stringify(channel));
    assert.equal((await r.json()).error, "unknown brain");
  }
  assert.deepEqual(moved, [], "a channel the body does not list still moved a mode");
});

test("no channel at all is still the active one: the roster is not even read", async () => {
  modeNext = "call";
  const r = await postMode("notes");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { mode: "notes" }, "an answer with no channel must name no row");
  assert.deepEqual(calls, [["mode", "notes"]]);
});

test("the page keeps no roster size in it: the two-channel shortcut is gone", async () => {
  const page = await (await fetch(base + "/")).text();
  assert.doesNotMatch(page, /chans\.length === 2/, "the two-channel shortcut is still in the page");
  assert.match(page, /id="halo"/, "the halo is not in the page");
  assert.match(page, /id="all"/, "the full index is not in the page");
});

// -- the ack ----------------------------------------------------------------

test("ack takes the seq from the body or the query and answers 204", async () => {
  const r = await authed("/remote/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seq: 5 }),
  });
  assert.equal(r.status, 204);
  calls = [];
  assert.equal((await authed("/remote/ack?seq=6", { method: "POST" })).status, 204);
  assert.deepEqual(calls, [["ack", 6]]);
});

test("ack without a usable seq is 400 and reaches nothing", async () => {
  for (const body of ["{}", '{"seq":"x"}', "not json"]) {
    calls = [];
    const r = await authed("/remote/ack", { method: "POST", body });
    assert.equal(r.status, 400, body);
    assert.deepEqual(calls, [], body);
  }
});

test("ack needs the cookie", async () => {
  assert.equal((await fetch(base + "/remote/ack", { method: "POST" })).status, 401);
});

// -- the replay -------------------------------------------------------------

test("a replay forwards the seq and answers ok — the reply itself comes back on the poll", async () => {
  const r = await replayOn(...(await ownServer()), 4);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(calls, [["replay", 4]]);
});

test("a seq the body no longer holds is 400, and nothing is said again", async () => {
  replayNext = false;
  const r = await replayOn(...(await ownServer()), 900);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "unknown seq");
});

test("a seq that is not one is 400 and reaches nothing", async () => {
  for (const body of ["{}", '{"seq":"x"}', '{"seq":-1}', '{"seq":1.5}', "not json"]) {
    calls = [];
    const r = await authed("/remote/replay", { method: "POST", body });
    assert.equal(r.status, 400, body);
    assert.deepEqual(calls, [], body);
  }
});

test("a held button is not twenty utterances: a second replay inside the second is 429", async () => {
  const [own, c] = await ownServer();
  const again = () => replayOn(own, c, 3);
  assert.equal((await again()).status, 200);
  calls = [];
  const r = await again();
  assert.equal(r.status, 429);
  assert.deepEqual(calls, [], "the body was never asked twice");
});

test("a refused replay never starts the gap — not for him, not for the other device", async () => {
  const [own, phone] = await ownServer();
  const pc = cookieOf(await login(own));
  replayNext = false;
  assert.equal((await replayOn(own, phone, 900)).status, 400);
  replayNext = true;
  assert.equal((await replayOn(own, pc, 3)).status, 200, "one device's bad press gagged the other");
  assert.equal((await replayOn(own, phone, 3)).status, 200, "a press that got nothing started the gap");
});

test("the gap is the device's own: a good press on one does not gag the other", async () => {
  const [own, phone] = await ownServer();
  const pc = cookieOf(await login(own));
  assert.equal((await replayOn(own, phone, 3)).status, 200);
  assert.equal((await replayOn(own, phone, 3)).status, 429);
  assert.equal((await replayOn(own, pc, 3)).status, 200, "the other device was made to wait");
});

test("a replay needs the cookie", async () => {
  assert.equal((await fetch(base + "/remote/replay", { method: "POST" })).status, 401);
  assert.deepEqual(calls, []);
});

// -- the cursor -------------------------------------------------------------

test("the cursor is the newest seq, and 0 when there is nothing", async () => {
  cursorNext = 12;
  const first = await (await authed("/remote/cursor")).json();
  assert.equal(first.seq, 12);
  cursorNext = 0;
  const second = await (await authed("/remote/cursor")).json();
  assert.equal(second.seq, 0);
  // the body's life, so a page still holding the last one's seqs knows they are gone
  assert.match(first.boot, /^[A-Za-z0-9_-]{8}$/);
  assert.equal(second.boot, first.boot, "the boot id changed without a restart");
});

test("the cursor needs the cookie", async () => {
  assert.equal((await fetch(base + "/remote/cursor")).status, 401);
});

// -- the reply audio --------------------------------------------------------

test("a known id is served as a wav", async () => {
  wavNext = Buffer.from("RIFF....WAVEfmt ");
  const r = await authed("/remote/audio/a1.wav");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/wav");
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), "RIFF....WAVEfmt ");
  assert.deepEqual(calls, [["wav", "a1"]]);
});

test("an unknown or expired id is 404", async () => {
  assert.equal((await authed("/remote/audio/gone.wav")).status, 404);
});

test("the wav id cannot walk out of its namespace", async () => {
  for (const p of ["/remote/audio/../../etc/passwd.wav", "/remote/audio/a%2Fb.wav", "/remote/audio/.wav"]) {
    assert.equal((await authed(p)).status, 404, p);
    assert.deepEqual(calls, [], p);
  }
});

test("a handler that throws is a 500, not a crash", async () => {
  const b = await start({ onPoll: () => { throw new Error("boom"); } });
  const c = cookieOf(await login(b));
  const r = await fetch(b + "/remote/poll", { headers: { cookie: `de=${c}` } });
  assert.equal(r.status, 500);
});
