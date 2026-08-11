/**
 * The Dark Eye — brain, slice A1: DarkSaddler talks (terminal, text).
 *
 * One long-lived streaming session with the Claude Agent SDK, persona from
 * soul/SOUL.md. Later slices swap the terminal for the body's MCP contract
 * (listen/speak) without touching the session shape.
 *
 * Usage:
 *   pnpm start                    → interactive chat
 *   pnpm start "single question"  → one answer, then exit
 */
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import readline from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));
const soul = readFileSync(join(here, "..", "..", "soul", "SOUL.md"), "utf8");

// -- the body (Windows side) ------------------------------------------------
// WSL2 reaches Windows at the default gateway (NAT mode). The nameserver
// trick lies when WSL DNS tunneling is on, so read the route table.
function windowsHost(): string {
  if (process.env.DARK_EYE_BODY_HOST) return process.env.DARK_EYE_BODY_HOST;
  try {
    for (const line of readFileSync("/proc/net/route", "utf8").split("\n")) {
      const f = line.trim().split(/\s+/);
      if (f[1] === "00000000" && f[2] && f[2] !== "00000000") {
        const h = f[2]; // little-endian hex gateway
        return [3, 2, 1, 0].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16)).join(".");
      }
    }
  } catch {}
  return "127.0.0.1";
}
const BODY_CONFIG =
  process.env.DARK_EYE_BODY_CONFIG ??
  "/mnt/c/Users/Oscar/AppData/Roaming/dark-eye/config.json";

let bodyMcp: { type: "http"; url: string; headers: Record<string, string> } | null = null;
let bodyNote = "";
if (existsSync(BODY_CONFIG)) {
  const cfg = JSON.parse(readFileSync(BODY_CONFIG, "utf8"));
  bodyMcp = {
    type: "http",
    url: `http://${windowsHost()}:${cfg.port ?? 8642}/mcp`,
    headers: { "x-dark-eye-key": cfg.secret },
  };
  bodyNote =
    "\n\n## The body is connected (slice A2)\n" +
    "You have a voice: the mcp__body__speak tool speaks aloud through the Eye " +
    "on Oscar's desktop. ALWAYS answer Oscar by calling speak, with your reply " +
    "written in spoken form — the speak call IS your answer. Report delegated " +
    "work with mcp__body__agent_status.";
} else {
  console.error("\x1b[2m[body config not found — running voiceless]\x1b[0m");
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

const singleShot = process.argv[2];

// -- streaming input: a queue the terminal (later: the body) feeds ----------
const queue: SDKUserMessage[] = [];
let wake: (() => void) | null = null;
function say(text: string) {
  queue.push({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  } as SDKUserMessage);
  wake?.();
}
async function* input(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    while (queue.length === 0) await new Promise<void>((r) => (wake = r));
    wake = null;
    yield queue.shift()!;
  }
}

// -- the ears: poll the body's listen() and feed transcripts to the session --
async function listenLoop() {
  if (!bodyMcp) return;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  while (true) {
    try {
      const client = new Client({ name: "dark-eye-brain", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(bodyMcp.url), {
        requestInit: { headers: bodyMcp.headers },
      });
      await client.connect(transport);
      while (true) {
        const res: any = await client.callTool(
          { name: "listen", arguments: { timeoutMs: 50000 } },
          undefined,
          { timeout: 60000 }
        );
        const text = res?.content?.[0]?.text ?? "";
        if (text) {
          console.log(`\x1b[33mvoice › ${text}\x1b[0m`);
          say(text);
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 3000)); // body away — retry quietly
    }
  }
}
listenLoop();

// -- terminal (interactive mode only) ---------------------------------------
let prompt = () => {};
if (!singleShot) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  prompt = () => {
    rl.setPrompt(green("you › "));
    rl.prompt();
  };
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return prompt();
    if (text === "/quit") process.exit(0);
    say(text);
  });
  rl.on("close", () => process.exit(0));
  console.log(dim("The Dark Eye — brain A1. DarkSaddler is listening. /quit to leave.\n"));
  prompt();
} else {
  say(singleShot);
}

for await (const message of query({
  prompt: input(),
  options: {
    systemPrompt: { type: "preset", preset: "claude_code", append: soul + bodyNote },
    maxTurns: 1000,
    ...(bodyMcp
      ? {
          mcpServers: { body: bodyMcp },
          allowedTools: ["mcp__body__speak", "mcp__body__agent_status"],
        }
      : {}),
  },
})) {
  if (message.type === "system" && message.subtype === "init") {
    console.log(dim(`[session ${message.session_id} · ${message.model}]\n`));
  } else if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") {
        process.stdout.write(`\n${block.text}\n\n`);
      } else if (block.type === "tool_use") {
        console.log(dim(`  ⚙ ${block.name}`));
      }
    }
  } else if (message.type === "result") {
    if (message.subtype !== "success") {
      console.error(dim(`[${message.subtype}]`));
    }
    if (singleShot) process.exit(0);
    prompt();
  }
}
