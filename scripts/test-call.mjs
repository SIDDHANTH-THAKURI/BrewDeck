// Phone-path unit tests — number normalising, Twilio signature checking, and
// the two text transforms that decide what actually gets spoken.
//   node scripts/test-call.mjs

import { createHmac } from "node:crypto";
import {
  toE164,
  twilioSignatureOk,
  takeSpeakable,
  speechClean,
  parseVoiceCommand,
  isHangupCommand,
  isSelfEcho,
  echoScore,
  classifyIntent,
  pickModel,
  isUsefulMemoryLine,
  CHAT_SYSTEM_PROMPT,
  needsBrowser,
} from "../call.js";

let failures = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log("ok  -", name);
  else {
    failures++;
    console.error("FAIL-", name, "\n  got: ", g, "\n  want:", w);
  }
}

// 1. AU numbers arrive from humans as 04xx but from Twilio as +614xx
eq("e164 from local 0-prefix", toE164("0411222333"), "+61411222333");
eq("e164 already E.164", toE164("+61411222333"), "+61411222333");
eq("e164 strips spacing", toE164("0411 222 333"), "+61411222333");
eq("e164 bare country code", toE164("61411222333"), "+61411222333");

// 2. Signature: params are concatenated in key order onto the full URL
{
  const token = "test-auth-token";
  const url = "https://example.ts.net/twilio/voice";
  const params = { From: "+61411222333", To: "+61255009999", CallSid: "CA123" };
  const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
  const good = createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");

  eq("signature accepts genuine", twilioSignatureOk(token, good, url, params), true);
  eq("signature rejects tampered param", twilioSignatureOk(token, good, url, { ...params, From: "+61400000000" }), false);
  eq("signature rejects wrong url", twilioSignatureOk(token, good, "https://evil.example/twilio/voice", params), false);
  eq("signature rejects wrong token", twilioSignatureOk("other-token", good, url, params), false);
  eq("signature rejects missing header", twilioSignatureOk(token, "", url, params), false);
  eq("signature rejects when unconfigured", twilioSignatureOk("", good, url, params), false);
}

// 3. Sentence carving — speech should start before claude finishes writing
eq("takes a complete sentence", takeSpeakable("Coffee is ready. Next up"), ["Coffee is ready.", "Next up"]);
eq("holds an incomplete short fragment", takeSpeakable("Coffee is"), ["", "Coffee is"]);
eq("keeps quote after terminator", takeSpeakable('He said "go." Then left'), ['He said "go."', "Then left"]);
eq("force flushes the tail", takeSpeakable("no terminator here", { force: true }), ["no terminator here", ""]);
{
  // long run-on with no punctuation still gets spoken rather than buffered forever
  const long = "this line simply keeps going and going without any terminator at all so it must flush";
  const [chunk, rest] = takeSpeakable(long);
  eq("long fragment flushes", chunk.length > 0 && rest.length > 0, true);
  eq("long fragment loses nothing", (chunk + " " + rest).trim(), long);
}

// 4. Markdown reads badly aloud
eq("drops code fences", speechClean("Try this:\n```js\nfoo()\n```\ndone"), "Try this: code block omitted. done");
eq("unwraps inline code", speechClean("run `npm start` now"), "run npm start now");
eq("strips heading marks", speechClean("## Results\nall good"), "Results all good");
eq("strips bold and italic", speechClean("**very** *important*"), "very important");
eq("strips bullet marks", speechClean("- one\n- two"), "one two");

// 5. Spoken model/effort switching, including the shapes Deepgram actually
//    produces when it mishears the model names
eq("switch to haiku", parseVoiceCommand("switch to haiku"), { type: "model", value: "haiku" });
eq("use opus", parseVoiceCommand("use opus"), { type: "model", value: "opus" });
eq("change model to sonnet", parseVoiceCommand("change model to sonnet"), { type: "model", value: "sonnet" });
eq("mishears sonnet as sonet", parseVoiceCommand("switch to sonet"), { type: "model", value: "sonnet" });
eq("mishears haiku as hi ku", parseVoiceCommand("switch to hi ku"), { type: "model", value: "haiku" });
eq("mishears opus as octopus", parseVoiceCommand("use octopus"), { type: "model", value: "opus" });
eq("set effort high", parseVoiceCommand("set effort high"), { type: "effort", value: "high" });
eq("use low effort", parseVoiceCommand("use low effort"), { type: "effort", value: "low" });

