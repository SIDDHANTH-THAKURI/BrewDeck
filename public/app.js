// BREWDECK client — bean picker (model), pressure gauge (effort), voice
// lever (hold to speak), receipts (streamed Claude Code output), TAB ledger.

"use strict";

const $ = (id) => document.getElementById(id);
const LS = localStorage;

const state = {
  token: LS.getItem("bd-token") || "",
  models: [],
  efforts: [],
  workspaces: [],
  model: LS.getItem("bd-model") || "sonnet",
  effortIdx: Number(LS.getItem("bd-effort-idx") ?? 1),
  budget: Number(LS.getItem("bd-budget") || 2),
  lang: LS.getItem("bd-lang") || "en-IN",
  workspace: LS.getItem("bd-workspace") || "",
  sameCup: LS.getItem("bd-samecup") !== "0",
  sessions: JSON.parse(LS.getItem("bd-sessions") || "{}"),
  brewing: false,
  listening: false,
};

const BUDGETS = [0.5, 1, 2, 5];
const BEAN_COLORS = { haiku: "#d9c8a8", sonnet: "#b98a5e", opus: "#6b4a32", fable: "#31221b" };

// ---------------------------------------------------------------- tiny audio

let actx = null;
function sfx(kind) {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    const t = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.connect(g);
    g.connect(actx.destination);
    const conf = {
      click: [880, 640, 0.05, 0.05],
      tick: [520, 460, 0.04, 0.05],
      send: [660, 990, 0.1, 0.06],
      ding: [1180, 1180, 0.25, 0.07],
      err: [300, 180, 0.2, 0.08],
    }[kind] || [600, 600, 0.05, 0.04];
    o.type = "triangle";
    o.frequency.setValueAtTime(conf[0], t);
    o.frequency.exponentialRampToValueAtTime(conf[1], t + conf[2]);
    g.gain.setValueAtTime(conf[3], t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + conf[2]);
    o.start(t);
    o.stop(t + conf[2] + 0.02);
  } catch {}
}
const buzz = (ms) => navigator.vibrate && navigator.vibrate(ms);

// ---------------------------------------------------------------- energy charge fx
// Shared "power-up" feedback for the pressure gauge and the bean picker:
// a glow ring + spark burst (level scales size/count/duration) plus a
// rising charge sound that gets longer, higher-pitched and crackles more
// the further you push it. `level` is 0..1.

const fxLayer = $("fx-layer");

