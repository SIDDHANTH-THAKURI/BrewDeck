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
  buildGrinder();
  renderOpts();
  renderWorkspaceChip();
  initFX();
  connectWS();
  setupPushChip();
}

// ---------------------------------------------------------------- character stage
// The roster (fx.js): each bean is a bar spirit, each pressure tier a form.
// The stage owns all switch/tier cinematics — VFX, synth SFX and haptics fire
// from the same timeline so they land together.

let fxStage = null;

function initFX() {
  if (fxStage || !window.BrewFX) return;
  fxStage = BrewFX.mount($("fx-stage"), {
    model: state.model,
    tier: state.effortIdx,
    muted: LS.getItem("bd-fxmute") === "1",
    onSwitch(char, o) {
      $("stage-name").textContent = char.name;
      $("stage-roast").textContent = char.roast;
      if (!o.instant) {
        const cap = $("stage-cap");
        cap.classList.remove("pop");
        void cap.offsetWidth; // restart the flourish
        cap.classList.add("pop");
      }
    },
  });
  const c = BrewFX.chars[state.model] || BrewFX.chars.sonnet;
  $("stage-name").textContent = c.name;
  $("stage-roast").textContent = c.roast;
  renderFxMute();
}

function renderFxMute() {
  $("fx-mute").textContent = LS.getItem("bd-fxmute") === "1" ? "🔇" : "🔊";
}

$("fx-mute").addEventListener("click", () => {
  const m = LS.getItem("bd-fxmute") === "1" ? "0" : "1";
  LS.setItem("bd-fxmute", m);
  fxStage?.setMuted(m === "1");
  renderFxMute();
});

// mobile autoplay policy: audio can only start from a gesture
document.addEventListener("pointerdown", () => window.BrewFX?.audio.unlock(), { once: true });

// ---------------------------------------------------------------- push
// The notification fires from the PC when a brew ends — the phone app being
// closed is the normal case, not the edge case. Needs a service worker,
// which Chrome only allows on trusted TLS: the tailscale https://…ts.net URL
// (see README) or localhost. On the self-signed IP origin registration
// throws and the bell simply stays hidden.

let swReg = null;

function urlB64ToU8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function setupPushChip() {
  const chip = $("bell-chip");
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  try {
    swReg = await navigator.serviceWorker.register("sw.js");
  } catch {
    return; // self-signed origin — push impossible here, keep the bell hidden
  }
  chip.hidden = false;
  if (Notification.permission === "granted") {
    // re-assert the subscription; endpoints rot when the browser feels like it
    subscribePush().catch(() => {});
  } else {
    renderBell(false);
  }
}

async function subscribePush() {
  const { key } = await api("/api/push/key");
  const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(key) });
  await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub) });
  renderBell(true);
}

async function unsubscribePush() {
  const sub = await swReg.pushManager.getSubscription();
  if (sub) {
    await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  renderBell(false);
}

function renderBell(on) {
  const chip = $("bell-chip");
  chip.classList.toggle("on", !!on);
  chip.textContent = on ? "🔔" : "🔕";
  chip.dataset.on = on ? "1" : "";
}

$("bell-chip").addEventListener("click", async () => {
  sfx("click");
  try {
    if ($("bell-chip").dataset.on) {
      await unsubscribePush();
      toast("push off — you'll only see results in the app");
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast("notifications blocked — allow them in site settings", 3600);
      return;
    }
    await subscribePush();
    toast("🔔 you'll get a ping when the brew is served");
  } catch (e) {
    toast("push setup failed: " + (e?.message || e), 3600);
  }
});

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
      state.model = m.id;
      LS.setItem("bd-model", m.id);
      buildBeans();
      wrap.querySelector(".bag.sel")?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      // the stage runs the whole activation: collapse → whiteout → resolve,
      // with the character's own stinger + haptics
      if (changed) fxStage?.setModel(m.id);
      else sfx("click");
    });
    wrap.appendChild(b);
  }
  const sel = state.models.find((m) => m.id === state.model);
  $("bean-note").textContent = sel ? "· " + sel.note : "";
}

