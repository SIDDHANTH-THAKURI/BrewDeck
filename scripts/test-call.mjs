// Phone-path unit tests — number normalising, Twilio signature checking, and
// the two text transforms that decide what actually gets spoken.
//   node scripts/test-call.mjs

import { createHmac } from "node:crypto";
import { toE164, twilioSignatureOk, takeSpeakable, speechClean, parseVoiceCommand } from "../call.js";

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

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall call tests passed");
