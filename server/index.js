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

// ---- first-run setup gate --------------------------------------------------
// Unconfigured instance (no .env AND no staff — see lib/setupState): every
// page redirects to the /setup wizard and every API call (except the setup
// API and /healthz) answers 503, so nothing is usable until configured.
// Configured instance (every existing install, incl. the Pi): this gate is a
// single latched-boolean check per request, /setup permanently redirects
// home, and nothing else changes.
const setupState = require('./lib/setupState');
const SETUP_ALLOWED = new Set(['/setup', '/setup.html', '/healthz', '/styles.css', '/theme.css',
  '/icon-192.png', '/icon-512.png', '/favicon.ico']);
app.use((req, res, next) => {
  if (setupState.isConfigured()) {
    if (req.path === '/setup' || req.path === '/setup.html') return res.redirect('/');
    return next();
  }
  if (SETUP_ALLOWED.has(req.path) || req.path.startsWith('/api/setup')) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(503).json({ error: 'This instance is not configured yet — open /setup in a browser.' });
  }
  return res.redirect('/setup');
});
app.use('/api/setup', require('./routes/setup'));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'setup.html')));

// public branding — keeps troop identity out of the source (shareability)
app.get('/api/config', (req, res) => {
  res.json({
    troop_id: env.TROOP_ID, troop_name: env.TROOP_NAME, ical_configured: !!env.ICAL_URL,
    theme: env.THEME,
  });
});
// theme palette as CSS variables, loaded after styles.css — the 'traillife'
// default emits exactly the values already in styles.css (pixel-identical)
const theme = require('./lib/theme');
app.get('/theme.css', (req, res) => {
  res.type('text/css').set('Cache-Control', 'no-cache').send(theme.themeCss());
});
app.get('/manifest.webmanifest', (req, res) => {
  const brand = theme.palette()['pine'];
  res.json({
    name: `${env.TROOP_ID} ${env.TROOP_NAME}`,
    short_name: env.TROOP_ID,
    start_url: '/',
    display: 'standalone',
    background_color: brand,
    theme_color: brand,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
});

app.use('/api/sms', require('./routes/sms')); // Twilio webhook — signature-authed, no session
app.use('/api/admin', admin);
app.use('/api', api);

// signature images and photos require a session
const sessionGate = (req, res, next) => {
  if (!auth.sessionFromRequest(req)) return res.status(401).send('Not signed in.');
  next();
};
app.use('/signatures', sessionGate, express.static(SIG_DIR));
app.use('/photos', sessionGate, express.static(require('path').join(require('./db').DATA_DIR, 'photos')));
app.use('/consent-forms', sessionGate, express.static(require('path').join(require('./db').DATA_DIR, 'consent-forms')));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true });
});

module.exports = app;

if (require.main === module) {
  // fail fast: a corrupt/empty core module must refuse to start the service,
  // not boot "healthy" and crash later on the code path (see lib/selfcheck.js)
  require('./lib/selfcheck').selfCheckOrExit();
  setInterval(auth.pruneSessions, 60 * 60 * 1000).unref();
  icalSync.scheduleNightly();
  require('./lib/backup').scheduleNightly(); // in-process nightly (SCHEDULE_BACKUP=off disables)
  require('./lib/syncRunner').scheduleWeekly(); // no-op unless SCHEDULE_ROSTER_SYNC=weekly
  require('./lib/notifySweep').scheduleSweep(); // no-op unless SMS_ENABLED=true
  require('./lib/attendanceSync').scheduleSweep(); // TLC write-back — no-op while queue is empty/disabled
  app.listen(PORT, () => console.log(`troop-checkin listening on :${PORT}`));
}