// ---------------------------------------------------------------- grind dial
// Effort = how fine you grind. Real barista logic: finer grind, harder
// extraction. Five click-stop detents (coarse chunks → ☠ powder); the knob
// twists between them with a springy snap and the roster stage fires the
// matching transformation.

const GRIND = { c: 100, r: 78, span: 240 }; // detents every 60°, -120°…+120°
const GRIND_ARC = (GRIND.span / 360) * Math.PI * 2 * GRIND.r;

function detAngle(i) {
  return -120 + i * 60; // degrees, 0 = straight up
}

function buildGrinder() {
  const g = $("grind-ticks");
  const roman = ["I", "II", "III", "IV", "V"];
  let html = "";
  for (let i = 0; i < 5; i++) {
    const a = (detAngle(i) * Math.PI) / 180;
    const dx = GRIND.c + Math.sin(a) * 91, dy = GRIND.c - Math.cos(a) * 91;
    const nx = GRIND.c + Math.sin(a) * 64, ny = GRIND.c - Math.cos(a) * 64;
    // detent markers ARE the grind: big chunk at I shrinking to ☠ powder at V
    if (i === 4) html += `<text class="det skull" x="${dx}" y="${dy + 4}" text-anchor="middle">☠</text>`;
    else html += `<circle class="det" cx="${dx}" cy="${dy}" r="${4.6 - i * 1.05}"/>`;
    html += `<text class="rn" x="${nx}" y="${ny + 3}" text-anchor="middle">${roman[i]}</text>`;
  }
  g.innerHTML = html;
  // grip ridges around the knob rim
  let grips = "";
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    grips += `<line x1="${100 + Math.sin(a) * 40}" y1="${100 - Math.cos(a) * 40}" x2="${100 + Math.sin(a) * 47}" y2="${100 - Math.cos(a) * 47}"/>`;
  }
  $("knob-grips").innerHTML = grips;
  const svg = $("grinder");
  svg.addEventListener("pointerdown", grinderPoint);
  svg.addEventListener("pointermove", (e) => e.buttons && grinderPoint(e));
  renderGrinder();
}

function grinderPoint(e) {
  const r = $("grinder").getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 200 - GRIND.c;
  const y = ((e.clientY - r.top) / r.height) * 200 - GRIND.c;
  let a = (Math.atan2(x, -y) * 180) / Math.PI; // 0 = up, clockwise positive
  a = Math.max(-120, Math.min(120, a));
  const idx = Math.round((a + 120) / 60);
  if (idx !== state.effortIdx) {
    state.effortIdx = idx;
    LS.setItem("bd-effort-idx", idx);
    renderGrinder();
    // tier up = charge → shockwave → hard snap; tier down = deflation
    fxStage?.setTier(idx);
  }
}

function renderGrinder() {
  const i = state.effortIdx;
  const e = state.efforts[i] || { name: "?", note: "" };
  const hot = i >= 4 ? "var(--bad)" : i >= 3 ? "var(--amber-deep)" : "var(--amber)";
  $("grinder-knob").style.transform = `rotate(${detAngle(i)}deg)`;
  $("grind-pointer").style.fill = hot;
  const fill = $("grind-fill");
  fill.style.strokeDasharray = `${GRIND_ARC * (i / 4)} ${GRIND_ARC}`;
  fill.style.stroke = hot;
  $("effort-name").textContent = e.name;
  $("effort-name").style.color = i >= 4 ? "var(--bad)" : "var(--espresso-deep)";
  $("effort-note").textContent = e.note;
  document.querySelectorAll("#grind-ticks .det").forEach((d, di) => d.classList.toggle("hot", di <= i));
  document.querySelectorAll("#grind-ticks .rn").forEach((t, ti) => t.classList.toggle("hot", ti <= i));
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
let pingTimer = null;
let pongDeadline = null;

function connectWS() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  ws = new WebSocket(`wss://${location.host}/ws?token=${state.token}`);
  ws.onopen = () => {
    $("conn-dot").classList.add("on");
    wsRetry = 1000;
    startPinging();
  };
  ws.onclose = () => {
    $("conn-dot").classList.remove("on");
    stopPinging();
    // the brew lives on the PC and keeps running while we're away — don't end
    // it here; the replay on reconnect tells us what really happened.
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

// Switching networks (wifi→cellular) or a long screen-off kills the TCP under
// us without a close frame — readyState stays OPEN and onclose never fires,
// which used to freeze the app forever. Only data proves the link is real:
// ping every 20s, and if the pong doesn't come back in time, declare the
// socket a zombie and close it ourselves (which triggers the reconnect path).
function probe(graceMs) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send('{"type":"ping"}');
  } catch {
    return;
  }
  if (!pongDeadline) {
    pongDeadline = setTimeout(() => {
      pongDeadline = null;
      try {
        ws.close();
      } catch {}
    }, graceMs);
  }
}