function energyBurst(x, y, level, color) {
  level = Math.max(0, Math.min(1, level));
  const ringSize = 44 + level * 90;
  const ringDur = 260 + level * 340;

  const ring = document.createElement("div");
  ring.className = "fx-ring";
  ring.style.left = x + "px";
  ring.style.top = y + "px";
  ring.style.width = ringSize + "px";
  ring.style.height = ringSize + "px";
  ring.style.background = `radial-gradient(circle, ${color}66 0%, ${color}33 45%, transparent 72%)`;
  fxLayer.appendChild(ring);
  const ringAnim = ring.animate(
    [
      { transform: "translate(-50%,-50%) scale(0.15)", opacity: 0.95 },
      { transform: `translate(-50%,-50%) scale(${1 + level * 1.3})`, opacity: 0 },
    ],
    { duration: ringDur, easing: "cubic-bezier(.16,.8,.3,1)" }
  );
  ringAnim.onfinish = () => ring.remove();

  // second delayed shockwave for the epic tier, timed to land with the
  // sound's low boom tail — the visual "thump" to match
  if (level > 0.8) {
    const boomDelay = (0.1 + level * 0.5) * 1000;
    const boom = document.createElement("div");
    boom.className = "fx-ring";
    boom.style.left = x + "px";
    boom.style.top = y + "px";
    boom.style.width = ringSize * 1.6 + "px";
    boom.style.height = ringSize * 1.6 + "px";
    boom.style.background = `radial-gradient(circle, ${color}80 0%, ${color}30 50%, transparent 75%)`;
    fxLayer.appendChild(boom);
    const boomAnim = boom.animate(
      [
        { transform: "translate(-50%,-50%) scale(0.3)", opacity: 0.9 },
        { transform: "translate(-50%,-50%) scale(1.9)", opacity: 0 },
      ],
      { duration: 420, delay: boomDelay, easing: "cubic-bezier(.1,.7,.25,1)" }
    );
    boomAnim.onfinish = () => boom.remove();
  }

  const sparkCount = Math.round(4 + level * 11);
  for (let i = 0; i < sparkCount; i++) {
    const s = document.createElement("div");
    s.className = "fx-spark";
    s.style.left = x + "px";
    s.style.top = y + "px";
    s.style.background = color;
    s.style.boxShadow = `0 0 ${4 + level * 5}px ${color}`;
    fxLayer.appendChild(s);
    const ang = Math.random() * Math.PI * 2;
    const dist = 16 + level * 52 + Math.random() * 22;
    const sdur = 340 + level * 300 + Math.random() * 140;
    const anim = s.animate(
      [
        { transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
        { transform: `translate(${Math.cos(ang) * dist - 3.5}px, ${Math.sin(ang) * dist - 3.5}px) scale(0.15)`, opacity: 0 },
      ],
      { duration: sdur, easing: "cubic-bezier(.13,.7,.25,1)" }
    );
    anim.onfinish = () => s.remove();
  }
}

// warm=true gives a mellower, rounder timbre (used for beans); false is
// brighter/harsher (used for the pressure gauge) — same escalation shape.
// modelTier (0..1) is how far up the bean lineup we are (haiku..fable) —
// it stacks on top of `level` so the SAME gauge pull sounds higher-pitched,
// louder and more dramatic the further up the beans you've gone, capping
// out epic/loud/high-pitched for Fable.
function chargeSound(level, warm = false, modelTier = 0) {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    level = Math.max(0, Math.min(1, level));
    modelTier = Math.max(0, Math.min(1, modelTier));
    const boosted = Math.min(1, level + modelTier * 0.4); // drives pitch/epic threshold
    const loud = 1 + modelTier * 0.6; // drives loudness on top of that
    const epic = boosted > 0.8; // Fable / DEATH WISH territory — go dramatic
    const t = actx.currentTime;
    const dur = 0.1 + boosted * (epic ? 0.5 : 0.3);

    const o = actx.createOscillator();
    o.type = boosted > 0.62 ? "sawtooth" : warm ? "sine" : "triangle";
    const f0 = (warm ? 150 : 190) * (1 + modelTier * 0.35);
    const f1 = (warm ? 360 : 470) + boosted * (warm ? (epic ? 760 : 480) : 920) + modelTier * 220;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.8);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.min(0.34, (0.05 + boosted * (epic ? 0.13 : 0.09)) * loud), t + dur * 0.32);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(actx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);

    // sub-bass swell — gives the epic tier real physical weight
    if (epic) {
      const sub = actx.createOscillator();
      sub.type = "sine";
      sub.frequency.setValueAtTime(46, t);
      sub.frequency.exponentialRampToValueAtTime(88, t + dur * 0.9);
      const subG = actx.createGain();
      subG.gain.setValueAtTime(0.0001, t);
      subG.gain.linearRampToValueAtTime(Math.min(0.32, 0.17 * boosted * loud), t + dur * 0.5);
      subG.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
      sub.connect(subG);
      subG.connect(actx.destination);
      sub.start(t);
      sub.stop(t + dur + 0.14);
    }

    const crackleBursts = boosted > 0.22 ? (epic ? 2 : 1) : 0;
    for (let c = 0; c < crackleBursts; c++) {
      const bufLen = Math.floor(actx.sampleRate * 0.13);
      const buf = actx.createBuffer(1, bufLen, actx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / bufLen);
      const src = actx.createBufferSource();
      src.buffer = buf;
      const nf = actx.createBiquadFilter();
      nf.type = "highpass";
      nf.frequency.value = 1600 + boosted * 2400;
      const ng = actx.createGain();
      const startAt = t + dur * (0.45 + c * 0.24);
      ng.gain.setValueAtTime(0.0001, startAt);
      ng.gain.linearRampToValueAtTime(Math.min(0.14, (0.025 + boosted * 0.05) * (epic ? 1.4 : 1) * loud), startAt + dur * 0.18);
      ng.gain.exponentialRampToValueAtTime(0.0001, startAt + dur * 0.4 + 0.05);
      src.connect(nf);
      nf.connect(ng);
      ng.connect(actx.destination);
      src.start(startAt);
    }

    const tick = actx.createOscillator();
    tick.type = "square";
    tick.frequency.value = 600 + boosted * 360 + modelTier * 200;
    const tg = actx.createGain();
    tg.gain.setValueAtTime(0.0001, t + dur);
    tg.gain.linearRampToValueAtTime(Math.min(0.26, (0.05 + boosted * (epic ? 0.16 : 0.1)) * loud), t + dur + 0.008);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + dur + (epic ? 0.16 : 0.1));
    tick.connect(tg);
    tg.connect(actx.destination);
    tick.start(t + dur);
    tick.stop(t + dur + (epic ? 0.18 : 0.11));

    // low boom tail — the "drama" for the top tier
    if (epic) {
      const boom = actx.createOscillator();
      boom.type = "sine";
      boom.frequency.setValueAtTime(130, t + dur);
      boom.frequency.exponentialRampToValueAtTime(38, t + dur + 0.3);
      const bg = actx.createGain();
      bg.gain.setValueAtTime(0.0001, t + dur);
      bg.gain.linearRampToValueAtTime(Math.min(0.36, 0.24 * loud), t + dur + 0.02);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.4);
      boom.connect(bg);
      bg.connect(actx.destination);
      boom.start(t + dur);
      boom.stop(t + dur + 0.42);
    }
  } catch {}
}

