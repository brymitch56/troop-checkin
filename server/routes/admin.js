'use strict';
// Admin API (Phase 2). Everything here requires an admin session; when the
// tunnel goes live these routes get Cloudflare Access on top (see docs).
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db, DATA_DIR } = require('../db');
const auth = require('../auth');
const icalSync = require('../lib/icalSync');

const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const CONSENT_DIR = path.join(DATA_DIR, 'consent-forms');
fs.mkdirSync(CONSENT_DIR, { recursive: true });
const consentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const router = express.Router();
router.use(auth.requireAuth('admin'));
router.use(express.json());

// ------------------------------------------------------------------ csv ----
function sendCsv(res, filename, header, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body + '\r\n');
}

// --------------------------------------------------------------- people ----
router.get('/people', (req, res) => {
  const q = String(req.query.q || '').trim();
  const type = req.query.type; // youth | adult
  const status = req.query.status; // active | inactive | visitor
  const like = `%${q}%`;
  const rows = db.prepare(
    `SELECT id, is_youth, member_id, first_name, last_name, nickname, patrol, level,
            role, status, badge_code IS NOT NULL AS has_badge
       FROM person
      WHERE status != 'merged'
        AND (? = '' OR first_name LIKE ? OR last_name LIKE ? OR nickname LIKE ? OR member_id LIKE ?)
        AND (? IS NULL OR (? = 'youth') = (is_youth = 1))
        AND (? IS NULL OR status = ?)
      ORDER BY is_youth DESC, last_name, first_name LIMIT 500`
  ).all(q, like, like, like, like, type || null, type || null, status || null, status || null);
  res.json(rows);
});

router.get('/people/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM person WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No such person.' });
  const guardians = p.is_youth ? db.prepare(
    `SELECT g.id, g.first_name, g.last_name, g.phone_mobile, g.email,
            pg.relationship, pg.authorized, pg.is_primary, pg.source,
            pg.sms_opt_in, pg.consent_form_id,
            cf.signed_by AS consent_signed_by, cf.file_path AS consent_file
       FROM person_guardian pg
       JOIN person g ON g.id = pg.guardian_id
       LEFT JOIN consent_form cf ON cf.id = pg.consent_form_id
      WHERE pg.youth_id = ? AND g.status != 'merged'
      ORDER BY pg.is_primary DESC, g.last_name`).all(p.id) : [];
  const wards = !p.is_youth ? db.prepare(
    `SELECT y.id, y.first_name, y.last_name, y.patrol, pg.authorized, pg.is_primary
       FROM person_guardian pg JOIN person y ON y.id = pg.youth_id
      WHERE pg.guardian_id = ? AND y.status != 'merged'
      ORDER BY y.last_name`).all(p.id) : [];
  res.json({ ...p, guardians, wards });
});

const PERSON_FIELDS = ['first_name', 'last_name', 'nickname', 'role', 'patrol', 'level',
  'email', 'phone_mobile', 'phone_home', 'phone_work', 'birthdate', 'membership_expires',
  'health_form_date', 'high_risk_form_date', 'notes', 'tlc_user_id'];
