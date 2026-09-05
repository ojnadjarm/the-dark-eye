/**
 * The Field — standalone server (spec B §4). Its own application: owns scene
 * truth (current form, board mode, conjured shape), serves the 3D page, and
 * pushes ops to open pages over SSE. Runs in WSL on :8643; Windows browsers
 * reach it via WSL2 localhost forwarding. The Eye's body carries NO field
 * code — the Eye and the Field are two clients of the same agents.
 *
 * Start:  cd ~/projects/the-dark-eye/field && node server.js
 * Auth:   field/.key (generated once, not the Eye's secret). The page and
 *         its EventSource can't set headers, so / and /events take ?key=;
 *         POST /op takes header x-field-key (or ?key=). Timing-safe compare,
 *         fail-closed (refuses to start without a key).
 * Static: /vendor/* → node_modules/three/build/*, /vendor/addons/* →
 *         node_modules/three/examples/jsm/*, /assets/* → assets/*.glb.
 *         Served keyless ON PURPOSE: three.js internals import each other by
 *         RELATIVE path (three.module.js → ./three.core.js, UnrealBloomPass →
 *         ../shaders/…), and relative resolution drops query strings — the
 *         same trap that forced the MVP to vendor an old single-file build.
 *         These files are a public library + CC-licensed sample models: no
 *         secrets, and the server binds 127.0.0.1 only.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const cjsRequire = createRequire(import.meta.url);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8643;
const HOST = "127.0.0.1"; // loopback only — LAN/headset is a later, deliberate decision

let KEY = "";
try {
  KEY = fs.readFileSync(path.join(ROOT, ".key"), "utf8").trim();
} catch {
  /* handled below */
}
if (!KEY) {
  console.error("field: refusing to serve without field/.key — generate one:");
  console.error("  node -e \"require('fs').writeFileSync('.key',require('crypto').randomBytes(24).toString('hex'),{mode:0o600})\"");
  process.exit(1);
}
const keyBuf = Buffer.from(KEY);
const keyOk = (k) => {
  if (typeof k !== "string") return false;
  const b = Buffer.from(k);
  return b.length === keyBuf.length && crypto.timingSafeEqual(b, keyBuf);
};

const log = (m) => console.log(`[field ${new Date().toISOString().slice(11, 23)}] ${m}`);

// ---------- scene truth (same protocol shape as the MVP) --------------------
const FORMS = ["eye", "figure", "hound", "ghost", "wave", "murmur"];
const BOARDS = ["waves", "lissajous", "bars"];
const SHAPES = ["cube", "torus"];
const state = { form: "eye", board: null, conjured: null, tv: null, summons: {} };
const clients = new Set(); // open SSE responses
const beats = {}; // latest heartbeat per page id — what each open page is actually doing
// slim view for op replies — geometry is for pages (snapshot), not CLIs
const slim = () => ({
  form: state.form,
  board: state.board,
  conjured: state.conjured,
  summons: Object.keys(state.summons),
});

function push(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function broadcast(op) {
  for (const res of clients) {
    try {
      push(res, op);
    } catch (err) {
      clients.delete(res);
      log(`page dropped: ${err.message}`);
    }
  }
}
// SSE has no application-level ping — a comment line keeps idle streams alive
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(": beat\n\n");
    } catch {
      clients.delete(res);
    }
  }
}, 25_000).unref();

