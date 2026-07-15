// BREWDECK server — espresso-bar voice console for Claude Code.
// Serves the mobile UI over HTTPS (self-signed, LAN), gates it with a PIN,
// runs `claude -p` jobs with streamed output over WebSocket, and aggregates
// token usage from ~/.claude/projects for the ledger tab.

import express from "express";
import { WebSocketServer } from "ws";
import https from "node:https";
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";
import qrcode from "qrcode-terminal";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "brewdeck.config.json");
const CERT_DIR = path.join(ROOT, ".cert");
const DESKTOP = path.join(os.homedir(), "OneDrive", "Desktop");
const CLAUDE_DIR = path.join(os.homedir(), ".claude");

// ---------------------------------------------------------------- config

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* first run */
  }
  let dirty = false;
  if (!cfg.pin) {
    cfg.pin = String(Math.floor(1000 + Math.random() * 9000));
    dirty = true;
  }
  if (!cfg.port) {
    cfg.port = 8443;
    dirty = true;
  }
  if (!cfg.secret) {
    cfg.secret = randomBytes(16).toString("hex");
    dirty = true;
  }
  if (!cfg.defaultWorkspace) {
    cfg.defaultWorkspace = ROOT;
    dirty = true;
  }
  if (dirty) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

const config = loadConfig();
const TOKEN = createHash("sha256").update(config.pin + ":" + config.secret).digest("hex").slice(0, 40);

// ---------------------------------------------------------------- tls

// All non-internal IPv4 addresses currently bound to this machine — LAN and
// Tailscale both show up here (Tailscale is just another network adapter).
// Windows self-assigns a 169.254.0.0/16 (APIPA) address to an adapter that's
// up but hasn't actually gotten a real address yet (DHCP still negotiating,
// or — as with Tailscale mid-reconnect — waiting on its coordination
// server). Nothing outside this machine can ever reach a link-local
// address, so it's never a valid answer to "how does my phone reach me."
function isLinkLocal(ip) {
  const p = ip.split(".").map(Number);
  return p[0] === 169 && p[1] === 254;
}

function allIPs() {
  const out = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal && !isLinkLocal(i.address)) out.push({ ip: i.address, name });
    }
  }
  return out;
}

// Tailscale hands out 100.64.0.0/10 (CGNAT range) — that's how we tell a
// "reachable from anywhere, still private" address apart from a plain LAN one.
function isTailscaleIP(ip) {
  const p = ip.split(".").map(Number);
  return p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

function lanIPs() {
  return allIPs()
    .filter((e) => !isTailscaleIP(e.ip))
    .map((e) => e.ip);
}

function tailscaleIPs() {
  return allIPs()
    .filter((e) => isTailscaleIP(e.ip) || /tailscale/i.test(e.name))
    .map((e) => e.ip);
}

// Regenerate the cert whenever the machine's address set has grown (new
// Wi-Fi, Tailscale just came up, etc.) so the SAN list stays valid —
// otherwise phones get a hostname mismatch instead of just the expected
// self-signed warning.
function ensureCert() {
  const keyPath = path.join(CERT_DIR, "key.pem");
  const crtPath = path.join(CERT_DIR, "cert.pem");
  const ipsPath = path.join(CERT_DIR, "ips.json");
  const currentIPs = [...lanIPs(), ...tailscaleIPs()].sort();

  if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
    let coveredIPs = [];
    try {
      coveredIPs = JSON.parse(fs.readFileSync(ipsPath, "utf8"));
    } catch {
      /* pre-dates ips.json; force regen below by leaving coveredIPs empty */
    }
    const allCovered = currentIPs.every((ip) => coveredIPs.includes(ip));
    if (allCovered && coveredIPs.length) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(crtPath) };
    }
  }

  const attrs = [{ name: "commonName", value: "brewdeck.local" }];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 2, value: "brewdeck.local" },
          ...currentIPs.map((ip) => ({ type: 7, ip })),
        ],
      },
    ],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(crtPath, pems.cert);
  fs.writeFileSync(ipsPath, JSON.stringify(currentIPs));
  return { key: pems.private, cert: pems.cert };
}

// ---------------------------------------------------------------- app

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public"), { index: "index.html" }));