const IMPORT_FIELDS = new Set(require('../lib/rosterImport').UPDATABLE);
router.patch('/people/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM person WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No such person.' });
  const b = req.body || {};
  // TLC user id: the hand-set mapping is authoritative for the attendance
  // write-back, so validate the shape and refuse an id another person holds
  if ('tlc_user_id' in b && b.tlc_user_id) {
    if (!/^[a-z0-9]{8,16}$/i.test(String(b.tlc_user_id))) {
      return res.status(400).json({ error: 'A TLC user id is 8–16 letters/digits (copy it from the lookup below or a TLC profile URL).' });
    }
    const holder = db.prepare(
      `SELECT first_name, last_name FROM person WHERE tlc_user_id = ? AND id != ? AND status != 'merged'`
    ).get(b.tlc_user_id, p.id);
    if (holder) {
      return res.status(409).json({ error: `That TLC id is already assigned to ${holder.first_name} ${holder.last_name} — clear it there first.` });
    }
  }
  const sets = [], vals = [];
  let locked = [];
  try { locked = JSON.parse(p.manual_fields || '[]'); } catch { /* ignore */ }
  const lockedSet = new Set(locked);
  for (const f of PERSON_FIELDS) {
    if (!(f in b)) continue;
    const nv = b[f] === '' ? null : b[f];
    sets.push(`${f} = ?`); vals.push(nv);
    // hand-edited import fields become locked: future imports won't touch them
    if (IMPORT_FIELDS.has(f) && nv !== (p[f] == null ? null : p[f])) lockedSet.add(f);
  }
  if ('status' in b) {
    if (!['active', 'inactive', 'visitor'].includes(b.status)) {
      return res.status(400).json({ error: 'Bad status.' });
    }
    sets.push('status = ?'); vals.push(b.status);
  }
  if (b.clear_manual) lockedSet.clear(); // "let imports manage this person again"
  if (!sets.length && !b.clear_manual) return res.status(400).json({ error: 'Nothing to update.' });
  sets.push('manual_fields = ?'); vals.push(lockedSet.size ? JSON.stringify([...lockedSet]) : null);
  db.prepare(`UPDATE person SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...vals, p.id);
  res.json(db.prepare('SELECT * FROM person WHERE id = ?').get(p.id));
});

// Youth photo for pickup confirmation (Phase 5). Stored under data/ with the
// rest of the PII; served session-gated at /photos/<file>.
router.post('/people/:id/photo', photoUpload.single('photo'), (req, res) => {
  const p = db.prepare('SELECT * FROM person WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No such person.' });
  if (!req.file || !/^image\/(jpeg|png|webp)$/.test(req.file.mimetype)) {
    return res.status(400).json({ error: 'Attach a JPEG/PNG/WebP photo.' });
  }
  const ext = req.file.mimetype === 'image/png' ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
  const name = `${p.id}.${ext}`;
  if (p.photo_path) fs.rmSync(path.join(PHOTO_DIR, p.photo_path), { force: true });
  fs.writeFileSync(path.join(PHOTO_DIR, name), req.file.buffer);
  db.prepare(`UPDATE person SET photo_path = ?, updated_at = datetime('now') WHERE id = ?`).run(name, p.id);
  res.json({ ok: true, photo_path: name });
});
router.delete('/people/:id/photo', (req, res) => {
  const p = db.prepare('SELECT * FROM person WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No such person.' });
  if (p.photo_path) fs.rmSync(path.join(PHOTO_DIR, p.photo_path), { force: true });
  db.prepare(`UPDATE person SET photo_path = NULL, updated_at = datetime('now') WHERE id = ?`).run(p.id);
  res.json({ ok: true });
});

// ------------------------------------------------- guardians / authorized ----
// Admin edits are authoritative: imports never overwrite or duplicate them.
router.post('/people/:youthId/guardians', (req, res) => {
  const { guardian_id, relationship, authorized, is_primary } = req.body || {};
  const youth = db.prepare('SELECT * FROM person WHERE id = ? AND is_youth = 1').get(req.params.youthId);
  const adult = db.prepare('SELECT * FROM person WHERE id = ? AND is_youth = 0').get(guardian_id);
  if (!youth || !adult) return res.status(400).json({ error: 'Youth and adult are required.' });
  const existing = db.prepare(
    'SELECT 1 FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').get(youth.id, adult.id);
  if (existing) return res.status(409).json({ error: 'Already linked — edit the existing entry.' });
  if (is_primary) {
    db.prepare('UPDATE person_guardian SET is_primary = 0 WHERE youth_id = ?').run(youth.id);
  }
  db.prepare(
    `INSERT INTO person_guardian (youth_id, guardian_id, relationship, authorized, is_primary, source)
     VALUES (?, ?, ?, ?, ?, 'manual')`
  ).run(youth.id, adult.id, relationship || null, authorized === false ? 0 : 1, is_primary ? 1 : 0);
  res.json({ ok: true });
});

// Consent-form designees: create a brand-new adult (not in any roster export)
// and link them as an authorized pickup in one step. They'll never be touched
// by imports (no member number) and the link is source='manual'.
router.post('/people/:youthId/guardians/new', (req, res) => {
  const { first_name, last_name, phone_mobile, relationship, is_primary } = req.body || {};
  const youth = db.prepare('SELECT * FROM person WHERE id = ? AND is_youth = 1').get(req.params.youthId);
  if (!youth) return res.status(404).json({ error: 'No such youth.' });
  if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name are required.' });
  const run = db.transaction(() => {
    const a = db.prepare(
      `INSERT INTO person (is_youth, first_name, last_name, phone_mobile, status, notes)
       VALUES (0, ?, ?, ?, 'active', 'Added as authorized pickup (consent form)')`
    ).run(String(first_name).trim(), String(last_name).trim(), phone_mobile || null);
    const adultId = Number(a.lastInsertRowid);
    if (is_primary) db.prepare('UPDATE person_guardian SET is_primary = 0 WHERE youth_id = ?').run(youth.id);
    db.prepare(
      `INSERT INTO person_guardian (youth_id, guardian_id, relationship, authorized, is_primary, source)
       VALUES (?, ?, ?, 1, ?, 'manual')`
    ).run(youth.id, adultId, relationship || null, is_primary ? 1 : 0);
    return adultId;
  });
  res.json({ ok: true, guardian_id: run() });
});

// Family setup in one shot: apply a guardian (existing or brand-new adult) to
// MULTIPLE youth at once — link, relationship, primary, and SMS opt-in with
// its consent form. One signed family form covers all the pairs it names.
router.post('/guardian-bulk', (req, res) => {
  const b = req.body || {};
  const youthIds = Array.isArray(b.youth_ids) ? b.youth_ids.map(Number).filter(Boolean) : [];
  if (!youthIds.length) return res.status(400).json({ error: 'Select at least one youth.' });
  if (b.opt_in && !b.consent_form_id) {
    return res.status(422).json({ error: 'Opt-in requires attaching the signed consent form.' });
  }
  if (b.consent_form_id && !db.prepare('SELECT 1 FROM consent_form WHERE id = ?').get(b.consent_form_id)) {
    return res.status(400).json({ error: 'No such consent form.' });
  }
  const youths = youthIds.map((id) =>
    db.prepare(`SELECT * FROM person WHERE id = ? AND is_youth = 1 AND status != 'merged'`).get(id));
  if (youths.some((y) => !y)) return res.status(400).json({ error: 'One of the selected youth was not found.' });

  const run = db.transaction(() => {
    // resolve the adult
    let guardianId = b.guardian_id ? Number(b.guardian_id) : null;
    if (!guardianId) {
      const ng = b.new_guardian || {};
      if (!ng.first_name || !ng.last_name) throw Object.assign(new Error('Guardian first and last name are required.'), { code: 400 });
      const r = db.prepare(
        `INSERT INTO person (is_youth, first_name, last_name, phone_mobile, status, notes)
         VALUES (0, ?, ?, ?, 'active', 'Added as authorized pickup (consent form)')`
      ).run(String(ng.first_name).trim(), String(ng.last_name).trim(), ng.phone_mobile || null);
      guardianId = Number(r.lastInsertRowid);
    } else if (!db.prepare(`SELECT 1 FROM person WHERE id = ? AND is_youth = 0 AND status != 'merged'`).get(guardianId)) {
      throw Object.assign(new Error('No such adult.'), { code: 400 });
    }
    const results = [];
    for (const y of youths) {
      const existing = db.prepare(
        'SELECT * FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').get(y.id, guardianId);
      if (b.is_primary) db.prepare('UPDATE person_guardian SET is_primary = 0 WHERE youth_id = ?').run(y.id);
      if (existing) {
        db.prepare(
          `UPDATE person_guardian SET authorized = 1, source = 'manual',
                  relationship = COALESCE(?, relationship),
                  is_primary = CASE WHEN ? THEN 1 ELSE is_primary END,
                  sms_opt_in = CASE WHEN ? THEN 'yes' ELSE sms_opt_in END,
                  consent_form_id = COALESCE(?, consent_form_id)
            WHERE youth_id = ? AND guardian_id = ?`
        ).run(b.relationship || null, b.is_primary ? 1 : 0, b.opt_in ? 1 : 0,
              b.consent_form_id || null, y.id, guardianId);
        results.push({ youth_id: y.id, action: 'updated' });
      } else {
        db.prepare(
          `INSERT INTO person_guardian (youth_id, guardian_id, relationship, authorized, is_primary,
                                        source, sms_opt_in, consent_form_id)
           VALUES (?, ?, ?, 1, ?, 'manual', ?, ?)`
        ).run(y.id, guardianId, b.relationship || null, b.is_primary ? 1 : 0,
              b.opt_in ? 'yes' : 'unknown', b.consent_form_id || null);
        results.push({ youth_id: y.id, action: 'linked' });
      }
    }
    return { guardian_id: guardianId, results };
  });
  try {
    const out = run();
    res.json({ ok: true, ...out, applied: out.results.length });
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

// Adult SELF-consent for SMS (person.sms_opt_in, migration 010) — the
// admin-editable counterpart of the per-pair youth consent below, with the
// same rule: opting in requires a stored signed consent form. Youth consent
// never lives here; it stays on the person_guardian link.
router.patch('/people/:id/opt-in', (req, res) => {
  const p = db.prepare(`SELECT * FROM person WHERE id = ? AND status != 'merged'`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No such person.' });
  if (p.is_youth) {
    return res.status(409).json({ error: 'Youth messaging consent is per guardian link — set it in the Guardians section.' });
  }
  const b = req.body || {};
  const sets = [], vals = [];
  if ('consent_form_id' in b) {
    if (b.consent_form_id && !db.prepare('SELECT 1 FROM consent_form WHERE id = ?').get(b.consent_form_id)) {
      return res.status(400).json({ error: 'No such consent form.' });
    }
    sets.push('consent_form_id = ?'); vals.push(b.consent_form_id || null);
  }
  if ('sms_opt_in' in b) {
    if (!['unknown', 'yes', 'stop'].includes(b.sms_opt_in)) {
      return res.status(400).json({ error: 'Bad sms_opt_in value.' });
    }
    const formAfter = 'consent_form_id' in b ? b.consent_form_id : p.consent_form_id;
    if (b.sms_opt_in === 'yes' && !formAfter) {
      return res.status(422).json({ error: 'Opt-in requires attaching the signed consent form first.' });
    }
    sets.push('sms_opt_in = ?'); vals.push(b.sms_opt_in);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  db.prepare(`UPDATE person SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...vals, p.id);
  res.json({ ok: true });
});

