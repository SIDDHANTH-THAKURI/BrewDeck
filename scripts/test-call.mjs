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
  isBackgroundCommand,
  isShortAffirmation,
  isFollowUp,
  INCOMPLETE_TAIL_RE,
  parseDevNote,
  buildThinkingTone,
  isSelfEcho,
  echoScore,
  classifyIntent,
  pickModel,
  isUsefulMemoryLine,
  CHAT_SYSTEM_PROMPT,
  TASK_SYSTEM_PROMPT,
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

// 6b. Background-task detection — untangled from a real, heavily garbled call:
//     "you are still processing in the background instead of me trying to bug
//     you all the time" turned out to mean "let long tasks keep running
//     without me staying on the line".
eq("background: explicit phrase", isBackgroundCommand("can you do that in the background"), true);
eq("background: don't wait for it", isBackgroundCommand("don't wait for it, just keep going"), true);
eq("background: keep processing", isBackgroundCommand("keep processing in the background"), true);
eq("background: you don't have to wait", isBackgroundCommand("you don't have to wait, I'll call back"), true);
eq("not background: unrelated sentence", isBackgroundCommand("what's my professional background?"), false);
eq("not background: ordinary request", isBackgroundCommand("create a new folder on desktop"), false);
eq("not background: empty", isBackgroundCommand(""), false);

// 6c. Short-affirmation detection — a real call had task tier ask "want me to
//     look at your screen too?", caller said "Yes.", and since it matched no
//     verb/object it fell through to chat tier's blank session, which had no
//     idea what it was agreeing to.
eq("affirmation: bare yes", isShortAffirmation("Yes."), true);
eq("affirmation: yeah", isShortAffirmation("yeah"), true);
eq("affirmation: sure", isShortAffirmation("sure"), true);
eq("affirmation: bare no", isShortAffirmation("No."), true);
eq("affirmation: nope", isShortAffirmation("nope"), true);
eq("not affirmation: yes embedded in a longer sentence", isShortAffirmation("yes I want that folder redesigned"), false);
eq("not affirmation: ordinary request", isShortAffirmation("create a new folder on desktop"), false);
eq("not affirmation: empty", isShortAffirmation(""), false);

// 6d. "Forge" marks an utterance as a message for whoever maintains this code,
//     not a request for the assistant on the call. The caller had twice used a
//     call to leave such a message and it was only understood on a re-read.
eq("dev note: extracts the message", parseDevNote("Forge, commit and push the changes"), "commit and push the changes");
eq("dev note: tolerates a colon", parseDevNote("Forge: the tone is too loud"), "the tone is too loud");
eq("dev note: accepts the 'force' mis-hearing", parseDevNote("Force, look at the barge-in bug"), "look at the barge-in bug");
eq("dev note: case insensitive", parseDevNote("forge fix the routing please"), "fix the routing please");
eq("not a dev note: ordinary sentence", parseDevNote("open the new application folder"), null);
eq("not a dev note: name with nothing after it", parseDevNote("Forge"), null);
eq("not a dev note: forge mid-sentence", parseDevNote("I went to the forge yesterday"), null);
eq("not a dev note: empty", parseDevNote(""), null);
// People don't start a sentence on the wake word. Both of these are verbatim
// from a real call and both were missed when this was anchored hard at ^, so
// the in-call assistant answered them as ordinary chat and the messages —
// meant for whoever reads the logs — were lost.
eq("dev note: 'So, forge,' lead-in",
  parseDevNote("So, forge, can you build a tool that allows mouse control"),
  "can you build a tool that allows mouse control");
eq("dev note: 'And also, forge,' lead-in",
  parseDevNote("And also, forge, I would like you to disable the interruption."),
  "I would like you to disable the interruption.");
eq("dev note: several fillers before the name",
  parseDevNote("Oh, my. So, forge, can you build a tool"), "can you build a tool");
// ...but "force" is an ordinary English word, so a lead-in of arbitrary words
// must not turn these into developer notes
eq("not a dev note: brute force", parseDevNote("use brute force to open that file"), null);
eq("not a dev note: may the force", parseDevNote("may the force be with you"), null);
eq("not a dev note: force as a noun", parseDevNote("the force of the wind broke it"), null);
// the wake word lands at the END as often as the start. Verbatim from a real
// call, and missed: the message (the thinking tone had stopped playing) was
// only recovered by reading the log afterwards.
eq("dev note: wake word trailing",
  parseDevNote("That sound you used to play while processing is lost. Fix that forge."),
  "That sound you used to play while processing is lost. Fix that");
