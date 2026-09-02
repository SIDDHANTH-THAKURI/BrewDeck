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
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

// Twilio media frames are 20ms of 8kHz mulaw — 160 bytes, base64'd.
const FRAME_BYTES = 160;

// endpointing is deliberately not tiny: at 300ms an ordinary mid-sentence pause
// ended the utterance, so "make a folder on the desktop, call it Apple" arrived
// as three fragments and claude answered "your message looks incomplete".
const DG_URL =
  "wss://api.deepgram.com/v1/listen" +
  "?encoding=mulaw&sample_rate=8000&channels=1" +
  "&model=nova-3&smart_format=true&interim_results=true" +
  "&endpointing=600&utterance_end_ms=1400&vad_events=true";

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

const VOICE_SYSTEM_PROMPT = [
  "You are talking to someone on a live phone call. They are listening, not reading:",
  "your reply is spoken aloud by text-to-speech and then it is gone. They cannot",
  "scroll back, see a screen, or read anything you write.",
  "",
  "Because of that:",
  "- Keep every reply to one or two short sentences. Long replies get cut off and",
  "  the caller loses the end of what you said.",
  "- If the full answer is long, say the single most useful part, then offer to go",
  "  on. For example: 'There are three problems. Want me to walk through them?'",
  "- Speak plainly. No markdown, headings, bullets, code blocks, asterisks, file",
  "  paths, or URLs unless asked. Say 'the server file' rather than './src/server.js'.",
  "- Never read code aloud. Describe what it does instead.",
  "- Do not narrate your steps. Do the work, then say what happened in one line.",
  "- If something will take more than a few seconds, say so first, briefly.",
  "- The caller may be interrupted or misheard by speech recognition. If a request",
  "  is garbled or ambiguous, ask one short clarifying question rather than guessing.",
  "- Numbers, times and names are spoken, so write them the way they should sound.",
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
    this.sessionId = null; // --resume, so turns in one call share context
    this.speaking = false;
    this.closed = false;
    this.pending = ""; // claude text not yet handed to TTS
    this.busy = false; // a turn is in flight; ignore new transcripts
    // per-call overrides, so "switch to haiku" lasts the call without
    // disturbing the configured defaults or any other caller
    this.model = opts.model;
    this.effort = opts.effort;

    ws.on("message", (raw) => this.onTwilio(raw));
    ws.on("close", () => this.destroy());
    ws.on("error", () => this.destroy());
  }

  log(...a) {
    if (this.opts.verbose) console.log("[call]", ...a);
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
        this.log("start", m.start?.callSid || "");
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
      case "mark":
        // Twilio echoes the mark once the audio before it has actually played,
        // so this is the moment the caller stopped hearing us.
        if (m.mark?.name === this.markName) this.speaking = false;
        break;
      case "stop":
        this.log("stop");
        this.destroy();
        break;
    }
  }

  openDeepgram() {
    const dg = new WebSocket(DG_URL, { headers: { Authorization: "Token " + this.opts.deepgramKey } });
    this.dg = dg;
    dg.on("open", () => this.log("deepgram open"));
    dg.on("message", (raw) => {
      let j;
      try {
        j = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (j.type === "SpeechStarted") {
        // barge-in: caller talked over the reply, so drop what's queued
        if (this.speaking) this.stopSpeaking();
        return;
      }
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
        // Only a real interruption should cut the reply. The handset mic hears
        // our own TTS, so a one-word partial is usually claude echoing back —
        // acting on it made claude interrupt itself mid-sentence.
        if (this.speaking && text.split(/\s+/).length >= 3) this.stopSpeaking();
        return;
      }
      (this.utterQ ||= []).push(text);
      // Safety net: if UtteranceEnd never arrives (it depends on VAD seeing a
      // clean gap), flush anyway rather than leaving the caller waiting.
      clearTimeout(this.utterTimer);
      this.utterTimer = setTimeout(() => this.flushUtterance(), 1800);
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
    if (this.busy) return; // still answering the previous one
    this.log("heard:", text);

    // model/effort switches are handled here rather than by claude — they take
    // effect on the next spawn, and answering locally is instant
    const cmd = parseVoiceCommand(text);
    if (cmd) {
      if (cmd.type === "model") this.model = cmd.value;
      else this.effort = cmd.value;
      this.log(`switched ${cmd.type} -> ${cmd.value}`);
      this.say(`Okay, ${cmd.type} is now ${cmd.value}.`);
      return;
    }

    this.busy = true;
    this.muted = false; // a new question un-mutes whatever the last one silenced
    this.pending = "";
    // stage timings, so a slow turn can be blamed on the right component
    this.t0 = Date.now();
    this.tFirstDelta = null;
    this.tFirstAudio = null;
    this.runClaude(text);
  }

  runClaude(prompt) {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", this.model,
      "--effort", this.effort,
      "--permission-mode", "bypassPermissions",
      "--max-budget-usd", String(this.opts.budget),
      "--append-system-prompt", VOICE_SYSTEM_PROMPT,
    ];
    if (this.sessionId) args.push("--resume", this.sessionId);

    const child = spawn("claude", args, {
      cwd: this.opts.cwd,
      shell: true, // resolves claude.cmd on Windows
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
      if (code !== 0) console.warn("[call] claude exited", code);
      const tail = this.pending.trim();
      this.pending = "";
      if (tail) this.say(speechClean(tail));
      else if (!this.spokeThisTurn) this.say("Done, but I had nothing to say about it.");
      this.busy = false;
      this.child = null;
    });
    child.on("error", (err) => {
      this.log("spawn failed", err.message);
      this.say("I couldn't start claude on the machine.");
      this.busy = false;
      this.child = null;
    });
    this.spokeThisTurn = false;
  }

  onClaudeLine(line) {
    if (!line.startsWith("{")) return;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    if (j.type === "system" && j.subtype === "init" && j.session_id) {
      this.sessionId = j.session_id;
      return;
    }
    if (j.type === "result") {
      if (j.session_id) this.sessionId = j.session_id;
      return;
    }
    if (j.type !== "stream_event") return;
    const ev = j.event;
    if (ev?.type !== "content_block_delta" || ev.delta?.type !== "text_delta") return;

    if (this.tFirstDelta === null && this.t0) {
      this.tFirstDelta = Date.now() - this.t0;
      this.log(`t+${this.tFirstDelta}ms claude first token`);
    }
    this.pending += ev.delta.text;
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
    if (this.tFirstAudio === null && this.t0) {
      this.tFirstAudio = Date.now() - this.t0;
      this.log(`t+${this.tFirstAudio}ms first audio out (caller starts hearing)`);
    }
    this.speaking = true;
    this.audioQ = this.audioQ?.length ? Buffer.concat([this.audioQ, buf]) : buf;
    // only whole frames — a short frame is an audible click
    while (this.audioQ.length >= FRAME_BYTES) {
      const frame = this.audioQ.subarray(0, FRAME_BYTES);
      this.audioQ = this.audioQ.subarray(FRAME_BYTES);
      this.sendFrame(frame);
    }
    // let Twilio tell us when playback actually drains, so `speaking` tracks
    // what the caller hears rather than what we've queued
    this.markSpeech();
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

  markSpeech() {
    if (this.ws.readyState !== WebSocket.OPEN || !this.streamSid) return;
    this.markName = "eos-" + (this.markSeq = (this.markSeq || 0) + 1);
    this.ws.send(
      JSON.stringify({ event: "mark", streamSid: this.streamSid, mark: { name: this.markName } })
    );
  }

  stopSpeaking() {
    this.audioQ = Buffer.alloc(0);
    this.speaking = false;
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

  destroy() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.elKeep);
    this.elKeep = null;
    clearTimeout(this.unmute);
    clearTimeout(this.utterTimer);
    try {
      this.dg?.close();
    } catch {}
    try {
      this.el?.close();
    } catch {}
    if (this.child?.pid) {
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
  }
}

// Mounts the phone path. Returns a `handleUpgrade` the http server routes to,
// because ws can't put two WebSocketServers on one http server by path — the
// first one's upgrade listener aborts every non-matching path with a 400.
export function mountCall({ app, config }) {
  const env = process.env;
  const cfg = {
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
    model: env.CALL_MODEL || "sonnet",
    effort: env.CALL_EFFORT || "medium",
    budget: Number(env.CALL_BUDGET_USD || 1),
    cwd: config?.defaultWorkspace,
    verbose: true,
  };

  const ready =
    cfg.authToken && cfg.deepgramKey && cfg.elevenKey && cfg.voiceId && cfg.allowFrom.length;

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
    new Call(ws, cfg);
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
