'use strict';
const env = require('./lib/env'); // load .env before anything reads process.env
const path = require('path');
const express = require('express');
const { db, SIG_DIR } = require('./db');
const auth = require('./auth');
const api = require('./routes/api');
const admin = require('./routes/admin');
const icalSync = require('./lib/icalSync');

const app = express();
const PORT = env.PORT;

app.disable('x-powered-by');
// behind the Cloudflare Tunnel the proxy runs on this host; trust it so
// req.secure reflects the real scheme and session cookies get `Secure`
app.set('trust proxy', 'loopback');

// public branding — keeps troop identity out of the source (shareability)
app.get('/api/config', (req, res) => {
  res.json({ troop_id: env.TROOP_ID, troop_name: env.TROOP_NAME, ical_configured: !!env.ICAL_URL });
});
app.get('/manifest.webmanifest', (req, res) => {
  res.json({
    name: `${env.TROOP_ID} ${env.TROOP_NAME}`,
    short_name: env.TROOP_ID,
    start_url: '/',
    display: 'standalone',
    background_color: '#17402C',
    theme_color: '#17402C',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
});

app.use('/api/admin', admin);
app.use('/api', api);

// signature images require a session
app.use('/signatures', (req, res, next) => {
  if (!auth.sessionFromRequest(req)) return res.status(401).send('Not signed in.');
  next();
}, express.static(SIG_DIR));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

module.exports = app;

if (require.main === module) {
  setInterval(auth.pruneSessions, 60 * 60 * 1000).unref();
  icalSync.scheduleNightly();
  require('./lib/backup').scheduleNightly();
  require('./lib/notifySweep').scheduleSweep(); // no-op unless SMS_ENABLED=true
  app.listen(PORT, () => console.log(`troop-checkin listening on :${PORT}`));
}