eq("dev note: trailing after a comma",
  parseDevNote("disable the interruption, forge"), "disable the interruption");
// "force" is tolerated as a mis-hearing at the START, but a sentence ENDING in
// "force" is virtually always the ordinary noun
eq("not a dev note: trailing brute force", parseDevNote("use brute force"), null);
eq("not a dev note: trailing air force", parseDevNote("call in the air force"), null);
eq("not a dev note: trailing forge as a place", parseDevNote("I need a new forge"), null);

// 6e. The thinking tone is synthesised, not shipped as an audio file — these
//     guard the format Twilio actually requires (mulaw 8kHz, whole 20ms frames)
//     and that it's an audible waveform rather than silence.
{
  const tone = buildThinkingTone();
  eq("tone is a Buffer", Buffer.isBuffer(tone), true);
  eq("tone is whole 160-byte frames (no click from a partial frame)", tone.length % 160, 0);
  eq("tone is 240ms at 8 bytes/ms", tone.length / 8, 240);
  eq("tone is an actual waveform, not silence", new Set(tone).size > 20, true);
}

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
// a real call asked this and it landed in chat, which has no screen-capture
// tool and confidently said the capability "hasn't been added yet" — false,
// it shipped two days earlier. Must route to task, where the tool lives.
eq("task: what can you see on my screen", classifyIntent("what can you see in my screen at the moment?"), "task");
eq("task: show me my screen", classifyIntent("can you show me my screen"), "task");
eq("task: view what's open", classifyIntent("view what's currently open on my computer"), "task");
// ordinary uses of "see"/"show"/"view" must stay chat — only the AND with a
// machine-object word should ever push these into task
eq("chat: 'I see what you mean' stays chat", classifyIntent("oh I see what you mean"), "chat");
eq("chat: 'let's see' stays chat", classifyIntent("let's see, I'm not sure"), "chat");
eq("chat: show enthusiasm, not a screen", classifyIntent("show me you're taking this seriously"), "chat");

// 8b. Natural phrasing. An audit of 36 phrasings — real ones from this user's
// calls plus researched ways people actually word assistant requests — routed
// 13 wrong, all of them work misfiled as tool-less chat. Measuring the
// ESCALATE fallback on those 13 showed it rescued only 2: the chat tier
// mostly replied with a clarifying question ("Which spreadsheet?") that it had
// no tools to act on, so the work simply never happened. These lock in the
// phrasings that broke it.
//
// inflected forms: bare imperatives matched, nothing else did
eq("task: gerund verb", classifyIntent("would you mind opening spotify for me?"), "task");
eq("task: -ing with doubled consonant", classifyIntent("mind grabbing that log file for me"), "task");
eq("task: past tense", classifyIntent("redesign that folder we created on the desktop"), "task");
// verbs that were missing from the list entirely
eq("task: close", classifyIntent("close the browser"), "task");
eq("task: restart", classifyIntent("restart the server"), "task");
eq("task: kill a process", classifyIntent("kill that process for me"), "task");
// particle verbs
eq("task: pull up", classifyIntent("do you think you could pull up that spreadsheet?"), "task");
eq("task: clean up", classifyIntent("is there any way you could clean up my desktop?"), "task");
eq("task: shut down", classifyIntent("shut down chrome please"), "task");
// requests phrased as questions — research says these are as common as commands
eq("task: question-shaped request", classifyIntent("can you check if node is installed?"), "task");
eq("task: polite hedge", classifyIntent("if you could just open notepad that'd be great"), "task");
// implicit requests carrying a need or a problem but no verb at all
eq("task: states a need", classifyIntent("I need that report from yesterday"), "task");
eq("task: states a problem", classifyIntent("something's wrong with the server"), "task");
eq("task: won't start", classifyIntent("the server won't start"), "task");
eq("task: what's on my screen", classifyIntent("what's on my screen right now"), "task");
// ...but a need or problem about something that isn't the machine is chat
eq("chat: need unrelated to the machine", classifyIntent("I need to sleep earlier"), "chat");
eq("chat: problem with a body part", classifyIntent("something's wrong with my knee"), "chat");
eq("chat: broken phone, not this machine", classifyIntent("my phone screen is broken"), "chat");
eq("chat: can't find a coffee shop", classifyIntent("can't find a decent coffee place nearby"), "chat");
// words that are both a verb and an object ("test", "build", "commit") once
// satisfied the verb-AND-object rule on their own, routing ordinary talk to
// the tool tier; verb and object must now be two different words
eq("chat: 'test' as a school test", classifyIntent("the test at school went badly"), "chat");
eq("chat: 'build' as a job title", classifyIntent("what does a build engineer actually do?"), "chat");
eq("task: verb and object are distinct words", classifyIntent("run the tests"), "task");
// ...except verbs that mean machine work and nothing else, which stand alone
eq("task: commit with no object", classifyIntent("go ahead and commit that"), "task");
// machine words used innocently in conversation
eq("chat: video games", classifyIntent("do you play any video games?"), "chat");
eq("chat: page of a book", classifyIntent("I read a page of that book last night"), "chat");
eq("chat: laptop shopping", classifyIntent("what's the best laptop to buy right now?"), "chat");
eq("chat: python as a topic", classifyIntent("is python hard to learn?"), "chat");
// asked on a real call right after the browser couldn't click a native dialog;
// routed to the tool-less tier, which replied that it couldn't do it and
// couldn't add it either — both false
eq("task: mouse control", classifyIntent("can you build a tool that gives you mouse control"), "task");
eq("task: native dialog", classifyIntent("click the got it button on that popup"), "task");
eq("task: move the cursor", classifyIntent("move the cursor to the top right"), "task");
eq("chat: a mouse in the kitchen", classifyIntent("I saw a mouse in the kitchen"), "chat");
// caught live, mid-call: "open" had no object to land on because callers say
// the actual address, not the words "website" or "url"
eq("task: bare domain", classifyIntent("Can you open wikipedia.com?"), "task");
eq("task: domain with more work", classifyIntent("go to github.com and check the issues"), "task");
eq("chat: an email address is not a request", classifyIntent("my email is bob@gmail.com"), "chat");
eq("chat: asking about a company, not opening it", classifyIntent("what is amazon.com worth?"), "chat");
eq("needsBrowser: a spoken address", needsBrowser("Can you open wikipedia.com?"), true);