// ordinary speech must never be mistaken for a command — a false positive
// silently swallows the caller's actual question
eq("plain question untouched", parseVoiceCommand("what can you do?"), null);
eq("question mentioning a model", parseVoiceCommand("which model are you, sonnet or opus?"), null);
eq("prose containing 'high'", parseVoiceCommand("the build is taking a high amount of time"), null);
eq("unrelated use of 'use'", parseVoiceCommand("what do I use this folder for?"), null);
eq("empty input", parseVoiceCommand(""), null);

// 6. Hangup detection — a real test caller had no way to end the call except
//    hanging up on the phone's own end. This is what the fix looks for.
eq("bare bye", isHangupCommand("bye"), true);
eq("real phrasing from the field: okay, bye", isHangupCommand("Okay. Bye."), true);
eq("goodbye alone", isHangupCommand("goodbye"), true);
eq("explicit hang up", isHangupCommand("hang up"), true);
eq("explicit end the call", isHangupCommand("please end the call"), true);
eq("end call no article", isHangupCommand("end call now"), true);

// must not fire — these are questions or unrelated content, not commands
eq("question about closing call — should be ANSWERED not obeyed", isHangupCommand("How do I close this call?"), false);
eq("question mentioning hang up", isHangupCommand("how do I hang up?"), false);
eq("goodbye buried in a long unrelated sentence", isHangupCommand("anyway that reminds me of the time I said goodbye to my old job and started this one"), false);
eq("empty", isHangupCommand(""), false);
eq("ordinary request", isHangupCommand("create a new folder on desktop"), false);

// 7. Self-echo suppression. The greeting was looping out of the handset
//    speaker back into its mic; these are the ACTUAL mis-transcriptions the
//    call log captured of "Hi, this is Claude. How can I help?" — each one
//    both cut the greeting short (false barge-in) and got answered as if the
//    caller had said it.
{
  const greeting = "Hi, this is Claude. How can I help?";
  eq("echo: 'Hi. This is Cole.'", isSelfEcho("Hi. This is Cole.", greeting), true);
  eq("echo: 'hi this is flawed'", isSelfEcho("hi, this is flawed", greeting), true);
  eq("echo: greeting transcribed verbatim", isSelfEcho("hi this is claude how can i help", greeting), true);

  // real speech during/just after the greeting must still get through
  eq("not echo: 'Can you hear me?'", isSelfEcho("Can you hear me?", greeting), false);
  eq("not echo: a genuine request", isSelfEcho("create a new folder on the desktop", greeting), false);
  eq("not echo: unrelated question", isSelfEcho("what's the weather like today?", greeting), false);

  // nothing spoken yet ⇒ nothing can be echo
  eq("no spoken history means never echo", isSelfEcho("hi this is claude", ""), false);
  eq("empty transcript scores as echo (nothing to act on)", echoScore("", greeting), 1);
}

// 8. Intent routing — ordinary conversation must not get dragged into the repo
eq("chat: general knowledge", classifyIntent("what's a good phone for my friend?"), "chat");
eq("chat: opinion", classifyIntent("do you think that's a good idea?"), "chat");
eq("chat: 'check the weather' has a verb but no machine object", classifyIntent("check the weather for tomorrow"), "chat");
eq("chat: greeting", classifyIntent("hi, can you hear me?"), "chat");
eq("task: create a file", classifyIntent("create a new file on the desktop"), "task");
eq("task: fix a bug", classifyIntent("fix the bug in the server code"), "task");
eq("task: look at repo", classifyIntent("look at the repo and tell me what changed"), "task");
eq("task: run tests", classifyIntent("run the tests for that project"), "task");
eq("empty input defaults to chat", classifyIntent(""), "chat");
// these came from a real call: routed to chat first, then had to escalate,
// which cost a whole extra round trip for something plainly machine work
eq("task: open a browser tab", classifyIntent("can you open a new tab in Edge browser?"), "task");
eq("task: open a website", classifyIntent("open YouTube in a new tab"), "task");
// but talking *about* an app is still conversation, not a command
eq("chat: opinion about an app", classifyIntent("which browser do you think is fastest?"), "chat");
eq("chat: question about youtube content", classifyIntent("who is the most subscribed youtube channel?"), "chat");
// browser control — "select the third video" was refused on a real call
eq("task: click a video", classifyIntent("select the third video"), "task");
eq("task: scroll the page", classifyIntent("scroll down the page a bit"), "task");
eq("task: click a button", classifyIntent("click the search button"), "task");
eq("chat: talking about a film, not a browser", classifyIntent("what film should I watch tonight?"), "chat");

