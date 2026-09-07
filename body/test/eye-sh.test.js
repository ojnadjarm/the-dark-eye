/** bridge/eye.sh against a stub bridge: every subcommand, validation, exit codes. */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EYE = path.join(__dirname, "..", "..", "bridge", "eye.sh");
const SECRET = "test-secret";

let server;
let seen;
let replies;
let dir;
let env;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-dark-eye-key"], body });
      res.writeHead(200, { "Content-Type": "application/json" }).end(replies.shift() ?? '{"ok":true}');
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eye-sh-"));
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ secret: SECRET, port: server.address().port })
  );
  env = { ...process.env, DARK_EYE_CONFIG: path.join(dir, "config.json") };
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  replies = [];
});

// spawnSync would block the loop the stub server runs on — every call is async
const run = (args, opts = {}) =>
  new Promise((resolve) => {
    const { input, ...rest } = opts;
    const p = spawn("bash", [EYE, ...args], { env, ...rest });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.stdin.on("error", () => {}); // a command that never reads stdin (e.g. help) can close it first
    p.stdin.end(input ?? "");
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
const sent = () => JSON.parse(seen[0].body);

test("help lists the verbs and exits 0", async () => {
  const r = await run(["help"]);
  assert.equal(r.status, 0, r.stderr);
  for (const v of ["speak", "listen", "listen-loop", "mic", "status", "show", "tv", "health"])
    assert.match(r.stdout, new RegExp(`\\b${v}\\b`), r.stderr);
});

test("no dropped verbs survive", async () => {
  const src = fs.readFileSync(EYE, "utf8");
  for (const gone of ["field", "register", "introduce", "attention", "active", "sessions", "cloak"])
    assert.equal(src.includes(gone), false, gone);
});

test("an unknown command exits 1", async () => {
  const r = await run(["conjure"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command/);
});

test("a missing config is a clear error", async () => {
  const r = await run(["health"], { env: { ...env, DARK_EYE_CONFIG: "/nonexistent/config.json" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /config/);
});

test("health prints the body and carries the secret", async () => {
  replies = ['{"ok":true,"brainListening":false,"micOpen":false}'];
  const r = await run(["health"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"ok":true/);
  assert.equal(seen[0].key, SECRET);
  assert.equal(seen[0].url, "/bridge/health");
});

test("tv with no argument reads the override", async () => {
  replies = ['{"ok":true,"mode":"off","on":false}'];
  const r = await run(["tv"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "/bridge/tv");
  assert.match(r.stdout, /"mode":"off"/);
});

test("tv off|on|auto post the mode", async () => {
  for (const mode of ["off", "on", "auto"]) {
    seen = [];
    await run(["tv", mode]);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/bridge/tv");
    assert.deepEqual(sent(), { mode });
  }
});

test("tv rejects anything else and sends nothing", async () => {
  const r = await run(["tv", "dark"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: eye tv/);
  assert.equal(seen.length, 0);
});

test("speak posts the joined words", async () => {
  await run(["speak", "bridge", "is", "up"]);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/bridge/speak");
  assert.deepEqual(sent(), { text: "bridge is up" });
});

test("speak --voice sends a numeric sid", async () => {
  await run(["speak", "hello", "there", "--voice", "17"]);
  assert.deepEqual(sent(), { text: "hello there", voice: 17 });
});

test("speak rejects an empty text and a bad sid", async () => {
  assert.notEqual((await run(["speak"])).status, 0);
  assert.notEqual((await run(["speak", "hi", "--voice", "loud"])).status, 0);
  assert.equal(seen.length, 0);
});

test("speak --to sends the channel, and no --to sends none", async () => {
  for (const to of ["local", "remote", "both"]) {
    seen = [];
    await run(["speak", "on the phone", "--to", to]);
    assert.deepEqual(sent(), { text: "on the phone", to });
  }
  seen = [];
  await run(["speak", "plain"]);
  assert.deepEqual(sent(), { text: "plain" });
});

test("speak rejects a channel that is not one of the three", async () => {
  for (const to of ["phone", "", "LOCAL"]) assert.notEqual((await run(["speak", "hi", "--to", to])).status, 0);
  assert.equal(seen.length, 0);
});

test("listen prints a VOICE line", async () => {
  replies = ['{"transcript":"open the canvas"}'];
  const r = await run(["listen", "1000"]);
  assert.equal(r.stdout.trim(), "VOICE: open the canvas");
  assert.equal(seen[0].url, "/bridge/listen?timeoutMs=1000");
});

test("a remote transcript is marked, a local one is not", async () => {
  replies = ['{"transcript":"are you there","source":"remote"}'];
  assert.equal((await run(["listen", "1000"])).stdout, "VOICE [remote]: are you there\n");
  seen = [];
  replies = ['{"transcript":"are you there","source":"local"}'];
  assert.equal((await run(["listen", "1000"])).stdout, "VOICE: are you there\n");
});

test("listen prints an EVENT line with its detail", async () => {
  replies = ['{"transcript":null,"event":"canvas-approved","detail":"login mockup"}'];
  assert.equal((await run(["listen"])).stdout.trim(), "EVENT: canvas-approved — login mockup");
  assert.equal(seen[0].url, "/bridge/listen?timeoutMs=50000");
});

test("a silent listen prints nothing", async () => {
  replies = ['{"transcript":null}'];
  assert.equal((await run(["listen", "500"])).stdout.trim(), "");
});

test("listen rejects a non-numeric timeout", async () => {
  assert.notEqual((await run(["listen", "soon"])).status, 0);
  assert.equal(seen.length, 0);
});

test("mic with no argument toggles", async () => {
  replies = ['{"ok":true,"on":true}'];
  const r = await run(["mic"]);
  assert.deepEqual(sent(), {});
  assert.match(r.stdout, /"on":true/);
});

test("mic on and mic off set the state", async () => {
  await run(["mic", "on"]);
  assert.deepEqual(sent(), { on: true });
  seen = [];
  await run(["mic", "off"]);
  assert.deepEqual(sent(), { on: false });
});

test("mic rejects anything but on/off", async () => {
  assert.notEqual((await run(["mic", "maybe"])).status, 0);
  assert.equal(seen.length, 0);
});

test("status posts id, state and label", async () => {
  await run(["status", "t1", "working", "e03", "bridge"]);
  assert.deepEqual(sent(), { id: "t1", state: "working", label: "e03 bridge" });
});

test("status validates its arguments", async () => {
  assert.notEqual((await run(["status", "t1"])).status, 0);
  assert.notEqual((await run(["status", "t1", "thinking", "x"])).status, 0);
  assert.equal(seen.length, 0);
});

test("show packages an html file", async () => {
  const f = path.join(dir, "page.html");
  fs.writeFileSync(f, "<p>hello</p>");
  replies = ['{"ok":true,"id":"1"}'];
  await run(["show", "a page", f]);
  assert.deepEqual(sent(), { title: "a page", kind: "html", data: "<p>hello</p>", verdict: false });
});

test("show packages an image as a data URL and takes --ask", async () => {
  const f = path.join(dir, "shot.png");
  fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await run(["show", "a shot", f, "--ask"]);
  const b = sent();
  assert.equal(b.kind, "image");
  assert.equal(b.verdict, true);
  assert.equal(b.data, "data:image/png;base64,iVBORw==");
});

test("show reads html from stdin and text from a .txt", async () => {
  await run(["show", "piped", "-"], { input: "<h1>hi</h1>" });
  assert.deepEqual(sent(), { title: "piped", kind: "html", data: "<h1>hi</h1>", verdict: false });
  seen = [];
  const f = path.join(dir, "notes.txt");
  fs.writeFileSync(f, "plain words");
  await run(["show", "notes", f]);
  assert.equal(sent().kind, "text");
});

test("show refuses a missing file and missing arguments", async () => {
  assert.notEqual((await run(["show", "gone", path.join(dir, "nope.html")])).status, 0);
  assert.notEqual((await run(["show", "only a title"])).status, 0);
  assert.equal(seen.length, 0);
});

test("an HTTP error says what the Eye said, not \"down? bad key?\"", async () => {
  const errServer = http.createServer((req, res) => {
    const [code, body] = replies.shift();
    res.writeHead(code, { "Content-Type": "application/json" }).end(body);
  });
  errServer.listen(0, "127.0.0.1");
  await new Promise((r) => errServer.once("listening", r));
  const cfg = writeConfig(errServer.address().port);
  const opts = { env: { ...env, DARK_EYE_CONFIG: cfg } };

  replies = [[400, '{"error":"no data"}']];
  assert.match((await run(["health"], opts)).stderr, /400.*no data/);
  replies = [[401, ""]];
  assert.match((await run(["health"], opts)).stderr, /401/);
  replies = [[404, ""]];
  assert.match((await run(["health"], opts)).stderr, /404/);
  errServer.close();
});

test("a dead bridge is a loud failure", async () => {
  const r = await run(["health"], { env: { ...env, DARK_EYE_CONFIG: writeConfig(1) } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no response/);
});

function writeConfig(port) {
  const f = path.join(dir, `config-${port}.json`);
  fs.writeFileSync(f, JSON.stringify({ secret: SECRET, port }));
  return f;
}

test("listen-loop prints both kinds of line and survives the bridge dying", async () => {
  const loopServer = http.createServer((req, res) => {
    const r = replies.shift();
    if (r === undefined) return void res.destroy();
    res.writeHead(200, { "Content-Type": "application/json" }).end(r);
  });
  loopServer.listen(0, "127.0.0.1");
  await new Promise((r) => loopServer.once("listening", r));
  replies = ['{"transcript":"first words"}', '{"transcript":null,"event":"channel-open","detail":""}'];
  const cfg = writeConfig(loopServer.address().port);

  const p = spawn("bash", [EYE, "listen-loop"], { env: { ...env, DARK_EYE_CONFIG: cfg } });
  let out = "";
  const done = new Promise((resolve) => {
    const timer = setTimeout(resolve, 15000);
    p.stdout.on("data", (c) => {
      out += c;
      if (out.includes("EYE OFFLINE")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await done;
  p.kill("SIGKILL");
  loopServer.close();
  assert.match(out, /VOICE: first words/);
  assert.match(out, /EVENT: channel-open/);
  assert.match(out, /EYE OFFLINE/);
  assert.equal(out.includes("— "), false, "an empty detail adds no dash");
});