router.patch('/people/:youthId/guardians/:guardianId', (req, res) => {
  const { youthId, guardianId } = req.params;
  const link = db.prepare(
    'SELECT * FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').get(youthId, guardianId);
  if (!link) return res.status(404).json({ error: 'No such link.' });
  const b = req.body || {};
  const sets = [], vals = [];
  if ('authorized' in b) { sets.push('authorized = ?'); vals.push(b.authorized ? 1 : 0); }
  if ('relationship' in b) { sets.push('relationship = ?'); vals.push(b.relationship || null); }
  if ('is_primary' in b) {
    if (b.is_primary) db.prepare('UPDATE person_guardian SET is_primary = 0 WHERE youth_id = ?').run(youthId);
    sets.push('is_primary = ?'); vals.push(b.is_primary ? 1 : 0);
  }
  if ('consent_form_id' in b) {
    if (b.consent_form_id && !db.prepare('SELECT 1 FROM consent_form WHERE id = ?').get(b.consent_form_id)) {
      return res.status(400).json({ error: 'No such consent form.' });
    }
    sets.push('consent_form_id = ?'); vals.push(b.consent_form_id || null);
  }
  if ('sms_opt_in' in b) {
    if (!['unknown', 'yes', 'stop'].includes(b.sms_opt_in)) {
      return res.status(400).json({ error: 'Bad sms_opt_in value.' });
    }
    // opting in requires a stored signed consent form on this pair
    const formAfter = 'consent_form_id' in b ? b.consent_form_id : link.consent_form_id;
    if (b.sms_opt_in === 'yes' && !formAfter) {
      return res.status(422).json({ error: 'Opt-in requires attaching the signed consent form first.' });
    }
    sets.push('sms_opt_in = ?'); vals.push(b.sms_opt_in);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  // any admin edit becomes authoritative
  sets.push(`source = 'manual'`);
  db.prepare(`UPDATE person_guardian SET ${sets.join(', ')} WHERE youth_id = ? AND guardian_id = ?`)
    .run(...vals, youthId, guardianId);
  res.json({ ok: true });
});

router.delete('/people/:youthId/guardians/:guardianId', (req, res) => {
  const { youthId, guardianId } = req.params;
  const link = db.prepare(
    'SELECT * FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').get(youthId, guardianId);
  if (!link) return res.status(404).json({ error: 'No such link.' });
  if (link.source !== 'manual') {
    // deleting an import link would just come back on re-import; unauthorize instead
    return res.status(409).json({
      error: 'This link came from a roster import — mark it Not Authorized instead of deleting (deletions would reappear on the next import).',
    });
  }
  db.prepare('DELETE FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').run(youthId, guardianId);
  res.json({ ok: true });
});

// --------------------------------------------------------------- events ----
router.get('/events', (req, res) => {
  // Default: current + future only, soonest first. Past (day-granular: an
  // event isn't past until its finish date's day has ended) via ?include_past=1.
  const includePast = req.query.include_past === '1';
  const rows = db.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM txn t WHERE t.event_id = e.id) AS txn_count,
            local_date(e.end_at) < local_date('now') AS is_past
       FROM event e
      WHERE ? OR local_date(e.end_at) >= local_date('now')
      ORDER BY is_past ASC,
               CASE WHEN is_past THEN NULL ELSE datetime(start_at) END ASC,
               datetime(start_at) DESC
      LIMIT 1000`).all(includePast ? 1 : 0);
  // resolve + cache TLC event links lazily so the editor shows the real
  // "linked" status even before the first attendance push
  const aSync = require('../lib/attendanceSync');
  for (const r of rows) {
    if (!r.tlc_event_id && r.source === 'ical') r.tlc_event_id = aSync.resolveTlcEventId(r);
  }
  res.json(rows);
});

router.patch('/events/:id', (req, res) => {
  const ev = db.prepare('SELECT * FROM event WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'No such event.' });
  const b = req.body || {};
  const sets = [], vals = [];
  for (const f of ['title', 'location', 'description', 'start_at', 'end_at']) {
    if (f in b) { sets.push(`${f} = ?`); vals.push(b[f] || null); }
  }
  for (const f of ['track_adults', 'all_day', 'requires_high_adventure_form', 'permission_block']) {
    if (f in b) { sets.push(`${f} = ?`); vals.push(b[f] ? 1 : 0); }
  }
  // permission-form requirement: an admin edit takes the flag over from the
  // sweep ('manual' wins forever); sending permission_form_source:'auto'
  // hands it back to auto-detection untouched-until-next-sweep
  if ('requires_permission_form' in b) {
    sets.push('requires_permission_form = ?', `permission_form_source = 'manual'`);
    vals.push(b.requires_permission_form ? 1 : 0);
  } else if (b.permission_form_source === 'auto') {
    sets.push(`permission_form_source = 'auto'`);
  }
  if ('notify_after_min' in b) { sets.push('notify_after_min = ?'); vals.push(b.notify_after_min ?? null); }
  // TLC write-back override: null = follow the global setting, 0 = never, 1 = always
  if ('tlc_push' in b) {
    sets.push('tlc_push = ?');
    vals.push(b.tlc_push === null || b.tlc_push === '' ? null : (b.tlc_push ? 1 : 0));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  db.prepare(`UPDATE event SET ${sets.join(', ')} WHERE id = ?`).run(...vals, ev.id);
  res.json(db.prepare('SELECT * FROM event WHERE id = ?').get(ev.id));
});

// ------------------------------------------- permission forms (per event) ----
const permSync = require('../lib/permissionSync');

router.get('/permission-forms', (req, res) => {
  res.json(permSync.getSettings());
});
router.put('/permission-forms', (req, res) => {
  res.json(permSync.saveSettings(req.body || {}));
});

// Per-event status: requirement + per-youth signed list, with fetched_at
// (staleness stays visible — parents sign at the last minute).
router.get('/events/:id/form-status', (req, res) => {
  const ev = db.prepare('SELECT * FROM event WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'No such event.' });
  const youth = db.prepare(
    `SELECT p.id, p.first_name, p.last_name, p.nickname, p.patrol,
            fs.signed, fs.fetched_at, fs.source
       FROM event_form_status fs JOIN person p ON p.id = fs.person_id
      WHERE fs.event_id = ?
      ORDER BY fs.signed, p.last_name, p.first_name`).all(ev.id);
  res.json({
    required: !!ev.requires_permission_form,
    source: ev.permission_form_source,
    block: !!ev.permission_block,
    linked: !!ev.tlc_event_id,
    et_slug_known: !!ev.tlc_et_slug,
    fetched_at: permSync.lastFetchedAt(ev.id),
    enabled: permSync.getSettings().enabled === 1,
    youth,
  });
});

router.post('/events/:id/refresh-forms', async (req, res) => {
  try {
    const r = await permSync.refreshEvent(Number(req.params.id));
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Manual fallback: upload the event's participants export (RSVP roster)
// downloaded from TLC by hand — for when TLC is unreachable or automation
// breaks (e.g. MFA). Parsed with the same code as the sync.
const formStatusUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
router.post('/events/:id/form-upload', formStatusUpload.single('file'), (req, res) => {
  const ev = db.prepare('SELECT * FROM event WHERE id = ?').get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'No such event.' });
  if (!req.file) return res.status(400).json({ error: 'Attach the event participants xlsx.' });
  try {
    const stored = permSync.storeStatuses(ev.id, permSync.parseExport(req.file.buffer), 'upload');
    res.json({ ok: true, stored, fetched_at: permSync.lastFetchedAt(ev.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/events/:id', (req, res) => {
  const used = db.prepare('SELECT 1 FROM txn WHERE event_id = ? LIMIT 1').get(req.params.id);
  if (used) return res.status(409).json({ error: 'Event has transactions — it cannot be deleted.' });
  const r = db.prepare('DELETE FROM event WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'No such event.' });
  res.json({ ok: true });
});

router.post('/sync-ical', async (req, res) => {
  try { res.json(await icalSync.syncIcal()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ----------------------------------------------------------------- txns ----
router.get('/txns', (req, res) => {
  const { event_id, person_id, from, to } = req.query;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const rows = db.prepare(
    `SELECT t.id, t.direction, t.signed_at, t.forced, t.close_method, t.signature_path,
            t.voided_by_txn_id, t.signer_name_override,
            e.title AS event_title, e.id AS event_id,
            st.name AS staff_name,
            sg.first_name || ' ' || sg.last_name AS signer_name,
            (SELECT GROUP_CONCAT(p.first_name || ' ' || p.last_name, ' · ')
               FROM txn_person tp JOIN person p ON p.id = tp.person_id
              WHERE tp.txn_id = t.id) AS people
       FROM txn t
       JOIN event e ON e.id = t.event_id
       JOIN staff st ON st.id = t.staff_id
       LEFT JOIN person sg ON sg.id = t.signer_person_id
      WHERE (? IS NULL OR t.event_id = ?)
        AND (? IS NULL OR t.id IN (SELECT txn_id FROM txn_person WHERE person_id = ?))
        AND (? IS NULL OR datetime(t.signed_at) >= datetime(?))
        AND (? IS NULL OR datetime(t.signed_at) <= datetime(?))
      ORDER BY datetime(t.signed_at) DESC LIMIT ?`
  ).all(event_id || null, event_id || null, person_id || null, person_id || null,
        from || null, from || null, to || null, to || null, limit);
  res.json(rows);
});

router.get('/txns/:id', (req, res) => {
  const t = db.prepare(
    `SELECT t.*, e.title AS event_title, st.name AS staff_name,
            sg.first_name || ' ' || sg.last_name AS signer_name
       FROM txn t JOIN event e ON e.id = t.event_id JOIN staff st ON st.id = t.staff_id
       LEFT JOIN person sg ON sg.id = t.signer_person_id
      WHERE t.id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'No such transaction.' });
  t.entries = db.prepare(
    `SELECT tp.*, p.first_name, p.last_name, p.is_youth, p.patrol
       FROM txn_person tp JOIN person p ON p.id = tp.person_id
      WHERE tp.txn_id = ?`).all(t.id);
  res.json(t);
});

