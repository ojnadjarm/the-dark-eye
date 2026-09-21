/**
 * The remote listener: the phone's page and `/remote/*` on a second loopback port,
 * behind a login cookie. One route table, one dispatcher — the bridge's shape.
 */
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MAX_SAMPLES } = require("./remote-ear");

const HOST = "127.0.0.1";
const AUDIO_MAX = MAX_SAMPLES * 2; // the ear's own cap in bytes — a clip fits, a runaway does not
const COOKIE_MAX_AGE = 2_592_000; // 30 days, owner's call
const LOGIN_TRIES = 5;
const LOGIN_WINDOW_MS = 300_000;
const MODES = ["call", "notes"]; // his words, the only ones the page may send
const REPLAY_GAP_MS = 1000; // a held ▶ must not queue twenty utterances, per device
const STATE_HOME = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
const SESSIONS_FILE = path.join(STATE_HOME, "dark-eye", "remote-sessions.json");
const WWW = path.join(__dirname, "remote-www");
const PUBLIC = { "/": "index.html", "/worklet.js": "worklet.js" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

/** Never a stale lane: an intermediary that cached one poll or cursor answer is a dead life's cursor. */
const json = (res, code, obj) =>
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(obj));

/** Reads a request body as one Buffer, answering 413 itself if it runs over the cap. */
function readBody(req, res, cap) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > cap) {
      json(res, 413, { error: "body too large" });
      res.once("finish", () => req.destroy());
      return void reject(new Error("body too large"));
    }
    const parts = [];
    let bytes = 0;
    req.on("data", (c) => {
      bytes += c.length;
      parts.push(c);
      if (bytes > cap) {
        json(res, 413, { error: "body too large" });
        res.once("finish", () => req.destroy()); // the 413 must reach him before the socket dies
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/** Int16LE bytes → Float32 in [-1,1); a trailing odd byte is dropped. */
function toFloat32(buf) {
  const out = new Float32Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** `?utt=` as a stream id, or null — it names an in-memory buffer, so it is narrow. */
const uttOf = (u) => {
  const v = u.searchParams.get("utt");
  return /^[A-Za-z0-9_-]{1,32}$/.test(v ?? "") ? v : null;
};

/** A token is never stored, only its digest — the file is a lock list, not a key ring. */
const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");

/** `{digest: expiresAt}` from disk with the expired dropped; an unreadable file is no sessions. */
function loadSessions(file, log) {
  const now = Date.now();
  try {
    const raw = JSON.parse(fsSync.readFileSync(file, "utf8"));
    return new Map(Object.entries(raw).filter(([, exp]) => Number(exp) > now));
  } catch (err) {
    if (err.code !== "ENOENT") log(`remote sessions unreadable: ${err.message}`);
    return new Map();
  }
}

/** The whole table at once, 0600 inside a 0700 dir, renamed into place. */
function saveSessions(file, sessions, log) {
  const tmp = `${file}.tmp`;
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fsSync.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    fsSync.chmodSync(tmp, 0o600);
    fsSync.renameSync(tmp, file);
  } catch (err) {
    log(`remote sessions unwritable: ${err.message}`);
  }
}

function startRemote({
  port,
  secret,
  onAudio,
  onStream = () => false,
  onFinal = () => null,
  onPoll = () => null,
  onCursor = () => 0,
  onAck = () => {},
  onReplay = () => false,
  onBrains = () => null,
  onActive = () => null,
  onMode = () => null,
  wav = () => null,
  sessionsFile = SESSIONS_FILE,
  log = () => {},
}) {
  if (!secret) throw new Error("refusing to serve without a secret — check config.json");
  const secretBuf = Buffer.from(secret);
  const sessions = loadSessions(sessionsFile, log); // token digest → expiry, so a restart keeps him in
  const attempts = new Map(); // remote address → recent login timestamps
  const replayAt = new Map(); // session digest → its last replay, so one device never gags the other
  const boot = crypto.randomBytes(6).toString("base64url"); // this life of the body: a page still holding the last one's seqs must know

  const keyOk = (key) => {
    if (typeof key !== "string") return false;
    const buf = Buffer.from(key);
    return buf.length === secretBuf.length && crypto.timingSafeEqual(buf, secretBuf);
  };

  /** False once an address has spent its 5 tries in the window; every try counts. */
  const tryLogin = (addr) => {
    const now = Date.now();
    const recent = (attempts.get(addr) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    recent.push(now);
    attempts.set(addr, recent);
    return recent.length <= LOGIN_TRIES;
  };

  /** Drops what the cookie's own Max-Age has already ended. */
  const sweep = () => {
    const now = Date.now();
    for (const [d, exp] of sessions)
      if (exp <= now) {
        sessions.delete(d);
        replayAt.delete(d);
      }
  };

  /** The session behind a live cookie, as its digest, else null — the device a limit is counted against. */
  const sessionOf = (req) => {
    const token = /(?:^|;\s*)de=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const d = token && digest(token);
    return d && (sessions.get(d) ?? 0) > Date.now() ? d : null;
  };

  const authed = (req) => !!sessionOf(req);

  const routes = {
    "POST /remote/login": async (req, res) => {
      const raw = await readBody(req, res, 4096);
      const ok = tryLogin(req.socket.remoteAddress ?? "") && keyOk(parseKey(raw));
      if (!ok) return void res.writeHead(401).end();
      const token = crypto.randomBytes(32).toString("base64url");
      sweep();
      sessions.set(digest(token), Date.now() + COOKIE_MAX_AGE * 1000);
      saveSessions(sessionsFile, sessions, log);
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `de=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
        })
        .end(JSON.stringify({ ok: true }));
    },
    /** A second of his voice while he is still talking — the ear reads it as it lands. */
    "POST /remote/stream": async (req, res, u) => {
      const utt = uttOf(u);
      const raw = u.searchParams.get("seq") ?? "";
      if (!utt || !/^\d{1,9}$/.test(raw)) return void json(res, 400, { error: "utt and seq" });
      const seq = Number(raw);
      const samples = toFloat32(await readBody(req, res, AUDIO_MAX));
      if (!onStream(utt, seq, samples)) return void json(res, 413, { error: "utterance too long" });
      json(res, 200, { ok: true });
    },
    /**
     * The final tap. With `?utt=` it settles what was streamed — the body is the
     * tail, and an empty one means "finalize what you have". Without it the body
     * is the whole clip, which is how the page asked before it streamed.
     */
    "POST /remote/audio": async (req, res, u) => {
      const samples = toFloat32(await readBody(req, res, AUDIO_MAX));
      const utt = uttOf(u);
      const transcript = utt
        ? await onFinal(utt, samples)
        : samples.length
          ? await onAudio(samples, 16000)
          : null;
      json(res, 200, { transcript: transcript ?? null });
    },
    /** "I have played this one" — it never comes back on a poll, on this page or another. */
    "POST /remote/ack": async (req, res, u) => {
      const raw = await readBody(req, res, 4096);
      const seq = Number(u.searchParams.get("seq") ?? parseSeq(raw));
      if (!Number.isInteger(seq) || seq <= 0) return void json(res, 400, { error: "seq" });
      // a tray item kept across a restart acks the seq of a life that is gone: that number
      // names someone else's reply here, and marking it played would take it off the ring
      const from = parseBoot(raw);
      if (from && from !== boot) return void res.writeHead(204).end();
      await onAck(seq);
      res.writeHead(204).end();
    },
    /**
     * "Say that one again" — the reply itself comes back on the poll lane, so this
     * answers only whether the body still has those words.
     */
    "POST /remote/replay": async (req, res) => {
      const seq = parseSeq(await readBody(req, res, 4096));
      if (!Number.isInteger(seq) || seq <= 0) return void json(res, 400, { error: "seq" });
      const who = sessionOf(req);
      const now = Date.now();
      if (now - (replayAt.get(who) ?? 0) < REPLAY_GAP_MS) return void json(res, 429, { error: "too fast" });
      if (!(await onReplay(seq))) return void json(res, 400, { error: "unknown seq" });
      replayAt.set(who, now); // only a press that was given words starts the gap
      json(res, 200, { ok: true });
    },
    /** The chips: who is there and who hears him. */
    "GET /remote/brains": async (req, res) => json(res, 200, await onBrains()),
    /** One tap on a chip; the answer is the roster as it stands now, or 400 for a name nobody has. */
    "POST /remote/active": async (req, res) => {
      const brain = parseBrain(await readBody(req, res, 4096));
      const roster = typeof brain === "string" ? await onActive(brain) : null;
      if (!roster) return void json(res, 400, { error: "unknown brain" });
      json(res, 200, roster);
    },
    /** Which mode the exchange is in, in his words — `call` or `notes`, never the body's. */
    "GET /remote/mode": async (req, res) => json(res, 200, { mode: await onMode() }),
    /**
     * One tap on the mode icon. Only his two words are a mode here: the body's own
     * `async` is 400, so the render socket's word can never come back through the
     * page. `channel` is optional and names the row it moves — it is checked against
     * the roster, so the page can never move a mode on a name nobody has; without it
     * the body moves the active channel, as it always did.
     */
    "POST /remote/mode": async (req, res) => {
      const raw = await readBody(req, res, 4096);
      const want = parseMode(raw);
      if (!MODES.includes(want)) return void json(res, 400, { error: "unknown mode" });
      const channel = parseChannel(raw);
      if (channel !== undefined && !(await onRoster(channel))) return void json(res, 400, { error: "unknown brain" });
      const mode = await onMode(want, channel);
      json(res, 200, channel === undefined ? { mode } : { mode, channel });
    },
    /**
     * Where a page that has just loaded should start polling from — and which life of the
     * body those seqs belong to: a restart counts the ring from 0 again, so a page still
     * holding the last life's numbers would press ▶ on replies that no longer exist.
     */
    "GET /remote/cursor": async (req, res) => json(res, 200, { seq: Number(await onCursor()) || 0, boot }),
    /**
     * No `since` at all means "from now": the head, so a reloaded page waits for
     * the next reply instead of replaying the ring. `since=<n>` resumes where it says.
     * Every answer carries this life, because a restart between two polls takes an idle
     * socket and nothing else: without it the page polls on with a dead life's cursor.
     */
    "GET /remote/poll": async (req, res, u) => {
      const raw = u.searchParams.get("since");
      const n = Number(raw);
      const since = raw === null ? Number(await onCursor()) || 0 : Number.isFinite(n) && n > 0 ? n : 0;
      res.setHeader("X-Eye-Boot", boot);
      json(res, 200, (await onPoll(since)) ?? null);
    },
  };

  const parseSeq = (raw) => {
    try {
      return JSON.parse(raw.toString()).seq;
    } catch {
      return NaN;
    }
  };

  const parseBoot = (raw) => {
    try {
      return JSON.parse(raw.toString()).boot;
    } catch {
      return null;
    }
  };

  const parseKey = (raw) => {
    try {
      return JSON.parse(raw.toString()).key;
    } catch {
      return null;
    }
  };

  /** True only for a name the body itself lists — the page's channel is never taken on trust. */
  const onRoster = async (name) => {
    if (typeof name !== "string") return false;
    const r = await onBrains();
    return Array.isArray(r?.brains) && r.brains.some((b) => b?.name === name);
  };

  const parseMode = (raw) => {
    try {
      return JSON.parse(raw.toString()).mode;
    } catch {
      return null;
    }
  };

  /** `undefined` when the page sent no channel at all, which means "the active one". */
  const parseChannel = (raw) => {
    try {
      return JSON.parse(raw.toString()).channel;
    } catch {
      return undefined;
    }
  };

  const parseBrain = (raw) => {
    try {
      return JSON.parse(raw.toString()).brain;
    } catch {
      return null;
    }
  };

  /** `/remote/audio/<id>.wav` — one reply utterance, whatever `wav` still holds. */
  const serveWav = async (res, id) => {
    const buf = await wav(id);
    if (!buf) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": buf.length }).end(buf);
  };

  /** Never a stale page: the browser must revalidate, and a file that has not changed costs a 304. */
  const serveStatic = async (req, res, file) => {
    try {
      const full = path.join(WWW, file);
      const { mtimeMs } = await fs.stat(full);
      const etag = `"${Math.floor(mtimeMs).toString(36)}"`;
      const headers = {
        "Cache-Control": "no-cache",
        ETag: etag,
        "Last-Modified": new Date(mtimeMs).toUTCString(),
      };
      if (req.headers["if-none-match"] === etag) return void res.writeHead(304, headers).end();
      const body = await fs.readFile(full);
      res.writeHead(200, { ...headers, "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    const route = `${req.method} ${u.pathname}`;
    const wavId = /^\/remote\/audio\/([A-Za-z0-9_-]+)\.wav$/.exec(u.pathname)?.[1];
    const isPublic = u.pathname in PUBLIC || route === "POST /remote/login";
    if (!isPublic && !authed(req)) return void res.writeHead(401).end();
    try {
      if (u.pathname in PUBLIC) {
        if (req.method !== "GET") return void res.writeHead(405, { Allow: "GET" }).end();
        return void (await serveStatic(req, res, PUBLIC[u.pathname]));
      }
      if (wavId) {
        if (req.method !== "GET") return void res.writeHead(405, { Allow: "GET" }).end();
        return void (await serveWav(res, wavId));
      }
      const handler = routes[route];
      if (!handler) {
        const allow = Object.keys(routes)
          .filter((r) => r.endsWith(` ${u.pathname}`))
          .map((r) => r.split(" ")[0]);
        if (allow.length) return void res.writeHead(405, { Allow: allow.join(", ") }).end();
        return void res.writeHead(404).end();
      }
      await handler(req, res, u);
    } catch (err) {
      log(`remote ${route}: ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  server.listen(port, HOST, () => log(`remote on ${HOST}:${server.address().port}`));
  return server;
}

module.exports = { startRemote, AUDIO_MAX };
