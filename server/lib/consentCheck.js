'use strict';
// Consent-form signer check. The troop's consent form covers ONLY the
// person who signed it (decided 2026-09-01: form kept as-is; each adult who
// receives texts signs their own copy, adult-only info is fine). The app
// records consent_form.signed_by as free text, so this is a tolerant name
// match used to WARN (with an explicit admin override) when an opt-in is
// attached to a form somebody else signed, plus an audit over existing
// opt-ins. It never blocks silently and never auto-revokes anything.
const { db } = require('../db');

const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// true when signed_by plausibly names this person: contains their last name
// AND (first name OR nickname). Blank signer = cannot verify = mismatch.
function signerMatches(signedBy, person) {
  const s = norm(signedBy);
  if (!s || !person) return false;
  const last = norm(person.last_name), first = norm(person.first_name), nick = norm(person.nickname);
  if (!last || !s.includes(last)) return false;
  return (!!first && s.includes(first)) || (!!nick && s.includes(nick));
}

// Check a person against a stored form id. Returns null when fine, else
// {signed_by, person_name} for the 422 payload.
function mismatchFor(personId, formId) {
  if (!formId) return null;
  const form = db.prepare('SELECT signed_by FROM consent_form WHERE id = ?').get(formId);
  const p = db.prepare('SELECT first_name, last_name, nickname FROM person WHERE id = ?').get(personId);
  if (!form || !p) return null; // existence is validated by the caller
  if (signerMatches(form.signed_by, p)) return null;
  return { signed_by: form.signed_by || '', person_name: `${p.first_name} ${p.last_name}` };
}

// Audit: every current opt-in whose form signer doesn't match the opted-in
// adult (youth↔guardian links and adult self-consent), oldest first.
function audit() {
  const rows = [];
  for (const l of db.prepare(
    `SELECT pg.youth_id, pg.guardian_id, pg.consent_form_id,
            y.first_name AS y_first, y.last_name AS y_last,
            g.first_name, g.last_name, g.nickname, cf.signed_by, cf.file_path
       FROM person_guardian pg
       JOIN person y ON y.id = pg.youth_id AND y.status != 'merged'
       JOIN person g ON g.id = pg.guardian_id AND g.status != 'merged'
       LEFT JOIN consent_form cf ON cf.id = pg.consent_form_id
      WHERE pg.sms_opt_in = 'yes'
      ORDER BY g.last_name, g.first_name, y.last_name, y.first_name`).all()) {
    if (signerMatches(l.signed_by, l)) continue;
    rows.push({
      kind: 'guardian', guardian_id: l.guardian_id, youth_id: l.youth_id,
      guardian_name: `${l.first_name} ${l.last_name}`, youth_name: `${l.y_first} ${l.y_last}`,
      signed_by: l.signed_by || '', form: l.file_path || '',
      reason: l.consent_form_id ? (l.signed_by ? 'signer does not match guardian' : 'form has no signer recorded') : 'no form attached',
    });
  }
  for (const a of db.prepare(
    `SELECT p.id, p.first_name, p.last_name, p.nickname, p.consent_form_id, cf.signed_by, cf.file_path
       FROM person p LEFT JOIN consent_form cf ON cf.id = p.consent_form_id
      WHERE p.is_youth = 0 AND p.status != 'merged' AND p.sms_opt_in = 'yes'
      ORDER BY p.last_name, p.first_name`).all()) {
    if (signerMatches(a.signed_by, a)) continue;
    rows.push({
      kind: 'adult', guardian_id: a.id, youth_id: null,
      guardian_name: `${a.first_name} ${a.last_name}`, youth_name: '',
      signed_by: a.signed_by || '', form: a.file_path || '',
      reason: a.consent_form_id ? (a.signed_by ? 'signer does not match adult' : 'form has no signer recorded') : 'no form attached',
    });
  }
  return rows;
}

module.exports = { signerMatches, mismatchFor, audit };
