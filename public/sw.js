const CACHE = 'pi-phone-v13';
const ASSETS = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg'];
const APP_SHELL = new Set(ASSETS);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

async function updateCache(request) {
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  const useNetworkFirst = request.mode === 'navigate' || APP_SHELL.has(url.pathname);

  if (useNetworkFirst) {
    event.respondWith(
      updateCache(request).catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        return caches.match('/');
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return updateCache(request);
    }),
  );
});