// one op in: validate, mutate truth, relay to every open page. Invalid args
// ride HTTP 200 {"error":...} so eye.sh prints the reason (register's pattern).
function apply(body) {
  const op = String(body?.op ?? body?.verb ?? "");
  if (op === "shift") {
    const form = String(body?.form ?? "").toLowerCase();
    if (!FORMS.includes(form)) return { error: `unknown form '${form}' — forms: ${FORMS.join(", ")}` };
    state.form = form;
    broadcast({ op: "shift", form });
    log(`shift ${form} → ${clients.size} page(s)`);
    return { ok: true, state: slim() };
  }
  if (op === "board") {
    const mode = String(body?.mode ?? "").toLowerCase();
    if (mode !== "off" && !BOARDS.includes(mode))
      return { error: `unknown board mode '${mode}' — modes: ${BOARDS.join(", ")}, off` };
    state.board = mode === "off" ? null : mode;
    state.tv = null; // glyph modes and the TV share the panel
    broadcast({ op: "board", mode });
    log(`board ${mode} → ${clients.size} page(s)`);
    return { ok: true, state: slim() };
  }
  if (op === "conjure") {
    const shape = String(body?.shape ?? "").toLowerCase();
    if (shape !== "off" && !SHAPES.includes(shape))
      return { error: `unknown shape '${shape}' — shapes: ${SHAPES.join(", ")}, off` };
    state.conjured = shape === "off" ? null : shape;
    broadcast({ op: "conjure", shape });
    log(`conjure ${shape} → ${clients.size} page(s)`);
    return { ok: true, state: slim() };
  }
  if (op === "dismiss") {
    state.board = null;
    state.conjured = null;
    state.summons = {};
    state.tv = null;
    broadcast({ op: "dismiss" });
    log(`dismiss → ${clients.size} page(s)`);
    return { ok: true, state: slim() };
  }
  // summon: ARBITRARY wireframe from an agent — any form, not the canned set.
  // v = [[x,y,z]…] local to the conjure anchor, e = [[ai,bi]…] vertex indices.
  // Renders through the same conjure pipeline (glyph riders, gold dissolve).
  if (op === "summon") {
    const name = String(body?.name ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "form";
    const v = body?.v, e = body?.e;
    if (!Array.isArray(v) || v.length < 2 || v.length > 500)
      return { error: "summon needs v: [[x,y,z]…] (2–500 vertices)" };
    if (!Array.isArray(e) || e.length < 1 || e.length > 340)
      return { error: "summon needs e: [[ai,bi]…] (1–340 edges)" };
    for (const p of v)
      if (!Array.isArray(p) || p.length !== 3 || p.some((n) => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 2000))
        return { error: "summon vertex out of range (finite numbers, |coord| ≤ 2000)" };
    for (const ed of e)
      if (!Array.isArray(ed) || ed.length !== 2 || ed.some((i) => !Number.isInteger(i) || i < 0 || i >= v.length))
        return { error: "summon edge index out of range" };
    // many at once (his ask): a named registry, budgeted, each independent
    const names = Object.keys(state.summons);
    if (!state.summons[name] && names.length >= 12)
      return { error: "summon limit: 12 forms at once — unsummon something first" };
    let totalE = e.length;
    for (const n of names) if (n !== name) totalE += state.summons[n].e.length;
    if (totalE > 1600) return { error: "summon budget: ≤1600 edges across all forms" };
    state.summons[name] = { v, e };
    broadcast({ op: "summon", name, v, e });
    log(`summon ${name} (${v.length}v/${e.length}e, ${Object.keys(state.summons).length} live) → ${clients.size} page(s)`);
    return { ok: true, state: slim() };
  }
  if (op === "unsummon") {
    const name = String(body?.name ?? "").toLowerCase();
    if (!state.summons[name]) return { error: `nothing summoned as '${name}' — live: ${Object.keys(state.summons).join(", ") || "none"}` };
    delete state.summons[name];
    broadcast({ op: "unsummon", name });
    log(`unsummon ${name} → ${clients.size} page(s)`);
    return { ok: true, state: slim() };
  }
  // tv: the board becomes a screen — any image (data URL) as its face.
  // Spec: "the board is a TV — real graphs and images, glyph modes are just
  // one channel." SVG data URLs keep payloads under the 64KB body cap.
  if (op === "tv") {
    const title = String(body?.title ?? "").slice(0, 80);
    const media = body?.media ? String(body.media) : null;
    if (media) {
      // a video already uploaded via POST /media
      if (!/^\/media\/[a-z0-9._-]+\.(webm|mp4)$/.test(media))
        return { error: "tv media must be a /media/… path from POST /media (webm|mp4)" };
      if (!fs.existsSync(path.join(ROOT, media))) return { error: `no such media: ${media}` };
      state.board = null;
      state.tv = { media, title };
      broadcast({ op: "tv", media, title });
      log(`tv video "${title}" (${media}) → ${clients.size} page(s)`);
      return { ok: true, state: slim() };
    }
    const image = String(body?.image ?? "");
    if (!/^data:image\/(svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image))
      return { error: "tv needs image (base64 data URL, ≤60000 chars) or media (/media/… video path)" };
    if (image.length > 60000) return { error: "tv image too large (≤60000 chars — SVG compresses best)" };
    state.board = null;
    state.tv = { image, title };
    broadcast({ op: "tv", image, title });
    log(`tv "${title}" (${image.length}b) → ${clients.size} page(s)`);
    return { ok: true, state: slim() };
  }
  // look: an agent frames something for the user — glides the USER'S camera
  // (his ask 2026-08-23: "change the camera angle to show me the graph").
  // Transient — not part of scene state; the user's drag cancels the glide.
  if (op === "look") {
    const at = body?.at;
    const named = typeof at === "string" && ["board", "avatar", "conjured", "center"].includes(at);
    const xyz = at && typeof at === "object" && ["x", "y", "z"].every((k) => Number.isFinite(at[k]) && Math.abs(at[k]) <= 2000);
    if (!named && !xyz) return { error: "look needs at: board|avatar|conjured|center or {x,y,z}" };
    const dist = Number.isFinite(body?.dist) ? Math.min(1500, Math.max(60, body.dist)) : undefined;
    broadcast({ op: "look", at, dist });
    log(`look ${named ? at : "xyz"} → ${clients.size} page(s)`);
    return { ok: true };
  }
  // say: the field itself speaks (browser TTS on every open page) + captions
  if (op === "say") {
    const text = String(body?.text ?? "").slice(0, 500);
    if (!text.trim()) return { error: "say needs text" };
    const quiet = !!body?.quiet; // caption only — the Eye's Kokoro carries the sound
    broadcast({ op: "say", text, quiet });
    log(`say${quiet ? " (quiet)" : ""} "${text.slice(0, 60)}" → ${clients.size} page(s)`);
    return { ok: true };
  }
  // voice: the user spoke into a field page's mic — relayed to every SSE
  // listener (agents subscribe to /events and read these)
  if (op === "voice") {
    const text = String(body?.text ?? "").slice(0, 1000);
    if (!text.trim()) return { error: "voice needs text" };
    broadcast({ op: "voice", text });
    log(`voice "${text.slice(0, 60)}"`);
    return { ok: true };
  }
  return { error: `unknown field op '${op}' — ops: shift, board, conjure, dismiss, summon, unsummon, say, voice, tv, look` };
}

// ---------- the field's own voice — Kokoro (sherpa-onnx), sid 17 ----------------
// His call 2026-08-23: "same voice as the Eye, but IN the field." Same model
// files the body uses (read from /mnt/c), same speaker id, no Eye involved.
// Lazy init (~2s first call), ~1s per sentence on CPU after that.
const KOKORO_DIR = "/mnt/c/Users/Oscar/projects/the-dark-eye/body/models/kokoro-multi-lang-v1_0";
const VOICE_SID = 17;
let ttsEngine = null;
function getTts() {
  if (ttsEngine) return ttsEngine;
  const sherpa = cjsRequire("sherpa-onnx-node");
  ttsEngine = new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: path.join(KOKORO_DIR, "model.onnx"),
        voices: path.join(KOKORO_DIR, "voices.bin"),
        tokens: path.join(KOKORO_DIR, "tokens.txt"),
        dataDir: path.join(KOKORO_DIR, "espeak-ng-data"),
        dictDir: path.join(KOKORO_DIR, "dict"),
        lexicon: [path.join(KOKORO_DIR, "lexicon-us-en.txt"), path.join(KOKORO_DIR, "lexicon-zh.txt")].join(","),
      },
      numThreads: 4,
      debug: false,
      provider: "cpu",
    },
    maxNumSentences: 2,
  });
  log(`kokoro ready (${ttsEngine.numSpeakers} speakers, sid ${VOICE_SID})`);
  return ttsEngine;
}
function wavFromSamples(samples, rate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

// ---------- http --------------------------------------------------------------
const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};
const STATIC = [
  // longest prefix first — /vendor/addons/ must win over /vendor/
  { prefix: "/vendor/addons/", dir: path.join(ROOT, "node_modules", "three", "examples", "jsm"), ext: [".js"] },
  { prefix: "/vendor/", dir: path.join(ROOT, "node_modules", "three", "build"), ext: [".js"] },
  { prefix: "/assets/", dir: path.join(ROOT, "assets"), ext: [".glb"] },
  // agent-uploaded board media (videos). Keyless like /assets: <video> tags
  // fetch without headers, and the server binds loopback only.
  { prefix: "/media/", dir: path.join(ROOT, "media"), ext: [".webm", ".mp4"] },
];

