'use strict';
// Trail Life Connect member-export importer.
// Rules validated against NY-2911_Members_07-19-2026.xlsx:
//   - title row above headers; header row located by the cell "Member Number"
//   - Youth column (Y/N) discriminates youth vs adults
//   - youth "Email" column is a TLC username, NOT an email; guardian email is "Adult Cc Email"
//   - only youth + registered adults carry member numbers
//   - guardian auto-link: cc-email -> adult email (45/50 on sample),
//     fallback last name OR normalized address+zip (remaining 5/50)
const XLSX = require('xlsx');
const { db } = require('../db');
const { normalizeDateCell } = require('./membership');

const norm = (v) => (v == null ? '' : String(v).trim());
const lower = (v) => norm(v).toLowerCase();
const normAddr = (a1, zip) =>
  lower(a1).replace(/[.,]/g, '').replace(/\s+/g, ' ') + '|' + norm(zip);

function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  const hdrIdx = rows.findIndex((r) => r.some((c) => norm(c) === 'Member Number'));
  if (hdrIdx === -1) {
    throw new Error('Could not find the header row ("Member Number" column) — is this a Trail Life Connect member export?');
  }
  const col = {};
  rows[hdrIdx].forEach((name, i) => { const n = norm(name); if (n) col[n] = i; });
  const need = ['Last Name', 'First Name', 'Youth', 'Member Number'];
  for (const n of need) if (!(n in col)) throw new Error(`Missing expected column: ${n}`);

  const g = (r, name) => (col[name] != null ? norm(r[col[name]]) : '');
  const people = [];
  for (const r of rows.slice(hdrIdx + 1)) {
    if (!r || !r.some((c, i) => i > 0 && norm(c))) continue; // blank row
    const yflag = g(r, 'Youth').toUpperCase();
    if (yflag !== 'Y' && yflag !== 'N') continue; // section/junk rows
    const isYouth = yflag === 'Y';
    people.push({
      is_youth: isYouth ? 1 : 0,
      member_id: g(r, 'Member Number') || null,
      first_name: g(r, 'First Name'),
      last_name: g(r, 'Last Name'),
      nickname: g(r, 'Nickname') || null,
      role: g(r, 'Role') || null,
      patrol: g(r, 'Patrol') || null,
      level: g(r, 'Current Level') || null,
      // youth "Email" is a TLC username; adults' is a real address
      email: isYouth ? null : (g(r, 'Email') || null),
      tlc_username: isYouth ? (g(r, 'Email') || null) : null,
      phone_mobile: g(r, 'Mobile Phone') || null,
      phone_home: g(r, 'Home Phone') || null,
      phone_work: g(r, 'Work Phone') || null,
      birthdate: g(r, 'Birthdate') || null,
      // "Membership Exp." (trailing period in the real export). raw:false
      // delivers a formatted string — normalize to ISO when recognizable,
      // keep the raw value otherwise (compare-time code parses defensively).
      membership_expires: normalizeDateCell(g(r, 'Membership Exp.')),
      // used only for guardian-link fallback, not persisted:
      _cc_email: lower(g(r, 'Adult Cc Email')),
      _addr: normAddr(g(r, 'Address Line 1'), g(r, 'Zip')),
    });
  }
  return people;
}

// Suggest guardian links within the parsed file.
// Returns [{youthKey, adultKey, source}] using array indices as keys.
function suggestLinks(people) {
  const youth = [];
  const adults = [];
  people.forEach((p, i) => (p.is_youth ? youth : adults).push(i));

  const adultByEmail = new Map();
  for (const ai of adults) {
    const e = lower(people[ai].email);
    if (e && !adultByEmail.has(e)) adultByEmail.set(e, ai);
  }
  const links = [];
  for (const yi of youth) {
    const y = people[yi];
    const byEmail = y._cc_email ? adultByEmail.get(y._cc_email) : undefined;
    if (byEmail != null) {
      links.push({ youth: yi, adult: byEmail, source: 'import_email', primary: true });
      continue;
    }
    // fallback: same last name OR same normalized address+zip
    let first = true;
    for (const ai of adults) {
      const a = people[ai];
      const sameName = lower(a.last_name) === lower(y.last_name);
      const sameAddr = a._addr && a._addr !== '|' && a._addr === y._addr;
      if (sameName || sameAddr) {
        links.push({ youth: yi, adult: ai, source: 'import_address', primary: first });
        first = false;
      }
    }
  }
  return links;
}

// Find the DB person row matching a parsed record, or null.
function findExisting(p) {
  if (p.member_id) {
    return db.prepare('SELECT * FROM person WHERE member_id = ?').get(p.member_id) || null;
  }
  // unregistered adult: match by type + name among rows without a member number
  return db.prepare(
    `SELECT * FROM person
      WHERE is_youth = 0 AND member_id IS NULL AND status != 'merged'
        AND lower(first_name) = ? AND lower(last_name) = ?`
  ).get(lower(p.first_name), lower(p.last_name)) || null;
}

