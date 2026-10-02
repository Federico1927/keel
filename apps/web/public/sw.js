/*
 * Service worker (#49). It caches ONLY the app shell and static assets: build files under
 * /_next/static, the icons, the manifest and the offline page. It never stores tenant data: pages
 * under /t/ and /admin, /api, server actions (POST, Next-Action), RSC payloads (RSC header or
 * _rsc parameter) and any other request are left to the network. A page that cannot load offline
 * shows /offline instead of the browser's error. `shouldCache` is unit-tested (sw-rules.test.ts).
 */
const CACHE = "app-shell-v1";
const SHELL = ["/offline", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icon.svg"];
const NEVER = [/^\/t\//, /^\/t$/, /^\/admin(\/|$)/, /^\/api\//, /^\/r\//, /^\/s\//, /^\/u\//, /^\/supplier\//, /^\/oauth\//, /^\/avatar\//, /^\/demo-media\//, /^\/welcome/, /^\/account\//];
const RSC_HEADERS = ["rsc", "next-action", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch"];

/** True when the response to this request may be kept in the cache. */
function shouldCache(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.searchParams.has("_rsc")) return false;
  for (const h of RSC_HEADERS) if (request.headers.get(h) !== null) return false;
  if (NEVER.some((re) => re.test(url.pathname))) return false;
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/icons/")) return true;
  return SHELL.includes(url.pathname) && url.search === "";
}
self.shouldCacheRequest = shouldCache;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(SHELL.map((path) => cache.add(new Request(path, { credentials: "same-origin" })).catch(() => undefined)))).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode === "navigate" && request.method === "GET") {
    // pages always come from the network; offline, the cached offline screen
    event.respondWith(fetch(request).catch(() => caches.match("/offline").then((r) => r || Response.error())));
    return;
  }
  if (!shouldCache(request)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      const network = fetch(request).then((response) => {
        if (response.ok && response.type === "basic") cache.put(request, response.clone());
        return response;
      });
      if (hit) {
        // build files are immutable; the shell refreshes in the background
        if (!new URL(request.url).pathname.startsWith("/_next/static/")) network.catch(() => undefined);
        return hit;
      }
      return network;
    }),
  );
});
