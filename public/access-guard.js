'use strict';
// Cloudflare Access bounce detection for background API calls.
//
// The admin page sits behind Cloudflare Access. When the Access session
// expires, API fetches get a cross-origin 302 to <team>.cloudflareaccess.com
// that a background fetch cannot follow usefully — historically the tables
// just rendered empty. This module detects that bounce so the caller can
// force a full-page navigation (which CAN follow the redirect and shows the
// Access login), with a one-shot guard so a genuinely broken state shows a
// visible message instead of a reload loop.
//
// UMD-ish: browser gets window.AccessGuard; node:test can require() it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AccessGuard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FLAG = 'tc-access-reloaded';

  // Does this response look like a Cloudflare Access login bounce (or a
  // response that cannot be the JSON we asked for)?
  function isBounce(res) {
    if (!res) return true; // network layer gave us nothing
    if (res.redirected && /cloudflareaccess\.com/i.test(res.url || '')) return true;
    if (res.type === 'opaqueredirect') return true; // blocked cross-origin redirect
    if (res.status === 0) return true;
    // HTML where JSON was expected = a login/interstitial page, not our API.
    // (Our own API errors are JSON, so a real 401/500 is NOT a bounce.)
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (res.ok && /text\/html/i.test(ct)) return true;
    return false;
  }

  // storage: sessionStorage-like; reload: () => void; onStuck: () => void
  function create({ storage, reload, onStuck }) {
    return {
      isBounce,
      // Returns 'reloading' the first time (and triggers the reload) or
      // 'stuck' if we already tried once since the last good response.
      handleBounce() {
        if (!storage.getItem(FLAG)) {
          storage.setItem(FLAG, '1');
          reload();
          return 'reloading';
        }
        onStuck();
        return 'stuck';
      },
      // Call on every successful API response: re-arms the one-shot reload.
      markGood() { storage.removeItem(FLAG); },
    };
  }

  return { isBounce, create, FLAG };
});