// Void = append-only correction: a new marker txn reverses the state effect
// of the original; the original row is never mutated beyond voided_by_txn_id.
router.post('/txns/:id/void', (req, res) => {
  const t = db.prepare('SELECT * FROM txn WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'No such transaction.' });
  if (t.voided_by_txn_id) return res.status(409).json({ error: 'Already voided.' });
  if (t.close_method === 'admin_close' && !t.signature_path && t.direction === 'out') {
    // fine — admin closes are voidable like any other txn
  }
  const entries = db.prepare('SELECT * FROM txn_person WHERE txn_id = ?').all(t.id);
  const run = db.transaction(() => {
    const v = db.prepare(
      `INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id, close_method)
       VALUES (?, ?, ?, ?, ?, 'admin_close')`
    ).run(`void-${t.id}-${Date.now()}`, t.event_id, t.direction, new Date().toISOString(), req.staff.staff_id);
    const voidId = Number(v.lastInsertRowid);
    for (const e of entries) {
      db.prepare(`INSERT INTO txn_person (txn_id, person_id, open, in_txn_id) VALUES (?, ?, 0, ?)`)
        .run(voidId, e.person_id, t.id);
      if (t.direction === 'in') {
        // voiding a sign-in closes its open rows
        db.prepare('UPDATE txn_person SET open = 0 WHERE txn_id = ? AND person_id = ?').run(t.id, e.person_id);
      } else if (e.in_txn_id) {
        // voiding a sign-out re-opens the original sign-in (unless that one is voided)
        const inTxn = db.prepare('SELECT voided_by_txn_id FROM txn WHERE id = ?').get(e.in_txn_id);
        if (inTxn && !inTxn.voided_by_txn_id) {
          db.prepare('UPDATE txn_person SET open = 1 WHERE txn_id = ? AND person_id = ?').run(e.in_txn_id, e.person_id);
        }
      }
    }
    db.prepare('UPDATE txn SET voided_by_txn_id = ? WHERE id = ?').run(voidId, t.id);
    return voidId;
  });
  res.json({ ok: true, void_txn_id: run() });
});

// Close a lingering open sign-in without a guardian present (audited).
router.post('/close-open', (req, res) => {
  const { person_id } = req.body || {};
  const open = db.prepare(
    `SELECT tp.txn_id AS in_txn_id, t.event_id
       FROM txn_person tp JOIN txn t ON t.id = tp.txn_id
      WHERE tp.person_id = ? AND tp.open = 1 AND t.voided_by_txn_id IS NULL LIMIT 1`
  ).get(person_id);
  if (!open) return res.status(404).json({ error: 'No open sign-in for that person.' });
  const run = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO txn (client_uuid, event_id, direction, signed_at, staff_id, close_method)
       VALUES (?, ?, 'out', ?, ?, 'admin_close')`
    ).run(`admin-close-${person_id}-${Date.now()}`, open.event_id, new Date().toISOString(), req.staff.staff_id);
    const txnId = Number(r.lastInsertRowid);
    db.prepare(`INSERT INTO txn_person (txn_id, person_id, open, in_txn_id) VALUES (?, ?, 0, ?)`)
      .run(txnId, person_id, open.in_txn_id);
    db.prepare('UPDATE txn_person SET open = 0 WHERE txn_id = ? AND person_id = ?')
      .run(open.in_txn_id, person_id);
    return txnId;
  });
  const txnId = run();
  // an admin close is still a departure — record TLC attendance (advancement
  // defaults to yes; the write-back is off unless enabled in Admin → Import)
  try { require('../lib/attendanceSync').enqueue(open.event_id, [person_id]); }
  catch (e) { console.error('[tlc-attendance] enqueue failed:', e.message); }
  res.json({ ok: true, txn_id: txnId });
});

// -------------------------------------------------------- visitor merge ----
router.post('/merge', (req, res) => {
  const { from_id, into_id } = req.body || {};
  const from = db.prepare('SELECT * FROM person WHERE id = ?').get(from_id);
  const into = db.prepare('SELECT * FROM person WHERE id = ?').get(into_id);
  if (!from || !into) return res.status(400).json({ error: 'from_id and into_id are required.' });
  if (from.id === into.id) return res.status(400).json({ error: 'Cannot merge a person into themselves.' });
  if (from.status === 'merged') return res.status(409).json({ error: 'Already merged.' });
  if (from.member_id) return res.status(400).json({ error: 'Only visitor/unregistered records (no member number) can be merged.' });
  if (from.is_youth !== into.is_youth) return res.status(400).json({ error: 'Youth records merge into youth; adults into adults.' });
  const run = db.transaction(() => {
    // attendance history transfers (guard against same-txn duplicates)
    for (const tp of db.prepare('SELECT * FROM txn_person WHERE person_id = ?').all(from.id)) {
      const clash = db.prepare('SELECT 1 FROM txn_person WHERE txn_id = ? AND person_id = ?').get(tp.txn_id, into.id);
      if (clash) db.prepare('DELETE FROM txn_person WHERE txn_id = ? AND person_id = ?').run(tp.txn_id, from.id);
      else db.prepare('UPDATE txn_person SET person_id = ? WHERE txn_id = ? AND person_id = ?').run(into.id, tp.txn_id, from.id);
    }
    db.prepare('UPDATE txn SET signer_person_id = ? WHERE signer_person_id = ?').run(into.id, from.id);
    // guardian links move unless the target already has that link
    for (const pg of db.prepare('SELECT * FROM person_guardian WHERE youth_id = ?').all(from.id)) {
      const clash = db.prepare('SELECT 1 FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').get(into.id, pg.guardian_id);
      if (!clash) db.prepare('UPDATE person_guardian SET youth_id = ? WHERE youth_id = ? AND guardian_id = ?').run(into.id, from.id, pg.guardian_id);
      else db.prepare('DELETE FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').run(from.id, pg.guardian_id);
    }
    for (const pg of db.prepare('SELECT * FROM person_guardian WHERE guardian_id = ?').all(from.id)) {
      const clash = db.prepare('SELECT 1 FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').get(pg.youth_id, into.id);
      if (!clash) db.prepare('UPDATE person_guardian SET guardian_id = ? WHERE youth_id = ? AND guardian_id = ?').run(into.id, pg.youth_id, from.id);
      else db.prepare('DELETE FROM person_guardian WHERE youth_id = ? AND guardian_id = ?').run(pg.youth_id, from.id);
    }
    if (from.badge_code && !into.badge_code) {
      db.prepare('UPDATE person SET badge_code = NULL WHERE id = ?').run(from.id);
      db.prepare(`UPDATE person SET badge_code = ?, updated_at = datetime('now') WHERE id = ?`).run(from.badge_code, into.id);
    }
    // TLC mapping follows the person (unless the target already has its own),
    // and queued/logged attendance pushes are re-pointed with dedupe
    if (from.tlc_user_id && !into.tlc_user_id) {
      db.prepare('UPDATE person SET tlc_user_id = NULL WHERE id = ?').run(from.id);
      db.prepare(`UPDATE person SET tlc_user_id = ?, updated_at = datetime('now') WHERE id = ?`).run(from.tlc_user_id, into.id);
    }
    for (const q of db.prepare('SELECT * FROM tlc_attendance_push WHERE person_id = ?').all(from.id)) {
      const clash = db.prepare('SELECT 1 FROM tlc_attendance_push WHERE event_id = ? AND person_id = ?').get(q.event_id, into.id);
      if (clash) db.prepare('DELETE FROM tlc_attendance_push WHERE id = ?').run(q.id);
      else db.prepare('UPDATE tlc_attendance_push SET person_id = ? WHERE id = ?').run(into.id, q.id);
    }
    db.prepare(`UPDATE person SET status = 'merged', merged_into_id = ?, badge_code = NULL,
                                  updated_at = datetime('now') WHERE id = ?`).run(into.id, from.id);
  });
  run();
  res.json({ ok: true });
});

// ------------------------------------------------- automated roster sync ----
// The fetch job (server/scripts/fetch-roster.js, weekly systemd timer or the
// "Sync now" button) stages a PENDING import; these routes surface it for
// one-tap Approve/Discard. The job can never commit — only approve does.
const rosterSync = require('../lib/rosterSync');
// child-process ownership lives in lib/syncRunner so the weekly in-process
// schedule and this button share the "one sync at a time" state
const syncRunner = require('../lib/syncRunner');

router.get('/roster-sync', (req, res) => {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'roster-fetch-state.json'), 'utf8'));
  } catch { /* no runs yet */ }
  const cred = rosterSync.credentialInfo(); // never includes the password
  const run = syncRunner.status();
  res.json({
    configured: !!cred.source,
    credentials: cred, // {source: 'admin'|'env'|null, email, updated_at}
    enabled: String(process.env.TLC_ENABLED || 'true').toLowerCase() !== 'false',
    running: run.running,
    started_at: run.started_at,
    last_run: state.last_run || null,
    last_status: state.last_status || null,
    last_error: state.last_error || null,
    last_rows: state.last_rows || null,
    pending: rosterSync.getPending(),
  });
});

router.post('/roster-sync/run', (req, res) => {
  if (syncRunner.status().running) return res.status(409).json({ error: 'A sync is already running.' });
  if (!rosterSync.credentialInfo().source) {
    return res.status(422).json({ error: 'Trail Life Connect credentials are not configured — save them below (or set TLC_EMAIL / TLC_PASSWORD in .env).' });
  }
  const r = syncRunner.start();
  if (!r.started) return res.status(409).json({ error: r.reason });
  res.json({ ok: true, started: true });
});

router.post('/roster-sync/approve', (req, res) => {
  try {
    res.json({ ok: true, ...rosterSync.approvePending(req.staff.staff_id) });
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

router.post('/roster-sync/discard', (req, res) => {
  res.json({ ok: true, ...rosterSync.discardPending() });
});

// Credentials are WRITE-ONLY through the API: saved/updated here, never read
// back (responses carry email + updated_at only). Blank password on an
// update means "keep the stored one".
router.put('/roster-sync/credentials', (req, res) => {
  const b = req.body || {};
  try {
    const saved = rosterSync.saveTlcCredentials({ email: b.email, password: b.password });
    // fresh credentials un-pause the attendance write-back sweep
    try { require('../lib/attendanceSync').clearAuthFailure(); } catch { /* pre-migration */ }
    res.json({ ok: true, ...saved });
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

router.delete('/roster-sync/credentials', (req, res) => {
  res.json({ ok: true, ...rosterSync.clearTlcCredentials() });
});

// ------------------------------------------- TLC attendance write-back -----
// Check-ins can be pushed back to Trail Life Connect as Attended marks
// (docs/12-attendance-writeback.md). Off by default; per-event override.
const attendanceSync = require('../lib/attendanceSync');

router.get('/tlc-attendance', (req, res) => {
  res.json({
    settings: attendanceSync.getSettings(),
    state: attendanceSync.getState(),
    queue: attendanceSync.queueSummary(),
    running: attendanceSync.isRunning(),
    credentials_configured: !!rosterSync.credentialInfo().source,
    recent: attendanceSync.recentRows(30),
  });
});

router.put('/tlc-attendance/settings', (req, res) => {
  res.json({ ok: true, settings: attendanceSync.saveSettings(req.body || {}) });
});

// Manual push — the one human action that bypasses the failed-login latch.
// Runs in-process and answers immediately; the UI polls GET for the result.
router.post('/tlc-attendance/push', (req, res) => {
  if (attendanceSync.isRunning()) return res.status(409).json({ error: 'A push is already running.' });
  if (!rosterSync.credentialInfo().source) {
    return res.status(422).json({ error: 'Trail Life Connect credentials are not configured — save them under Automatic roster sync.' });
  }
  attendanceSync.runPush({ manual: true })
    .catch((e) => console.error('[tlc-attendance] manual push failed:', e.message));
  res.json({ ok: true, started: true });
});

router.post('/tlc-attendance/retry', (req, res) => {
  res.json({ ok: true, ...attendanceSync.retryFailed() });
});

// Admin helper behind the person editor's "Find TLC id" button: reads one
// TLC event roster and returns same-surname candidates with their hashids.
router.post('/tlc-attendance/lookup', async (req, res) => {
  if (!rosterSync.credentialInfo().source) {
    return res.status(422).json({ error: 'Trail Life Connect credentials are not configured — save them under Automatic roster sync.' });
  }
  try {
    const b = req.body || {};
    res.json(await attendanceSync.lookupCandidates({
      personId: b.person_id, eventId: b.event_id || null,
    }));
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

// Same-name records among non-merged people — the traps behind wrong-person
// TLC pushes (youth/parent namesakes) and the duplicates worth merging.
router.get('/duplicate-names', (req, res) => {
  const aSync = require('../lib/attendanceSync');
  const rows = db.prepare(
    `SELECT id, first_name, last_name, is_youth, status, member_id, tlc_user_id, patrol, role
       FROM person WHERE status != 'merged' ORDER BY last_name, first_name`).all();
  const groups = new Map();
  for (const p of rows) {
    const key = aSync.nameKey(p.last_name, p.first_name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  res.json([...groups.values()].filter((g) => g.length > 1)
    .map((g) => ({ name: `${g[0].last_name}, ${g[0].first_name}`, people: g })));
});

// -------------------------------------------------------------- reports ----
router.get('/imports', (req, res) => {
  res.json(db.prepare(
    `SELECT ri.*, s.name AS staff_name FROM roster_import ri
       LEFT JOIN staff s ON s.id = ri.staff_id
      ORDER BY ri.id DESC LIMIT 50`).all());
});

// Attendance detail — filterable by event, person, and date range (records
// are kept forever; 3+ year lookback is just a wider from/to).
const attendanceFilters = (q) => [
  q.event_id || null, q.event_id || null,
  q.person_id || null, q.person_id || null,
  q.from || null, q.from || null,
  q.to || null, q.to || null,
];
const ATTENDANCE_WHERE = `
      WHERE (? IS NULL OR t.event_id = ?)
        AND (? IS NULL OR tp.person_id = ?)
        AND (? IS NULL OR datetime(t.signed_at) >= datetime(?))
        AND (? IS NULL OR datetime(t.signed_at) <= datetime(?, '+1 day'))`;

router.get('/export/attendance.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT e.title, p.last_name, p.first_name, CASE p.is_youth WHEN 1 THEN 'youth' ELSE 'adult' END,
            p.patrol, t.direction, t.signed_at,
            COALESCE(sg.first_name || ' ' || sg.last_name, t.signer_name_override, ''),
            st.name, tp.emerg_phone_1, tp.emerg_phone_2,
            CASE WHEN t.forced = 1 THEN 'yes' ELSE '' END,
            COALESCE(t.close_method, ''), CASE WHEN t.voided_by_txn_id IS NOT NULL THEN 'yes' ELSE '' END
       FROM txn_person tp
       JOIN txn t ON t.id = tp.txn_id
       JOIN person p ON p.id = tp.person_id
       JOIN event e ON e.id = t.event_id
       JOIN staff st ON st.id = t.staff_id
       LEFT JOIN person sg ON sg.id = t.signer_person_id
      ${ATTENDANCE_WHERE}
      ORDER BY datetime(t.signed_at)`).raw().all(...attendanceFilters(req.query));
  sendCsv(res, 'attendance.csv',
    ['event', 'last_name', 'first_name', 'type', 'patrol', 'direction', 'signed_at',
     'signer', 'staff', 'emerg_phone_1', 'emerg_phone_2', 'override', 'close_method', 'voided'],
    rows);
});

