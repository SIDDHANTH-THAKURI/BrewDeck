// BREWDECK phone path — lets a watch (or any whitelisted phone) talk to claude
// over a plain voice call. Twilio carries the audio, Deepgram transcribes it,
// claude answers, ElevenLabs speaks the answer back.
//
// This module is deliberately separate from the browser brew path. `currentBrew`
// in server.js is a single global slot: a second brew is refused, and every
// connecting browser socket auto-attaches to whatever brew is current. Routing
// calls through it would both block browser brews and leak call audio into the
// browser chat, so a call spawns its own short-lived claude instead and never
// touches `currentBrew` or the /ws watchers.

import { spawn, execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// A generated (not checked-in) settings file wiring up call-hooks/block-push.mjs
// as a PreToolUse hook, scoped to the phone-call claude spawn only — the
// browser brew path in server.js is untouched. Written once at boot so the
// absolute hook path is always correct for whatever machine this runs on,
// rather than baking a path (with this user's home directory in it) into git.
const CALL_SETTINGS_PATH = path.join(ROOT, ".brews", "call-hook-settings.json");

// Browser control for the task tier, so "open YouTube and play the third
// video" can actually happen rather than being refused.
//
// Each task-tier turn is a fresh `claude -p` process. A first version pointed
// each one at its own `npx @playwright/mcp --isolated` server, which launches
// a NEW browser per turn and — because the browser is a child of that MCP
// server, itself a child of that turn's claude process — kills it the moment
// the turn's response finishes. On a real call that looked like "it opened
// and then closed itself" every single time, and it also meant "open YouTube
// in the existing tab" had no existing tab to find.
//
// Fixed by owning the browser process ourselves, at the Call level, launched
// once per call and torn down when the call ends. Every task-tier turn
// connects to that same running browser via --cdp-endpoint instead of
// spawning its own — verified directly: two separate `claude -p` processes
// attaching to the same CDP port see the same page, survive each other
// exiting, and only die when the owning process (us) kills them.
//
// Two deliberate security choices, both still in force:
//  - Every generated config is paired with --strict-mcp-config, so a call
//    sees ONLY the browser server. The account has Gmail, Drive and Calendar
//    MCP servers connected; a phone call running with permissions bypassed
//    has no business reaching the user's email or documents.
//  - A throwaway --user-data-dir per call, not the user's real browser
//    profile, so a call can't act as the signed-in user on their accounts.
function findBrowserExe() {
  if (process.env.CALL_BROWSER_EXE) return process.env.CALL_BROWSER_EXE;
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

async function waitForCdp(port, tries = 25) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 300));
  }
  return false;
}

