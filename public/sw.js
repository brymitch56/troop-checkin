'use strict';
// App-shell cache. Transactions queue in IndexedDB (offline.js) — the SW only
// guarantees the shell loads offline; /api stays network-only on purpose.
// Bump VERSION on deploy so clients pick up new assets.
const VERSION = 'tc-v25'; // v25: offline login/search/on-site + emergency contacts + request timeouts
const SHELL = [
  '/', '/index.html', '/styles.css', '/theme.css', '/app.js', '/offline.js',
  '/manifest.webmanifest', '/vendor/jsqr.min.js',
  '/icon-192.png', '/icon-512.png',
  '/admin.html', '/admin.css', '/admin.js', '/access-guard.js', '/tabletools.js', '/guide.html',
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

  // ADMIN document: NETWORK-FIRST. The admin page sits behind Cloudflare
  // Access; serving it cache-first meant an installed PWA never revalidated
  // through Access, so an expired session rendered empty tables instead of
  // the login page (field bug, 2026-08-02). Opening admin online now always
  // hits the network — the browser follows the Access redirect and shows the
  // login — and the cached copy is only an offline fallback. The KIOSK stays
  // cache-first below: offline check-in must keep working.
  if (e.request.mode === 'navigate' && url.pathname.startsWith('/admin')) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/admin.html', copy));
        }
        return res;
      }).catch(() => caches.match('/admin.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
