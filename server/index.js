'use strict';
const env = require('./lib/env'); // load .env before anything reads process.env
const fs = require('fs');
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
  '/icon-192.png', '/icon-512.png', '/favicon.ico', '/icon.svg', '/apple-touch-icon.png']);
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
    // member-portal display labels ("Trail Life Connect"/"TLC" or "AHGfamily")
    // — public/portal.js relabels static wording from this
    portal: require('./lib/portal').label(),
    // kiosk health-form badge switch (admin-set, default off; not sensitive)
    flag_health_forms: require('./lib/healthForms').getCheckinFlags().health_form,
    // permission-form tracking switch — the kiosk banner keys off this
    permission_forms_enabled: require('./lib/permissionSync').getSettings().enabled,
    // who gets texted per youth: 'primary' (one guardian) or 'all' opted-in —
    // the kiosk broadcast dialog defaults its choice to this
    sms_recipients: require('./lib/notifySweep').getRecipientMode(),
  });
});
// theme palette as CSS variables, loaded after styles.css — the 'traillife'
// default emits exactly the values already in styles.css (pixel-identical)
const theme = require('./lib/theme');
app.get('/theme.css', (req, res) => {
  res.type('text/css').set('Cache-Control', 'no-cache').send(theme.themeCss());
});
// The app mark, themed from the same palette — served dynamically for the
// same reason /theme.css is: one build, many instances. /favicon.ico stays
// as the fallback for browsers that cannot use an SVG favicon.
app.get('/icon.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(theme.iconSvg());
});
// The same mark as PNG, for the places that cannot take an SVG: iOS home
// screens (apple-touch-icon is PNG-only) and any launcher that skips the
// manifest's SVG entry. These shadow the committed public/*.png of the same
// name — that file is the fallback if rasterizing ever throws, and stays the
// provenance of the geometry.
const iconPng = require('./lib/iconPng');
const PNG_SIZES = { '/apple-touch-icon.png': 180, '/icon-192.png': 192, '/icon-512.png': 512 };
app.get(Object.keys(PNG_SIZES), (req, res, next) => {
  const p = theme.palette();
  try {
    res.type('image/png').set('Cache-Control', 'no-cache')
      .send(iconPng.iconPng(PNG_SIZES[req.path], p.pine, p.paper));
  } catch (e) {
    next(); // fall through to the static file rather than serve a broken icon
  }
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
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
});

// theme-color paints the browser's OWN chrome on a phone — the address-bar
// and nav-bar tint, and the status bar of an installed app. It is a <meta>
// tag with no CSS equivalent, so it cannot ride along in /theme.css: the two
// pages that carry one are served with the palette's brand color patched in.
// Without this a themed instance shows the default preset's green above its
// own blue UI, which is the lookalike problem again in a different place.
const THEMED_PAGES = { '/': 'index.html', '/index.html': 'index.html', '/admin.html': 'admin.html' };
const pageSource = new Map();
app.get(Object.keys(THEMED_PAGES), (req, res, next) => {
  const file = THEMED_PAGES[req.path];
  try {
    if (!pageSource.has(file)) {
      pageSource.set(file, fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'));
    }
    const html = pageSource.get(file)
      .replace(/(<meta name="theme-color" content=")#[0-9A-Fa-f]{6}(">)/, `$1${theme.palette().pine}$2`);
    res.type('html').set('Cache-Control', 'no-cache').send(html);
  } catch (e) {
    next(); // unreadable for any reason — let express.static answer as before
  }
});

app.use('/api/sms', require('./routes/sms')); // Twilio webhook — signature-authed, no session
// Integration API — Bearer API key, no session (docs/13-integration-api.md);
// 401 on everything until enabled + a key exists (Admin → Integrations)
app.use('/api/integration', require('./routes/integration'));
// Portal session lease — loopback-only, own key, 404 unless PORTAL_LEASE_KEY
// is set. Lets another program on this Pi reuse the signed-in portal session
// instead of signing in itself and texting a human a code (routes/portalLease).
app.use('/api/portal-lease', require('./routes/portalLease'));
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
  require('./lib/permissionSync').scheduleJobs(); // permission-form sync — no-op until the admin switch is on
  require('./lib/webhook').scheduleSweep(); // integration webhook deliveries — no-op while disabled
  try { require('./lib/attendanceSync').backfillFromBadges(); } // badges carry TLC hashids — fill empty mappings
  catch (e) { console.error('[tlc-attendance] badge backfill failed:', e.message); }
  app.listen(PORT, () => console.log(`troop-checkin listening on :${PORT}`));
}