// 8c. Follow-ups inherit the previous tier. Caught live: a task turn opened the
// wrong site (speech recognition heard "wikipedia.com" as "wwpa.com"), and the
// caller's two corrections — "Wrong website. It should be wikipedia.com." then
// just "Wikipedia." — both classified as chat, so the tier with no browser was
// asked to fix a browser the other tier had open.
eq("follow-up: an explicit correction", isFollowUp("Wrong website. It should be wikipedia.com."), true);
eq("follow-up: a one-word answer", isFollowUp("Wikipedia."), true);
eq("follow-up: picking a different option", isFollowUp("no, the other one"), true);
eq("follow-up: retry with a new target", isFollowUp("try again with youtube"), true);
// a full sentence stands on its own and gets classified normally
eq("not a follow-up: a fresh question", isFollowUp("what is the weather like tomorrow in sydney"), false);
eq("not a follow-up: a request for more detail", isFollowUp("tell me more about that please"), false);
eq("not a follow-up: empty", isFollowUp(""), false);
// the only verb here ("build") is also an object word while the real object
// ("mouse") sits elsewhere — requiring a verb that is no object dropped this
eq("task: verb doubles as an object, real object elsewhere",
  classifyIntent("build a tool for mouse control"), "task");

// 8d. The inversion. Every routing miss across a session of live calls was a
// missing WORD (close, restart, mouse, wikipedia, maximize), each sending real
// work to the tool-less tier and costing a ~7s escalation to recover. Word
// lists don't converge, so the default flipped: request shapes are work,
// knowledge-seeking is conversation. None of the cases below needed a word
// added to any list — that is the point of them.
eq("inversion: vague request", classifyIntent("can you make it bigger"), "task");
eq("inversion: polite imperative", classifyIntent("please close that"), "task");
eq("inversion: no nameable object", classifyIntent("could you get rid of that thing"), "task");
eq("inversion: bare screen action", classifyIntent("scroll down"), "task");
eq("inversion: single word", classifyIntent("maximize"), "task");
eq("inversion: 'i need you to'", classifyIntent("i need you to fix that"), "task");
eq("inversion: 'is there any way'", classifyIntent("is there any way to hide that"), "task");
eq("inversion: 'mind ...ing ... for me'", classifyIntent("mind having a look at that for me"), "task");
// ...and the other half: a question is still a question
eq("inversion: knowledge behind a request form",
  classifyIntent("can you tell me about electric cars"), "chat");
eq("inversion: knowledge topic with an action verb",
  classifyIntent("check the weather for tomorrow"), "chat");
