/**
 * The bridge: the whole brain contract on 127.0.0.1, behind a shared secret.
 * speak / listen / mic / status / show / health — one route table, one dispatcher.
 */
const http = require("node:http");
const crypto = require("node:crypto");

const HOST = "127.0.0.1";
const BODY_MAX = 33_000_000; // ~32MB — inline base64 images fit, runaways don't
const LISTEN_MS = 50_000;
const LISTEN_MAX_MS = 55_000;
const LISTENING_GRACE_MS = 90_000;
const KINDS = ["html", "image", "text"];

const json = (res, code, obj) =>
  res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(obj));

const SOURCES = ["local", "remote", "both"];
/** The owner's TV switch: `auto` is the ladder, `on`/`off` force it (E12). */
const TV_MODES = ["auto", "on", "off"];

/** A bus item is spoken words (a string or `{text, source}`) or a body event (object). */
const payload = (t) => {
  const item = t && typeof t === "object" ? t : { text: t };
  const source = item.source === "remote" ? "remote" : "local";
  return item.event
    ? { transcript: null, event: item.event, detail: item.detail ?? "", source }
    : { transcript: item.text ?? null, source };
};

/** Reads a JSON body, answering 413 itself if it runs over the cap (wire bytes). */
function readBody(req, res) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > BODY_MAX) {
      json(res, 413, { error: "body too large" });
      res.once("finish", () => req.destroy());
      return void reject(new Error("body too large"));
    }
    let data = "";
    let bytes = 0;
    req.on("data", (c) => {
      bytes += c.length;
      data += c;
      if (bytes > BODY_MAX) {
        json(res, 413, { error: "body too large" });
        res.once("finish", () => req.destroy()); // the 413 must reach him before the socket dies
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

function startServer({ port, secret, onSpeak, onListen, onMic, onMicOpen, onStatus, onOrbiters = () => [], onShow, onTv = () => ({ mode: "auto" }), log = () => {} }) {
  if (!secret) throw new Error("refusing to serve without a secret — check config.json");
  const secretBuf = Buffer.from(secret);
  const authed = (req) => {
    const key = req.headers["x-dark-eye-key"];
    if (typeof key !== "string") return false;
    const keyBuf = Buffer.from(key);
    return keyBuf.length === secretBuf.length && crypto.timingSafeEqual(keyBuf, secretBuf);
  };

  let listeners = 0;
  let lastListen = 0;
  /** A brain has an ear here: a listen is pending, or one returned very recently. */
  const brainListening = () => listeners > 0 || Date.now() - lastListen < LISTENING_GRACE_MS;

  const routes = {
    "POST /bridge/speak": async (req, res) => {
      const b = await readBody(req, res);
      await onSpeak({
        text: String(b?.text ?? ""),
        voice: b?.voice === undefined ? undefined : Number(b.voice),
        // no `to` means the source of the last thing heard, which only the body knows
        to: SOURCES.includes(b?.to) ? b.to : undefined,
      });
      json(res, 200, { ok: true });
    },
    "GET /bridge/listen": async (req, res, u) => {
      const raw = Number(u.searchParams.get("timeoutMs"));
      const ms = Math.min(Number.isFinite(raw) && raw > 0 ? raw : LISTEN_MS, LISTEN_MAX_MS);
      listeners++;
      try {
        json(res, 200, payload(await onListen(ms)));
      } finally {
        listeners--;
        lastListen = Date.now();
      }
    },
    "POST /bridge/mic": async (req, res) => {
      const b = await readBody(req, res);
      const on = await onMic(b && "on" in b ? !!b.on : undefined);
      json(res, 200, { ok: true, on: !!on });
    },
    "POST /bridge/status": async (req, res) => {
      const b = await readBody(req, res);
      await onStatus({
        id: String(b?.id ?? "task"),
        state: b?.state === "done" || b?.state === "error" ? b.state : "working",
        label: String(b?.label ?? ""),
      });
      json(res, 200, { ok: true });
    },
    "GET /bridge/status": (req, res) => json(res, 200, { ok: true, orbiters: onOrbiters() }),
    "POST /bridge/show": async (req, res) => {
      const b = await readBody(req, res);
      const data = String(b?.data ?? "");
      if (!data) return json(res, 400, { error: "no data" });
      const id = await onShow({
        title: String(b?.title ?? ""),
        kind: KINDS.includes(b?.kind) ? b.kind : "html",
        data,
        verdict: !!b?.verdict,
      });
      json(res, 200, { ok: true, id: String(id) });
    },
    "GET /bridge/tv": (req, res) => json(res, 200, { ok: true, ...onTv() }),
    "POST /bridge/tv": async (req, res) => {
      const b = await readBody(req, res);
      if (!TV_MODES.includes(b?.mode)) return json(res, 400, { error: "mode must be auto, on or off" });
      json(res, 200, { ok: true, ...onTv(b.mode) });
    },
    "GET /bridge/health": (req, res) =>
      json(res, 200, {
        ok: true,
        brainListening: brainListening(),
        micOpen: !!onMicOpen(),
        tv: onTv().mode,
      }),
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (!authed(req)) return void res.writeHead(401).end();
    const route = `${req.method} ${u.pathname}`;
    const handler = routes[route];
    if (!handler) {
      const allow = Object.keys(routes)
        .filter((r) => r.endsWith(` ${u.pathname}`))
        .map((r) => r.split(" ")[0]);
      if (allow.length) return void res.writeHead(405, { Allow: allow.join(", ") }).end();
      return void res.writeHead(404).end();
    }
    try {
      await handler(req, res, u);
    } catch (err) {
      log(`bridge ${route}: ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  server.brainListening = brainListening;
  server.listen(port, HOST, () => log(`bridge on ${HOST}:${server.address().port}`));
  return server;
}

module.exports = { startServer };
