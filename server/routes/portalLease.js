'use strict';
// Portal session lease — lends the signed-in portal cookies to another
// program on THIS machine (docs/10-roster-sync.md, "Lending the session").
//
// Why this exists: the portal texts a code at every password sign-in, so a
// second program that signs in on its own wakes a human at whatever hour its
// cron fires — and each attempt burns another text on an account that reaches
// youth records. The rule is one owner: this app holds the credentials and
// the session, and every other local tool borrows what it already has.
//
// Deliberately NOT part of the Integration API. That contract exposes a
// minimum of read-only roster data and its key is handed to dashboards and
// badge trackers; a session cookie is the right to ACT AS the troop's portal
// account, which is a different privilege and must not ride the same key.
//
// Three independent gates, all required:
//   1. PORTAL_LEASE_KEY is set in .env      — absent means the route does not
//      exist at all, so every existing install is unchanged and off.
//   2. the request arrives on the loopback interface, with no forwarding
//      headers — a tunnelled request can never reach it.
//   3. the Bearer token matches PORTAL_LEASE_KEY (constant-time).
//
// This route NEVER signs in. If nobody is connected it says so and the
// borrower is expected to give up quietly; anything that "helpfully" retried
// here would text the human again, which is the whole problem.
const express = require('express');
const crypto = require('crypto');
const portalSession = require('../lib/portalSession');

const router = express.Router();

const MIN_KEY_LEN = 24;
const leaseKey = () => {
  const k = process.env.PORTAL_LEASE_KEY;
  return (typeof k === 'string' && k.length >= MIN_KEY_LEN) ? k : null;
};

// Loopback means the peer is literally on this host. req.ip is not enough:
// `trust proxy` makes it reflect X-Forwarded-For, so read the raw socket and
// then refuse outright if any forwarding header is present — a proxy in the
// path (the tunnel) is exactly what this must not accept.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLocal(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] ||
      req.headers['cf-connecting-ip'] || req.headers['forwarded']) return false;
  return LOOPBACK.has(req.socket && req.socket.remoteAddress);
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function bearerOf(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

// One body for every refusal — disabled, remote, and wrong key are
// indistinguishable from outside.
const DENY = { error: 'portal lease unavailable' };

router.use((req, res, next) => {
  const key = leaseKey();
  if (!key) return res.status(404).json(DENY);
  if (!isLocal(req)) return res.status(404).json(DENY);
  const presented = bearerOf(req);
  if (!presented || !timingSafeEqual(presented, key)) return res.status(401).json(DENY);
  next();
});

// What a borrower needs and nothing else: where the session points, the
// cookie lines to replay, and when it was established. No credentials.
router.get('/', (req, res) => {
  const info = portalSession.sessionInfo();
  if (!info.connected) {
    return res.status(409).json({
      connected: false,
      error: 'nobody is signed in to the portal — connect in Admin → Roster import',
    });
  }
  const cookies = portalSession.loadCookies(info.base);
  if (!cookies || !cookies.length) {
    return res.status(409).json({ connected: false, error: 'the stored session could not be read' });
  }
  res.set('Cache-Control', 'no-store').json({
    connected: true,
    base: info.base,
    cookies,
    connected_at: info.connected_at,
    last_ok_at: info.last_ok_at,
  });
});

// A borrower that used the session successfully says so here, so the admin
// panel's "last used" reflects every consumer and not just this app's own
// jobs. That timestamp is how the session's real lifetime gets measured.
router.post('/used', (req, res) => {
  const at = portalSession.touch();
  res.json({ ok: true, last_ok_at: at });
});

module.exports = router;
module.exports.isLocal = isLocal;
module.exports.leaseKey = leaseKey;