// current bean's position in the lineup, 0 (haiku) .. 1 (fable) — used to
// scale gauge/bean sounds so later beans sound higher-pitched & louder.
function beanTier(id) {
  if (!state.models.length) return 0;
  const maxDepth = Math.max(1, ...state.models.map((m) => m.depth || 1));
  const m = state.models.find((x) => x.id === id) || { depth: 1 };
  return maxDepth > 1 ? ((m.depth || 1) - 1) / (maxDepth - 1) : 0;
}

// ---------------------------------------------------------------- helpers

function toast(msg, ms = 2400) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", "x-brewdeck-token": state.token, ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    lock();
    throw new Error("locked");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.json();
}

const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n | 0));
const fmtCost = (c) => "$" + (c >= 10 ? c.toFixed(0) : c >= 1 ? c.toFixed(2) : c.toFixed(3));

// ---------------------------------------------------------------- lock screen

function lock() {
  state.token = "";
  LS.removeItem("bd-token");
  $("app").hidden = true;
  $("lock").hidden = false;
}

let pinBuf = "";
function buildPad() {
  const pad = $("pad");
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "☕", "0", "⌫"];
  pad.innerHTML = "";
  for (const k of keys) {
    const b = document.createElement("button");
    b.textContent = k;
    b.addEventListener("click", () => {
      sfx("click");
      buzz(10);
      if (k === "⌫") pinBuf = pinBuf.slice(0, -1);
      else if (k !== "☕") pinBuf = (pinBuf + k).slice(0, 4);
      renderPin();
      if (pinBuf.length === 4) tryPin();
    });
    pad.appendChild(b);
  }
}
function renderPin() {
  [...$("pin-dots").children].forEach((d, i) => d.classList.toggle("fill", i < pinBuf.length));
}
async function tryPin() {
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: pinBuf }),
    });
    if (!r.ok) throw 0;
    const { token } = await r.json();
    state.token = token;
    LS.setItem("bd-token", token);
    pinBuf = "";
    renderPin();
    enter();
  } catch {
    sfx("err");
    buzz([60, 40, 60]);
    $("pin-dots").classList.add("shake");
    setTimeout(() => $("pin-dots").classList.remove("shake"), 450);
    pinBuf = "";
    renderPin();
  }
}

// ---------------------------------------------------------------- boot / state

async function enter() {
  let st;
  try {
    st = await api("/api/state");
  } catch {
    return; // lock() already shown on 401
  }
  state.models = st.models;
  state.efforts = st.efforts;
  state.workspaces = st.workspaces;
  if (!state.workspace || !st.workspaces.some((w) => w.path === state.workspace)) {
    state.workspace = st.defaultWorkspace;
  }
  if (!state.models.some((m) => m.id === state.model)) state.model = "sonnet";

  $("lock").hidden = true;
  $("app").hidden = false;
  buildBeans();
  buildGauge();
  renderOpts();
  renderWorkspaceChip();
  connectWS();
}

// ---------------------------------------------------------------- beans

function bagSVG(id) {
  const c = BEAN_COLORS[id] || "#b98a5e";
  return `<svg width="64" height="64" viewBox="0 0 64 64">
    <path d="M18 14 L46 14 L44 8 L20 8 Z" fill="${c}" opacity="0.8"/>
    <path d="M14 18 C10 34 12 50 20 56 L44 56 C52 50 54 34 50 18 C40 12 24 12 14 18 Z" fill="${c}"/>
    <ellipse cx="32" cy="15" rx="15" ry="4.5" fill="#00000022"/>
    <path d="M22 30 a5 7 0 1 0 8 0 a5 7 0 1 0 -8 0" fill="#00000030"/>
    <path d="M34 36 a5 7 -20 1 0 8 0 a5 7 -20 1 0 -8 0" fill="#00000030"/>
    <rect x="16" y="44" width="32" height="8" rx="3" fill="#fffaf1" opacity="0.9"/>
  </svg>`;
}