function authed(req) {
  const t = req.headers["x-brewdeck-token"] || req.query.token;
  return t === TOKEN;
}
function requireAuth(req, res, next) {
  if (!authed(req)) return res.status(401).json({ error: "locked" });
  next();
}

// Brute-force guard on the PIN. Matters more once BREWDECK is reachable off
// the LAN (Tailscale) — a 4-digit PIN is fine behind a rate limit, not
// fine as the only gate on an internet-shaped endpoint. Per-source-IP
// sliding window + escalating lockout; in-memory is enough for a single
// household appliance.
const loginAttempts = new Map(); // ip -> {count, firstAt, lockedUntil}
function loginLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (rec?.lockedUntil > now) {
    const waitS = Math.ceil((rec.lockedUntil - now) / 1000);
    return res.status(429).json({ error: `too many tries — wait ${waitS}s` });
  }
  if (!rec || now - rec.firstAt > 10 * 60_000) {
    rec = { count: 0, firstAt: now, lockedUntil: 0 };
    loginAttempts.set(ip, rec);
  }
  req._loginRec = rec;
  next();
}
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [ip, r] of loginAttempts) if (r.firstAt < cutoff && r.lockedUntil < Date.now()) loginAttempts.delete(ip);
}, 5 * 60_000).unref();

app.post("/api/login", loginLimiter, (req, res) => {
  const rec = req._loginRec;
  if (String(req.body?.pin || "") === config.pin) {
    rec.count = 0;
    res.json({ token: TOKEN });
  } else {
    rec.count++;
    if (rec.count >= 6) {
      rec.lockedUntil = Date.now() + Math.min(2 ** (rec.count - 6), 32) * 15_000; // 15s, 30s, 60s… capped ~8min
    }
    res.status(403).json({ error: "wrong pin" });
  }
});

const MODELS = [
  { id: "haiku", name: "HAIKU", roast: "Light Roast", note: "Fast pour, bright and cheap. Everyday errands.", speed: 3, depth: 1 },
  { id: "sonnet", name: "SONNET", roast: "House Blend", note: "Balanced daily driver. Smooth body, quick crema.", speed: 2, depth: 2 },
  { id: "opus", name: "OPUS", roast: "Dark Roast", note: "Deep extraction. Heavy body for serious work.", speed: 1, depth: 3 },
  { id: "fable", name: "FABLE", roast: "Reserve Ristretto", note: "Top shelf, single origin. Maximum brainpower.", speed: 1, depth: 4 },
];

const EFFORTS = [
  { id: "low", name: "SINGLE", note: "one quick shot" },
  { id: "medium", name: "DOPPIO", note: "standard double" },
  { id: "high", name: "TRIPLE", note: "strong pull" },
  { id: "xhigh", name: "QUAD", note: "very strong" },
  { id: "max", name: "DEATH WISH", note: "maximum extraction" },
];

app.get("/api/state", requireAuth, (req, res) => {
  res.json({
    models: MODELS,
    efforts: EFFORTS,
    workspaces: listWorkspaces(),
    defaultWorkspace: config.defaultWorkspace,
    host: os.hostname(),
    version: "1.0.0",
  });
});