function startPinging() {
  stopPinging();
  pingTimer = setInterval(() => probe(8000), 20000);
}
function stopPinging() {
  clearInterval(pingTimer);
  clearTimeout(pongDeadline);
  pingTimer = null;
  pongDeadline = null;
}

// The app coming back to life — screen unlocked, tab foregrounded, restored
// from bfcache, network back — is exactly when the socket deserves zero
// trust: reconnect immediately if it's closed, and ping-probe it (short
// grace) if it claims to be open. Timers were frozen the whole time we were
// backgrounded, so none of this happens on its own.
function wake() {
  if (!state.token || $("app").hidden) return;
  wsRetry = 1000;
  if (!ws || ws.readyState === 2 || ws.readyState === 3) connectWS();
  else if (ws.readyState === 1) probe(4000);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) wake();
});
window.addEventListener("pageshow", wake);
window.addEventListener("online", wake);
window.addEventListener("focus", wake);

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

let brewAck = null; // armed when an order is sent; cleared by the server echo
let pendingOrder = ""; // the order text, kept until the bar confirms receipt

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
  fxStage?.setBrewing(true);
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
  // If the socket was secretly dead (zombie), the send above went nowhere and
  // no "brewing" echo will come back. Close the socket so the reconnect+replay
  // path can tell us the truth; the order text is kept for a one-tap resend.
  pendingOrder = text;
  clearTimeout(brewAck);
  brewAck = setTimeout(() => {
    if (state.brewing && ws?.readyState === 1) {
      try {
        ws.close();
      } catch {}
    }
  }, 5000);
}

// After a reconnect, the replay told us what the bar really knows. If it has
// no trace of the order we sent, the order never arrived — put it back in the
// user's hands instead of silently eating it.
function recoverPendingOrder() {
  if (!pendingOrder) return;
  const t = pendingOrder;
  pendingOrder = "";
  $("type-wrap").hidden = false;
  $("type-input").value = t;
  typeInput.dispatchEvent(new Event("input"));
  toast("order didn't reach the bar — tap ➤ to resend", 4200);
}

// True while the server is re-sending a brew's buffered transcript after a
// reconnect — the chat is rebuilt from that log, so local echo and one-shot
// feedback (sounds/haptics for things that already happened) are suppressed.
let replaying = false;

function handleServer(m) {
  switch (m.type) {
    case "pong":
      clearTimeout(pongDeadline);
      pongDeadline = null;
      break;
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
        // replay is the bar's full memory — if our just-sent order isn't in
        // it (didn't clear pendingOrder below), it never arrived
        recoverPendingOrder();
      }
      break;
    case "brewing":
      // the bar acknowledging OUR order (live echo, or inside a replay after
      // a blip) — the order made it, stop holding it for resend
      if (m.text === pendingOrder) {
        pendingOrder = "";
        clearTimeout(brewAck);
      }
      if (replaying) {
        // rebuild the order bubble + brewing chrome we never saw locally
        addOrder(m.text || "");
        state.brewing = true;
        fxStage?.setBrewing(true);
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
        fxStage?.react(m.ok); // the spirit takes a bow (or droops)
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
  fxStage?.setBrewing(false);
  clearTimeout(brewAck);
  removeStatus();
  $("lever").classList.remove("brewing");
  $("spill").hidden = true;
  $("lever-label").textContent = "HOLD · SPEAK · RELEASE";
  if (stopped) toast("☕ spilled — brew cancelled");
  else if (connectionLost) {
    toast("connection to the bar dropped", 3000);
    recoverPendingOrder();
  } else if (code !== 0 && !curReceipt) toast("the machine jammed (exit " + code + ")", 3200);
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