function buildBeans() {
  const wrap = $("beans");
  wrap.innerHTML = "";
  for (const m of state.models) {
    const b = document.createElement("button");
    b.className = "bag" + (m.id === state.model ? " sel" : "");
    b.innerHTML = `${bagSVG(m.id)}<span class="bag-name">${m.name}</span><span class="bag-roast">${m.roast}</span>`;
    b.addEventListener("click", () => {
      const changed = state.model !== m.id;
      // capture position before buildBeans() replaces this button's DOM node
      const rect = b.getBoundingClientRect();
      state.model = m.id;
      LS.setItem("bd-model", m.id);
      buildBeans();
      wrap.querySelector(".bag.sel")?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      if (changed) {
        const level = beanTier(m.id);
        energyBurst(rect.left + rect.width / 2, rect.top + rect.height * 0.4, level, BEAN_COLORS[m.id] || "#b98a5e");
        chargeSound(level, true, level);
        buzz(Math.round(15 + level * 45));
      } else {
        sfx("click");
      }
    });
    wrap.appendChild(b);
  }
  const sel = state.models.find((m) => m.id === state.model);
  $("bean-note").textContent = sel ? "· " + sel.note : "";
}

// ---------------------------------------------------------------- gauge

const GAUGE = { cx: 100, cy: 105, r: 85, arc: Math.PI * 85 };

function stopAngle(i) {
  return -90 + i * 45; // degrees, 0 = straight up
}

function buildGauge() {
  const g = $("gauge-ticks");
  g.innerHTML = "";
  const roman = ["I", "II", "III", "IV", "V"];
  for (let i = 0; i < 5; i++) {
    const a = (stopAngle(i) * Math.PI) / 180;
    const sx = GAUGE.cx + Math.sin(a) * 72, sy = GAUGE.cy - Math.cos(a) * 72;
    const ex = GAUGE.cx + Math.sin(a) * 88, ey = GAUGE.cy - Math.cos(a) * 88;
    const tx = GAUGE.cx + Math.sin(a) * 62, ty = GAUGE.cy - Math.cos(a) * 62;
    g.innerHTML += `<line class="tick t${i}" x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}"/>
      <text x="${tx}" y="${ty + 3}" text-anchor="middle">${roman[i]}</text>`;
  }
  const svg = $("gauge");
  svg.addEventListener("pointerdown", gaugePoint);
  svg.addEventListener("pointermove", (e) => e.buttons && gaugePoint(e));
  renderGauge(false);
}

function gaugePoint(e) {
  const r = $("gauge").getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 200;
  const y = ((e.clientY - r.top) / r.height) * 120;
  const dx = x - GAUGE.cx, dy = GAUGE.cy - y;
  let a = (Math.atan2(dx, dy) * 180) / Math.PI;
  a = Math.max(-90, Math.min(90, a));
  const idx = Math.round((a + 90) / 45);
  if (idx !== state.effortIdx) {
    state.effortIdx = idx;
    LS.setItem("bd-effort-idx", idx);
    renderGauge(true);
    const level = idx / 4;
    const tier = beanTier(state.model); // gauge levels sound higher/louder the further up the beans you are
    const color = idx >= 4 ? "#d9534f" : idx >= 3 ? "#c97f16" : "#e8a33d";
    const originX = r.left + r.width * 0.5;
    const originY = r.top + r.height * (GAUGE.cy / 120);
    energyBurst(originX, originY, Math.min(1, level + tier * 0.4), color);
    chargeSound(level, false, tier);
    buzz(Math.round(15 + Math.min(1, level + tier * 0.4) * 45));
  }
}

function renderGauge() {
  const i = state.effortIdx;
  const e = state.efforts[i] || { name: "?", note: "" };
  $("needle-g").style.transform = `rotate(${stopAngle(i)}deg)`;
  const fill = $("gauge-fill");
  const frac = i / 4;
  fill.style.strokeDasharray = `${GAUGE.arc * frac} ${GAUGE.arc}`;
  fill.style.stroke = i >= 4 ? "var(--bad)" : i >= 3 ? "var(--amber-deep)" : "var(--amber)";
  $("effort-name").textContent = e.name;
  $("effort-name").style.color = i >= 4 ? "var(--bad)" : "var(--espresso-deep)";
  $("effort-note").textContent = e.note;
  document.querySelectorAll("#gauge-ticks .tick").forEach((t, ti) => t.classList.toggle("hot", ti <= i));
}

// ---------------------------------------------------------------- options

function renderOpts() {
  $("cup-toggle").classList.toggle("on", state.sameCup);
  $("budget-val").textContent = String(state.budget);
  $("lang-val").textContent = state.lang.startsWith("hi") ? "हिं" : "EN";
}

$("cup-toggle").addEventListener("click", () => {
  state.sameCup = !state.sameCup;
  if (!state.sameCup) {
    delete state.sessions[state.workspace];
    LS.setItem("bd-sessions", JSON.stringify(state.sessions));
    toast("fresh cup — context cleared");
  } else {
    toast("same cup — replies keep context");
  }
  LS.setItem("bd-samecup", state.sameCup ? "1" : "0");
  sfx("click");
  renderOpts();
});

