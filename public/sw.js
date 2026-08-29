'use strict';
// App-shell cache. Transactions queue in IndexedDB (offline.js) — the SW only
// guarantees the shell loads offline; /api stays network-only on purpose.
// Bump VERSION on deploy so clients pick up new assets.
const VERSION = 'tc-v47'; // v47: admin switch for the check-in health-form badge (default off)
// NOTE: /admin.html is deliberately NOT precached. It sits behind Cloudflare
// Access, which answers a SW fetch from a device with no Access session with
// a cross-origin 302 the fetch spec rejects — one rejected entry aborts the
// whole install, so kiosk-only tablets silently ended up with NO service
// worker (and no offline mode) at all. The fetch handler below already
// serves admin navigations network-first and runtime-caches each successful
// online load into this same cache, so offline admin still works on any
// device that has opened admin online once per version — which is exactly
// the population that can pass Access anyway. Admin's static assets
// (admin.css/js etc.) are NOT behind Access and stay precached.
const SHELL = [
  '/', '/index.html', '/styles.css', '/theme.css', '/app.js', '/offline.js',
  '/manifest.webmanifest', '/vendor/jsqr.min.js',
  '/icon-192.png', '/icon-512.png', '/favicon.ico',
  '/admin.css', '/admin.js', '/access-guard.js', '/tabletools.js', '/guide.html',
];

self.addEventListener('install', (e) => {
  // cache:'reload' fetches every shell asset straight from the origin,
  // bypassing the browser's HTTP cache. Without it, addAll() can fill a
  // brand-new tc-vNN cache with STALE bytes whenever a CDN/proxy stretches
  // asset TTLs (found 2026-08: Cloudflare's default Browser Cache TTL
  // rewrote the origin's max-age=0 to 4h on css/js, so a version bump
  // shipped old CSS to freshly-updated kiosks). Any failure aborts the
  // install — a partial shell never replaces a complete one.
  e.waitUntil(
    caches.open(VERSION).then((c) =>
      Promise.all(SHELL.map((u) =>
        fetch(u, { cache: 'reload' }).then((r) => {
          if (!r.ok) throw new Error(`precache ${u}: ${r.status}`);
          return c.put(u, r);
        })
      ))
    ).then(() => self.skipWaiting())
  );
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