// 9. Model policy — fast by default, sonnet for work, opus only on request
eq("chat routes to haiku", pickModel("chat", {}), { model: "haiku", effort: "low" });
eq("task escalates to sonnet high", pickModel("task", {}), { model: "sonnet", effort: "high" });
eq("auto-escalation never reaches opus", pickModel("task", {}).model === "opus", false);
eq("explicit opus is honoured", pickModel("chat", { model: "opus" }), { model: "opus", effort: "high" });
eq("explicit haiku keeps low effort", pickModel("task", { model: "haiku" }), { model: "haiku", effort: "low" });
eq("explicit effort overrides the default", pickModel("chat", { effort: "high" }), { model: "haiku", effort: "high" });

// 10. Cross-call memory notes are injected into every later call, so a wrong
//     one becomes a permanent false belief. These three are the actual lines a
//     summariser wrote — the third asserts a source file is missing when it
//     exists, and rode along into later calls as fact.
eq(
  "rejects a false claim about a missing file",
  isUsefulMemoryLine("**Missing file:** `call-hooks/block-push.mjs` referenced in call.js:33 but doesn't exist."),
  false
);
eq(
  "rejects notes about the call system itself",
  isUsefulMemoryLine("Looking at transcript: voice call system struggled with transcription quality badly."),
  false
);
eq("rejects a truncated fragment ending in a colon", isUsefulMemoryLine("System did okay but identified real issue at end:"), false);
eq("rejects markdown bullets", isUsefulMemoryLine("- some note about the caller"), false);
eq("rejects file paths", isUsefulMemoryLine("The caller wants changes in src/server.js reviewed"), false);
eq("rejects too-short noise", isUsefulMemoryLine("ok sure"), false);

// genuine caller facts must still get through
eq("keeps a stated preference", isUsefulMemoryLine("Prefers short spoken answers rather than long explanations."), true);
eq("keeps an ongoing project", isUsefulMemoryLine("Is planning a trip to Japan in November and wants help with the itinerary."), true);
eq("keeps a follow-up promise", isUsefulMemoryLine("Asked to be reminded about renewing the car insurance next month."), true);

// 11. Guardrails the chat prompt must keep. A whole real call was spent with
//     claude insisting the caller had to hang up and "start a new Claude Code
//     session" to get anything done on their machine — while the escalation
//     path had already opened Edge and YouTube for them earlier in that same
//     call. These assert the instructions that stop that recurring, and are
//     static so an accidental prompt edit can't quietly drop them.
eq("chat prompt still defines the ESCALATE marker", /ESCALATE:/.test(CHAT_SYSTEM_PROMPT), true);
eq("chat prompt forbids suggesting a tool switch", /never suggest they\s+switch/i.test(CHAT_SYSTEM_PROMPT.replace(/\n/g, " ")), true);
eq("chat prompt asserts machine access via handoff", /you DO have access to their machine/i.test(CHAT_SYSTEM_PROMPT), true);
eq("chat prompt says they are already talking to Claude Code", /already talking to Claude Code/i.test(CHAT_SYSTEM_PROMPT), true);

// 12. Only launch a real browser process (costs a few seconds and a running
//     Edge instance) when the turn's own words plausibly need one — actual
//     phrases from the call that motivated the whole browser-persistence fix.
eq("needsBrowser: open a tab", needsBrowser("open a new tab in Edge browser"), true);
eq("needsBrowser: open youtube", needsBrowser("open YouTube in a new tab"), true);
eq("needsBrowser: select a video", needsBrowser("select the third video"), true);
eq("needsBrowser: click something", needsBrowser("click the search button"), true);
eq("needsBrowser: not needed for file work", needsBrowser("fix the bug in the server code"), false);
eq("needsBrowser: not needed for tests", needsBrowser("run the tests"), false);
eq("needsBrowser: not needed for plain chat", needsBrowser("what's a good phone for my friend?"), false);

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall call tests passed");