$("budget-chip").addEventListener("click", () => {
  const i = BUDGETS.indexOf(state.budget);
  state.budget = BUDGETS[(i + 1) % BUDGETS.length];
  LS.setItem("bd-budget", String(state.budget));
  sfx("tick");
  renderOpts();
});

$("lang-chip").addEventListener("click", () => {
  state.lang = state.lang.startsWith("hi") ? "en-IN" : "hi-IN";
  LS.setItem("bd-lang", state.lang);
  sfx("tick");
  renderOpts();
  toast("voice: " + (state.lang.startsWith("hi") ? "हिन्दी" : "English"));
});

// ---------------------------------------------------------------- workspace

function renderWorkspaceChip() {
  const w = state.workspaces.find((w) => w.path === state.workspace);
  $("ws-name").textContent = w ? w.name : "…";
}

$("ws-chip").addEventListener("click", () => {
  const list = $("ws-list");
  list.innerHTML = "";
  for (const w of state.workspaces) {
    const b = document.createElement("button");
    b.className = "ws-item" + (w.path === state.workspace ? " sel" : "");
    b.innerHTML = `<span>📁</span><span>${w.name}<span class="ws-path">${w.path}</span></span>`;
    b.addEventListener("click", () => {
      state.workspace = w.path;
      LS.setItem("bd-workspace", w.path);
      renderWorkspaceChip();
      closeSheets();
      sfx("click");
      toast("barista moved to " + w.name);
    });
    list.appendChild(b);
  }
  openSheet("ws-sheet");
});

// ---------------------------------------------------------------- sheets

function openSheet(id) {
  $("sheet-veil").hidden = false;
  $(id).hidden = false;
}
function closeSheets() {
  $("sheet-veil").hidden = true;
  $("tab-sheet").hidden = true;
  $("ws-sheet").hidden = true;
}
$("sheet-veil").addEventListener("click", closeSheets);

// ---------------------------------------------------------------- usage tab

$("tab-btn").addEventListener("click", () => {
  openSheet("tab-sheet");
  loadUsage();
});
$("tab-refresh").addEventListener("click", loadUsage);

async function loadUsage() {
  const body = $("tab-body");
  body.innerHTML = `<p class="dim">pouring the numbers…</p>`;
  let u;
  try {
    u = await api("/api/usage");
  } catch (e) {
    body.innerHTML = `<p class="dim">couldn't read the ledger: ${e.message}</p>`;
    return;
  }
  const t = u.today;
  const last7 = u.days.slice(-7);
  const maxC = Math.max(0.001, ...last7.map((d) => d.cost));
  const todayKey = new Date().toLocaleDateString("en-CA");
  const bars = last7
    .map((d) => {
      const h = Math.max(4, (d.cost / maxC) * 66);
      const day = new Date(d.day + "T12:00").toLocaleDateString("en", { weekday: "short" })[0];
      return `<div class="bar-col${d.day === todayKey ? " today" : ""}">
        <b>${fmtCost(d.cost)}</b><i style="height:${h}px"></i><span>${day}</span></div>`;
    })
    .join("");
  const modelRows = Object.entries(u.models)
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(
      ([m, v]) => `<div class="model-row">
        <span class="dotm" style="background:${BEAN_COLORS[m] || "#999"}"></span>
        ${m.toUpperCase()} <span class="msgs">· ${v.msgs} pulls</span>
        <span class="cost">${fmtCost(v.cost)}</span></div>`
    )
    .join("");
  body.innerHTML = `
    <div class="tab-hero"><div class="lbl">TODAY'S TAB</div><div class="big">${fmtCost(t.cost)}</div></div>
    <div class="tab-cells">
      <div class="tab-cell"><b>${fmtTok(t.inTok + t.cacheW)}</b><span>IN TOK</span></div>
      <div class="tab-cell"><b>${fmtTok(t.outTok)}</b><span>OUT TOK</span></div>
      <div class="tab-cell"><b>${fmtTok(t.cacheR)}</b><span>CACHE READ</span></div>
    </div>
    <p class="sec-label">LAST 7 DAYS</p>
    <div class="bars">${bars || '<p class="dim">no brews yet</p>'}</div>
    <p class="sec-label">BY BEAN · 14 DAYS · ${fmtCost(u.totalCost)} TOTAL</p>
    ${modelRows || '<p class="dim">nothing on the tab</p>'}
    <p class="est-note">☕ ${u.estNote || "estimates"}</p>`;
}

// ---------------------------------------------------------------- websocket

let ws = null;
let wsRetry = 1000;