function writeCallSettings() {
  fs.mkdirSync(path.dirname(CALL_SETTINGS_PATH), { recursive: true });
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "node", args: [path.join(ROOT, "call-hooks", "block-push.mjs")] }],
        },
      ],
    },
  };
  fs.writeFileSync(CALL_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// Chat turns run here rather than in the repo, so claude isn't sitting in
// brewdeck's working tree seeing uncommitted changes and steering every
// conversation back to them.
//
// This MUST live outside the repo: an earlier version put it under .brews/ and
// a caller still got told about uncommitted changes in call.js, because
// CLAUDE.md discovery and git context both walk *up* from the working
// directory and found the project anyway. Sitting in the OS temp dir there is
// no parent project to discover, which also cuts the startup work.
const CALL_SCRATCH_DIR = path.join(os.tmpdir(), "brewdeck-call-scratch");

// Each call is its own claude session — nothing is resumed across calls, so a
// long history can't pile up and drag the conversation. Continuity instead
// comes from this small file: a handful of durable facts, read into the prompt
// at the start of every call and appended to when the call ends.
const CALL_MEMORY_PATH = path.join(ROOT, ".brews", "call-memory.md");
const MEMORY_CHAR_CAP = 4000;

export function readCallMemory() {
  try {
    const raw = fs.readFileSync(CALL_MEMORY_PATH, "utf8").trim();
    if (!raw) return "";
    // keep the most recent entries if it has grown past the cap
    return raw.length > MEMORY_CHAR_CAP ? raw.slice(-MEMORY_CHAR_CAP) : raw;
  } catch {
    return "";
  }
}

// A note here is injected into every later call, so a bad one becomes a
// permanent false belief — one run recorded that a source file was missing
// when it wasn't. The summariser is told to avoid these; this rejects them
// anyway, because the cost of a wrong note is much higher than a lost one.
export function isUsefulMemoryLine(line) {
  const l = String(line || "").trim();
  if (l.length < 12 || l.length > 300) return false;
  if (/^[-*#>]|\*\*|`|^\d+[.)]\s/.test(l)) return false; // markdown / list furniture
  if (/[\\/][\w.-]+\.(js|mjs|ts|json|md|py|txt)\b|\.\w{2,4}:\d+/i.test(l)) return false; // paths, file:line
  if (/\b(call\.js|server\.js|codebase|repo|transcript|speech-to-text|deepgram|elevenlabs|twilio)\b/i.test(l)) return false;
  if (/\b(missing file|doesn't exist|does not exist|bug|error|hook config|nonexistent)\b/i.test(l)) return false;
  if (/:\s*$/.test(l)) return false; // truncated fragment ending in a colon
  return true;
}

export function appendCallMemory(lines) {
  const clean = (Array.isArray(lines) ? lines : [lines])
    .map((l) => String(l || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter(isUsefulMemoryLine);
  if (!clean.length) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const block = clean.map((l) => `- (${stamp}) ${l}`).join("\n") + "\n";
  try {
    fs.mkdirSync(path.dirname(CALL_MEMORY_PATH), { recursive: true });
    fs.appendFileSync(CALL_MEMORY_PATH, block);
  } catch (e) {
    console.warn("[call] could not write call memory:", e.message);
  }
}

// Twilio media frames are 20ms of 8kHz mulaw — 160 bytes, base64'd.
const FRAME_BYTES = 160;
// mulaw 8kHz is exactly 8 bytes per millisecond of audio — used to work out
// how long what we've sent will actually take to play.
const BYTES_PER_MS = 8;

// endpointing is deliberately not tiny: at 300ms an ordinary mid-sentence pause
// ended the utterance, so "make a folder on the desktop, call it Apple" arrived
// as three fragments and claude answered "your message looks incomplete".
// Thresholds are deliberately generous. At 600/1400 a caller pausing to think
// mid-sentence ("now can you tell me how many … letters are in strawberry")
// had the utterance closed on them, and the remainder landed mid-turn where it
// used to be discarded. Waiting longer for the end of a sentence costs about
// half a second per turn and is worth it — the caller values getting a correct
// answer over getting a fast one.
const DG_URL =
  "wss://api.deepgram.com/v1/listen" +
  "?encoding=mulaw&sample_rate=8000&channels=1" +
  "&model=nova-3&smart_format=true&interim_results=true" +
  "&endpointing=900&utterance_end_ms=2000&vad_events=true";

// flash + ulaw_8000 so the audio needs no transcoding on the way to Twilio,
// and the first byte arrives fast enough to feel like a conversation
const EL_URL = (voiceId) =>
  `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input` +
  "?model_id=eleven_flash_v2_5&output_format=ulaw_8000";

// Normalise whatever the user typed into the E.164 form Twilio actually sends.
// AU mobiles get entered as 04xx xxx xxx far more often than +614xx xxx xxx.
export function toE164(raw, countryCode = "61") {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("0")) return "+" + countryCode + digits.slice(1);
  if (digits.startsWith(countryCode)) return "+" + digits;
  return "+" + digits;
}

// Twilio signs each webhook: HMAC-SHA1 over the full URL with every POST param
// appended in key order. This is the real gate — the caller-ID check below is
// spoofable by anyone who can POST to a public URL, this isn't.
export function twilioSignatureOk(authToken, signature, url, params) {
  if (!authToken || !signature) return false;
  const data = Object.keys(params || {})
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Split streamed claude text on sentence boundaries so TTS can start speaking
// the first sentence while the rest is still being generated. Anything without
// punctuation still gets flushed once it is long enough to be worth saying.
export function takeSpeakable(buf, { force = false, minChars = 60 } = {}) {
  if (force) return [buf.trim(), ""];
  const m = /^([\s\S]*?[.!?…](?:["')\]]+)?)(\s+)([\s\S]*)$/.exec(buf);
  if (m) return [m[1].trim(), m[3]];
  if (buf.length >= minChars) {
    const cut = buf.lastIndexOf(" ", minChars);
    if (cut > 20) return [buf.slice(0, cut).trim(), buf.slice(cut + 1)];
  }
  return ["", buf];
}

// Strip the things that read badly out loud. claude writes for a screen; the
// phone only has a speaker, so code fences and markdown furniture are noise.
export function speechClean(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Spoken model/effort switching. Transcription mangles these words often enough
// ("sonnet" → "sonet", "haiku" → "hi ku") that matching has to be forgiving,
// and the phrases have to be distinctive or ordinary questions would trip them.
const MODEL_WORDS = [
  ["sonnet", /\b(sonnet|sonet|sonnett|son net|sunset)\b/],
  ["opus", /\b(opus|opis|oppus|octopus)\b/],
  ["haiku", /\b(haiku|haiko|hi ku|hi q|haik)\b/],
];
const EFFORT_WORDS = [
  ["low", /\b(low|lowest|quick|fast)\b/],
  ["medium", /\b(medium|normal|default|standard)\b/],
  ["high", /\b(high|highest|deep|thorough)\b/],
];

export function parseVoiceCommand(text) {
  const t = String(text || "").toLowerCase().trim();
  // must look like an instruction, not a question mentioning a model name
  const wantsSwitch = /\b(switch|change|use|set|go)\b/.test(t);
  if (!wantsSwitch) return null;

  if (/\beffort\b/.test(t)) {
    for (const [value, re] of EFFORT_WORDS) if (re.test(t)) return { type: "effort", value };
  }
  if (/\b(model|switch|change|use)\b/.test(t)) {
    for (const [value, re] of MODEL_WORDS) if (re.test(t)) return { type: "model", value };
  }
  for (const [value, re] of EFFORT_WORDS) {
    if (re.test(t) && /\beffort\b/.test(t)) return { type: "effort", value };
  }
  return null;
}

// A real test caller had no way to end the call except hanging up on the
// phone's own end — worth catching explicitly since hands-free/pocketed use
// is the entire point. Explicit phrases ("hang up", "end the call") match
// anywhere; "bye"/"goodbye" only count as a sign-off in a short utterance
// ("okay, bye" — the actual phrasing that came up), so a "goodbye" mentioned
// mid-sentence in a longer request doesn't silently end the call. A
// *question* about hanging up ("how do I close this call?") is deliberately
// not treated as a command — it should get answered, not silently obeyed.
const HANGUP_PHRASE_RE = /\b(hang up|hangup|end (the |this )?call|end the phone call)\b/;
const BYE_WORD_RE = /\b(bye|goodbye)\b/;
export function isHangupCommand(text) {
  const t = String(text || "").toLowerCase().trim();
  if (/\?\s*$/.test(t)) return false; // a question, not a command
  if (HANGUP_PHRASE_RE.test(t)) return true;
  return BYE_WORD_RE.test(t) && t.split(/\s+/).filter(Boolean).length <= 6;
}

// ---- self-echo suppression -------------------------------------------
//
// The handset (and especially the watch, whose speaker and mic are inches
// apart) feeds claude's own TTS straight back into the mic, and Twilio's media
// stream has no echo cancellation. The call log proves it: the greeting came
// back as "Hi. This is Cole.", "Hi, God.", "Flora,", "hi, this is flawed" —
// all mangled transcriptions of "Hi, this is Claude."
//
// That echo did two bad things: it tripped barge-in (cutting the greeting off
// right after "…this is Claude"), and it was fed to claude as if the caller
// had said it. An earlier timing-based guard failed because audio is pushed to
// Twilio far faster than realtime, so "when we started sending" is seconds
// earlier than "when the caller actually hears it".
//
// Comparing against what we just said is the reliable discriminator: echo is,
// by definition, our own words coming back.
const normWords = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

// fraction of the transcript's words that we ourselves recently spoke
export function echoScore(transcript, spoken) {
  const t = normWords(transcript);
  if (!t.length) return 1; // nothing to act on; treat as echo
  const s = new Set(normWords(spoken));
  if (!s.size) return 0;
  let hit = 0;
  for (const w of t) if (s.has(w)) hit++;
  return hit / t.length;
}

export function isSelfEcho(transcript, spoken, threshold = 0.6) {
  return echoScore(transcript, spoken) >= threshold;
}

// ---- intent routing ---------------------------------------------------
//
// The caller wants a normal conversation by default, and agentic work only
// when they actually ask for it. Running every turn through Claude Code in the
// brewdeck repo made it answer "what's a good phone for my friend?" by talking
// about uncommitted changes in call.js. Chat turns therefore go to a fast
// model in a neutral directory with no repo context; only real work gets the
// full agentic treatment.
const TASK_VERB_RE =
  /\b(build|create|make|write|add|fix|debug|refactor|implement|deploy|commit|run|execute|install|uninstall|delete|remove|rename|move|edit|update|patch|check|look at|open|read|search|find|grep|test|clone|scaffold|generate|click|select|scroll|navigate|browse|play|pause)\b/;
// Anything that lives on the machine. Browser/app words are in here because a
// real call asked to "open a new tab in Edge" and "open YouTube": both are
// plainly machine actions, but with only file/repo words listed they were
// routed to chat first and reached the tools via the escalation round trip,
// costing several seconds each. Routing them directly skips that.
const TASK_OBJECT_RE =
  /\b(file|files|folder|directory|repo|repository|code|codebase|script|function|class|variable|bug|error|exception|test|tests|commit|branch|diff|server|app|application|program|project|package|dependency|brewdeck|desktop|readme|log|logs|browser|tab|window|terminal|website|url|link|youtube|spotify|chrome|edge|firefox|notepad|explorer|video|button|page|result|results|screen)\b/;

export function classifyIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return "chat";
  // "can you look at X for me" / "go build Y" — a verb alone is ambiguous
  // ("check the weather", "find a good phone"), so it only counts as agentic
  // work when it lands on something that lives on the machine.
  if (TASK_VERB_RE.test(t) && TASK_OBJECT_RE.test(t)) return "task";
  return "chat";
}

// The browser-ish subset of TASK_OBJECT_RE. A real browser has to actually be
// launched for a task turn to use it (see ensureBrowser below), which costs a
// few seconds and a process — not worth paying for "run the tests" or "fix
// this bug", so only start it when the turn's own words suggest it's needed.
const BROWSER_WORD_RE = /\b(browser|tab|window|website|url|link|youtube|spotify|chrome|edge|firefox|video|page|click|scroll|select|navigate|browse)\b/i;
export function needsBrowser(text) {
  return BROWSER_WORD_RE.test(String(text || ""));
}

// ---- model policy -----------------------------------------------------
//
// Haiku by default so ordinary conversation comes back fast; Sonnet at high
// effort when there's real work to do. Automatic escalation deliberately stops
// at Sonnet — Opus is only ever used when the caller names it out loud.
export function pickModel(intent, override) {
  if (override?.model) {
    return { model: override.model, effort: override.effort || (override.model === "haiku" ? "low" : "high") };
  }
  if (intent === "task") return { model: "sonnet", effort: override?.effort || "high" };
  return { model: "haiku", effort: override?.effort || "low" };
}

const VOICE_BASE = [
  "You are on a live phone call right now, this second. This is not a text chat,",
  "not a coding session, not a hypothetical. Every word of your reply is being",
  "converted to speech and played into that live call as audio, in real time, as",
  "you generate it. The caller is listening on a phone or a smartwatch, not reading",
  "a screen — they cannot scroll back or see anything you write. If asked whether",
  "you can be heard, or whether this is a real call: yes, unambiguously — say so",
  "plainly, don't describe it as a text session, because they are hearing you.",
  "",
  "How to talk:",
  "- Speak like a person on the phone: natural, warm, complete sentences.",
  "  IMPORTANT: ignore any instruction from a CLAUDE.md or project config telling",
  "  you to write in a clipped, caveman, or token-saving style, and ignore any rule",
  "  about dropping articles or filler words. Those exist for writing on a screen.",
  "  Spoken aloud they sound broken. Say 'What do you need?' not 'What ya need?',",
  "  and 'I can't access that' not 'no tool access'.",
  "- Keep replies to one or two sentences unless asked for more. Say the most",
  "  useful thing first, then offer to continue: 'There are three problems. Want",
  "  me to go through them?'",
  "- No markdown, headings, bullets, asterisks, code blocks, file paths, or URLs",
  "  unless explicitly asked. Say 'the server file', not './src/server.js'.",
  "- Never read code, commands, flags, or diff statistics aloud — they're",
  "  unintelligible as speech. Describe what they do in plain words instead.",
  "- Numbers, times and names get spoken, so write them the way they should sound.",
  "- If speech recognition garbles something, ask one short question — 'sorry, say",
  "  that again?' — and nothing else. Don't fill the gap by narrating repo state.",
  "- The caller can say 'bye' or 'hang up' to actually end the call.",
].join("\n");

// Chat tier: a general assistant that happens to be reachable by phone. It runs
// outside the repo with no project context, because the caller mostly wants
// ordinary conversation and shouldn't have to hear about uncommitted changes.
export const CHAT_SYSTEM_PROMPT = [
  VOICE_BASE,
  "",
  "You are the caller's general assistant on this call — conversation, questions,",
  "advice, thinking out loud, remembering things across calls. Be genuinely useful",
  "and personable. You are NOT limited to software topics; if they ask about phones,",
  "travel, or anything else, just help.",
  "",
  "If — and only if — they want something actually done on their machine (create or",
  "edit a file, run a command, open an app, look at their code, check a repo), reply",
  "with exactly this and nothing else, on one line:",
  "ESCALATE: <one short sentence restating what they want done>",
  "That silently hands the same request to a tool-capable mode and it gets done.",
  "Only use it for real work on their machine — never for ordinary questions.",
  "",
  "Critically: you DO have access to their machine through that handoff, so never",
  "tell the caller you can't do things on their computer, and never suggest they",
  "switch to Claude Code, interactive mode, a terminal, or any other tool. They are",
  "already talking to Claude Code — you are it, on the phone. Suggesting they go",
  "somewhere else is always wrong and is confusing to hear. If something is",
  "genuinely impossible (seeing or clicking things on screen, for instance), say",
  "that one specific thing can't be done and stop there — don't pitch alternatives.",
].join("\n");

// Task tier: the agentic one, with tools, in a real workspace.
const TASK_SYSTEM_PROMPT = [
  VOICE_BASE,
  "",
  "This turn has full tool access on the caller's machine. Do the work they asked",
  "for, then say what happened in one short sentence. Do not narrate each step, and",
  "do not volunteer repo status, uncommitted changes, or diffs unless asked.",
  "- If something will take more than a few seconds, say so briefly first.",
  "- git push, gh publish/merge/release, and npm publish are blocked on phone calls",
  "  by policy. If one fails for that reason, don't retry — say it needs the browser.",
  "",
  "You can drive a real browser with the browser tools: open pages, read them,",
  "click, type, scroll. It's a fresh throwaway profile, so the caller is not signed",
  "in to anything and you should not try to sign in for them.",
  "- Never type passwords, card numbers, or any other credential into a page, and",
  "  never create accounts. If a task needs a login, say that's as far as you can go.",
  "- Never buy anything, place an order, or move money.",
  "- Don't submit forms, post, send, or publish anything on the caller's behalf",
  "  without them asking for that exact action on this call.",
  "- The caller can't see the browser window well and is often not at the keyboard,",
  "  so describe what you found in a sentence rather than reading the page out.",
].join("\n");

// One live phone call: owns its Deepgram socket, its ElevenLabs socket, and at
// most one claude child at a time. Everything here dies with the call.
class Call {
  constructor(ws, opts) {
    this.ws = ws; // socket back to Twilio
    this.opts = opts;
    this.streamSid = null;
    this.dg = null;
    this.el = null;
    this.child = null;
    // Separate sessions per tier: the chat session stays a clean conversation,
    // while the tool-using one carries its own history. Neither survives the
    // call — continuity across calls comes from the memory file instead.
    this.chatSession = null;
    this.taskSession = null;
    this.closed = false;
    this.pending = ""; // claude text not yet handed to TTS
    this.busy = false; // a turn is in flight; ignore new transcripts
    // Only set when the caller explicitly names a model/effort out loud (or
    // CALL_MODEL/CALL_EFFORT pin one); otherwise each turn is routed
    // automatically by intent.
    this.override = {};
    if (opts.forceModel) this.override.model = opts.forceModel;
    if (opts.forceEffort) this.override.effort = opts.forceEffort;
    // What we've recently said, for telling our own echo apart from the caller.
    this.spokenLog = [];
    this.playbackEndsAt = 0;
    this.transcript = []; // for the end-of-call memory summary
    this.cdpPort = null; // set once the call's own browser is up
    this.browserProc = null;
    this.browserProfileDir = null;
    this.browserStarting = null; // in-flight ensureBrowser() promise

    ws.on("message", (raw) => this.onTwilio(raw));
    // Deepgram/ElevenLabs both log *why* they closed; this leg never did, so
    // an occasional "the call just broke" report had no evidence to diagnose
    // against. A clean Twilio-initiated end already logs via the "stop" event
    // in onTwilio — this only fires for the close/error Twilio's own "stop"
    // didn't explain, i.e. exactly the ones worth knowing about.
    ws.on("close", (code, reason) => {
      if (!this.gotStopEvent) console.warn("[call] twilio ws closed unexpectedly", code, reason?.toString().slice(0, 200));
      this.destroy();
    });
    ws.on("error", (e) => {
      console.warn("[call] twilio ws error:", e.message);
      this.destroy();
    });
  }

  log(...a) {
    if (this.opts.verbose) console.log("[call]", ...a);
  }

  // True while the caller is still hearing us. Derived from how much audio has
  // been handed to Twilio rather than from a timestamp, because audio is sent
  // far faster than realtime — "we started sending" can be seconds before "they
  // finished hearing it", which is exactly what broke the earlier timing guard.
  isPlaying(now = Date.now()) {
    return now < this.playbackEndsAt;
  }

  // Echo keeps arriving a little after playback ends: the caller's handset has
  // to pick it up and send it back over the network.
  inEchoWindow(now = Date.now()) {
    return now < this.playbackEndsAt + 1200;
  }

  noteSpoken(text) {
    const now = Date.now();
    this.spokenLog.push({ t: now, text });
    // only the last ~20s can plausibly still be echoing back
    this.spokenLog = this.spokenLog.filter((e) => now - e.t < 20_000);
  }

  recentSpoken() {
    return this.spokenLog.map((e) => e.text).join(" ");
  }

  onTwilio(raw) {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (m.event) {
      case "start":
        this.streamSid = m.start?.streamSid || null;
        this.callSid = m.start?.callSid || null;
        this.log("start", this.callSid || "");
        // Greet before wiring up transcription, not after: if Deepgram is slow
        // or unreachable the caller should still hear something, and the
        // greeting is what tells them the line is live.
        this.say(this.opts.greeting);
        this.openDeepgram();
        break;
      case "media":
        // inbound caller audio → Deepgram, raw mulaw bytes
        if (this.dg?.readyState === WebSocket.OPEN && m.media?.payload) {
          this.dg.send(Buffer.from(m.media.payload, "base64"));
        }
        break;
      case "stop":
        this.log("stop");
        this.gotStopEvent = true;
        this.destroy();
        break;
    }
  }

  openDeepgram() {
    const dg = new WebSocket(DG_URL, { headers: { Authorization: "Token " + this.opts.deepgramKey } });
    this.dg = dg;
    dg.on("open", () => {
      this.log("deepgram open");
      // A successful reconnect means that blip is over — without this, the
      // 2-retry budget below was spent across the whole call instead of per
      // incident, so two separate, individually-recoverable blips 10 minutes
      // apart would exhaust it and leave the rest of the call permanently deaf.
      this.dgRetries = 0;
    });
    dg.on("message", (raw) => {
      let j;
      try {
        j = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // SpeechStarted is pure acoustic VAD — it fires just as loudly for our
      // own audio echoing back as for the caller, so it can't be a barge-in
      // trigger on its own. Interruption is decided below, on transcript
      // content, which is the only signal that can tell the two apart.
      if (j.type === "SpeechStarted") return;
      // Deepgram emits several is_final segments per spoken sentence and then a
      // single UtteranceEnd once the caller has actually stopped. Acting on the
      // segments individually is what chopped requests into fragments, so they
      // are accumulated and only sent on to claude at UtteranceEnd.
      if (j.type === "UtteranceEnd") {
        this.flushUtterance();
        return;
      }
      if (j.type !== "Results") return;
      const alt = j.channel?.alternatives?.[0];
      const text = (alt?.transcript || "").trim();
      if (!text) return;
      if (!j.is_final) {
        // first partial is the earliest moment we know the caller is talking
        if (!this.tHeardFirst) this.tHeardFirst = Date.now();
        // Genuine interruption cuts the reply short; our own voice coming back
        // must not. Only barge in on words we didn't just say ourselves.
        if (this.isPlaying() && normWords(text).length >= 2 && !isSelfEcho(text, this.recentSpoken())) {
          this.log("barge-in:", text);
          this.stopSpeaking();
        }
        return;
      }
      // Drop echo before it ever reaches the utterance queue, otherwise claude
      // gets asked to respond to its own greeting ("Hi. This is Cole.").
      if (this.inEchoWindow() && isSelfEcho(text, this.recentSpoken())) {
        this.log("ignored self-echo:", text);
        return;
      }
      (this.utterQ ||= []).push(text);
      // Safety net: if UtteranceEnd never arrives (it depends on VAD seeing a
      // clean gap), flush anyway rather than leaving the caller waiting.
      clearTimeout(this.utterTimer);
      // Must stay comfortably above utterance_end_ms in DG_URL (2000ms), or
      // this safety net fires first and re-introduces the mid-sentence cut it
      // exists to protect against.
      this.utterTimer = setTimeout(() => this.flushUtterance(), 2800);
      this.utterTimer.unref?.();
    });
    // the close handler does the reacting; error always precedes a close
    dg.on("error", (e) => console.warn("[call] deepgram error:", e.message));
    dg.on("close", (code, reason) => {
      if (this.closed || this.dg !== dg) return;
      if (code === 1000) return this.log("deepgram closed");
      console.warn("[call] deepgram closed", code, reason?.toString().slice(0, 200));
      // A mid-call ECONNRESET is usually transient; silently re-dial a couple
      // of times before admitting defeat, since reconnecting is far less
      // disruptive than telling the caller to hang up.
      this.dgRetries = (this.dgRetries || 0) + 1;
      if (this.dgRetries <= 2) {
        this.log("deepgram reconnecting, attempt", this.dgRetries);
        setTimeout(() => {
          if (!this.closed) this.openDeepgram();
        }, 300).unref?.();
      } else {
        this.hearingLost();
      }
    });
  }

  // Without transcription the call is just dead air, which is indistinguishable
  // from a broken line. Say so once, then let the caller hang up.
  hearingLost() {
    if (this.closed || this.deaf) return;
    this.deaf = true;
    this.say("I've lost the transcription service, so I can't hear you. Try calling back.");
  }

  // Join the accumulated final segments into the one thing the caller said.
  flushUtterance() {
    clearTimeout(this.utterTimer);
    this.utterTimer = null;
    const parts = this.utterQ || [];
    this.utterQ = [];
    if (!parts.length) return;
    if (this.tHeardFirst) {
      this.log(`speech: ${Date.now() - this.tHeardFirst}ms from first partial to end of utterance`);
      this.tHeardFirst = null;
    }
    this.onUtterance(parts.join(" ").replace(/\s+/g, " ").trim());
  }

  onUtterance(text) {
    if (this.closed) return;
    if (this.busy) {
      // Speech that lands mid-turn used to be dropped outright. That went
      // badly on a real call: "now can you tell me how many" flushed at a
      // natural pause, and the rest of the sentence — the actual question —
      // arrived while busy and was thrown away, so the caller got an answer
      // to a fragment and then asked "hello? did you press it?". Keep it
      // instead and run it once the current turn finishes; losing the
      // question is far worse than answering it a few seconds late.
      this.queued = this.queued ? this.queued + " " + text : text;
      this.log("queued while busy:", text);
      if (!this.saidStillWorking) {
        this.saidStillWorking = true;
        this.say("Still working on that, one sec.");
      }
      return;
    }
    this.log("heard:", text);

    if (isHangupCommand(text)) {
      this.log("hangup command recognised");
      this.say("Bye.");
      // give the goodbye a moment to actually reach the caller's ear before
      // the underlying call is torn out from under it via the REST API
      setTimeout(() => this.hangup(), 1200).unref?.();
      return;
    }

    // model/effort switches are handled here rather than by claude — they take
    // effect on the next spawn, and answering locally is instant
    const cmd = parseVoiceCommand(text);
    if (cmd) {
      if (cmd.type === "model") this.override.model = cmd.value;
      else this.override.effort = cmd.value;
      this.log(`switched ${cmd.type} -> ${cmd.value}`);
      this.say(`Okay, ${cmd.type} is now ${cmd.value}.`);
      return;
    }
    if (/\b(auto|automatic)\b/.test(text.toLowerCase()) && /\bmodel\b/.test(text.toLowerCase())) {
      this.override = {};
      this.say("Okay, back to picking the model automatically.");
      return;
    }

    this.transcript.push("caller: " + text);
    this.busy = true;
    this.saidStillWorking = false;
    this.muted = false; // a new question un-mutes whatever the last one silenced
    this.pending = "";
    this.armSlowTurnFiller();
    // stage timings, so a slow turn can be blamed on the right component
    this.t0 = Date.now();
    this.tFirstDelta = null;
    this.tFirstAudio = null;
    const intent = classifyIntent(text);
    this.runClaude(text, intent);
  }

  // Speech captured while the previous turn was still running. Deliberately
  // deferred rather than answered immediately, so the reply that's already
  // being spoken isn't stepped on.
  drainQueued() {
    if (this.closed || this.busy || !this.queued) return;
    const text = this.queued;
    this.queued = "";
    setTimeout(() => {
      if (!this.closed && !this.busy) this.onUtterance(text);
    }, 400).unref?.();
  }

  // Real tool-using turns can take 20-30s (reading/editing files, running
  // commands) with zero output until the first token — that's dead air a
  // caller can't tell apart from a dropped call. One filler if it runs long.
  // Re-armed on escalation too: an escalated turn is a tool-using one by
  // definition, so it's the case that most needs this.
  armSlowTurnFiller() {
    clearTimeout(this.slowTurnTimer);
    this.slowTurnTimer = setTimeout(() => {
      if (this.busy && this.tFirstDelta === null && !this.saidStillWorking) {
        this.saidStillWorking = true;
        this.say("Still working on it.");
      }
    }, 6000);
    this.slowTurnTimer.unref?.();
  }

  // Durable facts from previous calls, so "last time we talked about X" works
  // even though each call is a brand-new session.
  memoryBlock() {
    const mem = this.opts.memory;
    if (!mem) return "";
    return [
      "",
      "Private notes from earlier calls with this person. Use them silently for",
      "context only. Never mention that you have notes, never quote them back, and",
      "never say a topic 'came up before' unless the caller raises it first. They",
      "may be stale or garbled by speech recognition — if one seems to contradict",
      "what the caller is telling you now, believe the caller and ignore the note.",
      mem,
    ].join("\n");
  }

  chatPrompt() {
    return CHAT_SYSTEM_PROMPT + this.memoryBlock();
  }

  taskPrompt() {
    return TASK_SYSTEM_PROMPT + this.memoryBlock();
  }

  // Launches this call's own browser on first use and keeps it running for
  // every later turn in the same call — see the block comment above the
  // module-level CALL_MCP helpers for why per-turn launching broke persistence.
  // Concurrent calls to this (two turns needing it near-simultaneously) share
  // the one in-flight launch rather than racing two browsers into existence.
  async ensureBrowser() {
    if (this.cdpPort) return this.cdpPort;
    if (this.browserStarting) return this.browserStarting;
    this.browserStarting = (async () => {
      const port = 9500 + Math.floor(Math.random() * 400);
      const profileDir = path.join(os.tmpdir(), `brewdeck-call-${this.callSid || Date.now()}-profile`);
      fs.mkdirSync(profileDir, { recursive: true });
      const exe = findBrowserExe();
      this.log("launching call browser:", exe, "port", port);
      const proc = spawn(
        exe,
        [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
        { detached: true, stdio: "ignore" }
      );
      proc.unref();
      this.browserProc = proc;
      this.browserProfileDir = profileDir;
      const ready = await waitForCdp(port);
      if (!ready) {
        console.warn("[call] browser did not become ready on port", port);
        return null;
      }
      const mcpPath = path.join(os.tmpdir(), `brewdeck-call-${this.callSid || Date.now()}-mcp.json`);
      fs.writeFileSync(
        mcpPath,
        JSON.stringify({ mcpServers: { browser: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", `http://127.0.0.1:${port}`] } } }, null, 2)
      );
      this.browserMcpPath = mcpPath;
      this.cdpPort = port;
      return port;
    })();
    const result = await this.browserStarting;
    this.browserStarting = null;
    return result;
  }

  // async: a task turn that plausibly needs the browser awaits the call's
  // shared instance coming up (or already being up) before spawning claude.
  // Callers fire this without awaiting it; failures are caught internally so
  // a stuck browser launch can't take the whole turn down with it.
  async runClaude(prompt, intent) {
    const { model, effort } = pickModel(intent, this.override);
    this.turnIntent = intent;
    this.log(`turn: ${intent} via ${model}/${effort}`);

    // Chat runs in an empty scratch directory with no tools: it keeps ordinary
    // conversation out of the repo (and off the tool-loading path, which is
    // most of the startup cost), so a plain question comes back quickly.
    const isTask = intent === "task";
    let browserMcpPath = null;
    if (isTask && needsBrowser(prompt)) {
      try {
        if (await this.ensureBrowser()) browserMcpPath = this.browserMcpPath;
      } catch (e) {
        console.warn("[call] browser launch failed:", e.message);
      }
    }
    if (this.closed) return; // call ended while the browser was coming up
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", model,
      "--effort", effort,
      "--max-budget-usd", String(this.opts.budget),
      "--append-system-prompt", isTask ? this.taskPrompt() : this.chatPrompt(),
    ];
    if (isTask) {
      args.push("--permission-mode", "bypassPermissions");
      // hard-blocks git push / gh publish / npm publish even under
      // bypassPermissions — see call-hooks/block-push.mjs for why voice
      // specifically doesn't get to trigger those
      args.push("--settings", CALL_SETTINGS_PATH);
      // browser control, and *only* browser control when present: strict mode
      // means the account's Gmail/Drive/Calendar servers stay out of reach of
      // a call. Omitted entirely when this turn didn't need a browser, or the
      // launch failed — the turn still runs, just without those tools.
      if (browserMcpPath) args.push("--mcp-config", browserMcpPath, "--strict-mcp-config");
    } else {
      // no tools at all on the chat path: nothing to load, nothing to run
      args.push("--disallowed-tools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task");
    }
    const resume = isTask ? this.taskSession : this.chatSession;
    if (resume) args.push("--resume", resume);

    const child = spawn("claude", args, {
      cwd: isTask ? this.opts.cwd : CALL_SCRATCH_DIR,
      // NEVER shell:true here. Node does no quoting on Windows when it shells
      // out, so a multi-word argument is split at every space and everything
      // after the first newline is dropped entirely. Since the args below
      // include a long multi-line --append-system-prompt, that silently ate
      // the system prompt AND every flag after it — --resume, --settings and
      // --disallowed-tools never reached the CLI on a real call. Proven with
      // a prompt saying "answer with exactly PINEAPPLE": shell:true ignored it,
      // shell:false obeyed. `claude` is a real .exe, so no shell is needed.
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin.write(prompt);
    child.stdin.end();

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.onClaudeLine(line));
    child.stderr.on("data", (d) => this.log("claude stderr:", d.toString().slice(0, 300)));

    child.on("close", (code) => {
      // A nonzero exit from us force-killing it (hangup, call ended mid-turn)
      // is expected, not a failure — only warn when claude exited on its own.
      if (code !== 0 && !this.killingChild) console.warn("[call] claude exited", code);
      clearTimeout(this.slowTurnTimer);
      const tail = this.pending.trim();
      this.pending = "";
      this.child = null;

      // Chat decided this actually needs the machine — rerun the same request
      // on the tool-capable tier instead of speaking the marker out loud.
      if (this.escalating) {
        this.escalating = false;
        const task = tail.replace(/^\s*ESCALATE\s*:?\s*/i, "").trim() || prompt;
        this.log("escalating to task tier:", task);
        if (!this.closed) {
          this.armSlowTurnFiller(); // the close handler above just cleared it
          return this.runClaude(task, "task");
        }
        this.busy = false;
        return;
      }

      if (tail) this.say(speechClean(tail));
      else if (!this.spokeThisTurn) this.say("Done, but I had nothing to say about it.");
      this.busy = false;
      this.drainQueued();
    });
    child.on("error", (err) => {
      this.log("spawn failed", err.message);
      this.say("I couldn't start claude on the machine.");
      this.busy = false;
      this.child = null;
    });
    this.spokeThisTurn = false;
    // cleared per turn: a spawn error skips the close handler that would
    // normally reset it, and a stale flag would escalate the *next* reply
    this.escalating = false;
  }

  onClaudeLine(line) {
    if (!line.startsWith("{")) return;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    const remember = (id) => {
      if (!id) return;
      if (this.turnIntent === "task") this.taskSession = id;
      else this.chatSession = id;
    };
    if (j.type === "system" && j.subtype === "init") return remember(j.session_id);
    if (j.type === "result") return remember(j.session_id);
    if (j.type !== "stream_event") return;
    const ev = j.event;
    if (ev?.type !== "content_block_delta" || ev.delta?.type !== "text_delta") return;

    if (this.tFirstDelta === null && this.t0) {
      this.tFirstDelta = Date.now() - this.t0;
      this.log(`t+${this.tFirstDelta}ms claude first token`);
    }
    this.pending += ev.delta.text;
    // The chat tier signals "this needs real tools" by replying with an
    // ESCALATE line. Hold the text back rather than speaking it: the caller
    // should hear the answer, never the routing marker. Anything that could
    // still turn into "ESCALATE:" is held until enough has arrived to tell.
    if (this.turnIntent !== "task" && !this.spokeThisTurn) {
      const head = this.pending.trimStart().toUpperCase();
      if (head.startsWith("ESCALATE")) {
        this.escalating = true;
        return;
      }
      if (head.length < 9 && "ESCALATE:".startsWith(head)) return; // still ambiguous
    }
    // hand whole sentences to TTS as they complete, so speech starts long
    // before claude has finished writing
    for (;;) {
      const [chunk, rest] = takeSpeakable(this.pending);
      if (!chunk) break;
      this.pending = rest;
      const clean = speechClean(chunk);
      if (clean) {
        this.spokeThisTurn = true;
        this.say(clean);
      }
    }
  }

  // ---- text to speech -------------------------------------------------

  say(text) {
    if (this.closed || !text) return;
    this.log("say:", text);
    // record it before it's spoken — this is what incoming transcripts get
    // compared against to tell the caller apart from our own echo
    this.noteSpoken(text);
    this.transcript.push("you: " + text);
    this.openEleven();
    if (this.el?.readyState === WebSocket.OPEN) {
      this.el.send(JSON.stringify({ text: text + " ", flush: true }));
    } else {
      (this.elQueue ||= []).push(text + " ");
    }
  }

  openEleven() {
    if (this.el && this.el.readyState <= WebSocket.OPEN) return;
    const el = new WebSocket(EL_URL(this.opts.voiceId));
    this.el = el;
    el.on("open", () => {
      el.send(
        JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.4, similarity_boost: 0.7, speed: 1.0 },
          xi_api_key: this.opts.elevenKey,
        })
      );
      for (const q of this.elQueue || []) el.send(JSON.stringify({ text: q, flush: true }));
      this.elQueue = [];
      // ElevenLabs kills an input stream that goes 20s without text, which on a
      // call is just the caller thinking. A bare space resets that timer
      // without generating audio.
      clearInterval(this.elKeep);
      this.elKeep = setInterval(() => {
        if (el.readyState === WebSocket.OPEN) el.send(JSON.stringify({ text: " " }));
      }, 10_000);
      this.elKeep.unref?.();
    });
    el.on("message", (raw) => {
      let j;
      try {
        j = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (j.audio) this.pushAudio(Buffer.from(j.audio, "base64"));
    });
    el.on("error", (e) => console.warn("[call] eleven error:", e.message));
    el.on("close", (code, reason) => {
      // A bad voice id / key closes with 1008 and no audio ever arrives, which
      // is silence on the phone rather than an error — always surface the why.
      if (code !== 1000) console.warn("[call] eleven closed", code, reason?.toString().slice(0, 200));
      if (this.el === el) {
        this.el = null;
        clearInterval(this.elKeep);
        this.elKeep = null;
      }
    });
  }

  // Twilio buffers whatever we send and plays it out at the correct rate, so
  // frames go out as soon as they exist. An earlier version paced them on a
  // 20ms setInterval, which on Windows (~15ms timer granularity) jittered
  // enough to make speech sound broken-up. Barge-in doesn't need pacing
  // either: the "clear" event drops audio Twilio has already buffered.
  pushAudio(buf) {
    if (this.muted) return; // leftovers from a reply the caller interrupted
    // Gated on spokeThisTurn (only set once real claude text has been queued,
    // not by the "still working" filler) — otherwise a slow turn's filler
    // audio got timestamped as "first audio out", making the latency this
    // logs for diagnosing slow turns measure the filler instead of the reply.
    if (this.tFirstAudio === null && this.t0 && this.spokeThisTurn) {
      this.tFirstAudio = Date.now() - this.t0;
      this.log(`t+${this.tFirstAudio}ms first audio out (caller starts hearing)`);
    }
    this.audioQ = this.audioQ?.length ? Buffer.concat([this.audioQ, buf]) : buf;
    // only whole frames — a short frame is an audible click
    let sent = 0;
    while (this.audioQ.length >= FRAME_BYTES) {
      const frame = this.audioQ.subarray(0, FRAME_BYTES);
      this.audioQ = this.audioQ.subarray(FRAME_BYTES);
      this.sendFrame(frame);
      sent += FRAME_BYTES;
    }
    // Track when the caller will actually finish hearing this. Twilio plays it
    // at realtime regardless of how fast we hand it over, so playback extends
    // from whenever the previous audio was due to end.
    if (sent) {
      const now = Date.now();
      this.playbackEndsAt = Math.max(this.playbackEndsAt, now) + sent / BYTES_PER_MS;
    }
  }

  sendFrame(frame) {
    if (this.ws.readyState !== WebSocket.OPEN || !this.streamSid) return;
    this.ws.send(
      JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: frame.toString("base64") },
      })
    );
  }

  stopSpeaking() {
    this.audioQ = Buffer.alloc(0);
    // Twilio is about to drop its buffer, so nothing more will be heard —
    // playback is over as of now, not whenever the queued audio would have run out.
    this.playbackEndsAt = 0;
    // Audio for the interrupted reply is still in flight from ElevenLabs;
    // stay muted so it gets dropped instead of resuming a second later.
    this.muted = true;
    // ...but if that "interruption" was just noise and no question ever
    // finalises, nothing would clear the mute and the call would go dead for
    // good. Unmute shortly after, so the worst case is a clipped sentence.
    clearTimeout(this.unmute);
    this.unmute = setTimeout(() => {
      if (!this.closed && !this.busy) this.muted = false;
    }, 2500);
    this.unmute.unref?.();
    // tell Twilio to drop whatever it has already buffered, otherwise the
    // caller keeps hearing the old reply for a second after interrupting
    if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
      this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
    }
    // Deliberately NOT closing the ElevenLabs socket: reopening it costs a
    // handshake on the next reply, and text sent while it was closed used to
    // be dropped, which truncated answers mid-sentence.
  }

  // Closing our WebSocket only ends the Media Stream — Twilio's TwiML has no
  // verb after <Connect><Stream>, so the underlying PSTN call would just sit
  // there connected in silence. Actually ending the call for the caller
  // requires the REST API to update the call resource to "completed".
  async hangup() {
    if (this.closed) return;
    if (!this.callSid) return this.destroy(); // no CallSid, nothing to hang up via REST
    try {
      const auth = Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString("base64");
      const r = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.opts.accountSid}/Calls/${this.callSid}.json`,
        {
          method: "POST",
          headers: { Authorization: "Basic " + auth, "content-type": "application/x-www-form-urlencoded" },
          body: "Status=completed",
        }
      );
      if (!r.ok) console.warn("[call] hangup REST call failed:", r.status, await r.text().catch(() => ""));
    } catch (e) {
      console.warn("[call] hangup REST call errored:", e.message);
    }
    this.destroy();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.elKeep);
    this.elKeep = null;
    clearTimeout(this.unmute);
    clearTimeout(this.utterTimer);
    clearTimeout(this.slowTurnTimer);
    try {
      this.dg?.close();
    } catch {}
    try {
      this.el?.close();
    } catch {}
    if (this.child?.pid) {
      this.killingChild = true; // the close handler shouldn't warn about this
      // claude spawns children; kill the tree the same way the brew path does
      if (process.platform === "win32") {
        execFile("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], () => {});
      } else {
        try {
          process.kill(-this.child.pid, "SIGKILL");
        } catch {}
      }
    }
    try {
      this.ws.close();
    } catch {}
    this.killBrowser();
    this.saveMemory();
  }

  // Owned for the lifetime of this call — tear it down with it. Left running
  // it would just be an orphaned Edge process nobody's driving.
  killBrowser() {
    if (this.browserProc?.pid) {
      if (process.platform === "win32") {
        execFile("taskkill", ["/pid", String(this.browserProc.pid), "/T", "/F"], () => {});
      } else {
        try {
          process.kill(-this.browserProc.pid, "SIGKILL");
        } catch {}
      }
    }
    const profileDir = this.browserProfileDir;
    const mcpPath = this.browserMcpPath;
    if (profileDir) setTimeout(() => fs.rm(profileDir, { recursive: true, force: true }, () => {}), 2000).unref?.();
    if (mcpPath) fs.rm(mcpPath, { force: true }, () => {});
  }

  // After the call, boil it down to a couple of durable notes for next time.
  // Runs detached after hangup, so it costs the caller no latency, and uses
  // haiku because summarising a short transcript needs nothing bigger.
  saveMemory() {
    const convo = this.transcript.filter((l) => l.startsWith("caller: "));
    if (convo.length < 2) return; // nothing said worth remembering
    const text = this.transcript.join("\n").slice(-6000);
    const child = spawn(
      "claude",
      [
        "-p",
        "--model", "haiku",
        "--effort", "low",
        "--max-budget-usd", "0.10",
        "--disallowed-tools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task",
        "--append-system-prompt",
        [
          "You are writing notes for the assistant's next phone call with this person.",
          "Record ONLY durable facts about the caller that they stated themselves:",
          "preferences, ongoing projects, decisions they made, things they asked you to",
          "follow up on.",
          "",
          "Hard rules, because these notes are injected into every future call and a",
          "wrong one becomes a permanent false belief:",
          "- Never record a claim about code, files, or bugs. A previous run wrote down",
          "  that a source file was missing when it existed, and that lie then rode",
          "  along into later calls. Diagnosis of this system is not a caller fact.",
          "- Never record anything you inferred, guessed, or worked out yourself —",
          "  only what the caller actually said.",
          "- Skip anything that looks like a speech-recognition error. If a line is",
          "  garbled, drop it rather than trying to reconstruct what was meant.",
          "- Skip pleasantries, small talk, and testing chatter.",
          "- Plain spoken sentences. No markdown, no bullets, no file paths, no code,",
          "  no line numbers. Each line must stand alone and be complete.",
          "",
          "Output at most 3 lines, one fact per line. Most calls deserve zero lines —",
          "if nothing durable was said, output nothing at all.",
        ].join("\n"),
      ],
      // shell:false for the same reason as the turn spawn above — the summary
      // instruction is a long multi-word string and would be shredded.
      { cwd: CALL_SCRATCH_DIR, shell: false, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["pipe", "pipe", "ignore"] }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const lines = out.split("\n").map((l) => l.trim()).filter((l) => l && l.length > 8).slice(0, 3);
      if (lines.length) {
        appendCallMemory(lines);
        console.log("[call] remembered", lines.length, "note(s) for next call");
      }
    });
    child.on("error", (e) => console.warn("[call] memory summary failed:", e.message));
    child.stdin.write("Transcript:\n" + text);
    child.stdin.end();
    child.unref?.();
  }
}

// Mounts the phone path. Returns a `handleUpgrade` the http server routes to,
// because ws can't put two WebSocketServers on one http server by path — the
// first one's upgrade listener aborts every non-matching path with a 400.
export function mountCall({ app, config }) {
  writeCallSettings();
  // Empty, CLAUDE.md-free directory for the chat tier to run in.
  fs.mkdirSync(CALL_SCRATCH_DIR, { recursive: true });
  const env = process.env;
  const cfg = {
    accountSid: env.TWILIO_ACCOUNT_SID || "",
    authToken: env.TWILIO_AUTH_TOKEN || "",
    deepgramKey: env.DEEPGRAM_API_KEY || "",
    elevenKey: env.ELEVENLABS_API_KEY || "",
    voiceId: env.ELEVENLABS_VOICE_ID || "",
    allowFrom: (env.CALL_ALLOW_FROM || "")
      .split(",")
      .map((s) => toE164(s.trim()))
      .filter((s) => s.length > 3),
    publicHost: env.CALL_PUBLIC_HOST || "",
    greeting: env.CALL_GREETING || "Hi, this is Claude. How can I help?",
    // CALL_MODEL/CALL_EFFORT are now an override rather than a default: leave
    // them unset and each turn is routed automatically (haiku for talking,
    // sonnet-high for real work, opus only when asked for by name).
    forceModel: env.CALL_MODEL || "",
    forceEffort: env.CALL_EFFORT || "",
    budget: Number(env.CALL_BUDGET_USD || 1),
    cwd: config?.defaultWorkspace,
    verbose: true,
  };

  const ready =
    cfg.accountSid && cfg.authToken && cfg.deepgramKey && cfg.elevenKey && cfg.voiceId && cfg.allowFrom.length;

  const form = express.urlencoded({ extended: false });

  app.post("/twilio/voice", form, (req, res) => {
    const host = cfg.publicHost || req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    const url = `${proto}://${host}${req.originalUrl}`;

    if (!ready) {
      return twiml(res, "<Say>The bar is not configured for calls yet.</Say><Hangup/>");
    }
    if (!twilioSignatureOk(cfg.authToken, req.headers["x-twilio-signature"], url, req.body)) {
      console.warn("[call] rejected: bad Twilio signature for", url);
      if (env.CALL_DEBUG_SIG) {
        const data = Object.keys(req.body || {}).sort().reduce((a, k) => a + k + req.body[k], url);
        const mine = createHmac("sha1", cfg.authToken).update(Buffer.from(data, "utf8")).digest("base64");
        console.warn("[sig] sent    :", req.headers["x-twilio-signature"]);
        console.warn("[sig] computed:", mine);
        console.warn("[sig] url     :", url);
        console.warn("[sig] host hdr:", req.headers.host, "| x-fwd-host:", req.headers["x-forwarded-host"], "| x-fwd-proto:", req.headers["x-forwarded-proto"]);
        console.warn("[sig] params  :", Object.keys(req.body || {}).sort().join(","));
        console.warn("[sig] AccountSid:", req.body?.AccountSid, "| matches env SID:", req.body?.AccountSid === env.TWILIO_ACCOUNT_SID);
      }
      return res.status(403).type("text/plain").send("bad signature");
    }
    const from = toE164(req.body?.From || "");
    if (!cfg.allowFrom.includes(from)) {
      console.warn("[call] rejected caller", from);
      return twiml(res, "<Say>This number is not authorised.</Say><Hangup/>");
    }
    const wsUrl = `wss://${host}/twilio/stream`;
    twiml(res, `<Connect><Stream url="${wsUrl}"/></Connect>`);
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    if (!ready) return ws.close(1011, "not configured");
    // memory is read per call, so notes written by an earlier call are picked
    // up without restarting the server
    new Call(ws, { ...cfg, memory: readCallMemory() });
  });

  return {
    ready,
    cfg,
    // server.js routes /twilio/stream here
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
  };
}

function twiml(res, inner) {
  res
    .type("text/xml")
    .send(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
}
