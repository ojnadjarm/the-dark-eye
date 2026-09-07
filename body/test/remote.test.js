/** The remote contract: the page, cookie login, the rate limit, PCM in, replies out. */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startRemote } = require("../src/remote");

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
    onCursor: () => {
      calls.push(["cursor"]);
      return cursorNext;
    },
    wav: (id) => {
      calls.push(["wav", id]);
      return wavNext;
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
});

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

test("a declared length over the 3MB cap is answered 413 before a byte is read", { timeout: 10_000 }, async () => {
  const status = await new Promise((resolve, reject) => {
    const r = http.request(base + "/remote/audio", {
      method: "POST",
      headers: { cookie: `de=${cookie}`, "Content-Type": "application/octet-stream", "Content-Length": 3_200_000 },
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
    r.end(Buffer.alloc(3_200_000));
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

test("a single block over the 3MB cap is 413 before the ear sees a byte", async () => {
  const status = await new Promise((resolve, reject) => {
    const r = http.request(base + "/remote/stream?utt=u1&seq=0", {
      method: "POST",
      headers: { cookie: `de=${cookie}`, "Content-Length": 3_200_000 },
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

// -- the cursor -------------------------------------------------------------

test("the cursor is the newest seq, and 0 when there is nothing", async () => {
  cursorNext = 12;
  assert.deepEqual(await (await authed("/remote/cursor")).json(), { seq: 12 });
  cursorNext = 0;
  assert.deepEqual(await (await authed("/remote/cursor")).json(), { seq: 0 });
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
