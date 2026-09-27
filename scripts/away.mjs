// Away mode: while on, Claude Code sessions phone you (via call-hooks/phone-ask.mjs)
// instead of waiting at the keyboard for an answer or a permission.
//   node scripts/away.mjs on | off | status

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const flag = path.join(ROOT, ".brews", "away");
const arg = process.argv[2] || "status";

if (arg === "on") {
  fs.mkdirSync(path.dirname(flag), { recursive: true });
  fs.writeFileSync(flag, new Date().toISOString());
} else if (arg === "off") {
  fs.rmSync(flag, { force: true });
} else if (arg !== "status") {
  console.error("usage: node scripts/away.mjs on | off | status");
  process.exit(1);
}
console.log(fs.existsSync(flag) ? "away mode ON — Claude Code will phone you" : "away mode off");
