// Claude Code PreToolUse hook, wired in only for the phone-call path (see
// ../call.js runClaude). Blocks git/gh actions with an external, hard-to-undo
// effect — push, merge, release, publish. Everything else (local edits, reads,
// running commands) stays allowed, same as the browser path.
//
// Why voice specifically: a real call already produced two "message got cut
// off" mis-transcriptions in one session (Deepgram fragmenting speech), and a
// caller once had claude read git status back to them mid-call and offer to
// commit+push what it found. Typed chat has a confirmation step irreversible
// actions can lean on; a phone call transcribed by a third-party STT service
// does not, so those actions are refused here rather than trusted to voice.
//
// Exit code 2 blocks the tool call; stderr becomes the reason claude sees and
// can relay back to the caller.

const BLOCK_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgh\s+pr\s+merge\b/i,
  /\bgh\s+release\b/i,
  /\bgh\s+workflow\s+run\b/i,
  /\bnpm\s+publish\b/i,
];

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // malformed input isn't this hook's problem to block on
  }
  if (input.tool_name !== "Bash") process.exit(0);
  const cmd = String(input.tool_input?.command || "");
  if (BLOCK_PATTERNS.some((re) => re.test(cmd))) {
    process.stderr.write(
      "Blocked on a phone call: this action publishes or pushes something " +
        "externally and is hard to undo. Ask from brewdeck's browser UI instead, " +
        "where there's a typed confirmation step."
    );
    process.exit(2);
  }
  process.exit(0);
});
