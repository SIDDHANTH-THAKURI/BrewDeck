// Lifecycle tests — the "phone went away" scenarios BREWDECK exists to
// survive: app force-closed mid-brew, brew finishing while nobody's watching,
// reopening much later, and the bar itself restarting (clean or mid-brew).
// Boots its own server on a scratch port with a fake `claude` on PATH, so it
// burns no tokens and never touches the real bar or its config.
//
//   node scripts/test-lifecycle.mjs

import { spawn, execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "brewdeck-test-"));
const DATA = path.join(TMP, "brews");
const CFG = path.join(TMP, "config.json");
const PORT = 8971;
const BASE = `https://localhost:${PORT}`;
const PIN = "4321";

fs.writeFileSync(CFG, JSON.stringify({ pin: PIN, port: PORT, secret: "lifecycle-test-secret", defaultWorkspace: ROOT }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let serverProc = null;
let serverOut = "";

function fail(msg) {
  console.error("\nFAIL:", msg);
  console.error("--- server output tail ---\n" + serverOut.slice(-2500));
  cleanup();
  process.exit(1);
}

function cleanup() {
  if (serverProc?.pid) {
    try {
      execFileSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
}
process.on("exit", cleanup);

// ---------------------------------------------------------------- server boot

function bootServer() {
  const env = { ...process.env, BREWDECK_CONFIG: CFG, BREWDECK_DATA: DATA, BREWDECK_PORT: String(PORT), FAKE_DELTAS: "10", FAKE_STEP_MS: "300" };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  env[pathKey] = path.join(ROOT, "scripts", "fake-claude") + path.delimiter + env[pathKey];
  serverOut = "";
  serverProc = spawn(process.execPath, [path.join(ROOT, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  serverProc.stdout.on("data", (d) => (serverOut += d));
  serverProc.stderr.on("data", (d) => (serverOut += d));
}

async function waitListening() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/api/state");
      return;
    } catch {
      await sleep(250);
    }
  }
  fail("server never started listening");
}

function killServerHard() {
  execFileSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], { stdio: "ignore" });
  serverProc = null;
}

async function login() {
  const r = await fetch(BASE + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: PIN }),
  });
  if (!r.ok) fail("login " + r.status);
  return (await r.json()).token;
}

// ---------------------------------------------------------------- ws helper

function connect(token) {
  const ws = new WebSocket(`wss://localhost:${PORT}/ws?token=${token}`, { rejectUnauthorized: false });
  const c = { ws, msgs: [], open: false };
  ws.on("open", () => (c.open = true));
  ws.on("message", (raw) => c.msgs.push(JSON.parse(raw.toString())));
  c.until = async (pred, ms = 15000, what = "condition") => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (c.msgs.some(pred)) return;
      await sleep(60);
    }
    fail(`timeout waiting for ${what}; got: ` + JSON.stringify(c.msgs).slice(0, 1500));
  };
  c.count = (pred) => c.msgs.filter(pred).length;
  c.text = () => c.msgs.filter((m) => m.type === "delta").map((m) => m.text).join("");
  return c;
}

const isDone = (m) => m.type === "done";
const replayEnd = (m) => m.type === "replay" && m.start === false;
const FULL_TEXT = Array.from({ length: 10 }, (_, i) => `chunk${i} `).join("");

function sendBrew(c, text) {
  c.ws.send(JSON.stringify({ type: "brew", text, model: "haiku", effort: "low", budget: 0.1, workspace: ROOT }));
}

async function latestRecord() {
  const ids = fs
    .readdirSync(DATA)
    .filter((f) => f.endsWith(".json") && f !== "push-subs.json")
    .sort();
  if (!ids.length) return null;
  return JSON.parse(fs.readFileSync(path.join(DATA, ids[ids.length - 1]), "utf8"));
}

async function waitRecordSettled(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const rec = await latestRecord().catch(() => null);
    if (rec && rec.status !== "running") return rec;
    await sleep(200);
  }
  fail("brew record never settled on disk");
}

// ================================================================ scenarios

bootServer();
await waitListening();
const token = await login();
console.log("boot + login ok");

// --- S1: force-close the app mid-brew; reopen after it finished -----------
{
  const c1 = connect(token);
  await c1.until((m) => m.type === "hello", 5000, "hello");
  sendBrew(c1, "order alpha");
  await c1.until((m) => m.type === "delta" && m.text.includes("chunk1"), 10000, "2 deltas");
  c1.ws.terminate(); // abrupt: no close frame — same as the OS killing the app

  const rec = await waitRecordSettled(); // brew must finish with zero clients
  if (rec.status !== "done" || rec.text !== "order alpha") fail("S1 record wrong: " + JSON.stringify({ status: rec.status, text: rec.text }));

  const c2 = connect(token); // "reopening the app later"
  await c2.until(replayEnd, 8000, "replay end");
  const hello = c2.msgs.find((m) => m.type === "hello");
  const end = c2.msgs.find(replayEnd);
  if (hello.brewing !== false) fail("S1 hello.brewing should be false");
  if (end.live !== false) fail("S1 replay should be dead");
  if (!c2.text().includes(FULL_TEXT)) fail("S1 replay text incomplete: " + JSON.stringify(c2.text()));
  if (!c2.msgs.some((m) => m.type === "result" && m.ok)) fail("S1 replay missing ok result");
  if (!c2.msgs.some((m) => m.type === "brewing" && m.text === "order alpha")) fail("S1 replay missing order text");
  if (!c2.msgs.some(isDone)) fail("S1 replay missing done");

  // keepalive answers
  c2.ws.send('{"type":"ping"}');
  await c2.until((m) => m.type === "pong", 3000, "pong");
  c2.ws.close();
  console.log("S1 force-close mid-brew → full receipt on reopen: ok");
}