function connectWS() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  ws = new WebSocket(`wss://${location.host}/ws?token=${state.token}`);
  ws.onopen = () => {
    $("conn-dot").classList.add("on");
    wsRetry = 1000;
  };
  ws.onclose = () => {
    $("conn-dot").classList.remove("on");
    // the brew lives on the PC and keeps running while we're away — don't end
    // it here; the "hello" on reconnect tells us if it's really gone.
    setTimeout(connectWS, wsRetry);
    wsRetry = Math.min(wsRetry * 1.6, 10000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServer(m);
  };
}

// ---------------------------------------------------------------- chat ui

const chat = $("chat");
const chatInner = $("chat-inner");
let curReceipt = null; // {el, body, tools, gotText}
let orderNo = Number(LS.getItem("bd-orderno") || 0);
let statusEl = null;
let statusTimer = null;

function nearBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140;
}
function scrollDown(force) {
  if (force || nearBottom()) chat.scrollTop = chat.scrollHeight;
}

function addOrder(text) {
  orderNo++;
  LS.setItem("bd-orderno", String(orderNo));
  const d = document.createElement("div");
  d.className = "order";
  const meta = document.createElement("div");
  meta.className = "meta";
  const eff = state.efforts[state.effortIdx];
  meta.textContent = `ORDER #${orderNo} · ${state.model.toUpperCase()} · ${eff ? eff.name : ""}`;
  const body = document.createElement("div");
  body.textContent = text;
  d.append(meta, body);
  chatInner.appendChild(d);
  trimChat();
  scrollDown(true);
}

function addStatus() {
  removeStatus();
  statusEl = document.createElement("div");
  statusEl.className = "brew-status";
  statusEl.innerHTML = `<span class="steam"><i></i><i></i><i></i></span><span id="brew-verb">grinding beans…</span>`;
  chatInner.appendChild(statusEl);
  const verbs = ["grinding beans…", "tamping the puck…", "pulling the shot…", "steaming milk…", "reading the crema…", "still extracting…"];
  let vi = 0;
  statusTimer = setInterval(() => {
    vi++;
    const v = statusEl.querySelector("#brew-verb");
    if (v) v.textContent = verbs[Math.min(vi, verbs.length - 1)];
  }, 3200);
  scrollDown(true);
}
function removeStatus() {
  clearInterval(statusTimer);
  statusEl?.remove();
  statusEl = null;
}

function ensureReceipt() {
  if (curReceipt) return curReceipt;
  const el = document.createElement("div");
  el.className = "receipt";
  const tools = document.createElement("div");
  tools.className = "r-tools";
  tools.style.display = "none";
  const body = document.createElement("div");
  body.className = "r-body";
  el.append(tools, body);
  chatInner.appendChild(el);
  curReceipt = { el, body, tools, gotText: false };
  scrollDown(true);
  return curReceipt;
}

function trimChat() {
  while (chatInner.children.length > 60) chatInner.firstChild.remove();
}

// ---------------------------------------------------------------- brewing

function brew(text) {
  text = (text || "").trim();
  if (!text) return;
  if (state.brewing) {
    toast("already brewing — spill it first");
    return;
  }
  if (!ws || ws.readyState !== 1) {
    toast("no connection to the bar — retrying…");
    connectWS();
    return;
  }
  sfx("send");
  buzz(25);
  addOrder(text);
  addStatus();
  state.brewing = true;
  $("lever").classList.add("brewing");
  $("spill").hidden = false;
  $("lever-label").textContent = "BREWING…";
  curReceipt = null;
  ws.send(
    JSON.stringify({
      type: "brew",
      text,
      model: state.model,
      effort: (state.efforts[state.effortIdx] || { id: "medium" }).id,
      budget: state.budget,
      workspace: state.workspace,
      resume: state.sameCup ? state.sessions[state.workspace] || null : null,
    })
  );
}

// True while the server is re-sending a brew's buffered transcript after a
// reconnect — the chat is rebuilt from that log, so local echo and one-shot
// feedback (sounds/haptics for things that already happened) are suppressed.
let replaying = false;

