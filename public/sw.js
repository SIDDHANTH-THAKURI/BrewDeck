// BREWDECK service worker — push notifications (fired from the PC when a
// brew ends, so they land even when the app is closed) + shell caching so
// the app opens instantly and can rehydrate before the network is back.

const CACHE = "brewdeck-v3";
const SHELL = ["./", "index.html", "app.js", "fx.js", "voice-merge.js", "style.css", "manifest.json"];
const CUP_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Crect width='512' height='512' rx='110' fill='%23f6efe3'/%3E%3Ctext x='256' y='340' font-size='280' text-anchor='middle'%3E%E2%98%95%3C/text%3E%3C/svg%3E";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// network-first (dev freshness), cache fallback (offline open); API and the
// websocket never touch the cache
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api") || url.pathname === "/ws") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data.json();
  } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || "☕ BREWDECK", {
      body: data.body || "",
      tag: "brewdeck-brew", // newer result replaces the old notification
      icon: CUP_ICON,
      badge: CUP_ICON,
      vibrate: [80, 40, 80],
      data: { url: self.registration.scope },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow(e.notification.data?.url || "./");
    })
  );
});