eq("inversion: explain something abstract",
  classifyIntent("could you explain quantum computing"), "chat");
// ability questions wear a request's clothes and are the main false-positive
// risk the inversion introduces — found by holding these out while designing it
eq("inversion: ability question", classifyIntent("can you speak french?"), "chat");
eq("inversion: ability question, short", classifyIntent("can you sing?"), "chat");
eq("inversion: asking for advice", classifyIntent("can you give me some advice?"), "chat");
eq("inversion: asking about being wrong", classifyIntent("could you be wrong about that?"), "chat");
eq("inversion: help me understand", classifyIntent("can you help me understand how mortgages work?"), "chat");
// ...but the same words with something real to act on are work again
eq("inversion: 'help me' with a real object", classifyIntent("can you help me close that tab"), "task");
// idioms that begin with an action verb now that bare imperatives can route
eq("inversion: 'see you later' is not a screen request", classifyIntent("see you later"), "chat");
eq("inversion: 'let's see' is a filler", classifyIntent("let's see, I'm not sure"), "chat");

// 8f. Vision questions route on phrasing, not on a noun. A live call's "what
// can you see on my screen" was transcribed "...on McQueen", removing the only
// machine word, so a screenshot request reached the tier with no screenshot
// tool. Speech recognition mangling one noun should not decide the tier.
eq("screen: garbled noun still routes", classifyIntent("What can you see on McQueen?"), "task");
eq("screen: plain phrasing", classifyIntent("what can you see on my screen"), "task");
eq("screen: can you see my screen", classifyIntent("can you see my screen?"), "task");
eq("screen: what is on my desktop", classifyIntent("what is on my desktop"), "task");
// the comprehension idioms must stay conversation
eq("screen: 'see my point' is not vision", classifyIntent("do you see my point"), "chat");
eq("screen: 'see what you mean' is not vision", classifyIntent("I see what you mean"), "chat");

// 8g. Vocabulary and phrasings caught live while driving a desktop by voice.
eq("routing: leading 'you' before an imperative", classifyIntent("You click on bravo."), "task");
eq("routing: courtesy preface then a request",
  classifyIntent("Thanks so much. Can you pump up the volume to 50%?"), "task");
eq("routing: courtesy preface then a question stays chat",
  classifyIntent("That was helpful. Can you tell me about mortgages?"), "chat");
eq("routing: toggles and options", classifyIntent("And untoggle the two options in fifty one."), "task");
eq("routing: drawing", classifyIntent("draw a circle in paint"), "task");
eq("routing: drawing is not a hobby chat", classifyIntent("I like to draw in my spare time"), "chat");
eq("routing: painting a room is not a task", classifyIntent("I need to paint my room"), "chat");
eq("routing: switching careers is not a machine switch", classifyIntent("I need to switch careers"), "chat");

// hangup: "you can disconnect the call" ended a real call verbally and was
// answered as conversation instead, because only "hang up"/"bye" matched
eq("hangup: disconnect the call", isHangupCommand("Nah. You can disconnect the call."), true);
eq("hangup: bare disconnect", isHangupCommand("disconnect"), true);
eq("hangup: drop the call", isHangupCommand("drop the call"), true);
// ...but disconnecting other things is not a hangup
eq("not hangup: disconnect a printer", isHangupCommand("how do I disconnect my printer"), false);
eq("not hangup: disconnect the router", isHangupCommand("disconnect the wifi router"), false);

// 8e. Unfinished sentences. A live call said "Can you build a web page and",
// paused to think past the 3s threshold, and the half-request was sent — the
// reply could only be "sounds like you got cut off there". Silence alone is a
// bad end-of-turn signal; the words have to look finished too. Raising the
// threshold for everyone would slow every turn to suit the rare long pause.
eq("incomplete: trailing conjunction", INCOMPLETE_TAIL_RE.test("Can you build a web page and"), true);
eq("incomplete: trailing article", INCOMPLETE_TAIL_RE.test("open the"), true);
eq("incomplete: trailing infinitive", INCOMPLETE_TAIL_RE.test("I want you to"), true);
eq("incomplete: trailing copula", INCOMPLETE_TAIL_RE.test("can you check if it is"), true);
// ...complete sentences must not be delayed
eq("complete: a full request", INCOMPLETE_TAIL_RE.test("Can you open Wikipedia?"), false);
eq("complete: an imperative", INCOMPLETE_TAIL_RE.test("close the browser"), false);
eq("complete: a question", INCOMPLETE_TAIL_RE.test("what is the weather"), false);
eq("complete: ends on a noun", INCOMPLETE_TAIL_RE.test("run the tests"), false);

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
// measured: of 13 real work requests that reached the chat tier, it escalated
// only 2 and answered 11 with a clarifying question it had no tools to act on
eq("chat prompt says to escalate without asking for missing details",
  /Escalate even when details are missing/i.test(CHAT_SYSTEM_PROMPT), true);
