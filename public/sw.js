// App-shell caching. Bump VERSION to drop old caches after larger changes.
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;
const PRECACHE = ['./', './manifest.webmanifest', './icons/apple-touch-icon.png', './icons/icon-192.png'];
const DATA_HOSTS = ['api.brightsky.dev', 'ensemble-api.open-meteo.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL).catch(() => caches.match('./')));
  } else if (url.origin === self.location.origin) {
    // Built assets have hashed names, so cache-first is safe.
    event.respondWith(cacheFirst(request));
  } else if (DATA_HOSTS.includes(url.hostname)) {
    // Fresh data when online, last known data when offline.
    event.respondWith(networkFirst(request, DATA));
  }
});
