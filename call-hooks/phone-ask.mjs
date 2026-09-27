// Claude Code hook: when a session stops to ask a question (PreToolUse on
// AskUserQuestion) or for permission (PermissionRequest) while away mode is
// on, BREWDECK phones the owner and the spoken answer comes back here.
//
// Installed in ~/.claude/settings.json so it covers every project. It is a
// no-op unless away mode is on (node scripts/away.mjs on), and it fails open:
// server down, call unanswered, or no decision on the call all produce no
// output, which leaves Claude Code's normal prompt in charge.

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const readStdin = () =>
  new Promise((resolve) => {
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
  });

function post(port, token, body) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/ask",
        method: "POST",
        rejectUnauthorized: false, // self-signed, loopback only
        headers: { "x-brewdeck-local": token, "content-type": "application/json" },
      },
      (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(s));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.end(JSON.stringify(body));
  });
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  // A claude this server spawned for a call turn must never phone about its own
  // question: the person is already on the line, and the call would collide
  // with the one it came from.
  if (process.env.BREWDECK_CHILD) return;

  // A multiple-choice question always rings (nobody but them can answer it).
  // A permission prompt only rings while away mode is on — otherwise every
  // keyboard session would phone instead of showing its prompt.
  const question = input.tool_name === "AskUserQuestion";
  if (!question && !fs.existsSync(path.join(ROOT, ".brews", "away"))) return;

  let token, port;
  try {
    token = fs.readFileSync(path.join(ROOT, ".brews", "local-api.token"), "utf8").trim();
    port = JSON.parse(fs.readFileSync(path.join(ROOT, "brewdeck.config.json"), "utf8")).port || 8443;
  } catch {
    return;
  }

  const event = input.hook_event_name;
  const r = await post(port, token, {
    hookEvent: event,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    cwd: input.cwd,
  });
  if (!r || r.skip) return;

  if (event === "PreToolUse" && input.tool_name === "AskUserQuestion" && r.answers) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Answered by phone",
          updatedInput: { ...input.tool_input, answers: r.answers },
        },
      })
    );
  } else if (event === "PermissionRequest" && r.decision) {
    const decision =
      r.decision.behavior === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: r.decision.message ? `Denied by phone: ${r.decision.message}` : "Denied by phone" };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
  }
}

main().finally(() => process.exit(0));
