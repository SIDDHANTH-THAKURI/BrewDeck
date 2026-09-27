// Ring the owner's phone with a check-in call right now, through the running
// server — the same call the daily CALL_CHECKIN_AT schedule places.
//   node scripts/call-me.mjs

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const token = fs.readFileSync(path.join(ROOT, ".brews", "local-api.token"), "utf8").trim();
let port = Number(process.env.BREWDECK_PORT || 0);
if (!port) {
  try {
    port = JSON.parse(fs.readFileSync(path.join(ROOT, "brewdeck.config.json"), "utf8")).port;
  } catch {}
}
port ||= 8443;

// the server's cert is self-signed; this only ever talks to loopback
const req = https.request(
  { host: "127.0.0.1", port, path: "/api/call/checkin", method: "POST", rejectUnauthorized: false, headers: { "x-brewdeck-local": token } },
  (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => {
      console.log(res.statusCode, body);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  }
);
req.on("error", (e) => {
  console.error("server not reachable:", e.message);
  process.exit(1);
});
req.end();