// Per-person rollup over a date range: events attended, first/last seen.
const SUMMARY_SQL = `
  SELECT p.id, p.last_name, p.first_name,
         CASE p.is_youth WHEN 1 THEN 'youth' ELSE 'adult' END AS type, p.patrol,
         COUNT(DISTINCT CASE WHEN t.direction = 'in' THEN t.event_id END) AS events_attended,
         SUM(CASE WHEN t.direction = 'in' THEN 1 ELSE 0 END) AS sign_ins,
         MIN(t.signed_at) AS first_seen, MAX(t.signed_at) AS last_seen
    FROM txn_person tp
    JOIN txn t ON t.id = tp.txn_id AND t.voided_by_txn_id IS NULL
    JOIN person p ON p.id = tp.person_id
    ${ATTENDANCE_WHERE}
   GROUP BY p.id
   ORDER BY p.is_youth DESC, p.last_name, p.first_name`;

router.get('/report/summary', (req, res) => {
  res.json(db.prepare(SUMMARY_SQL).all(...attendanceFilters(req.query)));
});
router.get('/export/summary.csv', (req, res) => {
  const rows = db.prepare(SUMMARY_SQL).raw().all(...attendanceFilters(req.query))
    .map((r) => r.slice(1)); // drop id column
  sendCsv(res, 'attendance-summary.csv',
    ['last_name', 'first_name', 'type', 'patrol', 'events_attended', 'sign_ins', 'first_seen', 'last_seen'],
    rows);
});