const UPDATABLE = ['first_name', 'last_name', 'nickname', 'role', 'patrol', 'level',
  'email', 'tlc_username', 'phone_mobile', 'phone_home', 'phone_work', 'birthdate',
  'membership_expires'];

function diffFields(existing, p) {
  // fields the admin edited by hand are locked against imports (person.manual_fields)
  let locked = new Set();
  try { locked = new Set(JSON.parse(existing.manual_fields || '[]')); } catch { /* ignore */ }
  const changes = {};
  for (const f of UPDATABLE) {
    if (locked.has(f)) continue; // manual revision wins over the file, always
    const nv = p[f] == null ? null : p[f];
    const ov = existing[f] == null ? null : existing[f];
    if (nv !== null && nv !== ov) changes[f] = nv; // never blank out data with empty cells
  }
  if (existing.status === 'inactive') changes.status = 'active'; // returning member
  return changes;
}

function computePreview(people) {
  const adds = [], updates = [], unchanged = [];
  for (const p of people) {
    const ex = findExisting(p);
    if (!ex) { adds.push(p); continue; }
    const ch = diffFields(ex, p);
    (Object.keys(ch).length ? updates : unchanged).push({ p, ex, ch });
  }
  // deactivation: only within the classes present in the file, never visitors
  const hasYouth = people.some((p) => p.is_youth);
  const hasAdults = people.some((p) => !p.is_youth);
  const fileMemberIds = new Set(people.filter((p) => p.member_id).map((p) => p.member_id));
  const deactivate = [];
  const candidates = db.prepare(
    `SELECT id, is_youth, member_id, first_name, last_name FROM person
      WHERE status = 'active' AND member_id IS NOT NULL`
  ).all();
  for (const c of candidates) {
    if (c.is_youth && !hasYouth) continue;
    if (!c.is_youth && !hasAdults) continue;
    if (!fileMemberIds.has(c.member_id)) deactivate.push(c);
  }
  return { adds, updates, unchanged, deactivate };
}

const applyImport = (people, links, staffId, filename, rawPath) => {
  const run = db.transaction(() => {
    const preview = computePreview(people);
    const idOf = new Map(); // parsed index -> person.id

    const ins = db.prepare(
      `INSERT INTO person (is_youth, member_id, first_name, last_name, nickname, role, patrol,
        level, email, tlc_username, phone_mobile, phone_home, phone_work, birthdate, membership_expires)
       VALUES (@is_youth, @member_id, @first_name, @last_name, @nickname, @role, @patrol,
        @level, @email, @tlc_username, @phone_mobile, @phone_home, @phone_work, @birthdate, @membership_expires)`
    );
    people.forEach((p, i) => {
      const ex = findExisting(p);
      if (!ex) {
        const r = ins.run(p);
        idOf.set(i, Number(r.lastInsertRowid));
      } else {
        idOf.set(i, ex.id);
        const ch = diffFields(ex, p);
        if (Object.keys(ch).length) {
          const sets = Object.keys(ch).map((f) => `${f} = @${f}`).join(', ');
          db.prepare(`UPDATE person SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
            .run({ ...ch, id: ex.id });
        }
      }
    });

    for (const d of preview.deactivate) {
      db.prepare(`UPDATE person SET status = 'inactive', updated_at = datetime('now') WHERE id = ?`)
        .run(d.id);
    }

    // guardian suggestions: never touch rows an admin created/edited (source = 'manual'),
    // and never duplicate an existing link
    let linked = 0;
    const hasLink = db.prepare(
      'SELECT source FROM person_guardian WHERE youth_id = ? AND guardian_id = ?'
    );
    const hasPrimary = db.prepare(
      'SELECT 1 FROM person_guardian WHERE youth_id = ? AND is_primary = 1'
    );
    const insLink = db.prepare(
      `INSERT INTO person_guardian (youth_id, guardian_id, authorized, is_primary, source)
       VALUES (?, ?, 1, ?, ?)`
    );
    for (const l of links) {
      const yid = idOf.get(l.youth), gid = idOf.get(l.adult);
      if (!yid || !gid || hasLink.get(yid, gid)) continue;
      const primary = l.primary && !hasPrimary.get(yid) ? 1 : 0;
      insLink.run(yid, gid, primary, l.source);
      linked++;
    }

    const p = preview;
    const rec = db.prepare(
      `INSERT INTO roster_import (filename, staff_id, added, updated, deactivated, linked_guardians, raw_file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(filename, staffId, p.adds.length, p.updates.length, p.deactivate.length, linked, rawPath);
    return {
      import_id: Number(rec.lastInsertRowid),
      added: p.adds.length, updated: p.updates.length,
      deactivated: p.deactivate.length, linked_guardians: linked,
    };
  });
  return run();
};

module.exports = { parseWorkbook, suggestLinks, computePreview, applyImport, UPDATABLE };
