'use strict';
// App-shell cache. Transactions queue in IndexedDB (offline.js) — the SW only
// guarantees the shell loads offline; /api stays network-only on purpose.
// Bump VERSION on deploy so clients pick up new assets.
const VERSION = 'tc-v3'; // v3: [hidden] guard in styles.css (modal scrim bug)
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/offline.js',
  '/manifest.webmanifest', '/vendor/jsqr.min.js',
  '/icon-192.png', '/icon-512.png',
  '/admin.html', '/admin.css', '/admin.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/signatures')) return; // network only
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