// --- S2: connection lost mid-brew; reconnect while STILL brewing ----------
{
  const c3 = connect(token);
  await c3.until((m) => m.type === "hello", 5000, "hello");
  sendBrew(c3, "order beta");
  await c3.until((m) => m.type === "delta" && m.text.includes("chunk1"), 10000, "2 deltas");
  c3.ws.terminate();

  const c4 = connect(token); // back online while the shot is still pulling
  await c4.until((m) => m.type === "replay" && m.start === true, 5000, "replay start");
  const c5 = connect(token); // a second device watches the same brew
  await c4.until(isDone, 10000, "done on reconnecting client");
  await c5.until(isDone, 10000, "done on second watcher");

  const end4 = c4.msgs.find(replayEnd);
  if (end4.live !== true) fail("S2 replay should be live");
  if (c4.text() !== FULL_TEXT) fail("S2 replay+live text mismatch: " + JSON.stringify(c4.text()));
  if (!c4.msgs.some((m) => m.type === "result" && m.ok)) fail("S2 missing result");
  c4.ws.close();
  c5.ws.close();
  console.log("S2 reconnect mid-brew (replay + live continuation, 2 watchers): ok");
}

// --- S3: bar restarts AFTER a brew finished; reopen much later ------------
{
  killServerHard();
  await sleep(400);
  bootServer();
  await waitListening();
  const c6 = connect(token);
  await c6.until(replayEnd, 8000, "replay-from-disk end");
  if (!c6.msgs.some((m) => m.type === "brewing" && m.text === "order beta")) fail("S3 disk replay missing order");
  if (!c6.text().includes(FULL_TEXT)) fail("S3 disk replay text incomplete");
  if (!c6.msgs.some(isDone)) fail("S3 disk replay missing done");
  c6.ws.close();
  console.log("S3 server restart → receipt rehydrated from disk: ok");
}

// --- S4: bar dies MID-brew; restart marks it interrupted; bar still works -
{
  const c7 = connect(token);
  await c7.until(replayEnd, 8000, "replay end");
  sendBrew(c7, "order gamma");
  await c7.until((m) => m.type === "delta" && m.text.includes("chunk1"), 10000, "2 deltas");
  await sleep(1200); // let the debounced flush write the running record
  killServerHard();
  await sleep(400);

  bootServer();
  await waitListening();
  const c8 = connect(token);
  await c8.until(replayEnd, 8000, "replay end");
  if (!c8.msgs.some((m) => m.type === "brewing" && m.text === "order gamma")) fail("S4 missing interrupted order");
  if (!c8.msgs.some((m) => m.type === "stderr" && /restarted mid-brew/.test(m.text))) fail("S4 missing interruption notice");
  if (!c8.msgs.some((m) => m.type === "done" && m.interrupted)) fail("S4 missing interrupted done");
  const rec = await latestRecord();
  if (rec.status !== "interrupted") fail("S4 record status: " + rec.status);

  // and the bar still brews after recovery
  sendBrew(c8, "order delta");
  await c8.until((m) => m.type === "done" && m.code === 0, 15000, "post-recovery brew done");
  c8.ws.close();
  console.log("S4 restart mid-brew → marked interrupted, bar still functional: ok");
}

// --- S5: push endpoints ---------------------------------------------------
{
  const noAuth = await fetch(BASE + "/api/push/key");
  if (noAuth.status !== 401) fail("S5 push key served without token");
  const H = { "x-brewdeck-token": token, "content-type": "application/json" };
  const { key } = await (await fetch(BASE + "/api/push/key", { headers: H })).json();
  if (!key || key.length < 40) fail("S5 vapid key malformed");

  const sub = { endpoint: "https://push.example.invalid/sub1", keys: { p256dh: "BFake", auth: "fake" } };
  const s = await fetch(BASE + "/api/push/subscribe", { method: "POST", headers: H, body: JSON.stringify(sub) });
  if (!s.ok) fail("S5 subscribe failed");
  const stored = JSON.parse(fs.readFileSync(path.join(DATA, "push-subs.json"), "utf8"));
  if (!stored.some((x) => x.endpoint === sub.endpoint)) fail("S5 subscription not persisted");

  const u = await fetch(BASE + "/api/push/unsubscribe", { method: "POST", headers: H, body: JSON.stringify({ endpoint: sub.endpoint }) });
  if (!u.ok) fail("S5 unsubscribe failed");
  const after = JSON.parse(fs.readFileSync(path.join(DATA, "push-subs.json"), "utf8"));
  if (after.length !== 0) fail("S5 subscription not removed");
  console.log("S5 push subscribe/unsubscribe + auth wall: ok");
}

console.log("\nALL LIFECYCLE TESTS PASS");
cleanup();
process.exit(0);