function listWorkspaces() {
  const out = [];
  try {
    for (const e of fs.readdirSync(DESKTOP, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(DESKTOP, e.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(p).mtimeMs;
      } catch {}
      out.push({ name: e.name, path: p, mtime });
    }
  } catch {
    /* desktop missing? fall through */
  }
  out.sort((a, b) => b.mtime - a.mtime); // most recently touched first
  const trimmed = out.slice(0, 30).map(({ name, path: p }) => ({ name, path: p }));
  if (!trimmed.some((w) => w.path === ROOT)) trimmed.unshift({ name: "brewdeck", path: ROOT });
  return trimmed;
}

function safeWorkspace(p) {
  if (!p) return config.defaultWorkspace;
  const norm = path.resolve(String(p));
  const okRoots = [DESKTOP, ROOT];
  if (okRoots.some((r) => norm === r || norm.startsWith(r + path.sep))) {
    try {
      if (fs.statSync(norm).isDirectory()) return norm;
    } catch {
      /* not a dir */
    }
  }
  return config.defaultWorkspace;
}

// ---------------------------------------------------------------- usage ledger

const RATES = {
  // USD per MTok: [input, output]; cache write = 1.25x in, cache read = 0.1x in
  haiku: [1, 5],
  sonnet: [3, 15],
  opus: [15, 75],
  fable: [15, 75], // unpublished — estimate with opus rates
  default: [3, 15],
};

function rateFor(model) {
  const m = String(model || "").toLowerCase();
  for (const k of Object.keys(RATES)) {
    if (k !== "default" && m.includes(k)) return RATES[k];
  }
  return RATES.default;
}

function shortModel(model) {
  const m = String(model || "").toLowerCase();
  for (const k of ["haiku", "sonnet", "opus", "fable"]) {
    if (m.includes(k)) return k;
  }
  return m || "other";
}

async function collectUsage(days = 14) {
  const projDir = path.join(CLAUDE_DIR, "projects");
  const cutoff = Date.now() - days * 86400_000;
  const files = [];
  try {
    for (const proj of fs.readdirSync(projDir)) {
      const pdir = path.join(projDir, proj);
      let entries;
      try {
        entries = fs.readdirSync(pdir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = path.join(pdir, f);
        try {
          const st = fs.statSync(fp);
          if (st.mtimeMs >= cutoff && st.size > 0) files.push(fp);
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    return { days: [], models: {}, today: emptyBucket(), totalCost: 0, note: "no ~/.claude/projects data found" };
  }

  const byDay = new Map();
  const byModel = new Map();
  const seen = new Set();

  for (const fp of files) {
    await new Promise((resolve) => {
      const rl = readline.createInterface({ input: fs.createReadStream(fp), crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (line.length < 20 || !line.includes('"usage"')) return;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          return;
        }
        const msg = j.message;
        const u = msg?.usage;
        if (!u || j.type !== "assistant") return;
        if (String(msg.model || "").includes("synthetic")) return; // error placeholders
        const key = (msg.id || "") + ":" + (j.requestId || "");
        if (key !== ":" && seen.has(key)) return;
        seen.add(key);
        const ts = Date.parse(j.timestamp || 0);
        if (!ts || ts < cutoff) return;
        const day = new Date(ts).toLocaleDateString("en-CA"); // YYYY-MM-DD local
        const model = shortModel(msg.model);
        const inTok = u.input_tokens || 0;
        const outTok = u.output_tokens || 0;
        const cacheW = u.cache_creation_input_tokens || 0;
        const cacheR = u.cache_read_input_tokens || 0;
        let cost = typeof j.costUSD === "number" ? j.costUSD : null;
        if (cost == null) {
          const [ri, ro] = rateFor(msg.model);
          cost = (inTok * ri + cacheW * ri * 1.25 + cacheR * ri * 0.1 + outTok * ro) / 1e6;
        }
        addTo(byDay, day, inTok, outTok, cacheW, cacheR, cost);
        addTo(byModel, model, inTok, outTok, cacheW, cacheR, cost);
      });
      rl.on("close", resolve);
      rl.on("error", resolve);
    });
  }

  const todayKey = new Date().toLocaleDateString("en-CA");
  const daysArr = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([d, v]) => ({ day: d, ...v }));
  const models = {};
  for (const [m, v] of byModel) models[m] = v;
  let totalCost = 0;
  for (const d of daysArr) totalCost += d.cost;
  return {
    days: daysArr,
    models,
    today: byDay.get(todayKey) || emptyBucket(),
    totalCost,
    estNote: "costs estimated from public per-token rates",
  };
}

function emptyBucket() {
  return { inTok: 0, outTok: 0, cacheW: 0, cacheR: 0, cost: 0, msgs: 0 };
}
function addTo(map, key, i, o, cw, cr, c) {
  let b = map.get(key);
  if (!b) map.set(key, (b = emptyBucket()));
  b.inTok += i;
  b.outTok += o;
  b.cacheW += cw;
  b.cacheR += cr;
  b.cost += c;
  b.msgs += 1;
}

app.get("/api/usage", requireAuth, async (req, res) => {
  try {
    res.json(await collectUsage(14));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ---------------------------------------------------------------- brewing (claude jobs)

const VALID_MODELS = new Set(MODELS.map((m) => m.id));
const VALID_EFFORTS = new Set(EFFORTS.map((e) => e.id));

// The claude child runs on the PC, not in the browser, so a brew has no reason
// to die when the phone locks / the tab closes / wifi drops. A Brew therefore
// outlives any single socket: it buffers everything it emits into `log` and a
// reconnecting client re-attaches and replays it. Only an explicit "spill"
// (or the process finishing / --max-budget-usd) ends a brew.
let currentBrew = null;

const LOG_TEXT_CAP = 400_000; // chars of streamed text kept for replay

class Brew {
  constructor(params, ws) {
    this.ws = ws; // bound directly; attach() is for RECONNECTS (it replays)
    this.dead = false;
    this.log = [];
    this.logText = 0;

    const model = VALID_MODELS.has(params.model) ? params.model : "sonnet";
    const effort = VALID_EFFORTS.has(params.effort) ? params.effort : "medium";
    const budget = Math.min(Math.max(Number(params.budget) || 2, 0.05), 20);
    const cwd = safeWorkspace(params.workspace);

    const args = [
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", model,
      "--effort", effort,
      "--permission-mode", "bypassPermissions",
      "--max-budget-usd", String(budget),
    ];
    if (params.resume && /^[0-9a-f-]{16,}$/i.test(params.resume)) {
      args.push("--resume", params.resume);
    }

    // text rides along so a reconnecting client can rebuild the order bubble
    this.send({ type: "brewing", model, effort, cwd, budget, text: String(params.text || "") });

    this.child = spawn("claude", args, {
      cwd,
      shell: true, // resolves claude.cmd on Windows; args contain no spaces
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdin.write(String(params.text || ""));
    this.child.stdin.end();

    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));

    let errBuf = "";
    this.child.stderr.on("data", (d) => {
      errBuf += d.toString();
      if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
    });

    this.child.on("close", (code) => {
      if (this.dead) return;
      if (code !== 0 && errBuf.trim()) {
        this.send({ type: "stderr", text: errBuf.trim().slice(-1500) });
      }
      this.send({ type: "done", code });
      this.dead = true;
    });
    this.child.on("error", (err) => {
      this.send({ type: "stderr", text: "failed to start claude: " + err.message });
      this.send({ type: "done", code: -1 });
      this.dead = true;
    });
  }

  onLine(line) {
    if (!line.startsWith("{")) return;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    switch (j.type) {
      case "system":
        if (j.subtype === "init") {
          this.send({ type: "session", id: j.session_id, model: j.model });
        }
        break;
      case "stream_event": {
        const ev = j.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          this.send({ type: "delta", text: ev.delta.text });
        }
        break;
      }
      case "assistant": {
        const blocks = j.message?.content || [];
        for (const b of blocks) {
          if (b.type === "tool_use") {
            this.send({ type: "tool", name: b.name, hint: toolHint(b) });
          }
        }
        break;
      }
      case "result": {
        this.send({
          type: "result",
          ok: !j.is_error,
          cost: j.total_cost_usd ?? null,
          turns: j.num_turns ?? null,
          ms: j.duration_ms ?? null,
          sessionId: j.session_id || null,
          text: typeof j.result === "string" ? j.result : null,
          usage: j.usage
            ? {
                inTok: j.usage.input_tokens || 0,
                outTok: j.usage.output_tokens || 0,
                cacheR: j.usage.cache_read_input_tokens || 0,
              }
            : null,
        });
        break;
      }
    }
  }

  send(obj) {
    // coalesce consecutive deltas so a long brew's replay log stays small
    const last = this.log[this.log.length - 1];
    if (obj.type === "delta" && last?.type === "delta" && this.logText < LOG_TEXT_CAP) {
      last.text += obj.text;
      this.logText += obj.text.length;
    } else {
      if (obj.type === "delta") {
        if (this.logText >= LOG_TEXT_CAP) return this.wire(obj); // stream on, stop buffering
        this.logText += obj.text.length;
      }
      this.log.push(obj);
    }
    this.wire(obj);
  }

  wire(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  attach(ws) {
    this.ws = ws;
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "replay", start: true }));
    for (const o of this.log) ws.send(JSON.stringify(o));
    ws.send(JSON.stringify({ type: "replay", start: false, live: !this.dead }));
  }

  detach(ws) {
    if (this.ws === ws) this.ws = null; // brew keeps running, just unwatched
  }

  stop() {
    if (this.dead || !this.child?.pid) return;
    this.dead = true;
    // kill the whole tree on Windows (claude spawns children)
    execFile("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], () => {});
    this.send({ type: "done", code: 130, stopped: true });
  }
}

function toolHint(block) {
  const inp = block.input || {};
  try {
    switch (block.name) {
      case "Bash":
      case "PowerShell":
        return String(inp.command || "").slice(0, 80);
      case "Read":
      case "Write":
      case "Edit":
        return path.basename(String(inp.file_path || ""));
      case "Glob":
      case "Grep":
        return String(inp.pattern || "").slice(0, 60);
      case "WebFetch":
      case "WebSearch":
        return String(inp.url || inp.query || "").slice(0, 60);
      default: {
        const s = JSON.stringify(inp);
        return s.length > 60 ? s.slice(0, 60) + "…" : s;
      }
    }
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- boot

const tls = ensureCert();
const server = https.createServer(tls, app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "https://x");
  if (url.searchParams.get("token") !== TOKEN) {
    ws.close(4001, "locked");
    return;
  }
  // tell the client whether a brew is running before anything else, so a
  // client that thinks it's mid-brew can correct itself if the bar restarted
  ws.send(JSON.stringify({ type: "hello", brewing: !!(currentBrew && !currentBrew.dead) }));
  // reconnecting into a brew (still running, or finished while away)? catch up
  if (currentBrew) currentBrew.attach(ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "brew") {
      if (currentBrew && !currentBrew.dead) {
        ws.send(JSON.stringify({ type: "stderr", text: "already brewing — spill it first" }));
        return;
      }
      currentBrew = new Brew(msg, ws);
    } else if (msg.type === "stop") {
      currentBrew?.stop();
    } else if (msg.type === "ping") {
      ws.send('{"type":"pong"}');
    }
  });
  ws.on("close", () => currentBrew?.detach(ws));
});

server.listen(config.port, "0.0.0.0", () => {
  const lan = lanIPs();
  const tsIPs = tailscaleIPs();
  const lanUrls = lan.map((ip) => `https://${ip}:${config.port}`);
  const tsUrls = tsIPs.map((ip) => `https://${ip}:${config.port}`);

  console.log("\n  ☕ BREWDECK is open\n");
  console.log("  PIN:", config.pin);
  console.log("  Local:  https://localhost:" + config.port);
  for (const u of lanUrls) console.log("  Wi-Fi:  " + u + "   (needs phone on this same Wi-Fi)");

  if (tsUrls.length) {
    console.log("");
    for (const u of tsUrls) console.log("  Anywhere (Tailscale): " + u + "   (works on any network)");
  }

  console.log("\n  Whichever URL you use, accept the one-time certificate warning");
  console.log("  (self-signed) — voice needs HTTPS.\n");

  const qrTarget = tsUrls[0] || lanUrls[0];
  console.log("  QR below opens: " + qrTarget + (tsUrls.length ? " (Anywhere)" : " (Wi-Fi)"));
  if (qrTarget) qrcode.generate(qrTarget, { small: true }, (q) => console.log(q));

  if (!tsUrls.length) {
    execFile("tailscale", ["version"], (err) => {
      if (err) {
        console.log("  Want phone access from anywhere, not just home Wi-Fi?");
        console.log("  → install Tailscale (already fetched, if you asked for this):");
        console.log("    https://tailscale.com/download  — then sign in on this PC");
        console.log("    and on your phone with the same account. Restart brewdeck");
        console.log("    after and an \"Anywhere\" URL appears above.\n");
      } else {
        console.log("  Tailscale is installed but not signed in yet on this PC.");
        console.log("  Run:  tailscale up   (opens a browser to sign in), then");
        console.log("  restart brewdeck — an \"Anywhere\" URL will appear above.\n");
      }
    });
  }
});
