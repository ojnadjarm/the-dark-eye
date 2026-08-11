/**
 * The body's MCP server — the contract any brain speaks (spec §8).
 * Stateless streamable HTTP on :8642, guarded by a shared secret header.
 * MCP tools: listen, speak, agent_status, attention (default session "fast").
 * Plain-HTTP bridge: speak/listen/status/cloak/attention/active/sessions
 * (listen defaults to session "deep"). Oscar routes his voice between
 * sessions by saying "switch to <name>" — handled in main.js, not here.
 */
const http = require("node:http");
const os = require("node:os");
const crypto = require("node:crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

// Brains live in WSL2, so the server only needs the vEthernet (WSL) adapter —
// binding it keeps the port off Wi-Fi/Ethernet, where the secret would be the
// only gate between the LAN and Oscar's speakers.
function wslAdapterAddress() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!/wsl/i.test(name)) continue;
    const v4 = (addrs ?? []).find((a) => a.family === "IPv4" && !a.internal);
    if (v4) return v4.address;
  }
  return null;
}

function buildMcp({ onSpeak, onStatus, onAttention, onIntroduce, onRegister, hub }) {
  const mcp = new McpServer({ name: "dark-eye-body", version: "0.1.0" });

  mcp.registerTool(
    "register",
    {
      description:
        "Join the Eye as a session. Pick a short name and optionally a hex color; both must " +
        "be unique (green belongs to the Eye — it will be refused). Returns your final " +
        "name/color and the full roster of sessions. Call this FIRST, then listen with your name.",
      inputSchema: {
        name: z.string().describe("Your session name, e.g. 'research' — lowercase, short"),
        color: z.string().optional().describe("Preferred hex color like '#ff9a4d'; auto-assigned if taken/omitted"),
        brief: z.string().optional().describe("One line: what this session is doing"),
      },
    },
    async ({ name, color, brief }) => {
      const r = await onRegister({ name, color, brief });
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    }
  );

  mcp.registerTool(
    "listen",
    {
      description:
        "Wait for Oscar's next spoken words (push-to-talk). Long-polls up to timeoutMs; " +
        "returns empty text if he said nothing in that window. Words arrive only while " +
        "your session is the active voice channel (he says 'switch to <session>').",
      inputSchema: {
        timeoutMs: z.number().optional(),
        session: z.string().optional().describe("Your registered session name (default 'fast' — register first and pass your own)"),
      },
    },
    async ({ timeoutMs, session }) => {
      hub.touch(session || "fast");
      const t = await hub.bus(session || "fast").take(Math.min(timeoutMs ?? 50000, 55000));
      return { content: [{ type: "text", text: t ?? "" }] };
    }
  );

  mcp.registerTool(
    "introduce",
    {
      description:
        "Tell Oscar what this session is, in one short line (shown silently on the Eye " +
        "and next to your name in the tray). Call once when you connect, and again if " +
        "what you're working on changes.",
      inputSchema: {
        brief: z.string().describe("One line: what this session is doing, e.g. 'refactoring cryptodesk auth'"),
        session: z.string().optional().describe("Session name (default 'fast')"),
      },
    },
    async ({ brief, session }) => {
      await onIntroduce({ session: session || "fast", brief });
      return { content: [{ type: "text", text: "ok" }] };
    }
  );

  mcp.registerTool(
    "attention",
    {
      description:
        "Ask for Oscar's attention without speaking: the Eye tints to your session color " +
        "until he switches to you or you clear it. Use when you need his input but he may " +
        "be away or busy — never speak unprompted.",
      inputSchema: {
        on: z.boolean(),
        label: z.string().optional().describe("Short reason, e.g. 'needs approval'"),
        session: z.string().optional().describe("Session name (default 'fast')"),
      },
    },
    async ({ on, label, session }) => {
      await onAttention({ session: session || "fast", on, label });
      return { content: [{ type: "text", text: "ok" }] };
    }
  );

  mcp.registerTool(
    "speak",
    {
      description:
        "Speak to Oscar out loud through the Eye. This is your voice — use it to answer him. " +
        "Plain spoken language, no markdown, under 150 words.",
      inputSchema: { text: z.string().describe("What to say, written for the ear") },
    },
    async ({ text }) => {
      await onSpeak(text);
      return { content: [{ type: "text", text: "spoken" }] };
    }
  );

  mcp.registerTool(
    "agent_status",
    {
      description:
        "Report a subagent's state so the Eye can show it. Call when you spawn, progress, or finish delegated work.",
      inputSchema: {
        id: z.string().describe("Stable id of the subagent/task"),
        state: z.enum(["working", "done", "error"]),
        label: z.string().describe("Short human label, e.g. 'deps-updater · cryptodesk'"),
      },
    },
    async ({ id, state, label }) => {
      await onStatus({ id, state, label });
      return { content: [{ type: "text", text: "ok" }] };
    }
  );

  return mcp;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
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

function startServer({ port, secret, onSpeak, onStatus, onCloak, onAttention, onActive, onIntroduce, onRegister, hub, log }) {
  if (!secret) throw new Error("refusing to serve without a secret — check config.json");
  const secretBuf = Buffer.from(secret);
  const authed = (req) => {
    const key = req.headers["x-dark-eye-key"];
    if (typeof key !== "string") return false;
    const keyBuf = Buffer.from(key);
    return keyBuf.length === secretBuf.length && crypto.timingSafeEqual(keyBuf, secretBuf);
  };
  const server = http.createServer(async (req, res) => {
    if (!authed(req)) {
      res.writeHead(401).end();
      return;
    }
    // plain-HTTP side door for simple brains (curl-class clients)
    if (req.url === "/bridge/speak" && req.method === "POST") {
      try {
        const body = await readBody(req);
        await onSpeak(String(body?.text ?? ""));
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      } catch (err) {
        log(`bridge speak error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    if (req.url === "/bridge/cloak" && req.method === "POST") {
      try {
        const body = await readBody(req);
        await onCloak(!!body?.on);
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      } catch (err) {
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    if (req.url === "/bridge/status" && req.method === "POST") {
      try {
        const body = await readBody(req);
        await onStatus({
          id: String(body?.id ?? "task"),
          state: body?.state === "done" || body?.state === "error" ? body.state : "working",
          label: String(body?.label ?? ""),
        });
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      } catch (err) {
        log(`bridge status error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    if (new URL(req.url, "http://localhost").pathname === "/bridge/listen" && req.method === "GET") {
      const u = new URL(req.url, "http://localhost");
      const rawMs = Number(u.searchParams.get("timeoutMs") || 50000);
      const ms = Math.min(Number.isFinite(rawMs) && rawMs > 0 ? rawMs : 50000, 55000);
      const session = u.searchParams.get("session") || "deep";
      hub.touch(session);
      const t = await hub.bus(session).take(ms);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ transcript: t }));
      return;
    }
    if (req.url === "/bridge/attention" && req.method === "POST") {
      try {
        const body = await readBody(req);
        await onAttention({
          session: String(body?.session ?? "deep"),
          on: !!body?.on,
          label: body?.label ? String(body.label) : "",
        });
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      } catch (err) {
        log(`bridge attention error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    if (req.url === "/bridge/register" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const r = await onRegister({
          name: body?.name,
          color: body?.color,
          brief: body?.brief ? String(body.brief) : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(r));
      } catch (err) {
        log(`bridge register error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    if (req.url === "/bridge/introduce" && req.method === "POST") {
      try {
        const body = await readBody(req);
        await onIntroduce({
          session: String(body?.session ?? "deep"),
          brief: String(body?.brief ?? ""),
        });
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      } catch (err) {
        log(`bridge introduce error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    if (req.url === "/bridge/active" && req.method === "POST") {
      try {
        const body = await readBody(req);
        await onActive(String(body?.session ?? "deep"));
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      } catch (err) {
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    if (req.url === "/bridge/sessions" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ active: hub.active, sessions: hub.roster() })
      );
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    try {
      const body = await readBody(req);
      // Stateless: fresh server+transport per request.
      const mcp = buildMcp({ onSpeak, onStatus, onAttention, onIntroduce, onRegister, hub });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`mcp error: ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  const host = wslAdapterAddress();
  if (host) server.listen(port, host, () => log(`MCP server on ${host}:${port}/mcp (WSL adapter only)`));
  else {
    log("WARN: WSL adapter not found — binding all interfaces; port 8642 is LAN-visible");
    server.listen(port, "0.0.0.0", () => log(`MCP server on :${port}/mcp`));
  }
  return server;
}

module.exports = { startServer };
