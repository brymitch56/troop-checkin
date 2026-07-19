'use strict';
const crypto = require('crypto');
const { db } = require('./db');

const SESSION_HOURS = { door: 6, admin: 2 };
const COOKIE = 'tcsession';

// -- scrypt credential hashing (no native deps beyond Node itself) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(secret), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifySecret(secret, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, keyHex] = parts;
  const key = crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'), keyHex.length / 2, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// -- sessions ---------------------------------------------------------------
function createSession(staffId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const hours = SESSION_HOURS[role] || 2;
  db.prepare(
    `INSERT INTO session (token, staff_id, expires_at)
     VALUES (?, ?, datetime('now', ?))`
  ).run(token, staffId, `+${hours} hours`);
  return token;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM session WHERE token = ?').run(token);
}

function readCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionFromRequest(req) {
  const token = readCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.token, s.staff_id, st.name, st.role
       FROM session s JOIN staff st ON st.id = s.staff_id
      WHERE s.token = ? AND s.expires_at > datetime('now') AND st.active = 1`
  ).get(token);
  if (!row) return null;
  db.prepare(`UPDATE session SET last_seen_at = datetime('now') WHERE token = ?`).run(token);
  return row;
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// -- middleware -------------------------------------------------------------
function requireAuth(role) {
  return (req, res, next) => {
    const sess = sessionFromRequest(req);
    if (!sess) return res.status(401).json({ error: 'Not signed in.' });
    if (role === 'admin' && sess.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    req.staff = sess;
    next();
  };
}

// housekeeping: drop expired sessions occasionally
function pruneSessions() {
  db.prepare(`DELETE FROM session WHERE expires_at <= datetime('now')`).run();
}

module.exports = {
  hashSecret, verifySecret,
  createSession, destroySession, sessionFromRequest,
  setSessionCookie, clearSessionCookie,
  requireAuth, pruneSessions, COOKIE,
};
