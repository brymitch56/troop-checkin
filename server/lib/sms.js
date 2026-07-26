'use strict';
// Twilio SMS — deliberately zero-dependency (plain REST + HMAC), keeps the
// Pi install lean. Everything is inert unless SMS_ENABLED=true AND the three
// TWILIO_* values are set in .env.
const crypto = require('crypto');
const env = require('./env');

const configured = () =>
  env.SMS_ENABLED && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER;

// last-10-digits normalization for US numbers ("(555) 010-2345" == "+15550102345")
const normPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);
// Twilio wants E.164
const e164 = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return d ? `+${d}` : '';
};

// Returns { sid } on success; throws with Twilio's error message on failure.
// When PUBLIC_URL is set, Twilio posts delivery updates to /api/sms/status.
async function send(to, body) {
  if (!configured()) throw new Error('SMS is not configured (SMS_ENABLED / TWILIO_* in .env).');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const params = { From: env.TWILIO_FROM_NUMBER, To: e164(to), Body: body };
  if (env.PUBLIC_URL) params.StatusCallback = `${env.PUBLIC_URL}/api/sms/status`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Twilio error ${res.status}`);
  return { sid: data.sid };
}

// X-Twilio-Signature check: base64(HMAC-SHA1(authToken, url + sortedKey+value...))
// https://www.twilio.com/docs/usage/security#validating-requests
function validateSignature(signature, url, params) {
  if (!env.TWILIO_AUTH_TOKEN) return false;
  let data = url;
  for (const key of Object.keys(params || {}).sort()) data += key + params[key];
  const expected = crypto.createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(signature || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { configured, send, validateSignature, normPhone, e164 };
