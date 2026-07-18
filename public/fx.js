// BREWDECK FX — the roster. Four bar spirits (one per bean), five escalating
// forms each (one per pressure tier), rendered as a layered Canvas 2D rig with
// a real-time particle/aura simulation. Sound is synthesized live in WebAudio
// (per-character timbres) and haptics ride the same curves, so the visual hit,
// the stinger and the buzz always land on the same frame.
//
// Grammar (shared by all characters):
//   tier up    charge → shockwave burst (HARD palette snap on the ring's
//              spawn frame) → scatter & settle. Louder / bigger / longer as
//              the tier rises; DEATH WISH adds a delayed sub-boom.
//   tier down  its own deflation: aura recedes, particles FALL, no impact.
//   model swap collapse to a point of light → overexposure whiteout (never a
//              dark frame) → new character resolves at its current tier.
//
// Public API:
//   const stage = BrewFX.mount(canvas, { model, tier, muted, onSwitch });
//   stage.setModel("opus")   stage.setTier(3)   stage.setBrewing(true)
//   stage.react(ok)          stage.setMuted(m)  stage.tune({...})
//
// Original characters throughout — the transformation language is genre
// grammar, the designs are BREWDECK's own.

(() => {
  "use strict";

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const REDUCED = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)");
  // semitone transpose per tier — power-ups literally rise in pitch
  const TIER_ST = [0, 2, 4, 7, 12].map((st) => Math.pow(2, st / 12));

  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
    };
  }

  // ---------------------------------------------------------------- characters
  // Keyed by MODEL id (what the app knows); each carries its spirit's rig.

  const CHARS = {
    haiku: {
      rig: "wisp", name: "WISP", roast: "LIGHT ROAST", depth: 0,
      pal: [
        { body: "#cfd8d4", body2: "#dde4e0", aura: "#cfd8d4", glow: "#b9cdc6", eye: "#5c6662" },
        { body: "#b5d6cd", body2: "#cfe6df", aura: "#b5d6cd", glow: "#8fd0c0", eye: "#41615a" },
        { body: "#7fd0be", body2: "#a5e0d2", aura: "#7fd0be", glow: "#5fd6c2", eye: "#2e5a52" },
        { body: "#46c4b4", body2: "#7fdccf", aura: "#46c4b4", glow: "#2ec7b6", eye: "#174f48" },
        { body: "#19b8c9", body2: "#5fe0e5", aura: "#19b8c9", glow: "#8ff2f4", eye: "#e9fdff" },
      ],
      params: (t) => ({
        s: 0.8 + 0.09 * t,
        wing: [0, 0.35, 0.8, 1, 1.2][t],
        halo: [0, 0.5, 0.75, 0.9, 1.1][t],
        crk: [0, 0, 0, 1, 1.7][t],
        ghost: t === 4 ? 1 : 0,
        hz: 1.1 + 0.5 * t,
        amp: 2 + 0.8 * t,
        aura: [0, 0.35, 0.6, 0.85, 1.2][t],
        emit: [0, 0.5, 1, 2, 3.5][t],
      }),
    },
    sonnet: {
      rig: "crema", name: "CREMA", roast: "HOUSE BLEND", depth: 1,
      pal: [
        { body: "#d9c3a5", body2: "#e0cdb2", aura: "#d9c3a5", glow: "#cbb090", eye: "#6b5844" },
        { body: "#dfb98a", body2: "#e5c297", aura: "#dfb98a", glow: "#d0a674", eye: "#5d4832" },
        { body: "#e2a55f", body2: "#eab06e", aura: "#e2a55f", glow: "#d08c3f", eye: "#4c3527" },
        { body: "#e8933c", body2: "#efa04b", aura: "#e8933c", glow: "#ffb75e", eye: "#3f2a15" },
        { body: "#f59300", body2: "#ffa722", aura: "#f59300", glow: "#ffcf6e", eye: "#fff3df" },
      ],
      params: (t) => ({
        s: 0.85 + 0.06 * t,
        ear: 0.8 + 0.1 * t,
        ribbons: [1, 1, 2, 2, 2][t],
        rosetta: [0, 0, 0, 1, 0.5][t],
        orbit: t === 4 ? 1 : 0,
        flow: 0.6 + 0.35 * t,
        ring: [0, 1, 0.5, 0.2, 0][t],
        crk: [0, 0, 0, 1, 1.4][t],
        aura: [0, 0.3, 0.55, 0.85, 1.15][t],
        emit: [0, 0.4, 0.9, 1.6, 2.8][t],
      }),
    },
    opus: {
      rig: "burr", name: "BURR", roast: "DARK ROAST", depth: 2,
      pal: [
        { body: "#8a7666", body2: "#7e6a5a", aura: "#8a7666", glow: "#c9b8a6", eye: "#d8cfc4" },
        { body: "#96704f", body2: "#8a6544", aura: "#96704f", glow: "#c9803e", eye: "#ffcf96" },
        { body: "#b0703f", body2: "#a5623b", aura: "#a5623b", glow: "#e06a2e", eye: "#ffd9a0" },
        { body: "#cd5c33", body2: "#c14f2e", aura: "#c14f2e", glow: "#ff8a3c", eye: "#ffe2b8" },
        { body: "#e8492a", body2: "#e03a1f", aura: "#e03a1f", glow: "#ffb054", eye: "#fff1d6" },
      ],
      params: (t) => ({
        s: 0.9 + 0.09 * t,
        w: 0.85 + 0.12 * t,
        h: 0.9 + 0.1 * t,
        gap: [0, 0, 1.5, 3.5, 7][t],
        seam: [0, 0.35, 0.65, 1, 1.5][t],
        tremor: [0, 0, 0, 0.35, 1][t],
        vents: t >= 2 ? 1 : 0,
        aura: [0, 0.25, 0.5, 0.8, 1.2][t],
        emit: [0, 0.3, 0.8, 1.6, 3][t],
        crk: [0, 0, 0.3, 1, 1.6][t],
      }),
    },
    fable: {
      rig: "quill", name: "QUILL", roast: "RESERVE RISTRETTO", depth: 3,
      pal: [
        { body: "#b9b2c4", body2: "#aca3bb", inner: "#c6c0d2", aura: "#b9b2c4", glow: "#8f6fd0", eye: "#544a66" },
        { body: "#a893c9", body2: "#9b83c2", inner: "#bcaad8", aura: "#a893c9", glow: "#8f6fd0", eye: "#413359" },
        { body: "#9d82d6", body2: "#8f6fd0", inner: "#b49ae2", aura: "#8f6fd0", glow: "#b49ae2", eye: "#3c2a66" },
        { body: "#8a63dc", body2: "#7a4fd6", inner: "#a486e6", aura: "#7a4fd6", glow: "#c9b4f2", eye: "#efe6ff" },
        { body: "#7c46e8", body2: "#6a30e0", inner: "#9a6ff0", aura: "#6a30e0", glow: "#38c8d8", eye: "#f4edff" },
      ],
      params: (t) => ({
        s: 0.85 + 0.07 * t,
        wings2: [0, 0, 1, 1, 1][t],
        fray: [0.1, 0.2, 0.35, 0.7, 1][t],
        glyphs: [1, 2, 3, 5, 8][t],
        flick: [0.2, 0.25, 0.3, 0.4, 0.55][t],
        irid: [0, 0, 0, 0.35, 1][t],
        aura: [0.1, 0.35, 0.6, 0.85, 1.15][t],
        emit: [0.3, 0.7, 1.2, 2, 3.2][t],
        crk: [0, 0, 0, 1, 1.3][t],
      }),
    },
  };

  function lerpParams(a, b, t) {
    const out = {};
    for (const k in b) out[k] = lerp(a[k] ?? b[k], b[k], t);
    return out;
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ---------------------------------------------------------------- audio

  class FXAudio {
    constructor() {
      this.ctx = null;
      this.muted = false;
    }
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.75;
        this.comp = this.ctx.createDynamicsCompressor();
        this.master.connect(this.comp);
        this.comp.connect(this.ctx.destination);
        const len = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return true;
    }
    unlock() {
      this.ensure();
    }
    get t() {
      return this.ctx.currentTime;
    }
    // one oscillator, glide f0→f1, attack/decay envelope
    o(type, f0, f1, dur, peak, { at = 0, curve = "exp", attack = 0.25 } = {}) {
      if (this.muted || !this.ensure()) return;
      const t0 = this.t + at;
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(Math.max(1, f0), t0);
      if (f1 && f1 !== f0) {
        if (curve === "exp") o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur * 0.85);
        else o.frequency.linearRampToValueAtTime(Math.max(1, f1), t0 + dur * 0.85);
      }
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + dur * attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(this.master);
      o.start(t0);
      o.stop(t0 + dur + 0.03);
      return o;
    }
    // filtered noise; rev=true reverses the envelope (swell → hard cut)
    n(dur, { f = 1200, f1 = 0, type = "bandpass", q = 1 } = {}, peak, { at = 0, rev = false } = {}) {
      if (this.muted || !this.ensure()) return;
      const t0 = this.t + at;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const flt = this.ctx.createBiquadFilter();
      flt.type = type;
      flt.frequency.setValueAtTime(f, t0);
      if (f1) flt.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.9);
      flt.Q.value = q;
      const g = this.ctx.createGain();
      if (rev) {
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + dur * 0.92);
        g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
      } else {
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(peak, t0 + dur * 0.15);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      }
      src.connect(flt);
      flt.connect(g);
      g.connect(this.master);
      src.start(t0);
      src.stop(t0 + dur + 0.03);
    }
    // FM bell — Quill's voice
    bell(f, dur, peak, { at = 0, ratio = 2.7, index = 180 } = {}) {
      if (this.muted || !this.ensure()) return;
      const t0 = this.t + at;
      const car = this.ctx.createOscillator();
      car.frequency.value = f;
      const mod = this.ctx.createOscillator();
      mod.frequency.value = f * ratio;
      const mg = this.ctx.createGain();
      mg.gain.setValueAtTime(index, t0);
      mg.gain.exponentialRampToValueAtTime(1, t0 + dur);
      mod.connect(mg);
      mg.connect(car.frequency);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      car.connect(g);
      g.connect(this.master);
      car.start(t0);
      mod.start(t0);
      car.stop(t0 + dur + 0.03);
      mod.stop(t0 + dur + 0.03);
    }

    charge(id, tier, durS) {
      const k = tier / 4;
      if (id === "wisp") {
        this.n(durS, { f: 800, f1: 3200, type: "bandpass", q: 2 }, 0.07 + 0.05 * k, { rev: true });
        this.o("sine", 500, 1300 + 500 * k, durS, 0.05 + 0.04 * k, { attack: 0.6 });
      } else if (id === "crema") {
        this.o("triangle", 200, 500 + 200 * k, durS, 0.08 + 0.05 * k, { attack: 0.5 });
        this.n(durS, { f: 700, f1: 1600, type: "lowpass" }, 0.05 + 0.04 * k, { rev: true });
      } else if (id === "burr") {
        this.o("sawtooth", 60, 150 + 70 * k, durS, 0.07 + 0.05 * k, { attack: 0.5 });
        this.o("sine", 38, 72 + 20 * k, durS + 0.06, 0.12 + 0.08 * k, { attack: 0.6 });
      } else {
        this.bell(400 + 300 * k, durS, 0.06 + 0.04 * k, { index: 260 });
        this.n(durS, { f: 1200, f1: 4200, type: "highpass" }, 0.05 + 0.04 * k, { rev: true });
      }
    }
    impact(id, tier) {
      const k = tier / 4;
      const lowF = { wisp: 900, crema: 700, burr: 340, quill: 800 }[id];
      this.n(0.16 + 0.1 * k, { f: lowF + 400 * k, type: "lowpass" }, 0.16 + 0.1 * k);
      this.o("sine", 200 - 40 * k, 52, 0.16 + 0.08 * k, 0.18 + 0.1 * k, { attack: 0.02 });
    }
    stinger(id, tier) {
      const R = TIER_ST[tier];
      const k = tier / 4;
      if (id === "wisp") {
        this.o("triangle", 1319 * R, 1319 * R, 0.09, 0.1 + 0.05 * k, { attack: 0.05 });
        this.o("triangle", 1976 * R, 1976 * R, 0.11, 0.09 + 0.05 * k, { at: 0.07, attack: 0.05 });
      } else if (id === "crema") {
        this.o("triangle", 440 * R, 440 * R, 0.22, 0.1 + 0.05 * k, { attack: 0.06 });
        this.o("triangle", 554 * R, 554 * R, 0.22, 0.09 + 0.05 * k, { at: 0.015, attack: 0.06 });
        if (tier >= 3) this.o("triangle", 659 * R, 659 * R, 0.2, 0.07, { at: 0.05, attack: 0.06 });
      } else if (id === "burr") {
        this.o("sawtooth", 147 * R, 98 * R, 0.26, 0.12 + 0.06 * k, { attack: 0.04 });
        this.o("sine", 74 * R, 49 * R, 0.3, 0.16 + 0.08 * k, { attack: 0.04 });
      } else {
        this.bell(370 * R, 0.14, 0.1);
        this.bell(523 * R, 0.16, 0.09, { at: 0.08 });
        this.bell(659 * R, 0.3, 0.1 + 0.05 * k, { at: 0.16 });
      }
      // crackle layers arrive with the higher tiers
      if (tier >= 3) {
        this.n(0.1, { f: 2400 + 800 * k, type: "highpass" }, 0.05, { at: 0.03 });
        this.n(0.09, { f: 3200, type: "highpass" }, 0.04, { at: 0.12 });
      }
    }
    boom() {
      // DEATH WISH — full drama, felt not just heard
      this.o("sine", 120, 34, 0.5, 0.3, { attack: 0.04 });
      this.n(0.5, { f: 90, type: "lowpass" }, 0.16);
    }
    release(id, tier) {
      const base = { wisp: 1000, crema: 520, burr: 160, quill: 620 }[id];
      this.o(id === "burr" ? "sawtooth" : "triangle", base * (1 + tier * 0.1), base * 0.45, 0.34, 0.07, { attack: 0.08 });
      this.n(0.38, { f: 2000, f1: 300, type: "lowpass" }, 0.05);
    }
    inhale(id) {
      this.n(0.24, { f: 500, f1: 4200, type: "highpass" }, 0.09, { rev: true });
      this.o("sine", 300, 950, 0.24, 0.06, { attack: 0.7 });
    }
    whitePing() {
      this.o("sine", 2100, 2100, 0.05, 0.06, { attack: 0.05 });
    }
    motif(id) {
      const M = {
        wisp: { n: [659, 784, 988], d: 0.1, gap: 0.07, v: "triangle" },
        crema: { n: [440, 554, 659], d: 0.14, gap: 0.09, v: "triangle" },
        burr: { n: [147, 220, 294], d: 0.2, gap: 0.12, v: "sawtooth" },
        quill: { n: [494, 740, 1319], d: 0.13, gap: 0.085, v: "bell" },
      }[id];
      M.n.forEach((f, i) => {
        if (M.v === "bell") this.bell(f, M.d + 0.1, 0.1, { at: i * M.gap });
        else this.o(M.v, f, f, M.d, 0.1, { at: i * M.gap, attack: 0.06 });
      });
      if (id === "burr") this.o("sine", 74, 74, 0.3, 0.14, { at: 2 * 0.12, attack: 0.06 });
    }
  }

  const audio = new FXAudio();

  // ---------------------------------------------------------------- stage

  class Stage {
    constructor(canvas, opts = {}) {
      this.cv = canvas;
      this.cx2d = canvas.getContext("2d");
      this.model = CHARS[opts.model] ? opts.model : "sonnet";
      this.tier = clamp(opts.tier ?? 1, 0, 4);
      this.onSwitch = opts.onSwitch || null;
      audio.muted = !!opts.muted;
      this.char = CHARS[this.model];
      this.pal = this.char.pal[this.tier];
      this.P = this.char.params(this.tier);
      this.morph = { from: this.P, to: this.P, t: 1, vel: 0, spring: false };
      this.scaleS = { v: 1, vel: 0, target: 1 }; // bloom / anticipation / react
      this.auraMul = 1;
      this.particles = [];
      this.rings = [];
      this.lines = [];
      this.flash = 0;
      this.flashCol = "#ffffff";
      this.white = 0;
      this.collapse = 0; // 0 = none, 1 = fully collapsed to a point
      this.shake = { amp: 0, t: 0, dur: 1 };
      this.seq = [];
      this.seqT = 0;
      this.busy = false;
      this.brewing = false;
      this.charging = 0; // 0..1 while charge phase runs
      this.chargeDur = 1;
      this.blinkAt = performance.now() + rand(2400, 5200);
      this.blink = 0;
      this.emitAcc = 0;
      this.tune_ = { time: 1, particles: 1, shake: 1 };
      this.t0 = performance.now();
      this.raf = 0;
      this.dead = false;
      this._resize = this.resize.bind(this);
      this.resize();
      if (window.ResizeObserver) {
        this.ro = new ResizeObserver(this._resize);
        this.ro.observe(canvas.parentElement || canvas);
      } else {
        window.addEventListener("resize", this._resize);
      }
      this._vis = () => {
        cancelAnimationFrame(this.raf); // never let two loops stack
        if (!document.hidden) {
          this.last = performance.now();
          this.loop();
        }
      };
      document.addEventListener("visibilitychange", this._vis);
      this.last = performance.now();
      this.loop();
    }

    destroy() {
      this.dead = true;
      cancelAnimationFrame(this.raf);
      this.ro?.disconnect();
      window.removeEventListener("resize", this._resize);
      document.removeEventListener("visibilitychange", this._vis);
    }

    tune(o) {
      Object.assign(this.tune_, o);
    }
    setMuted(m) {
      audio.muted = !!m;
    }
    get reduced() {
      return REDUCED && REDUCED.matches;
    }

    resize() {
      const el = this.cv.parentElement || this.cv;
      const w = el.clientWidth || 320;
      const h = el.clientHeight || 160;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
      this.cv.style.width = w + "px";
      this.cv.style.height = h + "px";
      this.W = w;
      this.H = h;
      this.dpr = dpr;
    }

    haptic(v) {
      try {
        navigator.vibrate && navigator.vibrate(v);
      } catch {}
    }

    // -------- sequencing
    sched(atMs, fn) {
      this.seq.push({ at: this.seqT + atMs * this.tune_.time, fn });
    }
    cancelSeq() {
      // fast-forward: run nothing, just snap to a consistent end state
      this.seq = [];
      this.charging = 0;
      this.collapse = 0;
      this.white = 0;
      const cur = this.curP();
      this.morph = { from: cur, to: this.char.params(this.tier), t: 1, vel: 0, spring: false };
      this.pal = this.char.pal[this.tier];
      this.scaleS.target = 1;
      this.busy = false;
    }

    setTier(n, o = {}) {
      n = clamp(Math.round(n), 0, 4);
      if (n === this.tier && !o.force) return;
      const up = n > this.tier;
      if (o.instant || this.reduced) {
        const from = this.curP();
        this.cancelSeq();
        this.tier = n;
        this.pal = this.char.pal[n];
        this.morph = { from, to: this.char.params(n), t: 1, vel: 0, spring: false };
        if (!o.instant) {
          audio.stinger(this.char.rig, n);
          this.haptic(15 + n * 8);
        }
        return;
      }
      if (this.busy) this.cancelSeq();
      up ? this.seqUp(n) : this.seqDown(n);
    }

    seqUp(n) {
      this.busy = true;
      const k = n / 4;
      const dm = 1 + this.char.depth * 0.18; // deeper beans hit harder
      const charge = (150 + 150 * k) * this.tune_.time;
      this.chargeDur = charge;
      const rig = this.char.rig;

      // phase 1 — charge: aura flares, sparks gather, riser, soft tick
      this.charging = 0.0001;
      this.scaleS.target = 0.96;
      audio.charge(rig, n, charge / 1000 + 0.05);
      this.haptic(10);
      const nIn = Math.round((6 + 10 * k) * this.tune_.particles);
      for (let i = 0; i < nIn; i++) this.spawnInward(charge);

      // phase 2 — burst: ring + snap + impact, all on the same frame
      this.sched(charge, () => {
        const from = this.curP();
        this.tier = n;
        this.pal = this.char.pal[n]; // HARD SNAP — never a fade
        this.morph = { from, to: this.char.params(n), t: 0, vel: 0, spring: true, k: 130 + 60 * k, d: 11 };
        this.scaleS.target = 1;
        this.ring(1 + k * 1.1, this.pal.aura);
        if (n >= 3) this.sched(90, () => this.ring(0.8 + k, this.pal.glow));
        if (n >= 3) this.speedlines(Math.round((10 + 10 * k) * dm));
        this.flashCol = this.pal.aura;
        this.flash = 0.2 + 0.1 * k;
        this.doShake((2 + 4 * k) * dm, 120 + 150 * k);
        this.burst(Math.round((12 + 28 * k) * dm * this.tune_.particles));
        audio.impact(rig, n);
        audio.stinger(rig, n);
        this.haptic(Math.round(20 + 45 * k));
        this.charging = 0;
      });

      // DEATH WISH — the delayed low boom, timed like a distant detonation
      if (n === 4) {
        this.sched(charge + 260, () => {
          audio.boom();
          this.ring(2.2, this.pal.glow);
          this.doShake(3 * dm, 200);
          this.haptic([30, 40, 70]);
        });
      }

      this.sched(charge + 750, () => (this.busy = false));
    }

    seqDown(n) {
      this.busy = true;
      // deflation, not a reversed power-up: no charge, no ring, no impact
      audio.release(this.char.rig, this.tier);
      this.haptic(12);
      this.auraMul = 0.4;
      const drop = Math.round(10 * this.tune_.particles);
      for (let i = 0; i < drop; i++) this.spawnFalling();
      this.sched(120, () => {
        const from = this.curP();
        this.tier = n;
        this.pal = this.char.pal[n]; // still a snap — the grammar holds
        this.morph = { from, to: this.char.params(n), t: 0, vel: 0, spring: false, ease: 300 };
      });
      this.sched(450, () => {
        this.auraMul = 1;
        this.busy = false;
      });
    }

    setModel(id, o = {}) {
      if (!CHARS[id] || id === this.model) return;
      if (o.instant || this.reduced) {
        this.cancelSeq();
        this.model = id;
        this.char = CHARS[id];
        this.pal = this.char.pal[this.tier];
        this.P = this.char.params(this.tier);
        this.morph = { from: this.P, to: this.P, t: 1, vel: 0, spring: false };
        this.particles.length = 0;
        if (!o.instant) audio.motif(this.char.rig);
        this.onSwitch && this.onSwitch(this.char, { instant: true });
        return;
      }
      if (this.busy) this.cancelSeq();
      this.busy = true;
      const next = CHARS[id];

      // phase 1 — collapse: everything is pulled into a point of light
      audio.inhale(this.char.rig);
      this.haptic(15);
      for (const p of this.particles) {
        p.mode = "attract";
        p.k = 220;
      }
      this.collapse = 0.0001;

      // phase 2 — whiteout: overexposure, never darkness
      this.sched(250, () => {
        this.white = 1;
        audio.whitePing();
        this.model = id;
        this.char = next;
        this.pal = next.pal[this.tier];
        const to = next.params(this.tier);
        this.morph = { from: to, to, t: 1, vel: 0, spring: false };
        this.P = to;
        this.particles.length = 0;
        this.collapse = 0;
        this.scaleS.v = 0.55;
        this.scaleS.vel = 0;
        this.scaleS.target = 1;
      });

      // phase 3 — resolve: the new spirit blooms out of the flash
      this.sched(370, () => {
        const dm = 1 + next.depth * 0.3;
        this.ring(1.4 * dm, next.pal[this.tier].aura);
        this.speedlines(Math.round(8 + next.depth * 5));
        this.burst(Math.round((10 + 9 * next.depth) * this.tune_.particles));
        audio.motif(next.rig);
        this.haptic([20, 30, 25, 35]);
        this.onSwitch && this.onSwitch(next, {});
      });

      this.sched(950, () => (this.busy = false));
    }

    setBrewing(b) {
      this.brewing = !!b;
    }

    react(ok) {
      if (ok) {
        this.scaleS.v = 1.07;
        this.scaleS.vel = 0;
        this.ring(0.7, this.pal.glow);
        for (let i = 0; i < 7; i++) this.spawnSparkle();
      } else {
        this.scaleS.v = 0.92;
        this.scaleS.vel = 0;
        for (let i = 0; i < 5; i++) this.spawnFalling(true);
      }
    }

    // -------- particles / rings / lines / shake

    u() {
      return this.H / 170;
    }
    center() {
      return { x: this.W / 2, y: this.H * 0.56 };
    }

    spawnInward(chargeMs) {
      const c = this.center();
      const a = rand(0, TAU);
      const r = rand(40, 78) * this.u();
      this.particles.push({
        x: c.x + Math.cos(a) * r,
        y: c.y + Math.sin(a) * r * 0.7,
        vx: 0, vy: 0,
        mode: "attract", k: 90 + 40000 / chargeMs,
        ttl: chargeMs + 120, life: 0,
        sz: rand(1.6, 3.2) * this.u(),
        col: this.pal.glow,
        shape: "dot",
      });
    }
    burst(n) {
      const c = this.center();
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU);
        const sp = rand(90, 260) * this.u();
        this.particles.push({
          x: c.x, y: c.y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.8,
          mode: "burst", drag: 3.2, attractAfter: 260, k: 60,
          ttl: rand(600, 950), life: 0,
          sz: rand(1.8, 4) * this.u(),
          col: Math.random() < 0.6 ? this.pal.aura : this.pal.glow,
          shape: Math.random() < 0.3 ? "streak" : "dot",
        });
      }
    }
    spawnFalling(dark) {
      const c = this.center();
      this.particles.push({
        x: c.x + rand(-30, 30) * this.u(),
        y: c.y + rand(-30, 10) * this.u(),
        vx: rand(-14, 14) * this.u(), vy: rand(-8, 6) * this.u(),
        mode: "fall", g: 340 * this.u(),
        ttl: rand(420, 640), life: 0,
        sz: rand(1.6, 3) * this.u(),
        col: dark ? "#8a776a" : this.pal.aura,
        shape: "dot",
      });
    }
    spawnSparkle() {
      const c = this.center();
      const a = rand(-TAU / 2, 0);
      this.particles.push({
        x: c.x + rand(-16, 16) * this.u(),
        y: c.y - 10 * this.u(),
        vx: Math.cos(a) * rand(30, 90) * this.u(), vy: Math.sin(a) * rand(40, 110) * this.u(),
        mode: "fall", g: 220 * this.u(),
        ttl: rand(400, 700), life: 0,
        sz: rand(1.5, 2.6) * this.u(),
        col: this.pal.glow, shape: "dot",
      });
    }
    spawnAmbient(P) {
      const c = this.center();
      const rig = this.char.rig;
      const p = {
        life: 0, sz: rand(1.2, 2.4) * this.u(),
        col: hexA(this.pal.aura, 0.8), shape: "dot",
      };
      if (rig === "burr") {
        // embers off the seams, drifting up
        p.x = c.x + rand(-24, 24) * this.u();
        p.y = c.y + rand(-8, 14) * this.u();
        p.vx = rand(-6, 6) * this.u();
        p.vy = rand(-34, -18) * this.u();
        p.mode = "drift";
        p.ttl = rand(700, 1200);
        p.col = this.pal.glow;
      } else if (rig === "quill") {
        // ink motes wandering off the folds
        p.x = c.x + rand(-40, 40) * this.u();
        p.y = c.y + rand(-30, 26) * this.u();
        p.vx = rand(-14, 14) * this.u();
        p.vy = rand(-12, 6) * this.u();
        p.mode = "drift";
        p.ttl = rand(800, 1500);
        p.shape = Math.random() < 0.3 ? "glyph" : "dot";
      } else {
        // steam / foam rising
        p.x = c.x + rand(-26, 26) * this.u();
        p.y = c.y + rand(-4, 20) * this.u();
        p.vx = rand(-8, 8) * this.u();
        p.vy = rand(-30, -14) * this.u();
        p.mode = "drift";
        p.ttl = rand(700, 1300);
      }
      this.particles.push(p);
    }

    ring(mag, col) {
      this.rings.push({ r: 10 * this.u(), v: (240 + 160 * mag) * this.u(), w: 3 + 2.5 * mag, a: 0.65, col });
    }
    speedlines(n) {
      if (this.reduced) return;
      for (let i = 0; i < n; i++) {
        this.lines.push({ ang: rand(0, TAU), r0: rand(24, 40) * this.u(), len: rand(16, 40) * this.u(), a: 0.5, ttl: rand(120, 220), life: 0 });
      }
    }
    doShake(amp, dur) {
      if (this.reduced) return;
      this.shake = { amp: amp * this.tune_.shake, t: 0, dur };
      // a faint DOM wiggle sells the impact beyond the canvas edge
      const host = this.cv.parentElement;
      if (host && host.animate) {
        const a = Math.min(4, amp * 0.5) * this.tune_.shake;
        host.animate(
          [
            { transform: "translate(0,0)" },
            { transform: `translate(${a}px,${-a * 0.6}px)` },
            { transform: `translate(${-a * 0.8}px,${a * 0.5}px)` },
            { transform: `translate(${a * 0.4}px,${a * 0.3}px)` },
            { transform: "translate(0,0)" },
          ],
          { duration: dur, easing: "ease-out" }
        );
      }
    }

    // -------- per-frame

    curP() {
      const m = this.morph;
      const t = clamp(m.t, 0, 1.35);
      return lerpParams(m.from, m.to, t);
    }

    loop() {
      if (this.dead) return;
      this.raf = requestAnimationFrame(() => this.loop());
      const now = performance.now();
      let dt = Math.min(50, now - this.last) / 1000;
      this.last = now;
      const tSec = (now - this.t0) / 1000;

      // sequencer
      this.seqT += dt * 1000;
      if (this.seq.length) {
        this.seq.sort((a, b) => a.at - b.at);
        while (this.seq.length && this.seq[0].at <= this.seqT) this.seq.shift().fn();
      }

      // morph progress: spring (overshoot) or ease
      const m = this.morph;
      if (m.t < 1 || (m.spring && Math.abs(m.vel) > 0.001) || (m.spring && Math.abs(m.t - 1) > 0.001)) {
        if (m.spring) {
          const k = m.k || 140, d = m.d || 12;
          const acc = k * (1 - m.t) - d * m.vel;
          m.vel += acc * dt;
          m.t += m.vel * dt;
        } else {
          m.t = clamp(m.t + (dt * 1000) / (m.ease || 260), 0, 1);
        }
      }
      // global scale spring (anticipation / bloom / reacts)
      const S = this.scaleS;
      const acc = 170 * (S.target - S.v) - 16 * S.vel;
      S.vel += acc * dt;
      S.v += S.vel * dt;

      // charge progress
      if (this.charging > 0) this.charging = clamp(this.charging + (dt * 1000) / this.chargeDur, 0, 1);
      // collapse progress
      if (this.collapse > 0) this.collapse = clamp(this.collapse + dt / 0.25, 0, 1);
      // whiteout decay
      if (this.white > 0) this.white = Math.max(0, this.white - dt / 0.3);
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt / 0.09);
      this.auraMul = lerp(this.auraMul, 1, dt * 4);

      // blink
      if (now > this.blinkAt) {
        this.blink = 1;
        this.blinkAt = now + rand(2600, 5200);
      }
      if (this.blink > 0) this.blink = Math.max(0, this.blink - dt / 0.12);

      const P = this.curP();

      // ambient emission
      const emit = (P.emit || 0) * (this.brewing ? 1.9 : 1) * this.tune_.particles * (this.reduced ? 0 : 1);
      if (emit > 0) {
        this.emitAcc += dt * emit;
        while (this.emitAcc > 0.9 && this.particles.length < 90) {
          this.emitAcc -= 0.9;
          this.spawnAmbient(P);
        }
      }

      // particles physics
      const c = this.center();
      for (const p of this.particles) {
        p.life += dt * 1000;
        if (p.mode === "attract") {
          const dx = c.x - p.x, dy = c.y - p.y;
          p.vx += dx * (p.k || 90) * dt;
          p.vy += dy * (p.k || 90) * dt;
          p.vx *= 1 - 2.5 * dt;
          p.vy *= 1 - 2.5 * dt;
        } else if (p.mode === "burst") {
          p.vx *= 1 - (p.drag || 3) * dt;
          p.vy *= 1 - (p.drag || 3) * dt;
          if (p.life > (p.attractAfter || 1e9)) {
            p.mode = "attract";
            p.k = 70;
          }
        } else if (p.mode === "fall") {
          p.vy += (p.g || 300) * dt;
          p.vx *= 1 - 1.2 * dt;
        } else {
          // drift
          p.vx += rand(-16, 16) * dt * this.u();
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      this.particles = this.particles.filter((p) => p.life < p.ttl);

      for (const r of this.rings) {
        r.r += r.v * dt;
        r.a -= dt * 1.7;
      }
      this.rings = this.rings.filter((r) => r.a > 0);
      for (const l of this.lines) l.life += dt * 1000;
      this.lines = this.lines.filter((l) => l.life < l.ttl);

      if (this.shake.amp > 0) {
        this.shake.t += dt * 1000;
        if (this.shake.t >= this.shake.dur) this.shake.amp = 0;
      }

      this.draw(P, tSec);
    }

    // -------- drawing

    draw(P, t) {
      const ctx = this.cx2d;
      const { W, H, dpr } = this;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // impact shake (decaying oscillation)
      if (this.shake.amp > 0) {
        const k = 1 - this.shake.t / this.shake.dur;
        const a = this.shake.amp * k;
        ctx.translate(Math.sin(this.shake.t * 0.09) * a, Math.cos(this.shake.t * 0.11) * a * 0.7);
      }

      const c = this.center();
      const u = this.u();
      const col = this.collapse;
      // collapse squeezes the whole spirit into a point of light
      const gScale = this.scaleS.v * (col > 0 ? Math.max(0.04, 1 - col) : 1);
      const breathHz = (this.brewing ? 1.5 : 1) * (0.9 + this.tier * 0.22);
      const breath = 1 + Math.sin(t * TAU * breathHz * 0.5) * (0.018 + this.tier * 0.004);

      // ground shadow
      ctx.fillStyle = "rgba(76,53,39," + 0.1 * gScale + ")";
      ctx.beginPath();
      ctx.ellipse(c.x, c.y + 58 * u, 34 * u * P.s * gScale, 7 * u * gScale, 0, 0, TAU);
      ctx.fill();

      // aura core (breathing radial bloom; hotter second core at depth)
      const auraA = (P.aura || 0) * this.auraMul * (0.5 + 0.5 * breath) * gScale;
      if (auraA > 0.02) {
        const R = (46 + 26 * (P.aura || 0)) * u * breath;
        const g1 = ctx.createRadialGradient(c.x, c.y, 4 * u, c.x, c.y, R);
        g1.addColorStop(0, hexA(this.pal.aura, 0.34 * auraA));
        g1.addColorStop(0.55, hexA(this.pal.aura, 0.16 * auraA));
        g1.addColorStop(1, hexA(this.pal.aura, 0));
        ctx.fillStyle = g1;
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, R, R * 0.88, 0, 0, TAU);
        ctx.fill();
        if (this.tier >= 3) {
          const g2 = ctx.createRadialGradient(c.x, c.y, 2 * u, c.x, c.y, R * 0.5);
          g2.addColorStop(0, hexA(this.pal.glow, 0.22 * auraA));
          g2.addColorStop(1, hexA(this.pal.glow, 0));
          ctx.fillStyle = g2;
          ctx.beginPath();
          ctx.ellipse(c.x, c.y, R * 0.5, R * 0.45, 0, 0, TAU);
          ctx.fill();
        }
      }

      // charge flare — inward-leaning glow that swells until the burst
      if (this.charging > 0) {
        const q = this.charging;
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, (30 + 30 * q) * u);
        g.addColorStop(0, hexA(this.pal.glow, 0.35 * q));
        g.addColorStop(1, hexA(this.pal.glow, 0));
        ctx.fillStyle = g;
        ctx.fillRect(c.x - 70 * u, c.y - 70 * u, 140 * u, 140 * u);
      }
      // collapse point-of-light
      if (col > 0) {
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 26 * u);
        g.addColorStop(0, "rgba(255,255,255," + 0.9 * col + ")");
        g.addColorStop(0.4, hexA(this.pal.glow, 0.5 * col));
        g.addColorStop(1, hexA(this.pal.glow, 0));
        ctx.fillStyle = g;
        ctx.fillRect(c.x - 40 * u, c.y - 40 * u, 80 * u, 80 * u);
      }

      // character rig
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.scale(gScale * breath * P.s, gScale * breath * P.s);
      const drawFn = { wisp: this.drawWisp, crema: this.drawCrema, burr: this.drawBurr, quill: this.drawQuill }[this.char.rig];
      drawFn.call(this, ctx, P, t, u);
      ctx.restore();

      // particles
      for (const p of this.particles) {
        const a = 1 - p.life / p.ttl;
        ctx.globalAlpha = clamp(a, 0, 1);
        ctx.fillStyle = p.col;
        if (p.shape === "streak") {
          ctx.strokeStyle = p.col;
          ctx.lineWidth = p.sz * 0.8;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.045, p.y - p.vy * 0.045);
          ctx.stroke();
        } else if (p.shape === "glyph") {
          ctx.strokeStyle = p.col;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(p.x - p.sz, p.y);
          ctx.lineTo(p.x + p.sz, p.y - p.sz);
          ctx.moveTo(p.x - p.sz * 0.4, p.y + p.sz * 0.6);
          ctx.lineTo(p.x + p.sz * 0.6, p.y + p.sz * 0.2);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.sz, 0, TAU);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // shockwave rings
      for (const r of this.rings) {
        ctx.strokeStyle = hexA(r.col, clamp(r.a, 0, 1));
        ctx.lineWidth = r.w;
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, r.r, r.r * 0.86, 0, 0, TAU);
        ctx.stroke();
      }
      // radial speed-lines (classic burst frame)
      for (const l of this.lines) {
        const k = 1 - l.life / l.ttl;
        ctx.strokeStyle = hexA(this.pal.glow, 0.5 * k);
        ctx.lineWidth = 1.6;
        const r1 = l.r0 + (1 - k) * 26 * u;
        ctx.beginPath();
        ctx.moveTo(c.x + Math.cos(l.ang) * r1, c.y + Math.sin(l.ang) * r1 * 0.86);
        ctx.lineTo(c.x + Math.cos(l.ang) * (r1 + l.len), c.y + Math.sin(l.ang) * (r1 + l.len) * 0.86);
        ctx.stroke();
      }

      // accent impact frame
      if (this.flash > 0) {
        ctx.fillStyle = hexA(this.flashCol, this.flash * 0.55);
        ctx.fillRect(-20, -20, W + 40, H + 40);
      }
      // whiteout — overexposure bloom, never a dark frame
      if (this.white > 0) {
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, Math.max(W, H) * 0.75);
        g.addColorStop(0, "rgba(255,255,255," + Math.min(1, this.white * 1.15) + ")");
        g.addColorStop(1, "rgba(255,252,244," + 0.85 * this.white + ")");
        ctx.fillStyle = g;
        ctx.fillRect(-20, -20, W + 40, H + 40);
      }
    }

    eyes(ctx, x1, x2, y, r, col) {
      const sq = 1 - this.blink * 0.85;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.ellipse(x1, y, r, r * sq, 0, 0, TAU);
      ctx.ellipse(x2, y, r, r * sq, 0, 0, TAU);
      ctx.fill();
    }

    drawWisp(ctx, P, t) {
      const pal = this.pal;
      const hover = Math.sin(t * TAU * P.hz * 0.5) * P.amp;
      ctx.translate(Math.sin(t * 2.1) * P.amp * 0.4, hover);
      ctx.rotate(Math.sin(t * 1.3) * 0.05);
      const tear = (s) => {
        ctx.beginPath();
        ctx.moveTo(0, -30 * s);
        ctx.bezierCurveTo(17 * s, -24 * s, 16 * s, 6 * s, 0, 27 * s);
        ctx.bezierCurveTo(-16 * s, 6 * s, -17 * s, -24 * s, 0, -30 * s);
        ctx.fill();
      };
      // afterimage ghost — the awakened form can't quite stay in one place
      if (P.ghost > 0.05) {
        ctx.save();
        ctx.translate(-9 - Math.sin(t * 5) * 2, 3);
        ctx.globalAlpha = 0.22 * P.ghost;
        ctx.fillStyle = pal.aura;
        tear(1);
        ctx.restore();
      }
      // wings (steam blades)
      if (P.wing > 0.03) {
        const w = P.wing;
        ctx.fillStyle = pal.body2;
        const flap = Math.sin(t * TAU * P.hz) * 3 * w;
        for (const m of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(m * 8, -6);
          ctx.quadraticCurveTo(m * (18 + 16 * w), -14 - 10 * w + flap, m * (24 + 20 * w), -26 - 12 * w + flap);
          ctx.quadraticCurveTo(m * (14 + 8 * w), -14 - 2 * w + flap * 0.5, m * 10, 2);
          ctx.closePath();
          ctx.fill();
        }
      }
      // halo
      if (P.halo > 0.03) {
        ctx.strokeStyle = hexA(pal.aura, 0.45 * Math.min(1, P.halo));
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.ellipse(0, -2, 26 * P.halo, 24 * P.halo, 0, 0, TAU);
        ctx.stroke();
      }
      // body
      ctx.fillStyle = pal.body;
      tear(1);
      // crackle ticks at the edges
      if (P.crk > 0.2) {
        ctx.strokeStyle = pal.glow;
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        const n = Math.round(2 + P.crk * 2);
        for (let i = 0; i < n; i++) {
          const seed = Math.floor(t * 9) * 7 + i * 13;
          const a = ((seed * 2654435761) % 628) / 100;
          const r = 24 + ((seed >> 3) % 10);
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r * 0.9 - 4);
          ctx.lineTo(Math.cos(a) * (r + 6), Math.sin(a) * (r + 6) * 0.9 - 4);
          ctx.stroke();
        }
      }
      this.eyes(ctx, -5.5, 5.5, -9, 3, pal.eye);
    }

    drawCrema(ctx, P, t) {
      const pal = this.pal;
      ctx.translate(0, Math.sin(t * TAU * 0.45) * 1.6);
      // foot ring (tier II signature — the cup rim)
      if (P.ring > 0.03) {
        ctx.strokeStyle = hexA(pal.aura, 0.5 * P.ring);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(0, 36, 26, 7, 0, 0, TAU);
        ctx.stroke();
      }
      // rosetta petals behind the torso
      if (P.rosetta > 0.03) {
        ctx.strokeStyle = hexA(pal.glow, 0.4 * P.rosetta);
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + t * 0.4;
          ctx.beginPath();
          ctx.ellipse(Math.cos(a) * 20, Math.sin(a) * 16 - 4, 10, 4.5, a, 0, TAU);
          ctx.stroke();
        }
      }
      // pour ribbons
      const ribbons = Math.round(P.ribbons || 1);
      ctx.lineCap = "round";
      for (let i = 0; i < ribbons; i++) {
        const m = i % 2 === 0 ? 1 : -1;
        const ph = t * TAU * P.flow + i * 2.2;
        ctx.strokeStyle = hexA(i === 0 ? pal.body2 : pal.glow, 0.85);
        ctx.lineWidth = 3.4 - i * 0.5;
        ctx.beginPath();
        ctx.moveTo(m * 6, 26);
        ctx.quadraticCurveTo(m * (22 + Math.sin(ph) * 5), 20 + Math.cos(ph) * 4, m * (30 + Math.sin(ph + 1) * 6), 2 + Math.sin(ph * 0.7) * 6);
        ctx.stroke();
      }
      // orbit ribbons — form V: calm, constant, inevitable
      if (P.orbit > 0.03) {
        ctx.strokeStyle = hexA(pal.glow, 0.75 * P.orbit);
        ctx.lineWidth = 3;
        const a0 = t * 1.5;
        for (const off of [0, Math.PI]) {
          ctx.beginPath();
          ctx.ellipse(0, -2, 38, 30, 0.3, a0 + off, a0 + off + 1.7);
          ctx.stroke();
        }
      }
      // ears
      ctx.fillStyle = pal.body;
      for (const m of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(m * 3, -24);
        ctx.lineTo(m * (14 + 2 * P.ear), -38 - 8 * P.ear);
        ctx.lineTo(m * (12 + 2 * P.ear), -20);
        ctx.closePath();
        ctx.fill();
      }
      // head
      ctx.fillStyle = pal.body2;
      ctx.beginPath();
      ctx.moveTo(0, -28);
      ctx.bezierCurveTo(18, -25, 20, -8, 13, -2);
      ctx.lineTo(-13, -2);
      ctx.bezierCurveTo(-20, -8, -18, -25, 0, -28);
      ctx.fill();
      // torso
      ctx.fillStyle = pal.body;
      ctx.beginPath();
      ctx.moveTo(-11, -2);
      ctx.lineTo(11, -2);
      ctx.lineTo(6, 34);
      ctx.lineTo(-6, 34);
      ctx.closePath();
      ctx.fill();
      // crackle at ribbon tips
      if (P.crk > 0.2) {
        ctx.strokeStyle = pal.glow;
        ctx.lineWidth = 1.8;
        const seed = Math.floor(t * 8);
        for (const m of [-1, 1]) {
          const a = ((seed * 48271 + (m + 2) * 331) % 60) / 100 - 0.3;
          ctx.beginPath();
          ctx.moveTo(m * 30, -6);
          ctx.lineTo(m * (34 + 3 * P.crk), -10 - a * 12);
          ctx.stroke();
        }
      }
      this.eyes(ctx, -5.5, 5.5, -14, 2.8, pal.eye);
    }

    drawBurr(ctx, P, t) {
      const pal = this.pal;
      // tremor — barely contained, even standing still
      if (P.tremor > 0.03) {
        const s = Math.floor(t * 30);
        ctx.translate((((s * 2654435761) % 100) / 100 - 0.5) * 1.6 * P.tremor, (((s * 48271) % 100) / 100 - 0.5) * 1.4 * P.tremor);
      } else {
        ctx.translate(0, Math.sin(t * TAU * 0.35) * 1.2);
      }
      const rr = (x, y, w, h, r) => {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        ctx.fill();
      };
      const gap = P.gap;
      const seamA = Math.min(1, P.seam) * (0.7 + 0.3 * Math.sin(t * TAU * 1.4));
      // shoulders (drift apart as the tiers rise)
      ctx.fillStyle = pal.body2;
      rr(-34 * P.w - gap, -18 * P.h, 15 * P.w, 26 * P.h, 5);
      rr((34 * P.w + gap) - 15 * P.w, -18 * P.h, 15 * P.w, 26 * P.h, 5);
      // vents on the shoulders
      if (P.vents > 0.5) {
        ctx.fillStyle = hexA(pal.glow, 0.55 * Math.min(1, P.seam));
        rr(-31 * P.w - gap, -16 * P.h, 4, 8, 2);
        rr(27 * P.w + gap, -16 * P.h, 4, 8, 2);
      }
      // legs
      ctx.fillStyle = pal.body2;
      rr(-13 * P.w, 24 * P.h, 9 * P.w, 12, 3);
      rr(4 * P.w, 24 * P.h, 9 * P.w, 12, 3);
      // torso
      ctx.fillStyle = pal.body;
      rr(-20 * P.w, -22 * P.h, 40 * P.w, 46 * P.h, 8);
      // head (floats a little at the top tiers)
      const headY = -30 * P.h - gap * 0.8 - (P.tremor > 0.5 ? Math.sin(t * 5) * 1.2 : 0);
      rr(-11 * P.w, headY - 10, 22 * P.w, 16, 5);
      // glowing seams
      if (P.seam > 0.05) {
        ctx.fillStyle = hexA(pal.glow, seamA);
        ctx.fillRect(-16 * P.w, -6, 32 * P.w, 2.6 + P.seam);
        ctx.fillRect(-9 * P.w, 8, 18 * P.w, 2 + P.seam * 0.8);
        if (P.seam > 0.9) ctx.fillRect(-1.4, -22 * P.h, 2.8, 18);
      }
      // crackle arcs across the cracks
      if (P.crk > 0.2) {
        ctx.strokeStyle = pal.glow;
        ctx.lineWidth = 1.8;
        const seed = Math.floor(t * 10);
        if (seed % 3 !== 0) {
          const m = seed % 2 === 0 ? 1 : -1;
          ctx.beginPath();
          ctx.moveTo(m * 20 * P.w, -10);
          ctx.lineTo(m * (24 * P.w + gap * 0.6), -14 - (seed % 5));
          ctx.lineTo(m * (22 * P.w + gap), -4);
          ctx.stroke();
        }
      }
      this.eyes(ctx, -4.5, 4.5, headY - 2, 2.6, pal.eye);
    }

    drawQuill(ctx, P, t) {
      const pal = this.pal;
      // paper that never quite holds still — flicker & micro-glitch
      const fseed = Math.floor(t * 14);
      const dip = ((fseed * 2654435761) % 100) / 100;
      if (dip < P.flick * 0.28) {
        ctx.globalAlpha = 0.62;
        if (dip < P.flick * 0.1) ctx.translate(((fseed % 3) - 1) * 2, 0);
      }
      ctx.translate(0, Math.sin(t * TAU * 0.5) * 1.8);
      const flap = Math.sin(t * TAU * 0.55) * 0.06;
      ctx.rotate(flap * 0.3);
      const wing = (m, y, len, h, col) => {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(m * 2, y);
        ctx.lineTo(m * len, y - h);
        ctx.lineTo(m * (len * 0.62), y + h * 0.55);
        ctx.closePath();
        ctx.fill();
      };
      // main wings
      wing(-1, -12, 42, 12, pal.body2);
      wing(1, -12, 42, 12, pal.body2);
      // second pair
      if (P.wings2 > 0.05) {
        ctx.globalAlpha *= Math.min(1, P.wings2);
        wing(-1, 0, 32, 9, pal.inner);
        wing(1, 0, 32, 9, pal.inner);
        ctx.globalAlpha = dip < P.flick * 0.28 ? 0.62 : 1;
      }
      // body kite
      ctx.fillStyle = pal.body;
      ctx.beginPath();
      ctx.moveTo(0, -32);
      ctx.lineTo(6, -14);
      ctx.lineTo(0, 38);
      ctx.lineTo(-6, -14);
      ctx.closePath();
      ctx.fill();
      // head fold
      ctx.beginPath();
      ctx.moveTo(0, -32);
      ctx.lineTo(-8, -44);
      ctx.lineTo(3, -38);
      ctx.closePath();
      ctx.fill();
      // frayed trailing edges → calligraphy strokes
      if (P.fray > 0.05) {
        ctx.strokeStyle = hexA(pal.glow, 0.8);
        ctx.lineWidth = 1.6;
        ctx.lineCap = "round";
        const n = Math.round(2 + P.fray * 5);
        for (let i = 0; i < n; i++) {
          const m = i % 2 === 0 ? 1 : -1;
          const seed = (fseed + i * 17) * 48271;
          const dx = (seed % 13) - 6;
          const y = -6 + ((seed >> 4) % 22);
          ctx.beginPath();
          ctx.moveTo(m * (30 + P.fray * 10) + dx, y);
          ctx.lineTo(m * (36 + P.fray * 14) + dx, y - 4);
          ctx.stroke();
        }
      }
      // orbiting glyph-storm
      const glyphs = Math.round(P.glyphs || 0);
      if (glyphs > 0) {
        ctx.lineWidth = 1.5;
        for (let i = 0; i < glyphs; i++) {
          const a = t * 0.7 + (i / glyphs) * TAU;
          const r = 44 + (i % 3) * 6;
          const gx = Math.cos(a) * r;
          const gy = Math.sin(a) * r * 0.62 - 2;
          const irid = P.irid > 0.05 && i % 3 === 0;
          ctx.strokeStyle = hexA(irid ? pal.glow : pal.body2, 0.75);
          ctx.beginPath();
          ctx.moveTo(gx - 3, gy + 2);
          ctx.lineTo(gx + 2, gy - 3);
          ctx.moveTo(gx - 1, gy + 3);
          ctx.lineTo(gx + 3, gy + 1);
          ctx.stroke();
        }
      }
      ctx.fillStyle = pal.eye;
      ctx.beginPath();
      ctx.arc(0, -26, 2.4 * (1 - this.blink * 0.8), 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------- api

  window.BrewFX = {
    mount: (canvas, opts) => new Stage(canvas, opts),
    chars: Object.fromEntries(Object.entries(CHARS).map(([id, c]) => [id, { name: c.name, roast: c.roast, pal: c.pal }])),
    audio,
  };
})();