// Direct reply from the Messages tab to a guardian who texted in. Honors
// opt-out: refused when every one of their links is STOPped.
router.post('/sms-reply', async (req, res) => {
  const sms = require('../lib/sms');
  if (!sms.configured()) return res.status(503).json({ error: 'SMS is not configured.' });
  const { guardian_id } = req.body || {};
  const message = String((req.body || {}).message || '').trim();
  if (!guardian_id) return res.status(400).json({ error: 'guardian_id is required.' });
  if (!message) return res.status(400).json({ error: 'Type the message first.' });
  if (message.length > 300) return res.status(400).json({ error: 'Keep the message under 300 characters.' });
  const g = db.prepare(`SELECT * FROM person WHERE id = ? AND is_youth = 0 AND status != 'merged'`).get(guardian_id);
  if (!g || !g.phone_mobile) return res.status(400).json({ error: 'No mobile number on file for that adult.' });
  const links = db.prepare('SELECT sms_opt_in FROM person_guardian WHERE guardian_id = ?').all(g.id);
  if (links.length && links.every((l) => l.sms_opt_in === 'stop')) {
    return res.status(422).json({ error: 'They texted STOP — replies are blocked until they text START.' });
  }
  const body = `${require('../lib/env').TROOP_ID}: ${message}`;
  let status = 'failed', sid = null, err = null;
  try {
    const r = await sms.send(g.phone_mobile, body);
    status = 'sent'; sid = r.sid;
  } catch (e) { err = e.message; }
  db.prepare(
    `INSERT INTO sms_message (direction, kind, guardian_id, phone, body, twilio_sid, status)
     VALUES ('out', 'reply', ?, ?, ?, ?, ?)`
  ).run(g.id, g.phone_mobile, body, sid, status);
  if (status !== 'sent') return res.status(502).json({ error: `Send failed: ${err}` });
  res.json({ ok: true });
});

// Full SMS message log: broadcasts, alerts, and every inbound reply.
router.get('/messages', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(db.prepare(
    `SELECT m.*, g.first_name || ' ' || g.last_name AS guardian_name
       FROM sms_message m LEFT JOIN person g ON g.id = m.guardian_id
      ORDER BY m.id DESC LIMIT ?`).all(limit));
});

// SMS notification log (Phase 3)
router.get('/notifications', (req, res) => {
  res.json(db.prepare(
    `SELECT n.*, p.first_name || ' ' || p.last_name AS youth_name,
            g.first_name || ' ' || g.last_name AS guardian_name,
            e.title AS event_title
       FROM notification n
       JOIN person p ON p.id = n.person_id
       JOIN person g ON g.id = n.guardian_id
       JOIN event e ON e.id = n.event_id
      ORDER BY n.id DESC LIMIT 200`).all());
});

router.get('/export/open.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT e.title, p.last_name, p.first_name, p.patrol, t.signed_at
       FROM txn_person tp JOIN txn t ON t.id = tp.txn_id
       JOIN person p ON p.id = tp.person_id JOIN event e ON e.id = t.event_id
      WHERE tp.open = 1 AND t.voided_by_txn_id IS NULL
      ORDER BY datetime(t.signed_at)`).raw().all();
  sendCsv(res, 'open-signins.csv', ['event', 'last_name', 'first_name', 'patrol', 'signed_in_at'], rows);
});

router.get('/export/overrides.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT t.signed_at, e.title,
            (SELECT GROUP_CONCAT(p.first_name || ' ' || p.last_name, ' · ')
               FROM txn_person tp JOIN person p ON p.id = tp.person_id WHERE tp.txn_id = t.id),
            COALESCE(sg.first_name || ' ' || sg.last_name, t.signer_name_override, ''), st.name
       FROM txn t JOIN event e ON e.id = t.event_id JOIN staff st ON st.id = t.staff_id
       LEFT JOIN person sg ON sg.id = t.signer_person_id
      WHERE t.forced = 1 ORDER BY datetime(t.signed_at) DESC`).raw().all();
  sendCsv(res, 'overrides.csv', ['signed_at', 'event', 'people', 'signer', 'staff'], rows);
});

