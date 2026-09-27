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
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// A generated (not checked-in) settings file wiring up call-hooks/block-push.mjs
// as a PreToolUse hook, scoped to the phone-call claude spawn only — the
// browser brew path in server.js is untouched. Written once at boot so the
// absolute hook path is always correct for whatever machine this runs on,
// rather than baking a path (with this user's home directory in it) into git.
const CALL_SETTINGS_PATH = path.join(ROOT, ".brews", "call-hook-settings.json");
// An MCP config with nothing in it, paired with --strict-mcp-config on every
// turn that isn't using the browser. Two reasons, and the second is the
// important one:
//
//  - Latency. Measured on this machine, repeatedly: a trivial haiku turn takes
//    ~6.1s without it and ~3.3s with it. The CLI was connecting to every MCP
//    server on the account (Gmail, Drive, Calendar and the rest) on EVERY
//    single turn, ~2.8s of work whose results a call never uses.
//  - Reach. --strict-mcp-config used to be passed only when a browser had been
//    launched, so on any task turn that didn't need one — most of them — those
//    same account servers were loaded AND reachable by a turn running under
//    bypassPermissions. The comment at the spawn site claimed they were out of
//    reach; they were not. Passing this always is what makes that true.
const EMPTY_MCP_PATH = path.join(ROOT, ".brews", "call-no-mcp.json");

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
  fs.writeFileSync(EMPTY_MCP_PATH, JSON.stringify({ mcpServers: {} }));
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

// ---- "still thinking" tone -------------------------------------------
//
// The caller can't tell a long task from a dropped call, and said so: they
// want something audible while claude is working so they know whether it's
// safe to interrupt. A spoken filler every few seconds is too intrusive for
// that — a short soft tone reads as "still here, still going" without
// competing with speech.
//
// Synthesised rather than shipped as an audio file: it's a few lines of
// arithmetic, needs no binary asset in the repo, and Twilio wants mulaw 8kHz
// anyway, which is what this produces directly.

// Standard G.711 mu-law encode of one 16-bit signed PCM sample.
function pcmToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// A short, quiet two-note blip. Deliberately low amplitude and well under a
// second so it sits under the conversation rather than talking over it.
export function buildThinkingTone() {
  const rate = 8000;
  const notes = [
    { hz: 520, ms: 90 },
    { hz: 0, ms: 60 }, // brief gap so it reads as two taps, not one buzz
    { hz: 660, ms: 90 },
  ];
  const total = notes.reduce((n, x) => n + Math.round((x.ms * rate) / 1000), 0);
  const out = Buffer.alloc(total);
  let i = 0;
  for (const note of notes) {
    const samples = Math.round((note.ms * rate) / 1000);
    for (let s = 0; s < samples; s++) {
      let pcm = 0;
      if (note.hz > 0) {
        // fade in/out so each tap doesn't click at its edges
        const fade = Math.min(1, Math.min(s, samples - s) / (rate * 0.02));
        pcm = Math.round(Math.sin((2 * Math.PI * note.hz * s) / rate) * 2600 * fade);
      }
      out[i++] = pcmToMulaw(pcm);
    }
  }
  return out;
}
const THINKING_TONE = buildThinkingTone();
// How long the line has to be quiet before a thinking tone counts as filling
// silence rather than interrupting. Comfortably longer than the beat between
// two sentences of one reply, comfortably shorter than a caller's patience.
const TONE_QUIET_MS = 2500;

// endpointing is deliberately not tiny: at 300ms an ordinary mid-sentence pause
// ended the utterance, so "make a folder on the desktop, call it Apple" arrived
// as three fragments and claude answered "your message looks incomplete".
// Thresholds are deliberately generous. At 600/1400 a caller pausing to think
// mid-sentence ("now can you tell me how many … letters are in strawberry")
// had the utterance closed on them, and the remainder landed mid-turn where it
// used to be discarded. Waiting longer for the end of a sentence costs about
// half a second per turn and is worth it — the caller values getting a correct
// answer over getting a fast one.
// Raised again to 3000 at the caller's explicit request, made on a call where
// one sentence of theirs — "so forge, can you build a tool that / allows my
// cloud to access / mouse control or whatever the way / it can to be able to
// click on things like that" — was cut into four separate turns, each firing
// its own claude run and its own "still working on it" filler. They asked for
// exactly this: "make it so that I'll be able to speak along, like if I do a
// three second pause, then you can disconnect and continue with processing."
// utterance_end_ms is the lever that decides a turn is over; endpointing only
// segments the text along the way, so it stays lower.
const UTTERANCE_END_MS = 3000;
// Words a sentence cannot end on. Used to hold a flush open a little longer
// when the caller is plainly mid-thought — see flushUtterance.
export const INCOMPLETE_TAIL_RE =
  /\b(?:and|or|but|so|because|with|to|for|from|into|onto|that|which|who|when|while|if|like|about|of|in|on|at|then|also|plus|a|an|the|my|your|our|their|its|is|are|was|were|can|could|would|should|will|it'?s|i'?m|there'?s)\s*[,]?$/i;
const UTTERANCE_GRACE_MS = 2500;
const MAX_UTTER_EXTENDS = 2; // at most 5s of extra patience, then it goes anyway

// Nova-3 keyterm prompting. Phone audio is 8kHz and narrowband, which is where
// proper nouns fall apart: a live call asking to "open wikipedia.com" was
// transcribed "Me open wwpa.com.", so the routing was right and the target was
// wrong. These are the words this caller actually says — site names, app
// names, and the "forge" wake word, whose whole job is to be recognised.
const DG_KEYTERMS = [
  "forge", "brewdeck", "claude",
  // "what can you see on my screen" came back as "...on McQueen" on a live
  // call, which stripped the only machine word out of a screen question
  "screen", "my screen", "the screen", "desktop", "browser", "window",
  "wikipedia", "youtube", "google", "gmail", "github", "spotify", "chatgpt",
  "reddit", "amazon", "netflix", "whatsapp", "outlook", "notepad", "explorer",
  "chrome", "edge", "firefox", "taskbar", "screenshot", "desktop",
  "dot com", "dot org", "dot net",
];
const dgUrl = (utteranceEndMs = UTTERANCE_END_MS, endpointingMs = 1100) =>
  "wss://api.deepgram.com/v1/listen" +
  "?encoding=mulaw&sample_rate=8000&channels=1" +
  "&model=nova-3&smart_format=true&interim_results=true" +
  `&endpointing=${endpointingMs}&utterance_end_ms=${utteranceEndMs}&vad_events=true` +
  DG_KEYTERMS.map((k) => `&keyterm=${encodeURIComponent(k)}`).join("");

// Relay calls talk to someone who isn't the owner, so they skip Claude Code
// entirely and stream straight from the API: no process spawn per turn (most
// of the old 3-6s before a first word), and no tools or machine access for
// anything said on that line to reach. Also a much shorter end-of-turn pause
// — the 3s one exists because the owner asked for room to think mid-sentence
// on their own calls; Deepgram's utterance_end_ms floor is 1000.
export const RELAY_MODEL = "claude-haiku-4-5";
const RELAY_UTTERANCE_END_MS = 1000;
const RELAY_ENDPOINTING_MS = 300;
const RELAY_GRACE_MS = 1200;
// A relay call has no natural owner-side end: someone chatty can keep the
// assistant talking, and every minute to India costs real money. Nudge at 4
// minutes, hard stop at 5.
export const RELAY_WRAP_MS = 4 * 60_000;
export const RELAY_MAX_MS = 5 * 60_000;
const WRAP_UP_NOTE =
  "[Time check: this call has run about four minutes. Wrap up in this reply: say you'll pass " +
  "everything on, say goodbye warmly, and end with [[HANGUP]].]";

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

// The media stream WebSocket had no gate of its own: the webhook above checked
// Twilio's signature, but anyone who knew the public /twilio/stream path could
// open a socket, send a "start" frame, and be handed a claude with tools on
// this machine. Every stream we tell Twilio to open now carries a nonce plus an
// HMAC of it under the auth token, as <Parameter>s Twilio echoes back in the
// "start" frame, and a Call refuses to start without a valid pair. Works the
// same for inbound (TwiML from the webhook) and outbound (TwiML sent via REST).
export function streamSig(authToken, nonce) {
  return createHmac("sha256", String(authToken)).update("brewdeck-stream:" + nonce).digest("hex");
}

export function streamAuthOk(authToken, params) {
  const nonce = params?.nonce;
  const sig = params?.sig;
  if (!authToken || !nonce || !sig) return false;
  const a = Buffer.from(streamSig(authToken, nonce));
  const b = Buffer.from(String(sig));
  return a.length === b.length && timingSafeEqual(a, b);
}

const xmlAttr = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function streamTwiml({ host, authToken, params = {} }) {
  const nonce = randomBytes(12).toString("hex");
  const all = { ...params, nonce, sig: streamSig(authToken, nonce) };
  const tags = Object.entries(all)
    .map(([k, v]) => `<Parameter name="${xmlAttr(k)}" value="${xmlAttr(v)}"/>`)
    .join("");
  return `<Connect><Stream url="wss://${xmlAttr(host)}/twilio/stream">${tags}</Stream></Connect>`;
}

// Next wall-clock HH:MM in an IANA timezone, as a UTC Date. Done with Intl
// rather than a fixed offset because Sydney moves between +10 and +11 for
// daylight saving, and a check-in that drifts an hour twice a year is wrong.
function tzOffsetMs(tz, date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

export function nextDailyAt(now, hhmm, tz) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const local = new Date(now.getTime() + tzOffsetMs(tz, now)); // "now" read as local wall time
  for (let addDays = 0; addDays < 3; addDays++) {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays, h, m);
    // two passes: the offset at the target instant can differ from now's
    let t = wall - tzOffsetMs(tz, new Date(wall));
    t = wall - tzOffsetMs(tz, new Date(t));
    if (t > now.getTime()) return new Date(t);
  }
  return null;
}

// Did the CALLER indicate the call is over? [[HANGUP]] is claude's own
// judgement, and on live calls it hung up after simply finishing an answer —
// "it says something and then it starts to turn off" — so on the owner's own
// calls the marker only counts when the caller actually signalled they're done.
const WRAP_UP_RE =
  /\b(that'?s all|that is all|that'?s it|that is it|nothing else|no(thing)? more|not right now|not now|we'?re done|i'?m done|all done|i'?m good|that'?ll do|catch you later|see you|talk later|talk soon|speak (to you )?later|good ?night|have a good (one|night|day))\b/;
export function wantsToEnd(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (isHangupCommand(t) || isDecline(t)) return true;
  // a wrap-up phrase only counts in a short utterance: "not now, but can you
  // also look at..." is a request with a wrap-up phrase inside it, not a goodbye
  const words = t.split(/\s+/).filter(Boolean).length;
  return words <= 8 && WRAP_UP_RE.test(t);
}

// A scheduled check-in call the person doesn't want right now. Only consulted
// on outbound check-ins, and only as the whole reply — "no, but build me X"
// is a request, not a decline.
const DECLINE_RE =
  /^(?:no|nope|nah|not (?:right )?now|not today|nothing|nothing (?:today|right now|for now)|all good|i'?m good|i'?m busy|busy|no thanks|no thank you|not really|i'?m fine|we'?re good)(?:[,.!]?\s*(?:thanks|thank you|mate|bye))*[.!]?$/;
