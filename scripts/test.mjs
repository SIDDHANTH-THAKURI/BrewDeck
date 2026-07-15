// End-to-end test: boots nothing (expects server already running), logs in,
// checks state + usage APIs, then brews a real (tiny, haiku, low-effort)
// prompt over WebSocket and verifies streamed output + session resume.

import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "brewdeck.config.json"), "utf8"));
const BASE = `https://localhost:${cfg.port}`;

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

// login
const login = await fetch(BASE + "/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pin: cfg.pin }),
});
if (!login.ok) fail("login " + login.status);
const { token } = await login.json();
console.log("login ok");

const wrong = await fetch(BASE + "/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pin: "0000" }),
});
if (wrong.status !== 403 && cfg.pin !== "0000") fail("wrong pin accepted");
console.log("wrong pin rejected");

const H = { "x-brewdeck-token": token };

const st = await (await fetch(BASE + "/api/state", { headers: H })).json();
if (!st.models?.length || !st.efforts?.length) fail("state malformed");
console.log("state ok:", st.models.length, "models,", st.efforts.length, "efforts,", st.workspaces.length, "workspaces");

const noAuth = await fetch(BASE + "/api/state");
if (noAuth.status !== 401) fail("state served without token");
console.log("auth wall ok");

const usage = await (await fetch(BASE + "/api/usage", { headers: H })).json();
console.log("usage ok: days=", usage.days.length, "todayCost=", usage.today?.cost?.toFixed?.(4), "models=", Object.keys(usage.models).join(","));

// ---- brew over WS ----
function brewOnce(text, resume) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://localhost:${cfg.port}/ws?token=${token}`, { rejectUnauthorized: false });
    const events = { deltas: 0, textOut: "", session: null, result: null };
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("brew timeout"));
    }, 120000);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "brew",
          text,
          model: "haiku",
          effort: "low",
          budget: 0.25,
          workspace: ROOT,
          resume: resume || null,
        })
      );
    });
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "session") events.session = m.id;
      if (m.type === "delta") {
        events.deltas++;
        events.textOut += m.text;
      }
      if (m.type === "result") events.result = m;
      if (m.type === "stderr") console.log("  stderr:", m.text.slice(0, 200));
      if (m.type === "done") {
        clearTimeout(timer);
        ws.close();
        resolve(events);
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

console.log("brewing test prompt (haiku/low)…");
const b1 = await brewOnce("Reply with exactly this text and nothing else: BREW OK 7731");
console.log("  session:", b1.session);
console.log("  deltas:", b1.deltas, "| text:", JSON.stringify(b1.textOut.slice(0, 80)));
console.log("  result:", b1.result && { ok: b1.result.ok, cost: b1.result.cost, turns: b1.result.turns, ms: b1.result.ms });
if (!b1.session) fail("no session id");
if (!b1.result?.ok) fail("brew result not ok");
if (!(b1.textOut.includes("BREW OK 7731") || b1.result.text?.includes("BREW OK 7731"))) fail("expected text missing");
console.log("brew 1 ok");

console.log("brewing resume test (same cup)…");
const b2 = await brewOnce("What was the exact code phrase I asked you to reply with a moment ago? Reply with just the phrase.", b1.result.sessionId || b1.session);
console.log("  text:", JSON.stringify((b2.textOut || b2.result?.text || "").slice(0, 80)));
if (!b2.result?.ok) fail("resume brew failed");
if (!(b2.textOut + (b2.result.text || "")).includes("7731")) fail("resume lost context");
console.log("brew 2 (resume) ok — context retained");

console.log("\nALL TESTS PASS");
process.exit(0);