router.get('/export/visitors.csv', (req, res) => {
  // guardian contact rides along — this CSV is the open-house follow-up list
  const rows = db.prepare(
    `SELECT p.last_name, p.first_name, CASE p.is_youth WHEN 1 THEN 'youth' ELSE 'adult' END,
            (SELECT g.first_name || ' ' || g.last_name FROM person_guardian pg
              JOIN person g ON g.id = pg.guardian_id
             WHERE pg.youth_id = p.id ORDER BY pg.is_primary DESC LIMIT 1),
            (SELECT g.phone_mobile FROM person_guardian pg
              JOIN person g ON g.id = pg.guardian_id
             WHERE pg.youth_id = p.id ORDER BY pg.is_primary DESC LIMIT 1),
            (SELECT g.email FROM person_guardian pg
              JOIN person g ON g.id = pg.guardian_id
             WHERE pg.youth_id = p.id ORDER BY pg.is_primary DESC LIMIT 1),
            p.created_at, p.notes,
            (SELECT COUNT(*) FROM txn_person tp WHERE tp.person_id = p.id)
       FROM person p WHERE p.status = 'visitor' ORDER BY p.created_at DESC`).raw().all();
  sendCsv(res, 'visitors.csv',
    ['last_name', 'first_name', 'type', 'guardian', 'guardian_phone', 'guardian_email', 'first_seen', 'notes', 'txn_count'], rows);
});

// ------------------------------------------------- membership renewals ----
// Expired-or-expiring within N days (default 30; leadership chases renewals
// before they lapse). Includes youth AND registered adults; already-expired
// members are listed too (negative days_left), soonest/most-lapsed first.
const expiringDays = (q) => Math.min(Math.max(Number(q.days) || 30, 1), 365);
router.get('/expiring', (req, res) => {
  res.json(require('../lib/membership').expiringPeople(expiringDays(req.query)));
});

router.get('/export/expiring.csv', (req, res) => {
  const days = expiringDays(req.query);
  const rows = require('../lib/membership').expiringPeople(days).map((p) => [
    p.last_name, p.first_name, p.is_youth ? 'youth' : 'adult', p.member_id || '',
    p.is_youth ? p.patrol || '' : p.role || '', p.membership_expires, p.days_left,
  ]);
  sendCsv(res, `membership-expiring-${days}d.csv`,
    ['last_name', 'first_name', 'type', 'member_number', 'patrol_or_role', 'membership_expires', 'days_left'],
    rows);
});

// --------------------------------------------------- health-form status ----
// Two tracked forms (health = annual health form; high_risk = the separate
// High Adventure medical clearance), two views each: 'missing' (no date on
// file) and 'expiring' (submission + 12 months within N days, expired
// included). Active youth AND adults — everyone camps.
const healthForms = require('../lib/healthForms');
const formKind = (q) => (q.form === 'high_risk' ? 'high_risk' : 'health');
const healthRows = (q) => {
  const form = formKind(q);
  return q.view === 'missing'
    ? healthForms.missingPeople(form)
    : healthForms.expiringPeople(form, expiringDays(q));
};
router.get('/health-forms', (req, res) => {
  res.json(healthRows(req.query));
});

router.get('/export/health-forms.csv', (req, res) => {
  const missing = req.query.view === 'missing';
  const rows = healthRows(req.query).map((p) => [
    p.last_name, p.first_name, p.is_youth ? 'youth' : 'adult', p.member_id || '',
    p.is_youth ? p.patrol || '' : p.role || '',
    ...(missing ? [] : [p.submitted_on, p.expires_on, p.days_left]),
  ]);
  const name = `${formKind(req.query)}-form-${missing ? 'missing' : `expiring-${expiringDays(req.query)}d`}.csv`;
  sendCsv(res, name,
    ['last_name', 'first_name', 'type', 'member_number', 'patrol_or_role',
     ...(missing ? [] : ['submitted_on', 'expires_on', 'days_left'])],
    rows);
});

// ------------------------------------------------- messaging opt-in lists ----
// view=missing: youth families that never returned the messaging form;
// view=declined: families that said stop (mixed yes/stop = messageable =
// neither list). Each response carries a separate adults section (adults'
// own consent, new in migration 010 — starts all-'unknown' by design).
const optin = require('../lib/optin');
const optinRows = (q) => (q.view === 'declined'
  ? { youth: optin.youthDeclined(), adults: optin.adultsByOptIn('stop') }
  : { youth: optin.youthNoOptIn(), adults: optin.adultsByOptIn('unknown') });
router.get('/optin-report', (req, res) => {
  res.json(optinRows(req.query));
});

router.get('/export/optin.csv', (req, res) => {
  const r = optinRows(req.query);
  const rows = [
    ...r.youth.map((p) => [p.last_name, p.first_name, 'youth', p.member_id || '',
      p.patrol || '', p.guardian_count]),
    ...r.adults.map((p) => [p.last_name, p.first_name, 'adult', p.member_id || '',
      p.role || '', '']),
  ];
  sendCsv(res, `optin-${req.query.view === 'declined' ? 'declined' : 'missing'}.csv`,
    ['last_name', 'first_name', 'type', 'member_number', 'patrol_or_role', 'authorized_guardians'],
    rows);
});

// check-in badge switch (default OFF — see lib/healthForms.js)
router.get('/checkin-flags', (req, res) => {
  res.json(healthForms.getCheckinFlags());
});
router.put('/checkin-flags', (req, res) => {
  res.json(healthForms.saveCheckinFlags(req.body || {}));
});

// -------------------------------------------------------- consent forms ----
// One scanned form can cover many youth/guardian pairs; pairs link to it via
// person_guardian.consent_form_id. Files live under data/ with the other PII,
// served session-gated at /consent-forms/<file>.
router.post('/consent-forms', consentUpload.single('file'), (req, res) => {
  if (!req.file || !/^(application\/pdf|image\/(jpeg|png|webp))$/.test(req.file.mimetype)) {
    return res.status(400).json({ error: 'Attach the scanned form as PDF, JPEG, PNG, or WebP.' });
  }
  const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[req.file.mimetype];
  const r = db.prepare(
    `INSERT INTO consent_form (file_path, signed_by, signed_on, notes, staff_id)
     VALUES ('pending', ?, ?, ?, ?)`
  ).run(req.body.signed_by || null, req.body.signed_on || null, req.body.notes || null, req.staff.staff_id);
  const id = Number(r.lastInsertRowid);
  // File naming: the UI sends an editable file_name (defaulted to
  // Guardian Last_First_date); fall back to deriving it from signed_by +
  // signed-on/upload date, then to the bare id. Sanitized (the name becomes
  // a served URL path segment), extension always ours from the mimetype,
  // uniquified on disk so a re-upload never overwrites an earlier form.
  const clean = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 _.-]/g, '').trim().replace(/[ .]+/g, '_')
    .replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  let base = clean(String(req.body.file_name || '').replace(/\.(pdf|jpe?g|png|webp)$/i, ''));
  if (!base) {
    const parts = String(req.body.signed_by || '').trim().split(/\s+/).filter(Boolean);
    const who = parts.length >= 2
      ? `${clean(parts[parts.length - 1])}_${clean(parts.slice(0, -1).join(' '))}`
      : clean(parts[0] || '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.signed_on || '')
      ? req.body.signed_on : new Date().toISOString().slice(0, 10);
    if (who) base = `${who}_${date}`;
  }
  let name = `${base || id}.${ext}`;
  for (let n = 2; fs.existsSync(path.join(CONSENT_DIR, name)); n++) name = `${base || id}_${n}.${ext}`;
  fs.writeFileSync(path.join(CONSENT_DIR, name), req.file.buffer);
  db.prepare('UPDATE consent_form SET file_path = ? WHERE id = ?').run(name, id);
  res.json({ ok: true, id, file_path: name });
});