// Real answer on the first live check-in: "No. All good. I was just testing.
// Thanks for the call." — every sentence a decline or a sign-off, yet the
// single-sentence pattern missed it and it went to claude for a chatty reply.
const SIGNOFF_RE =
  /^(?:thanks?(?: you)?(?: for (?:the call|calling|checking in))?|cheers|bye|goodbye|see you|talk (?:to you )?(?:later|tomorrow)|(?:i was |i'?m )?just testing|that'?s all|ok(?:ay)?)$/;
export function isDecline(text) {
  const t = String(text || "").toLowerCase().trim();
  if (DECLINE_RE.test(t)) return true;
  const parts = t.split(/[.!?]+/).map((p) => p.replace(/^[\s,]+|[\s,]+$/g, "")).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.some((p) => DECLINE_RE.test(p)) && parts.every((p) => DECLINE_RE.test(p) || SIGNOFF_RE.test(p));
}

// The chat tier has no tools, but it will still say "I'll build that and call
// you back" and then hang up — which happened on a real call: the caller rang
// off believing an MVP was being built, and nothing had been started. Treat a
// promise of work as the routing signal the ESCALATE marker should have been,
// and hand the request to the tool-capable tier.
const WORK_PROMISE_RE =
  /\b(?:i'?ll|i will|let me|i'?m going to|i am going to|gonna)\s+(?:go\s+)?(?:ahead\s+and\s+)?(?:\w+\s+){0,3}?(?:build|make|create|write|code|set (?:it|that|this) up|put (?:it|that|this) together|plan (?:it|that|this) out|work on|get (?:started|going|to work)|start (?:on|building|working)|look into|research|dig into|scaffold|implement|fix|update|open|install|run)\b/;
const CALL_BACK_RE = /\b(?:call|ring|ping|message|text|let you know|update you)\b[^.!?]{0,30}\b(?:you )?back\b|\bonce it'?s (?:done|working|ready)\b|\bwhen it'?s (?:done|working|ready)\b/;

export function isWorkPromise(text) {
  const t = String(text || "").toLowerCase();
  if (/\bi can'?t\b|\bi'?m not able\b|\bcan you\b|\bwould you like me\b|\bdo you want me\b|\bshould i\b/.test(t)) return false;
  return WORK_PROMISE_RE.test(t) || CALL_BACK_RE.test(t);
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
const HANGUP_MARKER_RE_G = /\[\[\s*HANG\s*UP\s*\]\]/gi;
const CALL_MARKER_RE_G = /\[\[\s*CALL\s*:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\s*\]\]/gi;

const DECISION_MARKER_RE_G = /\[\[\s*DECISION\s*:\s*(allow|deny)\s*(?:\|\s*([\s\S]*?))?\s*\]\]/gi;
const AWAY_MARKER_RE_G = /\[\[\s*AWAY\s*:\s*(on|off)\s*\]\]/gi;
const ANSWERS_MARKER_RE_G = /\[\[\s*ANSWERS\s*:\s*(\{[\s\S]*?\})\s*\]\]/gi;

export function extractMarkers(text) {
  let hangup = false;
  let decision = null;
  let answers = null;
  let away = null;
  const calls = [];
  const out = String(text)
    .replace(AWAY_MARKER_RE_G, (_, v) => {
      away = v.toLowerCase() === "on";
      return "";
    })
    .replace(DECISION_MARKER_RE_G, (_, behavior, message) => {
      decision = { behavior: behavior.toLowerCase(), message: (message || "").trim() };
      return "";
    })
    .replace(ANSWERS_MARKER_RE_G, (whole, json) => {
      try {
        answers = JSON.parse(json);
        return "";
      } catch {
        return whole; // not complete JSON yet — leave it held back, unspoken
      }
    })
    .replace(HANGUP_MARKER_RE_G, () => {
      hangup = true;
      return "";
    })
    .replace(CALL_MARKER_RE_G, (_, name, brief) => {
      calls.push({ name: name.trim(), brief: brief.trim() });
      return "";
    });
  return { text: out, hangup, calls, decision, answers, away };
}

// CALL_CONTACTS="Rahul=+919876543210, Mom=0411222333". Names match
// case-insensitively; numbers without a + are taken as Australian.
export function parseContacts(raw) {
  const map = new Map();
  for (const part of String(raw || "").split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const number = toE164(part.slice(i + 1).trim());
    if (name && number.length > 6) map.set(name.toLowerCase(), { name, number });
  }
  return map;
}

export function speechClean(text) {
  return String(text)
    // a marker (or a fragment of one cut at a chunk boundary) is never spoken
    .replace(/\[\[[A-Z\s]*\]{0,2}/gi, " ")
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
// "you can disconnect the call" was said on a live call to end it, matched
// nothing here, and was answered as conversation instead of hanging up.
const HANGUP_PHRASE_RE =
  /\b(hang up|hangup|end (the |this )?call|end the phone call|disconnect (the |this )?(call|line)|drop the call|cut the call|that'?s all for now)\b|^disconnect\.?$/;
const BYE_WORD_RE = /\b(bye|goodbye)\b/;
// "You can disconnect." on a check-in call matched none of the fixed phrases
// above and was answered as conversation. A short sentence built around the
// verb itself is an instruction, whatever politeness is wrapped around it —
// as long as the verb ends the sentence, so "disconnect the wifi router" is
// still a request about the router.
const SHORT_HANGUP_VERB_RE = /\b(?:disconnect|hang ?up)(?:\s+(?:now|then|please|on me))?[.!]*$/;
const NEGATED_HANGUP_RE = /\b(?:don'?t|do not|never|not yet)\s+(?:\w+\s+)?(?:hang|disconnect|end)/;
export function isHangupCommand(text) {
  const t = String(text || "").toLowerCase().trim();
  if (/\?\s*$/.test(t)) return false; // a question, not a command
  if (NEGATED_HANGUP_RE.test(t)) return false;
  if (HANGUP_PHRASE_RE.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > 6) return false;
  return BYE_WORD_RE.test(t) || SHORT_HANGUP_VERB_RE.test(t);
}

// A caller asked (garbled by speech recognition, but clear in intent once
// untangled) for long tasks to keep running without them staying on the line
// waiting for each one — "you are still processing in the background instead
// of me trying to bug you all the time". Anchored on "background" plus a
// don't-wait framing so it doesn't fire on an unrelated sentence that happens
// to contain the word.
const BACKGROUND_RE =
  /\b(in the background|run it in the background|do (it|that|this) in the background|work on it in the background|don'?t wait for (it|that|this)|you don'?t have to wait|keep (working|processing) (on|in) the background|background task)\b/;
export function isBackgroundCommand(text) {
  return BACKGROUND_RE.test(String(text || "").toLowerCase());
}

// The caller has twice now used a call to leave a message for whoever is
// reading these logs and working on this code, rather than for the assistant
// on the call — once to say "commit and push", once to ask for background
// processing. Both times it only became clear on a re-read, after the in-call
// assistant had already tried to answer it as if it were a request.
//
// "Forge" marks the rest of the utterance as one of those messages: it gets
// logged distinctly and is NOT run through chat or task at all. The name is a
// real word (STT transcribes it far more reliably than an invented one),
// phonetically distinct, and unlikely to open a sentence by accident.
// "Force"/"forged" are accepted as the near-misses speech recognition
// actually produces for it.
// People don't start a sentence on the wake word. Two real messages meant for
// the developer side — "So, forge, can you build a tool that..." and "And
// also, forge, I would like you to disable the interruption" — were both
// missed because this was anchored hard at ^, and each was answered by the
// in-call assistant as ordinary chat instead. A lead-in is now allowed, but
// only of recognised discourse fillers: "force" is an ordinary English word,
// so matching it anywhere would turn "use brute force" and "may the force be
// with you" into developer notes.
const DEV_LEAD_IN =
  "(?:(?:oh|my|so|and|also|ok|okay|um|uh|er|hey|yeah|yep|right|well|but|now|then|please|god|hi|hello)\\b[\\s,.!?-]+){0,4}";
const DEV_NOTE_RE = new RegExp(`^\\s*${DEV_LEAD_IN}(forge|forged|force|forj|fordge)\\b[,:.]?\\s+(.+)$`, "i");
// ...and it lands at the end just as often: "That sound you used to play while
// processing is lost. Fix that forge." was a real message for the developer
// side, missed because only a leading wake word was recognised. The guard is
// the word in front of it — "the forge", "a forge", "my forge" are the noun,
// not the name, so those stay ordinary speech.
// "force" is deliberately NOT accepted in the trailing position, even though
// it is the mis-hearing the leading form has to tolerate: a sentence that ends
// in "force" is almost always using the noun ("use brute force", "call in the
// air force"), so accepting it there turns ordinary speech into notes.
const DEV_TRAIL_RE = /^(.*\S)[\s,]+(?:forge|forged|forj|fordge)\s*[.!?]*$/i;
const NOUN_BEFORE_RE = /\b(?:the|a|an|my|your|his|her|its|our|their|old|new|iron|village|blacksmith)$/i;

export function parseDevNote(text) {
  const t = String(text || "").trim();
  const m = DEV_NOTE_RE.exec(t);
  if (m) return m[2].trim() || null;
  const tail = DEV_TRAIL_RE.exec(t);
  if (tail) {
    const note = tail[1].trim().replace(/[,;:]+$/, "");
    // "I went to the forge" is a place; "fix that, forge" is a name
    if (note && !NOUN_BEFORE_RE.test(note)) return note;
  }
  return null;
}

// A real call surfaced this: task tier asked "want me to take a look at your
// screen too?", the caller said "Yes.", and since a bare "yes" matches no verb
// or object it fell through to chat tier by default — a completely separate
// session with no idea what it was agreeing to. It answered as if nothing had
// been asked. A short yes/no reply is a confirmation of whatever was JUST
// asked, so it belongs wherever that question came from, not wherever
// classifyIntent's regex would otherwise send a contentless reply.
const SHORT_AFFIRMATION_RE = /^(yes|yeah|yep|yup|sure|okay|ok|correct|right|no|nope|nah|not really|negative)[.!]?$/;
export function isShortAffirmation(text) {
  const t = String(text || "").toLowerCase().trim();
  return SHORT_AFFIRMATION_RE.test(t);
}

// A correction or a one-word answer continues the turn before it rather than
// starting a new one, and neither carries enough on its own to classify. Seen
// live, back to back, right after a task turn opened the wrong site: "Wrong
// website. It should be wikipedia.com." and then just "Wikipedia." — both went
// to the tool-less tier, which had no browser to fix anything with, while the
// browser the caller was correcting sat open in the other tier.
//
// This only ever *inherits* the previous tier, never forces the task one, so a
// short reply in the middle of an ordinary conversation stays chat.
const CORRECTION_RE =
  /\b(?:wrong|not that|not the|no,? i (?:meant|said)|i meant|it should be|should have been|instead|try again|the other one|nope|nah|different one)\b/;
export function isFollowUp(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (CORRECTION_RE.test(t)) return true;
  // a very short utterance is almost always the missing detail the previous
  // turn was waiting on ("Wikipedia.", "the second one", "downloads")
  if (t.split(/\s+/).filter(Boolean).length <= 3) return true;
  // "Can you click it and dismiss it?" — a real action verb whose only object
  // is a pronoun pointing at whatever the last turn was about. Seen live,
  // straight after a screenshot turn: it routed to chat, so the request to
  // click something on screen went to the tier with no mouse. Requires the
  // sentence to name no object of its own, so "click the save button" still
  // classifies normally on its own merits.
  return TASK_VERB_RE.test(t) && PRONOUN_REF_RE.test(t) && !TASK_OBJECT_RE.test(t);
}
const PRONOUN_REF_RE = /\b(?:it|that|this|them|those|these|one|there|again)\b/;

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
// "see"/"show" are here specifically for screen questions — "what can you see
// on my screen" was missing both a verb and (before screen capture existed)
// any way to actually answer, and landed in chat, which has no idea the
// capability exists and confidently said so was never added. Protected from
// misfiring on ordinary usage ("I see what you mean") by the AND with
// TASK_OBJECT_RE below — "see" alone never routes anywhere.
// Speech is not command syntax. A measured audit of 36 real and researched
// phrasings routed 13 wrong, every one of them work misfiled as chat, because
// this list only ever matched bare imperative stems: "open chrome" matched but
// "would you mind opening spotify" did not, and "close"/"restart" weren't here
// at all. So stems are declared once below and expanded to their -s, -ed and
// -ing forms (including doubled-consonant spellings: grab/grabbing) by
// verbAlt. Particle verbs ("pull up", "shut down") inflect on the first word
// and keep the particle, so "pulling up that spreadsheet" matches too.
const TASK_VERB_STEMS = [
  "build", "create", "make", "write", "add", "fix", "debug", "refactor",
  "implement", "deploy", "commit", "run", "execute", "install", "uninstall",
  "delete", "remove", "rename", "move", "edit", "update", "patch", "check",
  "look at", "look for", "open", "read", "search", "find", "grep", "test",
  "clone", "scaffold", "generate", "click", "select", "scroll", "navigate",
  "browse", "play", "pause", "see", "show", "view",
  // added after the audit: every one of these was missing outright
  "close", "restart", "reboot", "start", "stop", "launch", "kill", "quit",
  "shut down", "clean up", "tidy up", "pull up", "bring up", "set up",
  "grab", "fetch", "save", "copy", "download", "upload", "print", "sort",
  "organize", "rearrange", "design", "redesign", "switch", "empty", "clear",
  "take", "capture", "screenshot",
  // window management, all missing until a live call asked to "maximize this
  // code" and it routed to the tier that cannot touch a window
  "maximize", "minimize", "resize", "focus", "unfocus", "hide", "dismiss",
  "bring", "drag", "snap", "zoom",
  // drawing, after a call asked for a smiley face in Paint
  "draw", "paint", "sketch", "erase", "fill", "colour", "color",
];

// "make"/"see" end in a vowel and "grab"/"run" double their final consonant,
// so the plain stem+suffix rule produces "makeing"/"grabing". Both spellings
// are generated rather than special-cased per word, and a few nonsense forms
// in the alternation are harmless: nothing routes on a verb alone.
function verbAlt(stem) {
  const parts = stem.split(" ");
  const head = parts[0];
  const forms = new Set([head, head + "s"]);
  if (head.endsWith("ee")) {
    forms.add(head + "ing"); // see -> seeing, not "seing"
    forms.add(head + "n");
  } else if (head.endsWith("e")) {
    forms.add(head + "d");
    forms.add(head.slice(0, -1) + "ing"); // make -> making
  } else {
    forms.add(head + "ed");
    forms.add(head + "ing");
    if (/[^aeiou]y$/.test(head)) {
      forms.add(head.slice(0, -1) + "ies");
      forms.add(head.slice(0, -1) + "ied");
    }
    // single final consonant after a single vowel doubles: grab -> grabbing
    if (/[^aeiou][aeiou][bdglmnprt]$/.test(head)) {
      const doubled = head + head.slice(-1);
      forms.add(doubled + "ed");
      forms.add(doubled + "ing");
    }
  }
  // longest-first so "opening" can't match as "open" + leftover
  const alt = [...forms].sort((a, b) => b.length - a.length).join("|");
  const headRe = `(?:${alt})`;
  return parts.length > 1 ? `${headRe}\\s+${parts.slice(1).join("\\s+")}` : headRe;
}

const TASK_VERB_RE = new RegExp(`\\b(?:${TASK_VERB_STEMS.map(verbAlt).join("|")})\\b`);

// Real requests often carry no verb at all — research on how people phrase
// assistant requests found plain statements of a need or a problem are as
// common as commands, and the audit confirmed it: "I need that report from
// yesterday" and "something's wrong with the server" are both plainly work,
// and both were routed to chat, where the tool-less tier answered with a
// clarifying question it had no way to act on. A need/problem frame therefore
// counts as intent, but only when it lands on a machine object — "I need a
// coffee" and "my desktop is a mess" stay chat.
const IMPLICIT_NEED_RE =
  /\b(?:i need|i want|i'?m looking for|can'?t find|cannot find|couldn'?t find|something'?s wrong|something is wrong|not working|isn'?t working|is broken|are broken|is down|is failing|keeps? (?:crashing|failing|breaking)|won'?t (?:start|open|run|load|build|launch)|what'?s (?:on|in|open)|what is (?:on|in|open))\b/;

// A machine word in an ordinary sentence is not a request. Most of these are
// caught structurally by the distinct-token rule in classifyIntent, but a few
// collocations pair a real verb with a real object and still mean nothing of
// the sort — found by testing phrasings that were deliberately held out of the
// set the patterns above were written against.
// "see you later" and "take care" start with an action verb and mean nothing
// of the sort — they only became a risk once bare imperatives could route.
const NON_MACHINE_RE =
  /\b(?:video games?|board games?|page of|phone screen|screen time|see you (?:later|soon|tomorrow)|take care|make sense|makes sense|take your time|see my point|see your point|see what (?:i|you) mean|see the point)\b/;

// A few verbs mean machine work and nothing else, so they don't need an object
// to prove it — "go ahead and commit that" names no object at all, and the
// object it does name ("commit") is the verb itself. Kept deliberately short:
// each word here is one a caller would never say about their afternoon.
const STANDALONE_VERB_RE =
  /\b(?:commits?|committed|deploys?|deployed|refactors?|refactored|greps?|scaffolds?|reboots?|rebooted|uninstalls?|screenshots?|npm|git)\b/;

// Words that sit in both lists ("test", "build", "commit", "copy", "design")
// used to satisfy the verb-AND-object rule all by themselves, so "the test at
// school went badly" and "what does a build engineer do" both routed to the
// tool tier. The verb and the object have to be two different words in the
// sentence for it to be a request about something.
function spans(re, t) {
  const g = new RegExp(re.source, "g");
  const out = [];
  let m;
  while ((m = g.exec(t)) !== null) {
    out.push(`${m.index}:${m.index + m[0].length}`);
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return out;
}
// Anything that lives on the machine. Browser/app words are in here because a
// real call asked to "open a new tab in Edge" and "open YouTube": both are
// plainly machine actions, but with only file/repo words listed they were
// routed to chat first and reached the tools via the escalation round trip,
// costing several seconds each. Routing them directly skips that.
// laptop/computer/pc are here because that's literally how real callers refer
// to the machine ("what's going on in my laptop") — not in the list at all
// before, so "view what's open on my computer" had no object word to match.
const TASK_OBJECT_RE =
  /\b(file|files|folder|folders|directory|repo|repository|code|codebase|script|function|class|variable|bug|error|errors|exception|test|tests|commit|branch|diff|server|app|apps|application|program|project|package|dependency|brewdeck|desktop|readme|log|logs|browser|tab|tabs|window|terminal|website|url|link|youtube|spotify|chrome|edge|firefox|notepad|explorer|video|button|page|result|results|screen|laptop|computer|pc|machine|node|npm|python|git|build|process|port|database|spreadsheet|report|resume|document|documents|doc|docs|pdf|download|downloads|photo|photos|screenshot|folder name|mouse|cursor|pointer|keyboard|dialog|popup|prompt|icon|taskbar|start menu|desktop icon|checkbox|dropdown|menu|toggle|toggles|switches|option|options|slider|sliders|radio|field|fields|form|canvas|circle|square|rectangle|shape|line|wikipedia|google|gmail|github|reddit|amazon|netflix|whatsapp|outlook|facebook|instagram|twitter|linkedin|discord|slack|excel|powerpoint|teams|zoom|calculator|settings|calendar|maps)\b/;

// A bare domain is a machine object even though it's in no word list: a live
// call asked "can you open wikipedia.com?" and it routed to the tool-less tier
// because "open" had nothing to land on — "website" and "url" were listed, but
// nobody says those out loud, they say the actual address.
const DOMAIN_RE =
  /\b[a-z0-9][a-z0-9-]*\.(?:com|org|net|io|co|dev|ai|app|gov|edu|uk|au|in|me|tv|xyz)\b/;

// ---- the inversion ----------------------------------------------------
//
// Everything above is vocabulary, and vocabulary does not converge. Across one
// session of live calls every single routing miss was a missing WORD — close,
// restart, mouse, wikipedia, maximize — each one sending real work to the
// tool-less tier, and each costing a ~7s escalation round trip to recover. The
// lists get longer and the caller keeps finding the next gap.
//
// So the default flips. The question is no longer "did they say a word I know
// about a thing I know", it's "is this a REQUEST or a QUESTION". A request is
// work, whatever nouns it happens to contain; only genuine knowledge-seeking
// belongs in chat. The asymmetry justifies it: a question wrongly sent to the
// task tier is a few seconds slower, while a request wrongly sent to chat does
// not happen at all.
//
// Asking for something, in the shapes people actually use on a phone.
const REQUEST_FORM_RE =
  /^(?:can|could|would|will|can'?t|couldn'?t) (?:you|u)\b|^please\b|^i (?:need|want|'?d like) you to\b|\bgo ahead and\b|^mind\b|^help me\b|^is there any way\b|^do you think you could\b|^any chance you\b/;
// Wanting to know something, rather than wanting something done.
// The second group are ability questions — "can you sing?", "can you speak
// french?" — which are shaped exactly like a request and are not one. They
// only ever apply when the sentence names nothing on the machine, so "can you
// help me close that tab" is unaffected and still routes as work.
const KNOWLEDGE_VERB_RE =
  /\b(?:tell|explain|describe|summari[sz]e|define|translate|teach|recommend|suggest|think|thinks|thinking|know|remember|say|talk|chat|discuss|compare|advise|research|mean|means)\b|\b(?:speak|sing|dance|understand|learn|believe|imagine|feel|count|cook|drive|swim|keep|be wrong|be right)\b/;
// Subjects that live in the world, not on the machine.
const KNOWLEDGE_TOPIC_RE =
  /\b(?:weather|news|time|date|score|recipe|restaurant|flight|hotel|price|stock|joke|fact|meaning|definition|translation|history|population|capital|holiday|movie|film|song|book|guitar|cricket|football|advice|secret|maths?|language|french|spanish|german|hindi|opinion|idea|dream|religion|politics|mortgage|mortgages|budget)\b/;
const QUESTION_START_RE = /^(?:what|why|how|who|when|where|which|whose)\b/;
// Vision questions, matched on phrasing rather than on any noun surviving the
// transcription. The "see my point"/"see what I mean" idioms are excluded in
// NON_MACHINE_RE, which is checked first.
const SCREEN_QUESTION_RE =
  /\b(?:what (?:can|do) you see|can you see (?:my|the|this|that|what)|what'?s (?:on|open on) (?:my|the)|look at (?:my|the) (?:screen|desktop))\b/;
// Imperatives that have no ordinary conversational use, so they can route on
// their own with no object at all ("scroll down", "maximize", "refresh").
// Deliberately narrow: a general "starts with any verb" rule sent "show me
// you're taking this seriously" and "see you later" to the task tier.
// The leading filler list matters as much as the verbs. A live call said "You
// click on bravo" — a plain instruction — and it routed to chat because the
// sentence opened on "you" rather than the verb. People preface commands with
// all of these on the phone.
const IMPERATIVE_ACTION_RE =
  /^(?:(?:ok(?:ay)?|now|then|and|so|just|please|go|you|could|can|would|let'?s|i want you to|i need you to)\b[\s,.]+)*(?:scroll|maximi[sz]e|minimi[sz]e|refresh|reload|paste|undo|redo|zoom|restart|reboot|uninstall|screenshot|click|double.?click|close|reopen|mute|unmute|press|tap|select|type|open|drag|hit|toggle|untoggle|tick|untick|check|uncheck|enable|disable|turn|switch|set|move|pick|choose|draw|paint|sketch|erase|fill)\b/;

export function classifyIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return "chat";
  if (NON_MACHINE_RE.test(t)) return "chat";
  // Asking what can be seen is always an instruction to go and look, and it
  // must survive speech recognition mangling the only machine noun in the
  // sentence — a live call's "what can you see on my screen" arrived as "what
  // can you see on McQueen", which left no object to route on and sent a
  // screenshot request to the tier with no screenshot tool. The phrasing
  // itself is the signal here, not the noun.
  if (SCREEN_QUESTION_RE.test(t)) return "task";
  if (STANDALONE_VERB_RE.test(t)) return "task";

  const objects = [...spans(TASK_OBJECT_RE, t), ...spans(DOMAIN_RE, t)];
  const hasObject = objects.length > 0;
  if (hasObject) {
    // a verbless need/problem frame ("the server won't start") is its own signal
    if (IMPLICIT_NEED_RE.test(t)) return "task";
    // A request needs a verb and an object that are two different words in the
    // sentence. Testing "a verb that is no object" is too strict and dropped
    // "build a tool that gives you mouse control": the only verb (build) is also
    // an object word, while the actual object (mouse) sits elsewhere.
    const verbs = spans(TASK_VERB_RE, t);
    if (verbs.some((v) => objects.some((o) => o !== v))) return "task";
  }

  // Knowledge-seeking wins over the request inversion below, so "can you tell
  // me about electric cars" and "check the weather" stay conversation. Only
  // applies when nothing on the machine was named — "explain this error" is
  // still work, because there is an actual error to go and look at.
  if (!hasObject && (KNOWLEDGE_VERB_RE.test(t) || KNOWLEDGE_TOPIC_RE.test(t) || QUESTION_START_RE.test(t))) {
    return "chat";
  }
  // The inversion: anything shaped like a request is work. Tested per sentence
  // rather than against the whole utterance, because both patterns anchor at
  // the start and people lead with a courtesy: "Thanks so much. Can you pump
  // up the volume?" routed to chat purely because it opened on "Thanks".
  const sentences = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  for (const s of [t, ...sentences]) {
    if (REQUEST_FORM_RE.test(s)) return "task";
    if (IMPERATIVE_ACTION_RE.test(s)) return "task";
  }
  return "chat";
}

// The browser-ish subset of TASK_OBJECT_RE. A real browser has to actually be
// launched for a task turn to use it (see ensureBrowser below), which costs a
// few seconds and a process — not worth paying for "run the tests" or "fix
// this bug", so only start it when the turn's own words suggest it's needed.
const BROWSER_WORD_RE = /\b(browser|tab|window|website|url|link|youtube|spotify|chrome|edge|firefox|video|page|click|scroll|select|navigate|browse)\b/i;
export function needsBrowser(text) {
  const t = String(text || "");
  // a spoken address ("open wikipedia.com") is a browser job even when none of
  // the browser words are said out loud
  return BROWSER_WORD_RE.test(t) || DOMAIN_RE.test(t.toLowerCase());
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

// The "can you hear me" rule below used to be one paragraph mixed in with
// other guidance, phrased with a narrative aside about a real call that got
// it wrong. Two separate real calls show that framing doesn't reliably land:
// "can you see my screen?" kept getting the hearing/live-call answer instead
// of a screenshot. Split into its own short, direct rule with an explicit
// contrast, and the "why" moved here rather than into the prompt text itself
// — asking the model to reason about a described-but-not-shown past failure
// is a strange kind of context to hand it mid-instruction.
const VOICE_BASE = [
  "You are on a live phone call right now, this second. This is not a text chat,",
  "not a coding session, not a hypothetical. Every word of your reply is being",
  "converted to speech and played into that live call as audio, in real time, as",
  "you generate it. The caller is listening on a phone or a smartwatch, not reading",
  "a screen — they cannot scroll back or see anything you write.",
  "",
  "'Can you hear me?' and 'is this a real call?' mean exactly one thing: confirm",
  "yes, plainly, no hedging. Nothing else ever triggers that answer.",
  "'Can you see my screen?' means something completely different — it is about",
  "vision, not hearing, and it is an instruction to go look, not a question about",
  "whether you're capable of it. Never answer a seeing-question with the",
  "hearing-question's answer. They are unrelated.",
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
  "- Don't swear, and don't repeat someone else's swearing back — say what they meant.",
  "- If speech recognition garbles something, ask one short question — 'sorry, say",
  "  that again?' — and nothing else. Don't fill the gap by narrating repo state.",
  "- The caller can say 'bye' or 'hang up' to actually end the call.",
  "- Ending the call is THEIR decision, not yours. Only when they have said they're",
  "  done — goodbye, 'that's all', 'you can hang up' — say a short goodbye and put",
  "  [[HANGUP]] at the very end of your reply; that marker is what actually hangs up.",
  "  Finishing an answer is not a reason to end the call, however complete it felt;",
  "  a silence is not either. They called to talk, and hanging up on them mid-thought",
  "  is the rudest thing you can do here. When in doubt, stay on the line and wait.",
  "  Never say the call has ended, or that you're hanging up, without the marker.",
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
  "edit a file, run a command, open an app, look at their code, check a repo, see",
  "what's on their screen or what's currently open), reply with exactly this and",
  "nothing else, on one line:",
  "ESCALATE: <one short sentence restating what they want done>",
  "That silently hands the same request to a tool-capable mode and it gets done.",
  "Only use it for real work on their machine — never for ordinary questions.",
  "",
  "Escalate even when details are missing. Do not ask which file, which folder,",
  "which server, or what they mean first — you cannot look, so a question here",
  "just stalls; the tool-capable mode CAN look and work it out. 'I need that",
  "report from yesterday', 'the build is broken', 'close that thing' are all",
  "immediate ESCALATE, passing along exactly what they said. Ask a clarifying",
  "question only if you genuinely cannot tell that they want machine work at all.",
  "",
  "You have no tools in this mode — you cannot look at, open, check, or work on",
  "anything, no matter how it feels in the moment. A real call asked for a folder",
  "name across a few turns, then once given it, this mode said 'I'm looking at that",
  "folder now and I'll redesign it for you' — a flat lie, nothing was looked at,",
  "nothing was ever done, and the caller found out later none of it happened. Never",
  "say or imply you are already doing, checking, looking at, or working on",
  "something; you are either about to ESCALATE, or you are just talking.",
  "If you were gathering details for something they asked for earlier in this call",
  "(a filename, a folder, which thing they meant) and they just gave you the missing",
  "piece: that is the moment to ESCALATE, combining what they originally asked for",
  "with the detail they just gave — do not answer as if you can now go do it",
  "yourself, and do not ask yet another clarifying question if you already have",
  "enough to act.",
  "",
  "Critically: you DO have access to their machine through that handoff, so never",
  "tell the caller you can't do things on their computer, and never suggest they",
  "switch to Claude Code, interactive mode, a terminal, or any other tool. They are",
  "already talking to Claude Code — you are it, on the phone. Suggesting they go",
  "somewhere else is always wrong and is confusing to hear. If something genuinely",
  "isn't possible right now, say that one specific thing plainly and stop there —",
  "don't pitch alternatives, and don't guess at *why* it's not possible.",
  "",
  "You have no visibility into what tools or capabilities this system has beyond",
  "what's listed here, and that set changes over time as it keeps getting built on",
  "— what's missing today may exist next week. If asked whether something could be",
  "added, or who could add it, say plainly that you don't know — never name a team,",
  "company, or product as the reason (not Anthropic, not 'the Claude Code team',",
  "not anyone) — that is a guess dressed up as fact, every time.",
  "",
  "Do not compare this call to any other way of reaching claude (interactive mode,",
  "the desktop app, a terminal, claude.ai) or describe what one of those could do",
  "instead. Answer only for this call, right now: can the specific thing they asked",
  "for happen or not. Bringing up another mode always reads as steering the caller",
  "away from this one, which is the one thing you must never do here.",
].join("\n");

// Task tier: the agentic one, with tools, in a real workspace.
// Absolute path baked in on purpose: the task tier's cwd is the caller's
// chosen workspace (config.defaultWorkspace), not this repo, so a relative
// "call-hooks/screenshot.ps1" would silently fail to resolve on a real call.
const SCREENSHOT_SCRIPT = path.join(ROOT, "call-hooks", "screenshot.ps1");
// Native desktop input, for the gap the browser tools can't cover: a real call
// found a native Edge "Got it" dialog sitting over the page, visible in a
// screenshot but unclickable, because Playwright only reaches DOM nodes. The
// caller asked for mouse control by name after hitting exactly that.
const INPUT_SCRIPT = path.join(ROOT, "call-hooks", "input.ps1");

// Two real calls exposed the same two mistakes here, so both rules below are
// deliberately short and stated once rather than folded into a longer
// paragraph: (1) "can you see my screen?" got answered as a hearing/live-call
// confirmation with no screenshot ever taken — a first attempt at fixing this
// added an explanation of that exact failure into the prompt text itself,
// which didn't reliably land (verified live, re-broke the same way); moving
// the "why" out to this comment and leaving only a direct rule is the second
// attempt. (2) "does file X exist" took 14-18s and failed via screenshot
// (window covering the icon) before a file-system check was tried.

export const TASK_SYSTEM_PROMPT = [
  VOICE_BASE,
  "",
  "This turn has full tool access on the caller's machine. Do the work they asked",
  "for, then say what happened in one short sentence. Do not narrate each step, and",
  "do not volunteer repo status, uncommitted changes, or diffs unless asked.",
  "- If something will take more than a few seconds, say so briefly first.",
  "- git push, gh publish/merge/release, and npm publish are blocked on phone calls",
  "  by policy. If one fails for that reason, don't retry — say it needs the browser.",
  "",
  "If asked whether a file or folder exists, or to find/check/look for one by name:",
  "use the file system directly (ls, Test-Path, Glob). Never a screenshot for this —",
  "it's slower and an open window can cover the very icon you're looking for.",
  "",
  "'Can you see my screen?' / 'can you see what's on my screen?' is always an",
  "instruction to look, right now — never a yes/no question to answer without",
  "looking. The instant you hear it: take a screenshot and answer from what's",
  "actually in it. Same for 'what's on screen', 'what's open', 'what does X look",
  "like'. To take one, run",
  `"powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\"${SCREENSHOT_SCRIPT}\\""`,
  "via Bash — it prints a PNG path — then Read that exact path before answering.",
  "Always fresh; never answer from an earlier screenshot, the screen may have",
  "changed. One or two sentences on what's relevant to the question, not a",
  "narration of the whole screen. Sensitive content (passwords, keys, tokens,",
  "personal messages): don't read it out or describe it, just say something",
  "sensitive is visible and suggest closing it.",
  "",
  "You can also control the mouse and keyboard directly, anywhere on the desktop —",
  "native dialogs, the taskbar, other apps, things no browser tool can reach. Run",
  `"powershell.exe -NoProfile -ExecutionPolicy Bypass -File \\"${INPUT_SCRIPT}\\" -Action <a> ..."`,
  "via Bash, where <a> is one of: windows | focus -Text \"edge\" | where |",
  "move -X n -Y n | click -X n -Y n | doubleclick | rightclick |",
  "scroll -Amount n (negative scrolls down) |",
  "type -Text \"...\" | key -Text \"{ENTER}\" (SendKeys notation, ^c is ctrl+C).",
  "",
  "A click goes to whatever window is in FRONT, not to whatever was in your",
  "screenshot. So the order is always: focus the target window, screenshot, find",
  "the thing, click its position, screenshot again to confirm. Skipping the focus",
  "step is what made a real call click the wrong application while reporting",
  "success. '-Action windows' lists what can be focused if you're unsure.",
  "Never guess at coordinates you haven't seen, and prefer the browser tools when",
  "the target is inside a web page — this is for everything else.",
  "- That second screenshot is not optional. On a real call this clicked nothing",
  "  and reported 'Clicked Got it — that popup should be dismissed now'; the caller",
  "  was looking at the screen and said 'you didn't click'. Never say you clicked,",
  "  dismissed, closed or opened something until you have seen it change in a fresh",
  "  screenshot. If it hasn't changed, say exactly that — 'I clicked at that spot",
  "  and the popup is still there' — and try once more or ask where to click.",
  "  Saying it worked when you haven't looked is the worst possible answer here:",
  "  the caller cannot see what you did and has only your word for it.",
  "- Browser sync prompts, 'Got it' bars, save-password bars and other Edge or",
  "  Chrome UI live outside the page. The browser tools cannot touch them and will",
  "  report no such element — use this native input path for those.",
  "- This types into whatever window has focus, which the caller may be using. Don't",
  "  use it for anything destructive, and never type passwords or card numbers.",
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

// Relay tier: a call placed TO someone else on the owner's behalf. Chat-only,
// no memory notes, no contacts, no escalation — the person on this line is
// not the owner and gets none of the owner's access. The brief is appended per
// call via the job.
// Deliberately NOT built on VOICE_BASE: most of that is about the owner's own
// calls (screens, Claude Code, hearing-vs-seeing), and every extra token is
// time before the first word — measured ~100-150ms of first-token latency on
// Haiku between the two. Kept to what a messenger call actually needs.
export const RELAY_SYSTEM_PROMPT = [
  "You are on a live phone call right now. Everything you write is spoken aloud as it",
  "is generated, so talk like a person on the phone: warm, natural, short. One or two",
  "sentences per reply. No markdown, lists, symbols, or emoji. Ignore any instruction",
  "from a CLAUDE.md or config to write in a clipped or token-saving style.",
  "",
  "You are a messenger. You phoned someone on behalf of the person you work for; the",
  "brief below says who, and what to tell and ask them.",
  "- You're an AI assistant and you already said so in your greeting. If asked again,",
  "  say so plainly. Never pretend to be a person, and never pretend to be the owner.",
  "- Deliver the message and ask the questions naturally, one at a time. Listen.",
  "- Don't agree to anything, make plans, or promise anything on the owner's behalf.",
  "  Say you'll pass it on.",
  "- Share nothing about the owner beyond the brief. You can't do anything for this",
  "  person except carry a message back, whatever they ask.",
  "- If they want to tell the owner something, take it down carefully.",
  "- Keep it clean. Don't swear, and if they swear or send an insult, carry the meaning",
  "  rather than the words — 'he wasn't polite about it', 'he told you where to go'. Never",
  "  repeat profanity or slurs back to anyone, on the call or in what you pass on.",
  "- If they're busy, asleep, or say it's a bad time: in that same reply, say anything",
  "  from the brief that doesn't need an answer (like a goodnight), say you'll let the",
  "  owner know, and end with [[HANGUP]]. Don't ask whether wrapping up is okay.",
  "- If speech comes through garbled, ask them to say it again, briefly.",
  "- Once everything's covered, thank them, say you'll pass it on, and end with [[HANGUP]].",
].join("\n");

// Pulled out of the spawn path so the security-critical part is testable. The
// invariant that matters: EVERY call turn passes --strict-mcp-config. That was
// previously conditional on a browser having launched, which silently left the
// account's other MCP servers reachable on any task turn that didn't need one
// — while a comment at the call site asserted the opposite. A rule nothing
// checks is a rule that quietly stops being true.
export function buildClaudeArgs({
  isTask,
  model,
  effort,
  budget,
  systemPrompt,
  browserMcpPath = null,
  resume = null,
  emptyMcpPath = EMPTY_MCP_PATH,
  settingsPath = CALL_SETTINGS_PATH,
}) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model", model,
    "--effort", effort,
    "--max-budget-usd", String(budget),
    "--append-system-prompt", systemPrompt,
    // the browser server and nothing else, or nothing at all
    "--mcp-config", browserMcpPath || emptyMcpPath,
    "--strict-mcp-config",
  ];
  if (isTask) {
    args.push("--permission-mode", "bypassPermissions");
    // hard-blocks git push / gh publish / npm publish even under
    // bypassPermissions — see call-hooks/block-push.mjs for why voice
    // specifically doesn't get to trigger those
    args.push("--settings", settingsPath);
  } else {
    // no tools at all on the chat path: nothing to load, nothing to run
    args.push("--disallowed-tools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task");
  }
  if (resume) args.push("--resume", resume);
  return args;
}

// One live phone call: owns its Deepgram socket, its ElevenLabs socket, and at
// most one claude child at a time. Everything here dies with the call.
export class Call {
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
    this.foregroundTurn = null; // the current blocking turn's per-turn state
    // Whichever tier most recently finished speaking — a bare "yes"/"no" reply
    // has no verb/object for classifyIntent to route on, so it's routed back
    // to whichever tier just asked a question instead of defaulting to chat.
    this.lastTurnTier = null;
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
    // Turns detached to run without blocking the call — see isBackgroundCommand.
    // Separate from this.child (the current foreground turn) so a background
    // turn finishing doesn't touch busy/drainQueued state that may by then
    // belong to a completely different, later foreground turn.
    this.backgroundChildren = [];
    this.cdpPort = null; // set once the call's own browser is up
    this.browserProc = null;
    this.browserProfileDir = null;
    this.browserStarting = null; // in-flight ensureBrowser() promise

    ws.on("message", (raw) => this.onTwilio(raw));
    // Twilio sends "start" immediately; a socket that doesn't isn't Twilio.
    setTimeout(() => {
      if (!this.started && !this.closed) {
        console.warn("[call] stream never started, closing");
        this.gotStopEvent = true;
        this.destroy();
      }
    }, 10_000).unref?.();
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
      case "start": {
        const params = m.start?.customParameters || {};
        if (!streamAuthOk(this.opts.authToken, params)) {
          console.warn("[call] rejected stream: missing or bad stream signature");
          this.gotStopEvent = true; // not an unexpected close, we're doing it
          this.destroy();
          return;
        }
        this.started = true;
        this.streamSid = m.start?.streamSid || null;
        this.callSid = m.start?.callSid || null;
        if (this.callSid) this.opts.live?.set(this.callSid, this);
        // Outbound calls register a job (greeting + extra instructions) before
        // dialling; the stream carries only its id, never the content.
        this.job = (params.job && this.opts.jobs?.get(params.job)) || null;
        this.log("start", this.callSid || "", this.job ? `(outbound ${this.job.mode})` : "");
        // Greet before wiring up transcription, not after: if Deepgram is slow
        // or unreachable the caller should still hear something, and the
        // greeting is what tells them the line is live.
        if (this.job) this.job.started = true;
        if (this.job?.mode === "report" && this.job.detectVoicemail) {
          this.beginReport();
          break;
        }
        if (this.job?.mode === "relay") {
          this.beginRelay();
          break;
        }
        this.say(this.job?.greeting || this.opts.greeting);
        this.openDeepgram();
        if (this.job) this.armIdleHangup();
        break;
      }
      case "media":
        // inbound caller audio → Deepgram, raw mulaw bytes
        if (this.started && this.dg?.readyState === WebSocket.OPEN && m.media?.payload) {
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
    const dg = new WebSocket(this.fastTurns() ? dgUrl(RELAY_UTTERANCE_END_MS, RELAY_ENDPOINTING_MS) : dgUrl(), { headers: { Authorization: "Token " + this.opts.deepgramKey } });
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
      // Must stay comfortably above utterance_end_ms in DG_URL, or this safety
      // net fires first and re-introduces the mid-sentence cut it exists to
      // protect against — derived from it rather than hardcoded, because the
      // two were previously set independently and drifted into exactly that.
      this.utterTimer = setTimeout(() => this.flushUtterance(), (this.fastTurns() ? RELAY_UTTERANCE_END_MS : UTTERANCE_END_MS) + 800);
      this.utterTimer.unref?.();
      this.tLastFinal = Date.now();
      // Relay calls end the turn on speech_final (endpointing: ~500ms of
      // silence) instead of waiting for UtteranceEnd, which needs a full 1000ms
      // gap after the last word and then arrives late on top of that. A test
      // call to someone overseas said the replies felt like "a long pause, then
      // an answer". flushUtterance still holds back a sentence that ends
      // mid-thought, and the UtteranceEnd that follows finds an empty queue.
      if (this.fastTurns() && j.speech_final) this.flushUtterance();
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
  // A sentence that stops on "and", "to", "the" is not a sentence yet, whatever
  // the silence says. A live call asked "Can you build a web page and" — the
  // caller paused to think, the pause cleared the threshold, and the half
  // request went to claude, which could only reply "sounds like you got cut off
  // there". Raising the threshold for everyone would slow every turn down to
  // suit the rare long pause; waiting only when the words themselves are
  // unfinished costs nothing on a complete sentence.
  flushUtterance(force = false) {
    clearTimeout(this.utterTimer);
    this.utterTimer = null;
    const parts = this.utterQ || [];
    if (!parts.length) return;
    const joined = parts.join(" ").replace(/\s+/g, " ").trim();

    if (!force && INCOMPLETE_TAIL_RE.test(joined) && (this.utterExtends || 0) < MAX_UTTER_EXTENDS) {
      this.utterExtends = (this.utterExtends || 0) + 1;
      // left in utterQ on purpose: more speech appends to it, and the Results
      // handler resets this timer, so a caller who simply carried on is not
      // interrupted by the grace period expiring underneath them
      const grace = this.fastTurns() ? RELAY_GRACE_MS : UTTERANCE_GRACE_MS;
      this.log(`utterance ends mid-thought ("${joined.slice(-24)}") — waiting ${grace}ms`);
      this.utterTimer = setTimeout(() => this.flushUtterance(true), grace);
      this.utterTimer.unref?.();
      return;
    }

    this.utterQ = [];
    this.utterExtends = 0;
    if (this.tHeardFirst) {
      // the second number is the pure end-of-turn wait the caller sits through
      this.log(`speech: ${Date.now() - this.tHeardFirst}ms from first partial to end of utterance, ${this.tLastFinal ? Date.now() - this.tLastFinal : "?"}ms after last words`);
      this.tHeardFirst = null;
    }
    this.onUtterance(joined);
  }

  // Relay calls are dialled with answering-machine detection, so by the time
  // the stream starts Twilio knows whether a person or voicemail picked up.
  // A report call that reaches the owner's own voicemail has nobody to talk to;
  // onAmdResult hangs it up and the report goes out as a text instead.
  beginReport() {
    this.say(this.job.greeting);
    this.openDeepgram();
    this.armIdleHangup();
  }

  // Twilio's answering-machine verdict, which arrives mid-call now rather than
  // before it. A person is already being talked to by the time this lands; a
  // machine means throw away the conversation and leave a message instead.
  onAmdResult(answeredBy) {
    if (this.closed || this.amdHandled) return;
    this.amdHandled = true;
    this.log("answered by", answeredBy || "unknown");
    const machine = String(answeredBy).startsWith("machine") || answeredBy === "fax";
    if (!machine) return;

    if (this.job?.mode === "report" || this.job?.mode === "ask") {
      // nobody to talk to: hang up and let the caller be texted instead
      this.log("outbound call reached voicemail, hanging up");
      this.job.started = false;
      this.gotStopEvent = true;
      return this.hangup();
    }
    if (this.job?.mode !== "relay") return;

    this.job.voicemail = true;
    this.transcript.push("(reached voicemail)");
    this.stopSpeaking();
    clearInterval(this.idleTimer);
    this.busy = true;
    this.runClaude(
      "[This is their voicemail, not the person — the greeting has finished and the beep has gone. " +
        "Ignore whatever was said so far and leave one short message now: who you are, who you're calling " +
        "for, and everything in the brief that can be said without a reply (greetings, news, a goodnight) — " +
        "turn its questions into 'he wanted to know…'. Say the person you're calling for will get in touch; " +
        "never ask them to call this number back, it can't take their call. Then [[HANGUP]].]",
      "chat"
    );
  }

  beginRelay() {
    // Straight in. The voicemail verdict arrives separately, in onAmdResult.
    this.say(this.job.greeting);
    this.openDeepgram();
    this.armIdleHangup();
    this.armRelayTimeLimit();
  }

  armRelayTimeLimit() {
    this.relayWrapTimer = setTimeout(() => {
      if (this.closed) return;
      this.wrapUp = true;
      this.log("relay call hit the wrap-up time");
      // mid-turn: the next turn carries the note instead (see runApiTurn)
      if (!this.busy) {
        this.busy = true;
        this.runClaude(WRAP_UP_NOTE, "chat");
      }
    }, RELAY_WRAP_MS);
    this.relayWrapTimer.unref?.();
    this.relayHardTimer = setTimeout(() => {
      if (this.closed) return;
      this.log("relay call hit the time limit, ending it");
      this.apiAbort?.abort();
      this.say("Sorry, I have to go now. I'll pass everything on. Bye!");
      this.hangupAfterSpeech(8000);
    }, RELAY_MAX_MS);
    this.relayHardTimer.unref?.();
  }

  // An outbound call can land on voicemail, or be answered and put down on a
  // table. Nobody hangs those up on our side, so without this a check-in that
  // hit voicemail would sit on the line (and the bill) until Twilio's own cap.
  armIdleHangup(limitMs = 30_000) {
    this.lastHeardAt = Date.now();
    clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      if (this.closed) return clearInterval(this.idleTimer);
      if (this.busy || this.isPlaying()) return;
      const quietSince = Math.max(this.lastHeardAt, this.playbackEndsAt);
      if (Date.now() - quietSince < limitMs) return;
      clearInterval(this.idleTimer);
      this.log("outbound call idle, hanging up");
      this.say("I'll let you go. Bye.");
      setTimeout(() => this.hangup(), 2500).unref?.();
    }, 5000);
    this.idleTimer.unref?.();
  }

  onUtterance(text) {
    if (this.closed) return;
    this.lastHeardAt = Date.now();
    // Check-in calls: a plain "no / not now" is the whole answer — end the
    // call politely instead of sending it to claude for a chatty reply.
    if (this.job?.mode === "checkin" && !this.busy && isDecline(text)) {
      this.log("check-in declined:", text);
      this.transcript.push("caller: " + text);
      this.say("No worries, talk tomorrow. Bye.");
      setTimeout(() => this.hangup(), 2500).unref?.();
      return;
    }
    // Checked before the busy gate: a note for the developer is just logged,
    // never sent to claude, so it's safe to take immediately — and waiting
    // for an in-flight turn to finish would be exactly the delay the caller
    // is trying to avoid when they interrupt to leave one.
    const relay = this.job?.mode === "relay";
    // an ask call has one job — get an answer back to Claude Code — so it
    // stays on the fast tool-less tier like a relay call
    const chatOnly = relay || this.job?.mode === "ask";
    // Dev notes and model switching are owner features; on a relay call the
    // other person's words are only ever conversation.
    const devNote = relay ? null : parseDevNote(text);
    if (devNote) {
      console.warn("[call] DEV NOTE:", devNote);
      this.transcript.push("dev note: " + devNote);
      this.say("Noted.");
      return;
    }
    if (this.busy && isBackgroundCommand(text)) {
      this.log("backgrounding turn:", text);
      this.detachCurrentTurn();
      this.say("Okay, I'll keep working on that in the background. Go ahead.");
      return;
    }
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
      // Deliberately silent. This used to answer mid-sentence speech with
      // "Still working on that, one sec.", which is the assistant talking over
      // the caller at the exact moment they are still forming a request — on
      // one real call a single sentence drew three of these. The caller asked
      // for it to stop ("disable the interruption... make it so that I'll be
      // able to speak along"), and the thinking tone already signals "still
      // here" without using words. Their speech is still queued and answered.
      return;
    }
    this.log("heard:", text);
    this.lastHeardText = text;
    if (wantsToEnd(text)) this.callerSignalledEnd = true;

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
    const cmd = relay ? null : parseVoiceCommand(text);
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
    this.armSlowTurnFiller();
    // stage timings, so a slow turn can be blamed on the right component
    this.t0 = Date.now();
    this.tFirstDelta = null;
    this.tFirstAudio = null;
    // A bare "yes"/"no" carries no verb or object for classifyIntent to route
    // on — it's a confirmation of whatever the LAST tier just asked, so it
    // goes back to that same tier/session rather than defaulting to chat.
    // ...and the same is true of a correction or a one-word answer: both
    // continue the previous turn, so they inherit its tier instead of being
    // classified from scratch on words that carry no verb or object.
    const sticky = (isShortAffirmation(text) || isFollowUp(text)) && this.lastTurnTier;
    // relay calls are chat-only, always: no tools for someone who isn't the owner
    const intent = chatOnly ? "chat" : sticky ? this.lastTurnTier : classifyIntent(text);
    this.runClaude(text, intent);
  }

  // A caller asked for a long task to keep running without the call waiting on
  // it turn-by-turn ("you are still processing in the background instead of me
  // trying to bug you all the time"). Moves the in-flight turn out of the
  // blocking busy/this.child slot into backgroundChildren, so the call is free
  // to take new questions immediately while it keeps running underneath.
  detachCurrentTurn() {
    const turn = this.foregroundTurn;
    if (!turn) return;
    turn.foreground = false;
    this.foregroundTurn = null;
    this.child = null; // this.child means "the current foreground child" from here on
    this.backgroundChildren.push(turn);
    this.busy = false;
    this.saidStillWorking = false;
    clearTimeout(this.slowTurnTimer);
    // no more "still thinking" tone for a turn the caller explicitly stopped
    // waiting on — they've moved on to talking about something else
    this.stopThinkingTone();
    this.drainQueued();
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
        // on a relay or ask call "still working" means nothing to the listener
        this.say(this.job?.mode === "relay" || this.job?.mode === "ask" ? "One moment." : "Still working on it.");
      }
    }, 6000);
    this.slowTurnTimer.unref?.();
    this.armThinkingTone();
  }

  // Soft tone every few seconds while a turn is still thinking, so the caller
  // can hear the difference between "working" and "line went dead" and knows
  // whether interrupting is worth it. Stops the moment real speech starts —
  // it exists to fill silence, not to talk over an answer.
  armThinkingTone() {
    clearInterval(this.thinkingTone);
    this.thinkingTone = setInterval(() => {
      const turn = this.foregroundTurn;
      if (!this.busy || this.closed || !turn) {
        clearInterval(this.thinkingTone);
        this.thinkingTone = null;
        return;
      }
      // Used to stop for good the moment the turn said anything
      // (turn.spokeThisTurn). That made the tone vanish exactly when it was
      // needed most: a long task turn narrates a step, then works in silence
      // for twenty or thirty seconds, and the caller hears nothing at all. The
      // caller noticed and reported it — "that sound you used to play while
      // processing is lost". It now keeps going for as long as the turn does.
      //
      // The guard that replaces it is a quiet gap rather than "never spoke":
      // sentences of a reply arrive a beat apart, and a tone dropped into one
      // of those gaps would sound like an interruption. Only a silence longer
      // than the gap between sentences counts as "still working".
      if (Date.now() - this.playbackEndsAt < TONE_QUIET_MS) return;
      // logged because there was otherwise no way to tell from a call log
      // whether the caller actually heard anything during a long pause
      this.tonesPlayed = (this.tonesPlayed || 0) + 1;
      this.log(`thinking tone #${this.tonesPlayed} (t+${this.t0 ? Date.now() - this.t0 : "?"}ms)`);
      this.pushAudio(Buffer.from(THINKING_TONE), { tone: true });
    }, 2500);
    this.thinkingTone.unref?.();
  }

  stopThinkingTone() {
    clearInterval(this.thinkingTone);
    this.thinkingTone = null;
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

  jobBlock() {
    const parts = [];
    if (this.job?.promptExtra) parts.push(this.job.promptExtra);
    // results of calls placed during this call, so follow-ups have the facts
    if (this.relayReports?.length) parts.push("Calls you made for them during this call, and what came back:\n" + this.relayReports.join("\n"));
    return parts.length ? "\n\n" + parts.join("\n\n") : "";
  }

  contactsBlock() {
    const away = [
      "",
      "",
      "Away mode: while it's on, any Claude Code session on this machine that stops to ask",
      "a question or for permission phones the caller instead of waiting at the keyboard.",
      `It is currently ${isAway() ? "ON" : "off"}. If they ask to turn it on or off ('I'm heading out,`,
      "call me if Claude needs anything', 'I'm back at my desk'), confirm in one sentence and end",
      "that reply with [[AWAY: on]] or [[AWAY: off]]. That marker is what switches it.",
    ].join("\n");
    const contacts = this.opts.contacts;
    // Without this, an empty list meant the prompt never mentioned calling at
    // all, and a live call answered "call my friend" with "I can't make calls".
    if (!contacts?.size) {
      return (
        "\n\nPhoning people for the caller is supported, but no contacts are set up yet. If they ask" +
        " you to call someone, say that person needs adding to the contacts list first. Never say" +
        " you can't make calls at all." + away
      );
    }
    // last four digits only: enough for the owner to check the right number
    // is saved, without putting whole numbers into prompts
    const names = [...contacts.values()].map((c) => `${c.name} (number ending ${c.number.slice(-4).split("").join(" ")})`).join(", ");
    return [
      "",
      "",
      `You can phone people for the caller. Contacts you can call: ${names}.`,
      "If they ask you to call one of them — to pass on a message or find something out:",
      "- The moment you know WHO and roughly WHAT, place the call in that same reply. Ask at",
      "  most one question, and only when the name or the message is genuinely missing —",
      "  never to re-confirm something they already told you. On a real call this asked",
      "  'shall I call him?' three times in a row while the caller repeated the same request,",
      "  which is worse than calling with a slightly imperfect message.",
      "- 'Yes', 'yep', 'go ahead' in answer to your own offer IS the go-ahead: place the call",
      "  right then, using what they already said, rather than offering again.",
      "- A garbled tail doesn't block a clear request: act on the part you understood, and ask",
      "  about the rest afterwards if it still matters.",
      "- Write the brief in the third person about the caller, keeping their own wording, e.g.",
      "  'Siddhanth is going to the cricket on Sunday afternoon. Ask if they want to come, and if",
      "  they need a ride.' Re-read it before sending: who is going, who is offering, who is asking.",
      "  A brief that swaps those around sends the wrong message to a real person.",
      "- Confirm in one sentence ('I'll call Rahul now and ask about Saturday'), and end",
      "  that reply with [[CALL: <name> | <complete brief: what to tell them and what to ask,",
      "  keeping the caller's own wording>]]. That marker is what places the call.",
      "- The call happens after your reply. When it's done the result comes back: on this",
      "  call if it's still going, otherwise you'll phone them back. Never claim you've",
      "  already called or heard back.",
      "- Anyone not in that list: say you don't have their number. Never make up a number.",
      "- Calling someone is not machine work — never ESCALATE for it.",
    ].join("\n") + away;
  }

  chatPrompt() {
    if (this.job?.mode === "relay") return RELAY_SYSTEM_PROMPT + this.jobBlock();
    if (this.job?.mode === "ask") return CHAT_SYSTEM_PROMPT + this.memoryBlock() + this.jobBlock();
    return CHAT_SYSTEM_PROMPT + this.memoryBlock() + this.contactsBlock() + this.jobBlock();
  }

  taskPrompt() {
    return TASK_SYSTEM_PROMPT + this.memoryBlock() + this.contactsBlock() + this.jobBlock();
  }

  async startRelay({ name, brief }) {
    const contact = this.opts.contacts?.get(name.toLowerCase());
    if (!contact) {
      this.log("relay: unknown contact", name);
      return this.say(`Sorry, I don't have a number for ${name}.`);
    }
    console.log(`[call] relay brief for ${contact.name}: ${brief}`);
    try {
      await this.opts.hooks.relay(contact, brief, this);
    } catch (e) {
      console.warn("[call] relay call failed:", e.message);
      this.say(`I couldn't place the call to ${contact.name}.`);
    }
  }

  // A relay call finished while this call is still live: tell them now, and
  // keep it in context for follow-up questions.
  deliverRelayReport(text) {
    (this.relayReports ||= []).push(text);
    this.say(this.busy ? "By the way, " + text : text);
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
        // "-y @playwright/mcp@latest" hit the npm registry to resolve @latest
        // on every single browser turn, even fully cached — a real call saw
        // this take 34s and then fail to connect at all. @playwright/mcp is
        // now a pinned real dependency, invoked here by its absolute cli.js
        // path rather than via npx: a task-tier turn's cwd is the caller's
        // chosen workspace (could be anywhere), not this repo, so
        // "npx --no-install" would resolve node_modules relative to THAT cwd
        // and likely miss brewdeck's own install entirely. `node <abs path>`
        // has no cwd dependency and no network involved at all.
        JSON.stringify({
          mcpServers: {
            browser: {
              command: "node",
              args: [path.join(ROOT, "node_modules", "@playwright", "mcp", "cli.js"), "--cdp-endpoint", `http://127.0.0.1:${port}`],
            },
          },
        }, null, 2)
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
  fastTurns() {
    return this.job?.mode === "relay" && !!this.opts.anthropic;
  }

  async runApiTurn(prompt) {
    const turn = { pending: "", full: "", spokeThisTurn: false, escalating: false, intent: "chat", foreground: true };
    this.foregroundTurn = turn;
    this.log(`turn: chat via api ${RELAY_MODEL}`);
    if (!this.apiMessages) {
      // The API needs a user turn first; the greeting was already spoken, so
      // it goes in as the assistant's opening line. Voicemail had no greeting.
      this.apiMessages = this.job.voicemail
        ? []
        : [
            { role: "user", content: "(call connected)" },
            { role: "assistant", content: this.job.greeting },
          ];
    }
    const note = this.wrapUp && prompt !== WRAP_UP_NOTE ? "\n\n" + WRAP_UP_NOTE : "";
    this.apiMessages.push({ role: "user", content: prompt + note });
    const ac = new AbortController();
    this.apiAbort = ac;
    try {
      const stream = this.opts.anthropic.messages.stream(
        { model: RELAY_MODEL, max_tokens: 1024, system: this.chatPrompt(), messages: this.apiMessages },
        { signal: ac.signal }
      );
      for await (const ev of stream) {
        if (this.closed) break;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          turn.full += ev.delta.text;
          this.onTurnText(turn, ev.delta.text);
        }
      }
    } catch (e) {
      if (!this.closed) {
        console.warn("[call] api turn failed:", e.message);
        if (!turn.spokeThisTurn) this.say("Sorry, could you say that again?");
      }
    }
    this.apiAbort = null;
    this.apiMessages.push({ role: "assistant", content: extractMarkers(turn.full).text.trim() || "(no reply)" });
    clearTimeout(this.slowTurnTimer);
    this.stopThinkingTone();
    if (this.closed) return;
    const tail = turn.pending.trim();
    turn.pending = "";
    if (tail) this.say(speechClean(tail));
    if (turn.hangup) {
      if (this.mayHangUp()) {
        this.log("claude ended the call");
        return this.hangupAfterSpeech();
      }
      this.log("ignoring hangup marker — the caller hasn't said they're done");
    }
    this.busy = false;
    this.drainQueued();
  }

  async runClaude(prompt, intent, { background = false } = {}) {
    if (this.fastTurns()) return this.runApiTurn(prompt);
    const { model, effort } = pickModel(intent, this.override);
    this.log(`turn: ${intent} via ${model}/${effort}${background ? " (background)" : ""}`);
    // Per-turn state, not this.*: two children can genuinely be streaming
    // concurrently (a backgrounded one still finishing its own answer while a
    // new foreground turn starts), and onClaudeLine used to accumulate into
    // shared this.pending/this.spokeThisTurn — two turns' text would have
    // interleaved and corrupted each other's speech output.
    const turn = { pending: "", spokeThisTurn: false, escalating: false, intent, foreground: !background };
    if (!background) this.foregroundTurn = turn;

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
    const args = buildClaudeArgs({
      isTask,
      model,
      effort,
      budget: this.opts.budget,
      systemPrompt: isTask ? this.taskPrompt() : this.chatPrompt(),
      browserMcpPath,
      resume: isTask ? this.taskSession : this.chatSession,
    });

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
      env: { ...process.env, FORCE_COLOR: "0", BREWDECK_CHILD: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    turn.child = child;
    if (!background) this.child = child;
    else this.backgroundChildren.push(turn);
    child.stdin.write(prompt);
    child.stdin.end();

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.onClaudeLine(line, turn));
    child.stderr.on("data", (d) => this.log("claude stderr:", d.toString().slice(0, 300)));

    child.on("close", (code) => {
      // A nonzero exit from us force-killing it (hangup, call ended mid-turn)
      // is expected, not a failure — only warn when claude exited on its own.
      if (code !== 0 && !this.killingChild) console.warn("[call] claude exited", code);
      const tail = turn.pending.trim();
      turn.pending = "";
      // Never from a relay call: the person on that line is not the owner and
      // must not be able to make this machine phone anyone.
      if (turn.calls?.length && this.job?.mode !== "relay" && this.job?.mode !== "ask") {
        for (const c of turn.calls) this.startRelay(c);
      }
      if (turn.away != null && this.job?.mode !== "relay" && this.job?.mode !== "ask") {
        setAway(turn.away);
        this.log("away mode", turn.away ? "on" : "off");
      }
      if (this.job?.mode === "ask" && (turn.decision || turn.answers)) {
        this.opts.hooks?.askResolved(this.job, turn.decision ? { decision: turn.decision } : { answers: turn.answers });
      }
      if (turn.foreground) {
        clearTimeout(this.slowTurnTimer);
        this.stopThinkingTone();
        this.child = null;
      } else {
        this.backgroundChildren = this.backgroundChildren.filter((t) => t !== turn);
      }

      // Chat decided this actually needs the machine — rerun the same request
      // on the tool-capable tier instead of speaking the marker out loud.
      // Propagates foreground/background: a backgrounded turn that escalates
      // must stay backgrounded, not suddenly steal the busy/this.child slot
      // out from under whatever foreground turn is running by then.
      if (turn.escalating) {
        const task = tail.replace(/^\s*ESCALATE\s*:?\s*/i, "").trim() || prompt;
        this.log("escalating to task tier:", task, turn.foreground ? "" : "(background)");
        // A foreground turn can't escalate once the call's over — nothing to
        // speak into. A background turn keeps going regardless: the whole
        // point is that it outlives the caller hanging up.
        if (!turn.foreground || !this.closed) {
          if (turn.foreground) this.armSlowTurnFiller(); // close handler above just cleared it
          return this.runClaude(task, "task", { background: !turn.foreground });
        }
        this.busy = false;
        return;
      }

      // A background turn finishing while the caller's still on the line just
      // speaks up whenever it's ready — say()/pushAudio don't require busy.
      // If the call's already over, there's no line to speak into, so the
      // result is handed to the caller's next call instead of being lost.
      if (!turn.foreground && this.closed) {
        const result = tail ? speechClean(tail) : turn.spokeThisTurn ? "" : "finished, with nothing further to report";
        if (result) {
          // They rang off expecting to hear back — a note in the memory file
          // isn't hearing back.
          if (this.opts.hooks?.reportBack) this.opts.hooks.reportBack(`That task you asked me to work on is done. ${result}`);
          else appendCallMemory(`Finished the background task you asked about: ${result}`);
        }
        return;
      }

      if (!turn.foreground && tail) {
        // Announced distinctly rather than blurted as a direct reply, since
        // the caller may be mid-conversation about something else entirely.
        this.say("By the way, that background task finished. " + speechClean(tail));
        return;
      }

      if (tail) this.say(speechClean(tail));
      else if (!turn.spokeThisTurn && !turn.hangup) this.say("Done, but I had nothing to say about it.");

      // Promised work it has no tools for: run it for real on the task tier.
      // In the background when the call is ending, so "start on it and call me
      // back" does exactly that instead of dying with the call.
      if (turn.intent !== "task" && this.job?.mode !== "relay" && isWorkPromise((turn.said || "") + " " + tail)) {
        this.log("chat tier promised work — escalating to the task tier");
        this.runClaude(prompt, "task", { background: !!turn.hangup });
        if (!turn.hangup) {
          this.armSlowTurnFiller();
          return;
        }
      }

      if (turn.foreground && turn.hangup) {
        if (this.mayHangUp()) {
          this.log("claude ended the call");
          return this.hangupAfterSpeech();
        }
        this.log("ignoring hangup marker — the caller hasn't said they're done");
      }
      if (turn.foreground) {
        this.lastTurnTier = turn.intent;
        this.busy = false;
        this.drainQueued();
      }
    });
    child.on("error", (err) => {
      this.log("spawn failed", err.message);
      if (turn.foreground) {
        this.say("I couldn't start claude on the machine.");
        this.busy = false;
        this.child = null;
      } else {
        this.backgroundChildren = this.backgroundChildren.filter((t) => t !== turn);
        if (!this.closed) this.say("Sorry, the background task I was running just failed to start.");
      }
    });
  }

  onClaudeLine(line, turn) {
    if (!line.startsWith("{")) return;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    const remember = (id) => {
      if (!id) return;
      if (turn.intent === "task") this.taskSession = id;
      else this.chatSession = id;
    };
    if (j.type === "system" && j.subtype === "init") return remember(j.session_id);
    if (j.type === "result") return remember(j.session_id);
    if (j.type !== "stream_event") return;
    const ev = j.event;
    if (ev?.type !== "content_block_delta" || ev.delta?.type !== "text_delta") return;

    this.onTurnText(turn, ev.delta.text);
  }

  // Everything that happens to a piece of streamed reply text, whichever way
  // it arrived (Claude Code's stream-json, or the API directly).
  onTurnText(turn, text) {
    // Diagnostic timing only tracks whichever turn is currently in the
    // foreground — a background turn doesn't touch it, since this.t0 may by
    // then belong to a different, later foreground turn entirely.
    if (turn.foreground && this.tFirstDelta === null && this.t0) {
      this.tFirstDelta = Date.now() - this.t0;
      this.log(`t+${this.tFirstDelta}ms claude first token`);
    }
    turn.pending += text;
    // claude's action markers — [[HANGUP]] (VOICE_BASE) and [[CALL: …]]
    // (contactsBlock). Stripped before anything is spoken; acted on at turn
    // end so whatever was said alongside them is heard first.
    const mk = extractMarkers(turn.pending);
    if (mk.hangup || mk.calls.length || mk.decision || mk.answers || mk.away !== null) {
      if (mk.away !== null) turn.away = mk.away;
      turn.pending = mk.text;
      if (mk.hangup) turn.hangup = true;
      (turn.calls ||= []).push(...mk.calls);
      if (mk.decision) turn.decision = mk.decision;
      if (mk.answers) turn.answers = mk.answers;
    }
    // The chat tier signals "this needs real tools" by replying with an
    // ESCALATE line. Hold the text back rather than speaking it: the caller
    // should hear the answer, never the routing marker. Anything that could
    // still turn into "ESCALATE:" is held until enough has arrived to tell.
    if (turn.intent !== "task" && !turn.spokeThisTurn && this.job?.mode !== "relay" && this.job?.mode !== "ask") {
      const head = turn.pending.trimStart().toUpperCase();
      if (head.startsWith("ESCALATE")) {
        turn.escalating = true;
        return;
      }
      if (head.length < 9 && "ESCALATE:".startsWith(head)) return; // still ambiguous
    }
    // Foreground: hand whole sentences to TTS as they complete, so speech
    // starts long before claude has finished writing. Background: stay
    // silent while generating — the caller may be having an entirely
    // separate live exchange right now, and a background turn's sentences
    // dripping in mid-conversation would interleave with it unpredictably.
    // Its full answer is accumulated in turn.pending and announced once, at
    // completion, by the close handler in runClaude.
    if (!turn.foreground) return;
    // An unfinished marker is held back whole: a [[CALL: …]] brief contains
    // full sentences, and speaking them as they arrive would read the private
    // brief out to the caller before the marker's closing brackets show up.
    const open = turn.pending.indexOf("[[");
    const held = open >= 0 ? turn.pending.slice(open) : "";
    let speakable = open >= 0 ? turn.pending.slice(0, open) : turn.pending;
    for (;;) {
      // The first chunk of a reply is what the caller is waiting on, so it goes
      // as soon as there is a clause worth saying; later chunks wait for whole
      // sentences, which keeps the prosody from sounding chopped.
      const [chunk, rest] = takeSpeakable(speakable, { minChars: turn.spokeThisTurn ? 60 : 28 });
      if (!chunk) break;
      speakable = rest;
      const clean = speechClean(chunk);
      if (clean) {
        turn.spokeThisTurn = true;
        turn.said = (turn.said || "") + " " + clean;
        this.say(clean);
      }
    }
    turn.pending = speakable + held;
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
          // 1.0 was reported as too slow on real calls; this is a shade quicker
          // than neutral without tipping into sounding rushed
          voice_settings: { stability: 0.4, similarity_boost: 0.7, speed: 1.12 },
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
  pushAudio(buf, { tone = false } = {}) {
    if (this.muted) return; // leftovers from a reply the caller interrupted
    // Whether the caller is currently hearing only a thinking tone rather than
    // an actual answer. Barge-in treats the two differently: interrupting a
    // reply must suppress the rest of it, interrupting a tone must not — there
    // is no reply yet, and muting here would silently swallow the real answer
    // when it finally arrives.
    this.tonePlaying = tone;
    // Gated on the foreground turn's spokeThisTurn (only set once real claude
    // text has been queued, not by the "still working" filler) — otherwise a
    // slow turn's filler audio got timestamped as "first audio out", making
    // the latency this logs for diagnosing slow turns measure the filler
    // instead of the reply.
    if (this.tFirstAudio === null && this.t0 && this.foregroundTurn?.spokeThisTurn) {
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
    const wasOnlyTone = this.tonePlaying;
    this.audioQ = Buffer.alloc(0);
    // Twilio is about to drop its buffer, so nothing more will be heard —
    // playback is over as of now, not whenever the queued audio would have run out.
    this.playbackEndsAt = 0;
    this.tonePlaying = false;
    // Interrupting a thinking tone is not interrupting an answer: there's no
    // reply in flight to suppress, and muting here would drop the real answer
    // when it arrives moments later. Just stop the tone and let the turn
    // deliver normally.
    if (wasOnlyTone) {
      this.stopThinkingTone();
    } else {
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
    }
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
  // claude asked to hang up. Honoured outright on calls it placed for a
  // specific purpose (a relay call is over when the message is delivered; an
  // ask call ends once the answer is in), and only with the caller's blessing
  // on the owner's own calls.
  mayHangUp() {
    const mode = this.job?.mode;
    if (mode === "relay" || mode === "ask") return true;
    return !!this.callerSignalledEnd;
  }

  // Let the goodbye finish playing before pulling the line. Capped, so a TTS
  // stall can't leave a call the assistant already said goodbye on hanging open.
  hangupAfterSpeech(maxWaitMs = 20_000) {
    const deadline = Date.now() + maxWaitMs;
    const tick = () => {
      if (this.closed) return;
      const pending = (this.elQueue?.length || 0) > 0;
      if ((this.isPlaying() || pending) && Date.now() < deadline) return setTimeout(tick, 300).unref?.();
      setTimeout(() => this.hangup(), 800).unref?.();
    };
    // audio for the last sentence may not have come back from TTS yet
    setTimeout(tick, 1200).unref?.();
  }

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
    if (this.callSid) this.opts.live?.delete(this.callSid);
    this.apiAbort?.abort();
    clearTimeout(this.relayWrapTimer);
    clearTimeout(this.relayHardTimer);
    clearInterval(this.idleTimer);
    clearInterval(this.elKeep);
    this.elKeep = null;
    clearTimeout(this.unmute);
    clearTimeout(this.utterTimer);
    clearTimeout(this.slowTurnTimer);
    this.stopThinkingTone();
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
    // A relay call's transcript is someone else talking — it goes back to the
    // owner as a report, never into the owner's memory notes.
    if (this.job?.mode === "relay") this.opts.hooks?.relayDone(this);
    // an ask call is a yes/no for another session, nothing about the caller
    else if (this.job?.mode !== "ask") this.saveMemory();
    // hung up without deciding: Claude Code falls back to its own prompt
    if (this.job?.mode === "ask") this.opts.hooks?.askResolved(this.job, null);
    // Deliberately NOT killing this.backgroundChildren here. The entire point
    // of backgrounding a turn is that it keeps running after the caller stops
    // waiting on it — including after they hang up. Each one is bounded by
    // its own --max-budget-usd and will exit on its own; its close handler
    // (in runClaude) sees this.closed and writes the result to call memory
    // instead of trying to speak into a call that's no longer there.
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
      { cwd: CALL_SCRATCH_DIR, shell: false, env: { ...process.env, FORCE_COLOR: "0", BREWDECK_CHILD: "1" }, stdio: ["pipe", "pipe", "ignore"] }
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
export function mountCall({ app, config, notify }) {
  writeCallSettings();
  // Empty, CLAUDE.md-free directory for the chat tier to run in.
  fs.mkdirSync(CALL_SCRATCH_DIR, { recursive: true });
  const env = process.env;
  // The API key is for relay calls only. Left in process.env, every claude -p
  // this server spawns (call turns, browser brews) inherits it, and Claude Code
  // prefers an API key over the subscription login — silently moving all of
  // that usage onto API billing and disabling claude.ai connectors. Taken out
  // of the environment here, before anything is spawned.
  const anthropicKey = env.ANTHROPIC_API_KEY || "";
  delete env.ANTHROPIC_API_KEY;
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
    // The Twilio number outbound calls come from, and who "call me" means.
    fromNumber: env.CALL_FROM_NUMBER ? toE164(env.CALL_FROM_NUMBER) : "",
    ownerNumber: env.CALL_OWNER ? toE164(env.CALL_OWNER) : "",
    ownerName: env.CALL_OWNER_NAME || "",
    contacts: parseContacts(env.CALL_CONTACTS),
    // the SMS-capable number; unset = texting is off and push is the fallback
    smsFrom: env.CALL_SMS_FROM ? toE164(env.CALL_SMS_FROM) : "",
    // relay calls only; unset = they fall back to the claude -p path
    anthropic: anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null,
    // Daily check-in call, e.g. CALL_CHECKIN_AT=17:30. Unset = no check-in.
    checkinAt: env.CALL_CHECKIN_AT || "",
    checkinTz: env.CALL_CHECKIN_TZ || "Australia/Sydney",
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
  if (!cfg.ownerNumber) cfg.ownerNumber = cfg.allowFrom[0] || "";

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
    twiml(res, streamTwiml({ host, authToken: cfg.authToken }));
  });

  // Texting BREWDECK: same machine access as a call, but answered in writing.
  // Twilio drops the connection if TwiML takes more than ~15s, and a real task
  // takes longer than that, so this acknowledges immediately and texts the
  // answer when it lands.
  app.post("/twilio/sms", form, (req, res) => {
    const host = cfg.publicHost || req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    const url = `${proto}://${host}${req.originalUrl}`;
    if (!ready || !twilioSignatureOk(cfg.authToken, req.headers["x-twilio-signature"], url, req.body)) {
      console.warn("[sms] rejected: bad Twilio signature");
      return res.status(403).type("text/plain").send("bad signature");
    }
    const from = toE164(req.body?.From || "");
    if (!cfg.allowFrom.includes(from)) {
      console.warn("[sms] rejected sender", from);
      return res.status(204).end();
    }
    const text = String(req.body?.Body || "").trim();
    console.log(`[sms] from ${from}: ${text}`);
    res.type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    if (text) answerText(from, text);
  });

  // one conversation, resumed across texts, so "and now the other one" works
  let smsSession = null;
  let smsBusy = false;
  const smsQueue = [];

  async function answerText(to, text) {
    if (smsBusy) {
      smsQueue.push([to, text]);
      return;
    }
    smsBusy = true;
    const intent = classifyIntent(text);
    const args = buildClaudeArgs({
      isTask: intent === "task",
      model: intent === "task" ? "sonnet" : "haiku",
      effort: intent === "task" ? "high" : "low",
      budget: cfg.budget,
      systemPrompt: SMS_SYSTEM_PROMPT + (readCallMemory() ? "\n\nNotes from earlier calls:\n" + readCallMemory() : ""),
      resume: smsSession,
    });
    const child = spawn("claude", args, {
      cwd: intent === "task" ? cfg.cwd : CALL_SCRATCH_DIR,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0", BREWDECK_CHILD: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.startsWith("{")) return;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (j.session_id) smsSession = j.session_id;
      if (j.type === "stream_event" && j.event?.delta?.type === "text_delta") out += j.event.delta.text;
    });
    child.on("close", async () => {
      const reply = speechClean(extractMarkers(out).text).trim() || "Done, but I had nothing to say about it.";
      try {
        await sendSms(cfg, to, reply);
      } catch (e) {
        console.warn("[sms] reply failed:", e.message);
      }
      smsBusy = false;
      const next = smsQueue.shift();
      if (next) answerText(next[0], next[1]);
    });
    child.on("error", (e) => {
      console.warn("[sms] claude failed to start:", e.message);
      smsBusy = false;
    });
    child.stdin.write(text);
    child.stdin.end();
  }

  // Where Twilio posts its answering-machine verdict once it has one.
  const live = new Map(); // callSid -> Call
  app.post("/twilio/amd", form, (req, res) => {
    const host = cfg.publicHost || req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    const url = `${proto}://${host}${req.originalUrl}`;
    if (!twilioSignatureOk(cfg.authToken, req.headers["x-twilio-signature"], url, req.body)) {
      console.warn("[call] rejected: bad Twilio signature on /twilio/amd");
      return res.status(403).type("text/plain").send("bad signature");
    }
    const call = live.get(req.body?.CallSid);
    if (call) call.onAmdResult(req.body?.AnsweredBy || "");
    else console.warn("[call] amd result for a call we don't have:", req.body?.CallSid, req.body?.AnsweredBy);
    res.status(204).end();
  });

  // Outbound calls: what to say and what the call is for, keyed by an id the
  // stream carries back. Kept here rather than in the TwiML so it can be long
  // and never leaves the machine.
  const jobs = new Map();
  const outbound = (job) => placeOutboundCall(cfg, jobs, job);

  // Get a relay result to the owner by the best route still open: the call
  // they asked from if it's live, else ring them, else a push notification.
  // Always also noted in call memory, so the next call knows either way.
  // Unanswered call → text first, push second. A push is easy to miss on a
  // watch; a text is what they asked for when they said "if I'm busy, text me".
  const pushFallback = async (title, text) => {
    if (cfg.smsFrom && cfg.ownerNumber) {
      try {
        await sendSms(cfg, cfg.ownerNumber, `${title}: ${text}`);
        return;
      } catch (e) {
        console.warn("[sms] failed, falling back to push:", e.message);
      }
    }
    try {
      await notify?.(title, text, { tag: "telephone_receiver" });
    } catch {}
  };
  const report = async (text, parentCall, title, retry = null, quiet = false) => {
    appendCallMemory(text);
    // quiet: the owner asked not to be rung back — memory note and log only
    if (quiet) return console.log(`[call] report (no callback): ${text}`);
    if (parentCall && !parentCall.closed) return parentCall.deliverRelayReport(text);
    const job = {
      to: cfg.ownerNumber,
      mode: "report",
      detectVoicemail: true,
      greeting: `Hi, it's Claude, calling back. ${text} Anything you want me to do about that?`,
      promptExtra: [
        `About this call: YOU called THEM to report back on a call they asked you to make. What you told them: ${text}`,
        retry ? `The original brief for ${retry.name} was: ${retry.brief}. If they want you to try again, call back, or add something, place the call with [[CALL: ${retry.name} | <the original brief word for word, plus only what they add>]]. Never reinterpret or swap who is doing what in the original.` : "",
      ].filter(Boolean).join("\n"),
    };
    try {
      await outbound(job);
      watchOutbound(cfg, job, ({ connected }) => {
        if (!connected) pushFallback(title, text);
      });
    } catch (e) {
      console.warn("[call] report callback failed:", e.message);
      pushFallback(title, text);
    }
  };

  const hooks = {
    async relay(contact, brief, parentCall, { quiet = false } = {}) {
      const job = relayJob(cfg, contact, brief);
      job.parentCall = parentCall;
      job.quiet = quiet;
      await outbound(job);
      watchOutbound(cfg, job, ({ status, connected }) => {
        if (connected) return; // relayDone reports once the transcript exists
        const why = NOT_REACHED[status] || "the call didn't connect";
        report(`I tried calling ${contact.name}, but ${why}.`, parentCall, `Couldn't reach ${contact.name}`, { name: contact.name, brief }, quiet);
      });
    },
    reportBack(text) {
      report(text, null, "Task finished");
    },
    askResolved(job, result) {
      if (job.resolve) {
        const done = job.resolve;
        job.resolve = null;
        done(result);
      }
    },
    async relayDone(call) {
      const job = call.job;
      const text = job.voicemail
        ? `I called ${job.contactName} and got voicemail, so I left your message.`
        : await summarizeRelay({ name: job.contactName, brief: job.brief, transcript: call.transcript }, cfg.anthropic);
      report(text, job.parentCall, `Called ${job.contactName}`, { name: job.contactName, brief: job.brief }, job.quiet);
    },
  };

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    if (!ready) return ws.close(1011, "not configured");
    // memory is read per call, so notes written by an earlier call are picked
    // up without restarting the server
    new Call(ws, { ...cfg, jobs, hooks, live, memory: readCallMemory() });
  });

  // Local control API for scripts and hooks on this machine. The public
  // tunnels (Funnel, cloudflared) also arrive from 127.0.0.1, so loopback
  // alone proves nothing — callers must present the token from this file.
  const localToken = readOrCreateLocalToken();
  const localOnly = (req, res, next) => {
    const got = Buffer.from(String(req.headers["x-brewdeck-local"] || ""));
    const want = Buffer.from(localToken);
    if (got.length === want.length && timingSafeEqual(got, want)) return next();
    res.status(403).json({ error: "forbidden" });
  };
  app.post("/api/call/checkin", localOnly, async (_req, res) => {
    try {
      res.json({ sid: await outbound(checkinJob(cfg)) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Away mode: only while it's on does Claude Code phone you instead of waiting
  // at the keyboard. A file, so it survives a server restart.
  app.post("/api/away", localOnly, (req, res) => {
    setAway(!!req.body?.on);
    res.json({ away: isAway() });
  });
  app.get("/api/away", localOnly, (_req, res) => res.json({ away: fs.existsSync(AWAY_PATH) }));

  // Long-polled by call-hooks/phone-ask.mjs. One ask at a time: a second
  // Claude Code session asking while the phone's already ringing waits its turn.
  let askChain = Promise.resolve();
  app.post("/api/ask", localOnly, (req, res) => {
    // A question with options has no sensible answer without the person, so it
    // always earns a call. A permission prompt is answerable at the keyboard in
    // a second, so that one still waits for away mode.
    const alwaysCall = req.body?.toolName === "AskUserQuestion";
    if (!ready || (!alwaysCall && !isAway())) return res.json({ skip: true });
    const run = async () => {
      if (!alwaysCall && !isAway()) return { skip: true };
      const job = askJob(cfg, req.body || {});
      const result = new Promise((resolve) => {
        job.resolve = resolve;
        // well inside the hook's 600s timeout, so a stuck call can't hang Claude Code
        setTimeout(() => hooks.askResolved(job, null), 8 * 60_000).unref?.();
      });
      try {
        await outbound(job);
        watchOutbound(cfg, job, ({ connected }) => {
          if (connected) return;
          pushFallback("Claude Code needs you", job.greeting.replace(/^Hi, it's Claude\. /, ""));
          hooks.askResolved(job, null);
        });
      } catch (e) {
        console.warn("[call] ask call failed:", e.message);
        hooks.askResolved(job, null);
      }
      return (await result) || { skip: true };
    };
    const p = askChain.then(run, run);
    askChain = p.catch(() => {});
    p.then((r) => res.json(r)).catch((e) => res.status(500).json({ error: e.message }));
  });

  // { text } — ring the owner and say something. The same shape as a relay
  // report, for anything that needs to reach them by voice right now.
  app.post("/api/call/say", localOnly, async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "text required" });
    try {
      await report(text, null, "BREWDECK");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // { name, brief } — same path as asking for it on a call, minus the call.
  app.post("/api/call/relay", localOnly, async (req, res) => {
    const contact = cfg.contacts.get(String(req.body?.name || "").toLowerCase());
    if (!contact) return res.status(404).json({ error: "no such contact" });
    if (!req.body?.brief) return res.status(400).json({ error: "brief required" });
    try {
      await hooks.relay(contact, String(req.body.brief), null, { quiet: req.body.callback === false });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  if (ready && cfg.checkinAt) scheduleDaily(cfg, () => outbound(checkinJob(cfg)));

  return {
    ready,
    cfg,
    outbound,
    // server.js routes /twilio/stream here
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
  };
}

export const LOCAL_TOKEN_PATH = path.join(ROOT, ".brews", "local-api.token");
const AWAY_PATH = path.join(ROOT, ".brews", "away");
export const isAway = () => fs.existsSync(AWAY_PATH);
function setAway(on) {
  if (on) {
    fs.mkdirSync(path.dirname(AWAY_PATH), { recursive: true });
    fs.writeFileSync(AWAY_PATH, new Date().toISOString());
  } else fs.rmSync(AWAY_PATH, { force: true });
}

function readOrCreateLocalToken() {
  try {
    const t = fs.readFileSync(LOCAL_TOKEN_PATH, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(LOCAL_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_TOKEN_PATH, t);
  return t;
}

// Dials `to` and connects the answered call to a Call running `job`. The TwiML
// goes inline with the REST request, so no webhook (and no webhook signature
// check against a public host) is involved in placing the call.
export async function placeOutboundCall(cfg, jobs, job) {
  const { to, mode, detectVoicemail = false } = job;
  if (!cfg.fromNumber) throw new Error("CALL_FROM_NUMBER is not set");
  if (!cfg.publicHost) throw new Error("CALL_PUBLIC_HOST is not set");
  if (!to) throw new Error("no number to call");
  const id = randomBytes(8).toString("hex");
  jobs.set(id, job);
  // a call rings for at most ~30s; anything left after that was never answered
  setTimeout(() => jobs.delete(id), 30 * 60_000).unref?.();
  const body = new URLSearchParams({
    To: to,
    From: cfg.fromNumber,
    Timeout: "30",
    Twiml: `<Response>${streamTwiml({ host: cfg.publicHost, authToken: cfg.authToken, params: { job: id } })}</Response>`,
  });
  // Voicemail detection runs ASYNCHRONOUSLY. Synchronous detection holds every
  // scrap of audio until Twilio has made up its mind, and when that took its
  // time a real person sat listening to silence — one answered, heard nothing
  // for twenty-two seconds, and hung up. With AsyncAmd the conversation starts
  // immediately and the verdict arrives later on /twilio/amd.
  if (detectVoicemail) {
    body.set("MachineDetection", "DetectMessageEnd");
    body.set("AsyncAmd", "true");
    body.set("AsyncAmdStatusCallback", `https://${cfg.publicHost}/twilio/amd`);
    body.set("AsyncAmdStatusCallbackMethod", "POST");
    body.set("MachineDetectionTimeout", "20");
  }
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    jobs.delete(id);
    throw new Error(`Twilio refused the call (${r.status}): ${j.message || "unknown error"}`);
  }
  console.log(`[call] dialling ${to} for ${mode} (${j.sid})`);
  job.sid = j.sid;
  return j.sid;
}

const TERMINAL_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

// Polls a placed call until it's over and reports whether it ever connected to
// a Call. Polling instead of a status-callback webhook: webhooks need a stable
// public URL and signature checks against it, and the tunnel host changes.
export function watchOutbound(cfg, job, onEnd, { intervalMs = 5000, maxMs = 20 * 60_000 } = {}) {
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const deadline = Date.now() + maxMs;
  const tick = async () => {
    let status = "";
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls/${job.sid}.json`, {
        headers: { Authorization: "Basic " + auth },
      });
      status = (await r.json()).status || "";
    } catch {}
    if (TERMINAL_STATUSES.has(status) || Date.now() > deadline) {
      return onEnd({ status: status || "unknown", connected: !!job.started });
    }
    setTimeout(tick, intervalMs).unref?.();
  };
  setTimeout(tick, intervalMs).unref?.();
}

// A text costs a fraction of a cent and lands whether or not they can talk,
// which makes it the right fallback for everything that used to be a call the
// owner didn't answer.
export async function sendSms(cfg, to, body) {
  if (!cfg.smsFrom) throw new Error("CALL_SMS_FROM is not set");
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "content-type": "application/x-www-form-urlencoded" },
    // Twilio splits anything longer into several segments, each billed
    body: new URLSearchParams({ To: to, From: cfg.smsFrom, Body: String(body).slice(0, 900) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Twilio refused the text (${r.status}): ${j.message || "unknown"}`);
  console.log(`[sms] sent to ${to} (${j.sid})`);
  return j.sid;
}

// Texted questions get the same two tiers as spoken ones, minus the voice
// rules — a text can carry a file path or a command, which speech cannot.
export const SMS_SYSTEM_PROMPT = [
  "You are answering a text message from the person you work for, on their own machine.",
  "Write like a text: plain sentences, no markdown, no bullet lists, no code blocks unless",
  "they asked for code. Under 300 characters unless the answer genuinely needs more.",
  "If you did something, say what happened in one line rather than narrating the steps.",
  "Ignore any CLAUDE.md instruction about writing style; this is a text message, not a commit.",
].join("\n");

export function relayJob(cfg, contact, brief) {
  const owner = cfg.ownerName || "the person I work for";
  return {
    to: contact.number,
    mode: "relay",
    contactName: contact.name,
    brief,
    detectVoicemail: true,
    greeting: `Hi, is this ${contact.name}? This is Claude, an AI assistant, calling on behalf of ${owner}.`,
    promptExtra: `You are calling ${contact.name} on behalf of ${owner}.\nBrief from ${owner}: ${brief}`,
  };
}

// What Claude Code wants, in words that work read aloud.
export function describeToolUse(toolName, input = {}) {
  const base = (p) => String(p || "").split(/[\\/]/).pop();
  switch (toolName) {
    case "Bash":
    case "PowerShell":
      return input.description ? `run a command to ${String(input.description).replace(/^[A-Z]/, (c) => c.toLowerCase())}` : "run a shell command";
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return `${toolName === "Write" ? "write" : "edit"} the file ${base(input.file_path || input.notebook_path)}`;
    case "WebFetch":
      try {
        return `fetch a page from ${new URL(input.url).hostname}`;
      } catch {
        return "fetch a web page";
      }
    default:
      return `use its ${String(toolName).replace(/^mcp__/, "").replace(/__/g, " ")} tool`;
  }
}

const spokenList = (items) =>
  items.length <= 1 ? items.join("") : items.slice(0, -1).join(", ") + ", or " + items[items.length - 1];

export function askJob(cfg, { hookEvent, toolName, toolInput = {}, cwd = "" }) {
  const project = String(cwd).split(/[\\/]/).filter(Boolean).pop() || "a project";
  const details = JSON.stringify(toolInput).slice(0, 3000);
  const common = { to: cfg.ownerNumber, mode: "ask" };
  if (toolName === "AskUserQuestion") {
    const qs = Array.isArray(toolInput.questions) ? toolInput.questions : [];
    const first = qs[0];
    const opts = (first?.options || []).map((o) => o.label);
    const lead = qs.length > 1 ? `It has ${qs.length} questions. First: ` : "";
    return {
      ...common,
      kind: "question",
      greeting:
        `Hi, it's Claude. Claude Code in ${project} has a question for you. ${lead}${first?.question || ""}` +
        (opts.length ? ` The options are ${spokenList(opts)}.` : ""),
      promptExtra: [
        `About this call: YOU called THEM because Claude Code, working in ${project}, stopped to ask them something and they're away from the keyboard. The greeting already read out the first question.`,
        `The questions, exactly: ${details}`,
        "- Ask each question in turn, reading its options. If they want to know what an option means, explain briefly from the option's description.",
        "- Map each answer to the exact option label. If nothing fits, use their own words. For multiSelect, join labels with commas.",
        '- Once every question has an answer, confirm it back in one sentence, then write [[ANSWERS: {"<exact question text>": "<answer>"}]] with every question as a key, then a short goodbye and [[HANGUP]].',
        "- If they'd rather answer at the keyboard, just say goodbye with [[HANGUP]] and no ANSWERS.",
      ].join("\n"),
    };
  }
  const action = describeToolUse(toolName, toolInput);
  return {
    ...common,
    kind: "permission",
    greeting: `Hi, it's Claude. Claude Code in ${project} needs your OK: it wants to ${action}. Should I allow it?`,
    promptExtra: [
      `About this call: YOU called THEM because Claude Code, working in ${project}, is waiting for permission and they're away from the keyboard.`,
      `Tool: ${toolName}. Exact request: ${details}`,
      "- If they ask what it does, explain in plain words — never read a command out character by character.",
      "- If you can see the request is destructive (deleting things, force pushes, touching credentials), say so plainly before they decide.",
      "- When they allow it: write [[DECISION: allow]]. When they refuse: write [[DECISION: deny | <their reason, or what they want Claude Code to do instead>]].",
      "- Then a short goodbye and [[HANGUP]]. If they'd rather decide at the keyboard, just say goodbye with [[HANGUP]] and no DECISION.",
    ].join("\n"),
  };
}

const NOT_REACHED = {
  busy: "the line was busy",
  "no-answer": "nobody picked up",
  failed: "the call didn't go through",
  canceled: "the call was cancelled",
};

// Turns a finished relay call into the few sentences the owner hears. haiku,
// tool-less, in the scratch dir — same shape as saveMemory.
const summaryInstructions = (name) =>
  [
    `You phoned ${name} for the person you work for, and are now reporting back to them by voice.`,
    "From the transcript, say what they said in answer to the brief, plus anything they asked",
    `to pass on. Two to four plain spoken sentences, first person ('I spoke to ${name}...').`,
    "Only what's actually in the transcript. If a question went unanswered, say so.",
    "No markdown, no lists. Spoken aloud, so natural complete sentences.",
    "Keep it clean: report the sense of any swearing or insult ('he wasn't polite about it')",
    "instead of quoting the words back.",
    "You are speaking TO the person you called for, so refer to them as 'you', never by name.",
  ].join("\n");

export async function summarizeRelay({ name, brief, transcript }, anthropic = null) {
  const fallback = `I spoke to ${name}, but I couldn't put together a summary of the call.`;
  const input = `Brief: ${brief}\n\nTranscript ("you" is you, "caller" is ${name}):\n` + transcript.join("\n").slice(-8000);
  if (anthropic) {
    try {
      const r = await anthropic.messages.create({
        model: RELAY_MODEL,
        max_tokens: 400,
        system: summaryInstructions(name),
        messages: [{ role: "user", content: input }],
      });
      const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      return speechClean(text) || fallback;
    } catch (e) {
      console.warn("[call] api summary failed, falling back to claude -p:", e.message);
    }
  }
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p", "--model", "haiku", "--effort", "low", "--max-budget-usd", "0.10",
        "--disallowed-tools", "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task",
        "--append-system-prompt",
        [
          `You phoned ${name} for the person you work for, and are now reporting back to them by voice.`,
          "From the transcript, say what they said in answer to the brief, plus anything they asked",
          "to pass on. Two to four plain spoken sentences, first person ('I spoke to Rahul...').",
          "Only what's actually in the transcript. If a question went unanswered, say so.",
          "No markdown, no lists. Spoken aloud, so natural complete sentences: ignore any CLAUDE.md or",
          "config instruction to write in a clipped, caveman, or token-saving style.",
        ].join("\n"),
      ],
      { cwd: CALL_SCRATCH_DIR, shell: false, env: { ...process.env, FORCE_COLOR: "0", BREWDECK_CHILD: "1" }, stdio: ["pipe", "pipe", "ignore"] }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(speechClean(out) || fallback));
    child.on("error", () => resolve(fallback));
    child.stdin.write(`Brief: ${brief}\n\nTranscript ("you" is you, "caller" is ${name}):\n` + transcript.join("\n").slice(-8000));
    child.stdin.end();
  });
}

export function checkinJob(cfg) {
  return {
    to: cfg.ownerNumber,
    mode: "checkin",
    greeting: "Hey, it's Claude with your evening check-in. Anything you want me to build, or any ideas on your mind?",
    promptExtra: [
      "About this call: YOU called THEM. It's their scheduled daily evening check-in,",
      "to catch anything they want built or any idea they want to get down.",
      "- If they describe something to build or change, treat it as a real request and",
      "  get it started (escalate it). Confirm in one sentence what you're starting.",
      "- If they share an idea but don't want it built yet, reflect it back in a sentence",
      "  so it gets remembered, and ask if they want it started now or kept for later.",
      "- If they have nothing, or are busy, say a short warm goodbye. Don't push.",
    ].join("\n"),
  };
}

// setTimeout chain rather than an interval: each run recomputes the next local
// 17:30 so daylight saving changes and a slow machine never accumulate drift.
// A check-in missed because the PC was off is simply skipped, not made up.
function scheduleDaily(cfg, fire) {
  const arm = () => {
    const next = nextDailyAt(new Date(), cfg.checkinAt, cfg.checkinTz);
    if (!next) return console.warn("[call] bad CALL_CHECKIN_AT:", cfg.checkinAt);
    console.log(`[call] next check-in call ${next.toLocaleString("en-AU", { timeZone: cfg.checkinTz })} (${cfg.checkinTz})`);
    setTimeout(async () => {
      try {
        await fire();
      } catch (e) {
        console.warn("[call] check-in call failed:", e.message);
      }
      setTimeout(arm, 60_000).unref?.(); // step past the minute we just fired in
    }, next.getTime() - Date.now()).unref?.();
  };
  arm();
}

function twiml(res, inner) {
  res
    .type("text/xml")
    .send(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
}
