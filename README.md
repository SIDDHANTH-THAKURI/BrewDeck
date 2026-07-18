# BREWDECK ☕

An espresso-bar console for **Claude Code, from your phone**. Pull the lever,
speak your order, and the barista (Claude Code running on your PC) gets to work
inside the folder you picked — while you watch the receipt print live.

No boring dropdowns:

- **Beans = model, and every bean is a bar spirit.** Haiku is **WISP** the
  steam sprite (Light Roast), Sonnet is **CREMA** the house barista (House
  Blend), Opus is **BURR** the grinder golem (Dark Roast), Fable is **QUILL**
  the ink crane (Reserve Ristretto). Switching beans plays a full activation:
  the current spirit collapses to a point of light, a whiteout flash, and the
  new one resolves on the stage with its own sound motif and haptics.
- **Grind dial = effort, and each click-stop is a transformation.** Twist the
  burr knob from coarse chunks to ☠ powder — finer grind, harder extraction,
  exactly like a real barista tunes a shot. Five detents:
  SINGLE → DOPPIO → TRIPLE → QUAD → ☠️ DEATH WISH (`--effort low…max`). Tier
  up = charge, shockwave, hard palette snap, particle burst, screen-shake
  (DEATH WISH adds a sub-boom). Tier down = a softer power-down deflation.
  All real-time canvas simulation — bench-test everything at `/fx-lab.html`;
  🔊 button on the stage mutes the FX sound.
- **The lever = your voice.** Hold, speak, release to brew. (Keyboard icon for
  typing instead.)
- **🧾 THE TAB = usage.** Today's spend, 7-day bars, and a by-bean breakdown of
  the last 14 days, parsed from your local Claude Code logs.
- **SAME CUP** keeps conversation context (session resume) per folder;
  **CAP $** limits spend per brew (`--max-budget-usd`).

## Start the bar (on the PC)

Double-click **`start.cmd`** (or `npm start`). The terminal prints:

- the **PIN** (also saved in `brewdeck.config.json` — edit it there if you like)
- the **phone URL** (e.g. `https://192.168.x.x:8443`)
- a **QR code** — scan it with the phone

## On the phone

1. Be on the **same Wi-Fi** as the PC.
2. Open the URL / scan the QR. You'll see a certificate warning **once** —
   tap *Advanced → Proceed*. (The cert is self-signed; HTTPS is required for
   the microphone.)
3. Enter the PIN.
4. Optional: browser menu → **Add to Home Screen** for an app-like launch.
5. Hold the lever and order: *"add a pause menu to the game and run the build"*.

Voice works best in Chrome on Android. The 🗣️ chip flips voice recognition
between English and हिन्दी. On iPhone, use the keyboard (Safari's speech
support is patchy).

## Leaving mid-brew (lock the phone, close the app, walk away)

The brew runs **on the PC**, never on the phone — the phone is just a window
onto it. Specifically:

- Lock the phone, close the app, lose signal, switch Wi-Fi → cellular:
  the brew keeps running. Reopen the app whenever — it reconnects and
  **replays the whole receipt** (still-brewing or finished).
- Every brew is also **saved to disk** (`.brews/`, last 25). Even if the PC
  rebooted or you restarted `start.cmd` since, reopening the app still shows
  the last receipt. A brew that was mid-pour when the bar died is marked
  **interrupted** — any files Claude already wrote are still in the folder.
- The app pings the bar every 20s and reconnects the moment it comes back to
  the foreground, so a dead connection never masquerades as a live one; the
  green dot in the header is the truth.

## Push notifications (know when it's served, app closed)

The **PC** sends the notification when a brew ends, so it arrives even with
the app closed and the phone in your pocket. Needs a *trusted* HTTPS URL
(browsers refuse service workers on self-signed certs):

1. One-time: enable **HTTPS certificates** for your tailnet —
   <https://login.tailscale.com/admin/dns> → "Enable HTTPS".
2. Restart brewdeck. The terminal now prints a
   **`Trusted: https://<machine>.<tailnet>.ts.net:8443`** URL (real
   Let's Encrypt cert, auto-renewed) — open the app from *that* URL,
   no cert warning.
3. Tap **🔔** in the top bar, allow notifications. Done — "☕ order served"
   pops up wherever you are.

No-Tailscale fallback: install the [ntfy](https://ntfy.sh) app, pick a long
random topic name, subscribe to it in the app, and add
`"ntfyTopic": "your-topic"` to `brewdeck.config.json`.

## Taking control from anywhere (not just home Wi-Fi)

BREWDECK itself never opens a port on the public internet — that'd mean a
4-digit PIN standing between the whole internet and code execution on your
PC, which is a bad trade even with the lockout below. Instead it rides on
**Tailscale**, a private mesh VPN: your PC and phone get a stable
`100.x.x.x` address that only reaches each other, end-to-end encrypted,
no router configuration, and nothing exposed publicly.

1. Install Tailscale on the PC — <https://tailscale.com/download/windows>
   (already fetched for you if this was set up recently; just needs you to
   click through the installer once).
2. Sign in: run `tailscale up` in a terminal, or open the Tailscale tray
   icon → **Log in**. Use any account (Google/Microsoft/GitHub all work).
3. Install the **Tailscale app** on your phone (Play Store / App Store) and
   sign in with the *same account*.
4. Restart brewdeck (`start.cmd`). The terminal now prints an extra
   **`Anywhere (Tailscale): https://100.x.x.x:8443`** line and QR code —
   that URL works from mobile data, another Wi-Fi, anywhere, as long as
   both devices are signed into Tailscale.
5. Same PIN, same app, same everything — it's just reachable further now.

Your phone still needs the Tailscale app **running** (it works in the
background, no need to open it) to be "on the network."

## What it actually runs

Each brew spawns on the PC:

```
claude -p --output-format stream-json --include-partial-messages \
  --model <beans> --effort <pressure> --permission-mode bypassPermissions \
  --max-budget-usd <cap> [--resume <same-cup-session>]
```

with the working directory set to the folder shown in the 📁 chip (any folder
on your Desktop — pick `brewdeck` itself, the game project, anything).

## Security notes (read once)

- The bar is **never publicly exposed** — reachable only over your home
  Wi-Fi, or over Tailscale's private encrypted mesh if you set that up. The
  auth token never leaves either.
- The PIN gate has **brute-force lockout**: 5 wrong tries locks that source
  for 15s, doubling (capped ~8 min) on repeated abuse.
- Brews run with **permissions bypassed** so the barista never stalls waiting
  for an approval you can't see — that means Claude can freely edit files and
  run commands **inside the chosen folder**. Point it only at folders you're
  happy to let it work in.
- If Windows Firewall asks about Node.js (or Tailscale) the first time,
  allow it on **Private networks** — otherwise the phone can't reach the bar.

## Files

- `server.js` — HTTPS + WebSocket server, Claude job runner, brew store, push, usage ledger
- `public/` — the phone UI (+ `sw.js` service worker: push + offline shell)
- `public/fx.js` — the roster: character rigs, particle/aura simulation,
  transition choreography, WebAudio synth + haptics
- `public/fx-lab.html` — FX test bench (all characters/tiers/transitions,
  timing + particle + shake sliders, fps meter)
- `.brews/` — persisted brew receipts (last 25) + push subscriptions
- `scripts/test-lifecycle.mjs` — `npm test`: boots an isolated bar with a fake
  `claude`, then force-closes clients mid-brew, restarts the server, etc.
- `scripts/test.mjs` — `npm run test:live`: full E2E against the real bar +
  real Claude (server must be running; costs a few cents)
- `brewdeck.config.json` — PIN / port / default folder / push keys