function handleServer(m) {
  switch (m.type) {
    case "hello":
      // we think we're brewing but the bar has no brew (it restarted / the
      // brew was spilled elsewhere) — stop pretending
      if (!m.brewing && state.brewing) brewFinished(-1, true);
      break;
    case "replay":
      if (m.start) {
        replaying = true;
        chatInner.innerHTML = ""; // the log rebuilds it; avoids double-render
        removeStatus();
        curReceipt = null;
        state.brewing = false;
      } else {
        replaying = false;
        if (m.live) toast("☕ still brewing — caught you up");
      }
      break;
    case "brewing":
      if (replaying) {
        // rebuild the order bubble + brewing chrome we never saw locally
        addOrder(m.text || "");
        state.brewing = true;
        $("lever").classList.add("brewing");
        $("spill").hidden = false;
        $("lever-label").textContent = "BREWING…";
        addStatus();
      }
      break;
    case "session":
      state.sessions[state.workspace] = m.id;
      LS.setItem("bd-sessions", JSON.stringify(state.sessions));
      break;
    case "delta": {
      const r = ensureReceipt();
      r.gotText = true;
      r.body.textContent += m.text;
      scrollDown();
      break;
    }
    case "tool": {
      const r = ensureReceipt();
      r.tools.style.display = "flex";
      const pill = document.createElement("span");
      pill.className = "tool-pill";
      pill.textContent = `⚙ ${m.name}${m.hint ? ": " + m.hint : ""}`;
      r.tools.appendChild(pill);
      if (r.tools.children.length > 14) r.tools.firstChild.remove();
      scrollDown();
      break;
    }
    case "result": {
      const r = ensureReceipt();
      if (!r.gotText && m.text) r.body.textContent = m.text;
      const foot = document.createElement("div");
      foot.className = "r-foot";
      const okBit = m.ok ? `<span class="ok">✓ SERVED</span>` : `<span class="err">✗ BURNT</span>`;
      const bits = [okBit];
      if (m.cost != null) bits.push(fmtCost(m.cost));
      if (m.turns != null) bits.push(m.turns + (m.turns === 1 ? " shot" : " shots"));
      if (m.ms != null) bits.push((m.ms / 1000).toFixed(1) + "s");
      if (m.usage) bits.push(fmtTok(m.usage.outTok) + " out");
      foot.innerHTML = bits.join(" · ");
      r.el.appendChild(foot);
      if (!m.ok) r.el.classList.add("err");
      if (m.sessionId) {
        state.sessions[state.workspace] = m.sessionId;
        LS.setItem("bd-sessions", JSON.stringify(state.sessions));
      }
      if (!replaying) {
        sfx(m.ok ? "ding" : "err");
        buzz(m.ok ? [30, 40, 30] : 80);
      }
      scrollDown();
      break;
    }
    case "stderr":
      if (m.text) toast(m.text.split("\n").pop().slice(0, 160), 3600);
      break;
    case "done":
      brewFinished(m.code, false, m.stopped);
      break;
  }
}

function brewFinished(code, connectionLost, stopped) {
  if (!state.brewing) return;
  state.brewing = false;
  removeStatus();
  $("lever").classList.remove("brewing");
  $("spill").hidden = true;
  $("lever-label").textContent = "HOLD · SPEAK · RELEASE";
  if (stopped) toast("☕ spilled — brew cancelled");
  else if (connectionLost) toast("connection to the bar dropped", 3000);
  else if (code !== 0 && !curReceipt) toast("the machine jammed (exit " + code + ")", 3200);
  curReceipt = null;
}

$("spill").addEventListener("click", () => {
  if (ws && ws.readyState === 1) ws.send('{"type":"stop"}');
  sfx("err");
  buzz(50);
});

// ---------------------------------------------------------------- voice lever

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recFinal = "";
let recActive = false;
let recWantSend = false;
let recHolding = false; // lever is physically held — outlives one recognition session
let recCommitted = ""; // text carried over from earlier sessions in this same hold
let recSegs = []; // finalized transcript per result index of the CURRENT session

// Mobile (Android) speech recognition doesn't emit clean incremental
// segments — each new "final" result tends to be a full restatement of
// the utterance so far (or an exact repeat), not just the new words. So
// concatenating every final by index duplicates text ("HI" -> "HI HI HI",
// or a sentence retyping itself word-by-word with everything before it).
// Fix: when a new final chunk is a superset (or repeat) of what we already
// have, replace instead of append; only append when it's genuinely new,
// disjoint content. This is safe for desktop too, where segments are
// already disjoint and never match the "startsWith" case.
function mergeFinal(acc, chunk) {
  chunk = chunk.trim();
  if (!chunk) return acc;
  const accTrim = acc.trim();
  if (!accTrim) return chunk;
  const a = accTrim.toLowerCase(), c = chunk.toLowerCase();
  if (c.length >= a.length && c.startsWith(a)) return chunk; // fuller restatement
  if (a.length >= c.length && a.startsWith(c)) return accTrim; // stale repeat, keep what we have
  return accTrim + " " + chunk; // genuinely new content
}

// `e.results` is cumulative — every onresult event re-delivers all earlier
// results. So finals must be stored BY INDEX and the transcript rebuilt from
// scratch each event; folding each event's results into a running accumulator
// re-appends every already-seen final (only index 0 is caught by mergeFinal's
// prefix guard), which is what made long sentences echo themselves into an
// oversized prompt. Index-keyed writes are idempotent under re-delivery.
function joinSegs(segs) {
  return segs.reduce((acc, s) => mergeFinal(acc, s || ""), "");
}

