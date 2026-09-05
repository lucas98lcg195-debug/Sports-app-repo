// Caches the app shell (HTML/CSS/JS/icons) so the app opens offline, and
// caches team logos aggressively since they almost never change. Live
// score data from /api/ is never cached here; it always goes to the
// network so scores stay current.

const SHELL_CACHE = "ncaa-scores-shell-v1";
const LOGO_CACHE = "ncaa-scores-logos-v1";

const SHELL_ASSETS = [
  "index.html",
  "game.html",
  "team.html",
  "style.css",
  "app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/team-placeholder.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== LOGO_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, live scores need to stay live.
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Team logos come from ESPN's CDN, cache them aggressively.
  if (url.hostname.endsWith("espncdn.com")) {
    event.respondWith(cacheFirst(event.request, LOGO_CACHE));
    return;
  }

  // Same-origin static assets: cache first, fall back to network.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request, SHELL_CACHE));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}
