'use strict';
// Cloudflare Access bounce detection (public/access-guard.js): an expired
// Access session must trigger ONE forced reload (never a loop, never a
// silent empty render). Regression tests for the 2026-08-02 field bug.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const AG = require('../public/access-guard.js');

const jsonHeaders = { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) };
const htmlHeaders = { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) };
const resp = (o) => ({ ok: true, status: 200, redirected: false, url: 'https://checkin.example.org/api/x', type: 'basic', headers: jsonHeaders, ...o });

test('isBounce: detects the Cloudflare Access redirect', () => {
  assert.equal(AG.isBounce(resp({
    redirected: true,
    url: 'https://plain-mouse-6ef5.cloudflareaccess.com/cdn-cgi/access/login/checkin.example.org',
    headers: htmlHeaders,
  })), true);
});

test('isBounce: opaque redirects and status 0 are bounces', () => {
  assert.equal(AG.isBounce(resp({ type: 'opaqueredirect', ok: false, status: 0 })), true);
  assert.equal(AG.isBounce(resp({ status: 0, ok: false })), true);
  assert.equal(AG.isBounce(null), true);
});

test('isBounce: HTML where JSON was expected is a bounce', () => {
  assert.equal(AG.isBounce(resp({ headers: htmlHeaders })), true);
});

test('isBounce: normal API responses (including our own 401/500 JSON errors) are NOT bounces', () => {
  assert.equal(AG.isBounce(resp()), false);
  assert.equal(AG.isBounce(resp({ ok: false, status: 401 })), false); // app login required — handled by the app
  assert.equal(AG.isBounce(resp({ ok: false, status: 500 })), false);
  // same-origin redirect (not Access) is fine
  assert.equal(AG.isBounce(resp({ redirected: true, url: 'https://checkin.example.org/api/y' })), false);
});

function makeGuard() {
  const store = new Map();
  const calls = { reload: 0, stuck: 0 };
  const g = AG.create({
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    reload: () => { calls.reload++; },
    onStuck: () => { calls.stuck++; },
  });
  return { g, calls };
}

test('handleBounce: reloads exactly once, then shows the stuck message (no loop)', () => {
  const { g, calls } = makeGuard();
  assert.equal(g.handleBounce(), 'reloading'); // first bounce → reload
  assert.equal(calls.reload, 1);
  assert.equal(g.handleBounce(), 'stuck'); // still broken after reload → visible message
  assert.equal(g.handleBounce(), 'stuck');
  assert.equal(calls.reload, 1, 'must never reload twice in a row');
  assert.equal(calls.stuck, 2);
});

test('markGood re-arms the one-shot reload after a successful API response', () => {
  const { g, calls } = makeGuard();
  g.handleBounce();
  g.markGood(); // a later successful call clears the flag…
  assert.equal(g.handleBounce(), 'reloading'); // …so a NEW expiry reloads again
  assert.equal(calls.reload, 2);
  assert.equal(calls.stuck, 0);
});

// The SW side of the fix: admin navigations must be network-first while the
// kiosk shell stays cache-first (offline check-in). The full behavior is
// covered in the browser E2E; this guards the strategy in the source so a
// refactor can't silently drop it.
test('sw.js: admin navigations network-first, kiosk cache-first, /api untouched', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(src, /mode === 'navigate' && url\.pathname\.startsWith\('\/admin'\)/);
  assert.match(src, /fetch\(e\.request\)[\s\S]*catch[\s\S]*caches\.match\('\/admin\.html'\)/, 'admin: network first, cache fallback');
  assert.match(src, /caches\.match\(e\.request\)\.then\(\(hit\) => hit \|\| fetch\(e\.request\)\)/, 'default (kiosk) stays cache-first');
  assert.match(src, /startsWith\('\/api'\)/, '/api stays network-only');
});
