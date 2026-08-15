/**
 * DEQR receiver service worker.
 *
 * The offline shell is a product requirement, but a cache-first shell is not:
 * an earlier revision answered every same-origin GET from the cache, including
 * the HTML document, under a fixed cache name and with no update path. An
 * installed phone therefore stayed pinned to whichever build it saw first and
 * could never receive a fix, which also defeated the host's `Cache-Control:
 * no-cache` on the shell.
 *
 * Strategy now depends on what is being fetched:
 *   - the health probe  -> never touched; it must report the live host
 *   - the HTML document -> network first, cache only as an offline fallback
 *   - hashed build assets -> cache first; their URL changes when they change
 *   - everything else   -> cache first with a background refresh
 */
const CACHE = 'deqr-mobile-shell-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/deqr.svg'];
const HEALTH_PATH = '/health';
// Vite emits content-hashed files here, so a cached one is never stale.
const IMMUTABLE_PREFIX = '/assets/';

self.addEventListener('install', (event) => {
  // Take over as soon as this build installs. Waiting for every tab to close
  // is what let a broken shell survive indefinitely.
  self.skipWaiting();
  // Precache each entry on its own. `cache.addAll` rejects the whole batch if a
  // single fetch fails, which fails the install and leaves the previous worker
  // in charge — including one whose cached shell is the reason this update
  // exists. A worker that activates with an incomplete cache still serves the
  // network first and can fill in later; one that never installs cannot.
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(CORE.map(async (url) => {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (response.ok) await cache.put(url, response);
    } catch {
      // Offline coverage degrades for this entry; the update still lands.
    }
  }))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith('deqr-mobile-') && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'PRECACHE_URLS' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(event.data.urls.filter((url) => typeof url === 'string' && new URL(url, self.location.origin).origin === self.location.origin).map(async (url) => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (response.ok) await cache.put(url, response.clone());
  }))));
});

function isDocumentRequest(request) {
  return request.mode === 'navigate' || request.destination === 'document';
}

/** Newest shell when the host answers, cached shell when it does not. */
async function documentStrategy(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Keep both keys aligned; a navigation may arrive as either one.
      await Promise.all([cache.put('./index.html', response.clone()), cache.put('./', response.clone())]);
    }
    return response;
  } catch {
    return (await cache.match(request)) ?? (await cache.match('./index.html')) ?? new Response('Offline', { status: 503 });
  }
}

async function cacheFirst(request, revalidate) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) {
    if (revalidate) {
      // Refresh in the background; never block the response on the network.
      void fetch(request).then((response) => {
        if (response.ok) return cache.put(request, response.clone());
      }).catch(() => undefined);
    }
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Reachability must be measured, not remembered.
  if (url.pathname === HEALTH_PATH) return;

  if (isDocumentRequest(request)) {
    event.respondWith(documentStrategy(request));
    return;
  }

  event.respondWith(cacheFirst(request, !url.pathname.startsWith(IMMUTABLE_PREFIX)));
});
