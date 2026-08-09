const CACHE = 'deqr-mobile-shell-v1';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/deqr.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('deqr-mobile-') && key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'PRECACHE_URLS' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(event.data.urls.filter((url) => typeof url === 'string' && new URL(url, self.location.origin).origin === self.location.origin).map(async (url) => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (response.ok) await cache.put(url, response.clone());
  }))));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok && event.request.destination !== 'document') caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => event.request.mode === 'navigate' ? caches.match('./index.html') : new Response('Offline', { status: 503 }))));
});