router.get('/consent-forms', (req, res) => {
  res.json(db.prepare(
    `SELECT cf.*, s.name AS uploaded_by,
            (SELECT COUNT(*) FROM person_guardian pg WHERE pg.consent_form_id = cf.id) AS linked_pairs
       FROM consent_form cf LEFT JOIN staff s ON s.id = cf.staff_id
      ORDER BY cf.id DESC`).all());
});

// Compliance export: every youth↔guardian pair with its SMS consent state.
router.get('/export/sms-consent.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT y.last_name, y.first_name, g.last_name, g.first_name, g.phone_mobile,
            pg.relationship, CASE pg.authorized WHEN 1 THEN 'yes' ELSE 'no' END,
            pg.sms_opt_in, COALESCE(cf.signed_by, ''), COALESCE(cf.signed_on, ''),
            COALESCE(cf.file_path, '')
       FROM person_guardian pg
       JOIN person y ON y.id = pg.youth_id AND y.status != 'merged'
       JOIN person g ON g.id = pg.guardian_id AND g.status != 'merged'
       LEFT JOIN consent_form cf ON cf.id = pg.consent_form_id
      ORDER BY y.last_name, y.first_name, pg.is_primary DESC`).raw().all();
  sendCsv(res, 'sms-consent.csv',
    ['youth_last', 'youth_first', 'guardian_last', 'guardian_first', 'guardian_mobile',
     'relationship', 'authorized', 'sms_opt_in', 'consent_signed_by', 'consent_signed_on', 'consent_file'],
    rows);
});

// ---------------------------------------------------------------- staff ----
// Door staff use a PIN. Admins use a password by default; giving an admin a
// PIN overrides the password at login (clearing the PIN restores it).
router.get('/staff', (req, res) => {
  res.json(db.prepare(
    `SELECT id, name, role, active, created_at,
            pin_hash IS NOT NULL AS has_pin, password_hash IS NOT NULL AS has_password
       FROM staff ORDER BY active DESC, role DESC, name`).all());
});

router.post('/staff', (req, res) => {
  const { name, role, pin, password } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!['door', 'admin'].includes(role)) return res.status(400).json({ error: 'Role must be door or admin.' });
  if (role === 'door' && !pin) return res.status(400).json({ error: 'Door staff need a PIN.' });
  if (role === 'admin' && !password) return res.status(400).json({ error: 'Admins need a password (a PIN is optional and overrides it).' });
  const dup = db.prepare('SELECT 1 FROM staff WHERE name = ?').get(String(name).trim());
  if (dup) return res.status(409).json({ error: 'That name already exists.' });
  const r = db.prepare(
    `INSERT INTO staff (name, role, pin_hash, password_hash) VALUES (?, ?, ?, ?)`
  ).run(String(name).trim(), role,
        pin ? auth.hashSecret(pin) : null,
        password ? auth.hashSecret(password) : null);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.patch('/staff/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such staff member.' });
  const b = req.body || {};
  const lastAdminGuard = () => {
    const others = db.prepare(
      `SELECT COUNT(*) c FROM staff WHERE role = 'admin' AND active = 1 AND id != ?`).get(s.id).c;
    return others === 0;
  };
  const sets = [], vals = [];
  if ('name' in b) {
    if (!String(b.name).trim()) return res.status(400).json({ error: 'Name cannot be empty.' });
    const dup = db.prepare('SELECT 1 FROM staff WHERE name = ? AND id != ?').get(String(b.name).trim(), s.id);
    if (dup) return res.status(409).json({ error: 'That name already exists.' });
    sets.push('name = ?'); vals.push(String(b.name).trim());
  }
  if ('role' in b) {
    if (!['door', 'admin'].includes(b.role)) return res.status(400).json({ error: 'Bad role.' });
    if (s.role === 'admin' && b.role === 'door' && lastAdminGuard()) {
      return res.status(409).json({ error: 'Cannot demote the last active admin.' });
    }
    sets.push('role = ?'); vals.push(b.role);
  }
  if ('active' in b) {
    if (!b.active && s.id === req.staff.staff_id) {
      return res.status(409).json({ error: 'You cannot deactivate your own account.' });
    }
    if (!b.active && s.role === 'admin' && lastAdminGuard()) {
      return res.status(409).json({ error: 'Cannot deactivate the last active admin.' });
    }
    sets.push('active = ?'); vals.push(b.active ? 1 : 0);
    if (!b.active) db.prepare('DELETE FROM session WHERE staff_id = ?').run(s.id); // kick them out
  }
  if (b.clear_pin) { sets.push('pin_hash = NULL'); }
  else if (b.pin) { sets.push('pin_hash = ?'); vals.push(auth.hashSecret(b.pin)); }
  if (b.password) { sets.push('password_hash = ?'); vals.push(auth.hashSecret(b.password)); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  db.prepare(`UPDATE staff SET ${sets.join(', ')} WHERE id = ?`).run(...vals, s.id);
  const out = db.prepare(
    `SELECT id, name, role, active, pin_hash IS NOT NULL AS has_pin,
            password_hash IS NOT NULL AS has_password FROM staff WHERE id = ?`).get(s.id);
  res.json(out);
});

router.post('/backup', (req, res) => {
  try { res.json(require('../lib/backup').runBackup()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/status', (req, res) => {
  const count = (sql) => db.prepare(sql).get().c;
  let lastSync = null;
  const m = db.prepare(`SELECT value FROM meta WHERE key = 'last_ical_sync'`).get();
  if (m) { try { lastSync = JSON.parse(m.value); } catch { /* ignore */ } }
  res.json({
    youth_active: count(`SELECT COUNT(*) c FROM person WHERE is_youth = 1 AND status = 'active'`),
    adults_active: count(`SELECT COUNT(*) c FROM person WHERE is_youth = 0 AND status = 'active'`),
    visitors: count(`SELECT COUNT(*) c FROM person WHERE status = 'visitor'`),
    open_signins: count(`SELECT COUNT(*) c FROM txn_person tp JOIN txn t ON t.id = tp.txn_id
                          WHERE tp.open = 1 AND t.voided_by_txn_id IS NULL`),
    events: count('SELECT COUNT(*) c FROM event'),
    txns: count('SELECT COUNT(*) c FROM txn'),
    expiring_30: require('../lib/membership').expiringPeople(30).length,
    health_missing: healthForms.missingPeople('health').length,
    health_expiring_30: healthForms.expiringPeople('health', 30).length,
    high_risk_missing: healthForms.missingPeople('high_risk').length,
    high_risk_expiring_30: healthForms.expiringPeople('high_risk', 30).length,
    optin_missing: optin.youthNoOptIn().length,
    optin_declined: optin.youthDeclined().length,
    last_ical_sync: lastSync,
  });
});

module.exports = router;