eq("chat prompt forbids suggesting a tool switch", /never suggest they\s+switch/i.test(CHAT_SYSTEM_PROMPT.replace(/\n/g, " ")), true);
eq("chat prompt asserts machine access via handoff", /you DO have access to their machine/i.test(CHAT_SYSTEM_PROMPT), true);
eq("chat prompt says they are already talking to Claude Code", /already talking to Claude Code/i.test(CHAT_SYSTEM_PROMPT), true);
// a real call asked "can you build that yourself?" and got "no, that would need
// Anthropic's team" — false, since capabilities are actively built into this
// same call path in normal development sessions. A first fix still let the
// model reword it as "the Claude Code team" and volunteer "switch to
// interactive mode" in the same breath — both banned explicitly now, verified
// live against the actual failing question, not just this static check.
eq("chat prompt forbids naming any team/company for missing capabilities", /never name a team,\s*company, or product/i.test(CHAT_SYSTEM_PROMPT.replace(/\n/g, " ")), true);
eq("chat prompt forbids comparing to other modes of reaching claude", /do not compare this call to any other way/i.test(CHAT_SYSTEM_PROMPT.replace(/\n/g, " ")), true);
// a real call gathered a folder name across turns, then chat tier said "I'm
// looking at that folder now and I'll redesign it" — a flat lie, no tools, and
// the actual work never happened; the caller found out only at hang-up.
eq("chat prompt forbids claiming to already be doing/checking/working on something", /never\s+say or imply you are already doing/i.test(CHAT_SYSTEM_PROMPT.replace(/\n/g, " ")), true);
eq("chat prompt says gathering details then getting them is the moment to escalate", /that is the moment to ESCALATE/i.test(CHAT_SYSTEM_PROMPT), true);

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

// 13. Screen capture — verified live against a real screenshot that the task
//     tier correctly described visible secrets generically ("sensitive, close
//     it") without naming which service or reading values. These assert the
//     instructions behind that don't quietly regress.
eq("task prompt references the screenshot script", TASK_SYSTEM_PROMPT.includes("screenshot.ps1"), true);
// native input: the browser tools reach DOM nodes only, so clicking a native
// dialog needs this path to be described or it may as well not exist
eq("task prompt references the native input script", TASK_SYSTEM_PROMPT.includes("input.ps1"), true);
// a click lands on the front window, not on whatever was in the screenshot —
// a real call clicked the wrong application and still reported success
eq("task prompt requires focusing the window before clicking",
  /focus the target window/i.test(TASK_SYSTEM_PROMPT), true);
eq("task prompt makes the confirming screenshot mandatory",
  /not optional/i.test(TASK_SYSTEM_PROMPT), true);
eq("task prompt forbids claiming a click that wasn't verified",
  /Never say you clicked/i.test(TASK_SYSTEM_PROMPT), true);
eq("task prompt lists the window-listing action",
  /-Action windows/.test(TASK_SYSTEM_PROMPT), true);
eq("task prompt forbids typing credentials with native input",
  /never type passwords/i.test(TASK_SYSTEM_PROMPT), true);
eq("task prompt takes a fresh screenshot each time, not memory", /always fresh; never answer from an earlier screenshot/i.test(TASK_SYSTEM_PROMPT.replace(/\n/g, " ")), true);
eq("task prompt forbids reading out sensitive on-screen content", /don't read it out or describe it/i.test(TASK_SYSTEM_PROMPT.replace(/\n/g, " ")), true);
// two real calls: "can you see my screen?" answered as a hearing/live-call
// confirmation with no screenshot ever taken. A first fix (embedding the
// failure narrative into the prompt text) didn't reliably land — verified
// live, re-broke the same way — so these check the rule is direct and that
// hearing vs seeing are explicitly kept apart.
eq("voice base treats seeing and hearing as unrelated", /they are unrelated/i.test(CHAT_SYSTEM_PROMPT), true);
eq("task prompt: seeing-the-screen is an instruction, not a capability question", /never a yes\/no question to answer without/i.test(TASK_SYSTEM_PROMPT.replace(/\n/g, " ")), true);

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall call tests passed");