function startListening() {
  if (state.brewing || recActive) return;
  if (!SR) {
    toast("voice needs Chrome/Edge over HTTPS — use the keyboard instead");
    openTyping();
    return;
  }
  if (!window.isSecureContext) {
    toast("open the https:// address for voice");
    return;
  }
  recHolding = true;
  recCommitted = "";
  recFinal = "";
  recWantSend = false;
  openSession();
}

// One recognition session. Android ends these on its own after a silence gap
// (it ignores `continuous`), so a single hold may span several — hence the
// split between recCommitted (earlier sessions) and recSegs (this one).
function openSession() {
  rec = new SR();
  rec.lang = state.lang;
  rec.continuous = true;
  rec.interimResults = true;
  recSegs = [];
  recActive = true;

  rec.onresult = (e) => {
    let interim = "";
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) recSegs[i] = r[0].transcript;
      else interim += r[0].transcript;
    }
    recFinal = mergeFinal(recCommitted, joinSegs(recSegs));
    const txt = (recFinal + " " + interim).trim();
    $("ticket-text").textContent = txt || "…";
    $("ticket").hidden = !txt;
  };

  rec.onerror = (e) => {
    // A silence gap mid-hold surfaces as no-speech; keep the hold alive and
    // let onend respawn the session rather than dropping what was said.
    if (e.error === "no-speech" && recHolding) return;
    recActive = false;
    recHolding = false;
    setLeverListening(false);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("mic permission blocked — allow it in site settings", 3600);
    } else if (e.error !== "aborted" && e.error !== "no-speech") {
      toast("mic hiccup: " + e.error);
    } else if (e.error === "no-speech") {
      toast("didn't catch that — hold and speak");
    }
    $("ticket").hidden = true;
  };

  rec.onend = () => {
    recActive = false;
    recCommitted = mergeFinal(recCommitted, joinSegs(recSegs));
    recFinal = recCommitted;
    // Still held? Android just timed out the session — respawn and keep going
    // instead of silently binning a half-spoken sentence.
    if (recHolding) {
      try {
        openSession();
        rec.start();
        return;
      } catch {
        recHolding = false;
      }
    }
    setLeverListening(false);
    const text = recFinal.trim();
    $("ticket").hidden = true;
    if (recWantSend && text) brew(text);
    else if (recWantSend && !text) toast("didn't catch that — hold and speak");
  };

  try {
    rec.start();
    setLeverListening(true);
    sfx("click");
    buzz(30);
  } catch {
    recActive = false;
    recHolding = false;
  }
}

function stopListening(send) {
  if (!recHolding && !recActive) return;
  recWantSend = send;
  recHolding = false; // release the hold first so onend won't respawn
  if (!recActive) {
    // session already ended on its own; onend won't fire again — send here
    setLeverListening(false);
    const text = recFinal.trim();
    $("ticket").hidden = true;
    if (send && text) brew(text);
    else if (send && !text) toast("didn't catch that — hold and speak");
    return;
  }
  try {
    rec.stop();
  } catch {}
}

function setLeverListening(on) {
  state.listening = on;
  $("lever").classList.toggle("listening", on);
  $("lever-ico").textContent = on ? "🔴" : "🎙️";
  $("lever-label").textContent = on ? "LISTENING — RELEASE TO BREW" : state.brewing ? "BREWING…" : "HOLD · SPEAK · RELEASE";
}

const lever = $("lever");
lever.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  lever.setPointerCapture(e.pointerId);
  startListening();
});
lever.addEventListener("pointerup", () => stopListening(true));
lever.addEventListener("pointercancel", () => stopListening(false));
lever.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------------------------------------------------------------- typing

function openTyping() {
  $("type-wrap").hidden = false;
  $("type-input").focus();
}
$("kbd-btn").addEventListener("click", () => {
  const w = $("type-wrap");
  w.hidden = !w.hidden;
  if (!w.hidden) $("type-input").focus();
});
const typeInput = $("type-input");
typeInput.addEventListener("input", () => {
  typeInput.style.height = "auto";
  typeInput.style.height = Math.min(typeInput.scrollHeight, window.innerHeight * 0.3) + "px";
});
typeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTyped();
  }
});
$("type-send").addEventListener("click", sendTyped);
function sendTyped() {
  const t = typeInput.value.trim();
  if (!t) return;
  typeInput.value = "";
  typeInput.style.height = "auto";
  $("type-wrap").hidden = true;
  brew(t);
}

// ---------------------------------------------------------------- go

buildPad();
if (state.token) enter();
else $("lock").hidden = false;
