/**
 * The bridge: the whole brain contract on 127.0.0.1, behind a shared secret.
 * speak / listen / brains / mic / status / show / mode / health — one route table, one dispatcher.
 */
const http = require("node:http");
const crypto = require("node:crypto");
const { validName } = require("./brains");
const { WIRE, fromWire, toWire } = require("./mode");

const HOST = "127.0.0.1";
const BODY_MAX = 33_000_000; // ~32MB — inline base64 images fit, runaways don't
const LISTEN_MS = 50_000;
const LISTEN_MAX_MS = 55_000;
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

/** `brain` from a query or a body: undefined when absent, null when not a name. */
const brainOf = (v) => (v == null || v === "" ? undefined : validName(v) ? v : null);

function startServer({ port, secret, onSpeak, onListen, onMic, onMicOpen, onStatus, onOrbiters = () => [], onShow, onTv = () => ({ mode: "auto" }), onBrains = () => ({ active: null, brains: [] }), onActive = () => null, onHeld = () => 0, onMode = () => "call", log = () => {} }) {
  if (!secret) throw new Error("refusing to serve without a secret — check config.json");
  const secretBuf = Buffer.from(secret);
  const authed = (req) => {
    const key = req.headers["x-dark-eye-key"];
    if (typeof key !== "string") return false;
    const keyBuf = Buffer.from(key);
    return keyBuf.length === secretBuf.length && crypto.timingSafeEqual(keyBuf, secretBuf);
  };

  /** The active brain has an ear here: a listen is pending, or one returned very recently. */
  const brainListening = () => {
    const { active, brains } = onBrains();
    return !!brains.find((b) => b.name === active)?.connected;
  };

  const routes = {
    "POST /bridge/speak": async (req, res) => {
      const b = await readBody(req, res);
      const brain = brainOf(b?.brain);
      if (brain === null) return json(res, 400, { error: "brain must be [a-z0-9-]{1,16}" });
      await onSpeak({
        text: String(b?.text ?? ""),
        voice: b?.voice === undefined ? undefined : Number(b.voice),
        // no `to` means the source of the last thing heard, which only the body knows
        to: SOURCES.includes(b?.to) ? b.to : undefined,
        brain,
      });
      json(res, 200, { ok: true });
    },
    "GET /bridge/listen": async (req, res, u) => {
      const raw = Number(u.searchParams.get("timeoutMs"));
      const ms = Math.min(Number.isFinite(raw) && raw > 0 ? raw : LISTEN_MS, LISTEN_MAX_MS);
      const brain = brainOf(u.searchParams.get("brain"));
      if (brain === null) return json(res, 400, { error: "brain must be [a-z0-9-]{1,16}" });
      const voice = u.searchParams.get("voice");
      json(res, 200, payload(await onListen(ms, brain, voice === null ? undefined : Number(voice))));
    },
    "GET /bridge/brains": (req, res) => json(res, 200, { ok: true, ...onBrains() }),
    "POST /bridge/brains/active": async (req, res) => {
      const b = await readBody(req, res);
      const roster = validName(b?.brain) ? await onActive(b.brain) : null;
      if (!roster) return json(res, 400, { error: "unknown brain" });
      json(res, 200, { ok: true, ...roster });
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
    // the wire speaks his words, the body its own: `notes` out here is `async` inside
    "GET /bridge/mode": (req, res) => json(res, 200, { ok: true, mode: toWire(onMode()) }),
    "POST /bridge/mode": async (req, res) => {
      const b = await readBody(req, res);
      const m = fromWire(b?.mode);
      if (!m) return json(res, 400, { error: `mode must be ${Object.keys(WIRE).join(" or ")}` });
      // no channel is the active one; a name off the roster is never invented here
      if (b.channel !== undefined && !onBrains().brains.some((x) => x.name === b.channel))
        return json(res, 400, { error: "unknown brain" });
      json(res, 200, { ok: true, mode: toWire(await onMode(m, b.channel)) });
    },
    // quiet was audio notes mode under another name: kept so nothing outside the repo breaks
    "GET /bridge/quiet": (req, res) => json(res, 200, { ok: true, on: onMode() === "async" }),
    "POST /bridge/quiet": async (req, res) => {
      const b = await readBody(req, res);
      if (typeof b?.on !== "boolean") return json(res, 400, { error: "on must be true or false" });
      json(res, 200, { ok: true, on: (await onMode(b.on ? "async" : "call")) === "async" });
    },
    "GET /bridge/health": (req, res) =>
      json(res, 200, {
        ok: true,
        active: onBrains().active,
        brainListening: brainListening(),
        micOpen: !!onMicOpen(),
        held: onHeld(),
        mode: toWire(onMode()),
        quiet: onMode() === "async",
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

  server.listen(port, HOST, () => log(`bridge on ${HOST}:${server.address().port}`));
  return server;
}

module.exports = { startServer };