function serveStatic(u, res) {
  for (const { prefix, dir, ext } of STATIC) {
    if (!u.pathname.startsWith(prefix)) continue;
    const rel = decodeURIComponent(u.pathname.slice(prefix.length));
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir + path.sep) || !ext.includes(path.extname(file))) break;
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)], "Cache-Control": "max-age=3600" }).end(buf);
    });
    return true;
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 65536) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (serveStatic(u, res)) return;

  // page heartbeats: each open page reports render-loop + tv health every 4s
  // so agents can see what the user sees (freeze debugging, 2026-08-23)
  if (u.pathname === "/beat" && req.method === "POST") {
    if (!keyOk(u.searchParams.get("key"))) { res.writeHead(401).end(); return; }
    readBody(req)
      .then((b) => {
        const id = String(b?.id ?? "?").slice(0, 12);
        beats[id] = {
          ua: String(b?.ua ?? "").slice(0, 80),
          frames: Number(b?.frames) || 0,
          hidden: !!b?.hidden,
          tv: b?.tv && typeof b.tv === "object"
            ? { t: Number(b.tv.t) || 0, paused: !!b.tv.paused, ready: Number(b.tv.ready) || 0, err: Number(b.tv.err) || 0,
                draw: Number.isFinite(Number(b.tv.draw)) ? Number(b.tv.draw) : -1 }
            : null,
          at: new Date().toISOString().slice(11, 19),
        };
        res.writeHead(204).end();
      })
      .catch(() => res.writeHead(400).end());
    return;
  }
  if (u.pathname === "/beats" && req.method === "GET") {
    if (!keyOk(u.searchParams.get("key"))) { res.writeHead(401).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(beats));
    return;
  }

  if (u.pathname === "/" && req.method === "GET") {
    if (!keyOk(u.searchParams.get("key"))) {
      res.writeHead(401, { "Content-Type": "text/plain" }).end("401 — open the address that `eye.sh field url` prints\n");
      return;
    }
    try {
      const html = fs.readFileSync(path.join(ROOT, "index.html"));
      // no-cache: a stale page is invisible sabotage — every reload must
      // carry the current code (board-freeze night, 2026-08-23)
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(html);
    } catch (err) {
      log(`page error: ${err.message}`);
      res.writeHead(500).end();
    }
    return;
  }

  if (u.pathname === "/events" && req.method === "GET") {
    if (!keyOk(u.searchParams.get("key"))) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    clients.add(res);
    push(res, { op: "state", state }); // snapshot-on-connect: late joiner sees the live scene
    log(`page connected (${clients.size} open)`);
    req.on("close", () => {
      if (clients.delete(res)) log(`page closed (${clients.size} open)`);
    });
    return;
  }

  if (u.pathname === "/tts" && req.method === "GET") {
    if (!keyOk(u.searchParams.get("key"))) {
      res.writeHead(401).end();
      return;
    }
    const text = String(u.searchParams.get("text") || "").slice(0, 400).trim();
    if (!text) {
      res.writeHead(400).end();
      return;
    }
    try {
      const audio = getTts().generate({ text, sid: VOICE_SID, speed: 1.0 });
      res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" })
        .end(wavFromSamples(audio.samples, audio.sampleRate));
    } catch (err) {
      log(`tts error: ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
    return;
  }

  // media upload — agent pushes a video for the board TV. Key-gated, capped,
  // extension from a content-type whitelist, name from the content hash.
  if (u.pathname === "/media" && req.method === "POST") {
    if (!keyOk(req.headers["x-field-key"]) && !keyOk(u.searchParams.get("key"))) {
      res.writeHead(401).end();
      return;
    }
    const EXT = { "video/webm": ".webm", "video/mp4": ".mp4" };
    const ext = EXT[String(req.headers["content-type"] || "").split(";")[0]];
    if (!ext) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "content-type must be video/webm or video/mp4" }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 30 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        if (!buf.length) throw new Error("empty body");
        const name = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + ext;
        fs.mkdirSync(path.join(ROOT, "media"), { recursive: true });
        fs.writeFileSync(path.join(ROOT, "media", name), buf);
        log(`media uploaded: ${name} (${(buf.length / 1024).toFixed(0)}KB)`);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, url: `/media/${name}` }));
      } catch (err) {
        log(`media error: ${err.message}`);
        if (!res.headersSent) res.writeHead(400).end();
      }
    });
    req.on("error", () => { if (!res.headersSent) res.writeHead(400).end(); });
    return;
  }

  if (u.pathname === "/op" && req.method === "POST") {
    if (!keyOk(req.headers["x-field-key"]) && !keyOk(u.searchParams.get("key"))) {
      res.writeHead(401).end();
      return;
    }
    try {
      const body = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(apply(body)));
    } catch (err) {
      log(`op error: ${err.message}`);
      if (!res.headersSent) res.writeHead(400).end();
    }
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, HOST, () => log(`the Field on http://${HOST}:${PORT}/ (loopback only; key in field/.key)`));
