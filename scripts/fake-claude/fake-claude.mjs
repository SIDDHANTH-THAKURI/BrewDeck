// Emits the same stream-json shape `claude -p --output-format stream-json`
// does — slowly, so lifecycle tests can disconnect mid-stream. Knobs via env:
//   FAKE_DELTAS   number of text chunks (default 8)
//   FAKE_STEP_MS  delay between chunks   (default 250)

const stdinText = await new Promise((res) => {
  let b = "";
  process.stdin.on("data", (d) => (b += d));
  process.stdin.on("end", () => res(b));
});

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = Number(process.env.FAKE_DELTAS || 8);
const STEP = Number(process.env.FAKE_STEP_MS || 250);
const SESSION = "fa4ec1a0-0000-4000-8000-00000000cafe";

out({ type: "system", subtype: "init", session_id: SESSION, model: "claude-fake" });
for (let i = 0; i < N; i++) {
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `chunk${i} ` } } });
  await sleep(STEP);
}
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo fake" } }] } });
out({
  type: "result",
  is_error: false,
  total_cost_usd: 0.0123,
  num_turns: 1,
  duration_ms: N * STEP,
  session_id: SESSION,
  result: "FAKE DONE: " + stdinText.trim().slice(0, 60),
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 },
});
