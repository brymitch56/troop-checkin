'use strict';
const path = require('path');
const express = require('express');
const { db, SIG_DIR } = require('./db');
const auth = require('./auth');
const api = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
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
  app.listen(PORT, () => console.log(`troop-checkin listening on :${PORT}`));
}
