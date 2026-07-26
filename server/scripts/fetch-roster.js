'use strict';
/**
 * fetch-roster.js — pull the member export from Trail Life Connect (TLC).
 *
 * No dependencies beyond Node 20 (global fetch) + the existing xlsx package.
 * Runs standalone (systemd timer / CLI) or via the admin "Sync now" button.
 *
 * Flow (docs/10-roster-sync.md — observed TLC behaviour, July 2026):
 *   1. GET  /login                            → _csrf cookie + token
 *   2. POST /login                            → session cookie (302 on success)
 *   3. GET  $TLC_EXPORT_PATH                  → 503, kicks off async export job
 *   4. POST /databuilder/get-download-status  → {"status":"pending"|"finished"}
 *      (headers: X-CSRF-Token, X-Requested-With: XMLHttpRequest)
 *   5. GET  $TLC_EXPORT_PATH                  → 200, the file
 *   6. Sniff bytes (server mislabels CSV as spreadsheetml — never trust
 *      Content-Type), sanity-check, write to data/roster-exports/ (mode 600),
 *      stage a PENDING IMPORT (preview only — never commits), exit 0.
 *
 * Safety rules (non-negotiable, from the spec):
 *   - never commits an import; a human approves in the admin UI
 *   - a failed login exits immediately — NO retry loop (TLC may lock the acct)
 *   - row-count guard vs the previous successful fetch (default 20%, strict
 *     while the TLC filter-persistence question is open; TLC_ROW_TOLERANCE)
 *   - credentials never appear in logs/errors; downloads are PII (mode 600,
 *     pruned after TLC_RETAIN_DAYS, dir covered by .gitignore's data/)
 *
 * Env (.env, chmod 600, gitignored — see .env.example):
 *   TLC_EMAIL, TLC_PASSWORD, TLC_ENABLED, TLC_BASE, TLC_EXPORT_PATH,
 *   TLC_ROW_TOLERANCE, TLC_POLL_MS, TLC_POLL_MAX, TLC_RETAIN_DAYS,
 *   HEALTHCHECK_URL, DATA_DIR
 *
 * Exit codes: 0 ok/disabled · 1 config · 2 auth · 3 export · 4 sanity check
 *             · 5 staging (file saved but pending-import creation failed)
 */

const fs = require('fs');
const path = require('path');
// Self-load .env exactly like the app does (same proven parser; values
// already in process.env win). Without this, a plain `node fetch-roster.js`
// and the systemd timer had no credentials — found in the 2026-07-26 live
// test, where only a manual `-r ./server/lib/env.js` preload worked.
require('../lib/env');

// ---------------------------------------------------------------- errors ---
class FetchError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}
const fail = (code, msg) => { throw new FetchError(code, msg); };

// ---------------------------------------------------------------- config ---
function makeConfig(env = process.env) {
  const dataDir = env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
  return {
    enabled: String(env.TLC_ENABLED || 'true').toLowerCase() !== 'false',
    email: env.TLC_EMAIL || '',
    password: env.TLC_PASSWORD || '',
    base: (env.TLC_BASE || 'https://www.traillifeconnect.com').replace(/\/$/, ''),
    // xlsx by default — the format the import parser was validated against
    exportPath: env.TLC_EXPORT_PATH || '/user/index?export=xlsx&new=0',
    statusPath: '/databuilder/get-download-status',
    dataDir,
    outDir: path.join(dataDir, 'roster-exports'),
    stateFile: path.join(dataDir, 'roster-fetch-state.json'),
    pollMax: Number(env.TLC_POLL_MAX) > 0 ? Number(env.TLC_POLL_MAX) : 40, // ~2 min at 3 s
    pollMs: Number(env.TLC_POLL_MS) > 0 ? Number(env.TLC_POLL_MS) : 3000,
    rowTolerance: env.TLC_ROW_TOLERANCE !== undefined && env.TLC_ROW_TOLERANCE !== ''
      ? Number(env.TLC_ROW_TOLERANCE) : 0.2,
    retainDays: Number(env.TLC_RETAIN_DAYS) > 0 ? Number(env.TLC_RETAIN_DAYS) : 56, // 8 weeks
    healthcheckUrl: env.HEALTHCHECK_URL || '',
    userAgent: 'troop-checkin-roster-sync/1.0 (+self-hosted troop tool)',
  };
}

// ------------------------------------------------------------ cookie jar ---
// Hand-rolled: keep every cookie the site sets, honor deletions (empty value,
// Max-Age<=0, or an Expires date in the past — Yii uses 1970 but any past
// date must count), last write wins.
class CookieJar {
  constructor() { this.map = new Map(); }
  absorbLines(lines) {
    for (const line of lines || []) {
      if (!line) continue;
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      let del = value === '';
      for (const attr of attrs) {
        const j = attr.indexOf('=');
        const key = (j < 0 ? attr : attr.slice(0, j)).trim().toLowerCase();
        const val = j < 0 ? '' : attr.slice(j + 1).trim();
        if (key === 'max-age' && Number(val) <= 0) del = true;
        if (key === 'expires') {
          const d = new Date(val);
          if (!isNaN(d) && d.getTime() < Date.now()) del = true;
        }
      }
      if (del) this.map.delete(name);
      else this.map.set(name, value);
    }
  }
  absorb(res) {
    const lines = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [].concat(res.headers.get('set-cookie') || []);
    this.absorbLines(lines);
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  get size() { return this.map.size; }
}

// --------------------------------------------------------------- request ---
// Manual redirect following so cookies set mid-chain (e.g. the session cookie
// on the login 302) are absorbed. Redirects are always refetched as GET
// without the original body — correct for the 302-after-POST login flow.
async function request(cfg, jar, pathOrUrl, opts = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : cfg.base + pathOrUrl;
  const baseHeaders = () => ({
    'User-Agent': cfg.userAgent,
    'Accept-Language': 'en-US,en;q=0.9',
    ...(jar.size ? { Cookie: jar.header() } : {}),
    ...(opts.headers || {}),
  });
  let res = await fetch(url, { ...opts, headers: baseHeaders(), redirect: 'manual' });
  jar.absorb(res);
  let hops = 0;
  let from = url;
  while (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops++ < 5) {
    const next = new URL(res.headers.get('location'), from).toString();
    const h = baseHeaders();
    delete h['Content-Type']; // never re-send POST headers on the redirect GET
    h.Cookie = jar.header();
    res = await fetch(next, { headers: h, redirect: 'manual' });
    jar.absorb(res);
    from = next;
  }
  res._redirected = hops > 0; // eslint-disable-line no-underscore-dangle
  return res;
}

// ------------------------------------------------------------------ csrf ---
const decodeHtml = (s) => s
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#0?34;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Yii2 renders the token both as <meta name="csrf-token" content="..."> and
// as a hidden <input name="_csrf" value="..."> in the form (attribute order
// varies). Prefer the meta tag; fall back to the hidden field.
function csrfFrom(html) {
  const meta = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
  if (meta) return decodeHtml(meta[1]);
  const hidden = html.match(/name=["']_csrf[^"']*["'][^>]*value=["']([^"']+)["']/i)
              || html.match(/value=["']([^"']+)["'][^>]*name=["']_csrf[^"']*["']/i);
  return hidden ? decodeHtml(hidden[1]) : null;
}

// ----------------------------------------------------------------- login ---
async function login(cfg, jar) {
  if (!cfg.email || !cfg.password) fail(1, 'TLC_EMAIL / TLC_PASSWORD not set.');

  const page = await request(cfg, jar, '/login');
  const html = await page.text();
  const token = csrfFrom(html);
  if (!token) fail(2, 'Could not find the _csrf token on the login page — the form may have changed.');

  const body = new URLSearchParams({
    _csrf: token,
    'LoginForm[email]': cfg.email,
    'LoginForm[password]': cfg.password,
    'LoginForm[rememberMe]': '1',
  });
  const res = await request(cfg, jar, '/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: cfg.base,
      Referer: cfg.base + '/login',
    },
    body: body.toString(),
  });
  const after = await res.text();
  // Success = Yii issues a 302 away from /login (we followed it). Failure =
  // the form re-renders in place with the password field present.
  if (/LoginForm\[password\]/.test(after)) {
    fail(2, 'Login rejected. Check credentials — do NOT retry in a loop, TLC may lock the account.');
  }
  // fresh token from the signed-in page for the XHR polling step
  return csrfFrom(after) || token;
}

// ---------------------------------------------------------------- export ---
async function pollUntilReady(cfg, jar, token) {
  for (let i = 0; i < cfg.pollMax; i++) {
    const res = await request(cfg, jar, cfg.statusPath, {
      method: 'POST',
      headers: {
        'X-CSRF-Token': token,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: cfg.base + '/user/index',
      },
    });
    let json = {};
    try { json = JSON.parse(await res.text()); } catch { /* transient — keep polling */ }
    if (String(json.status).toLowerCase() === 'finished') return true;
    if (i < cfg.pollMax - 1) await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
  return false;
}

async function fetchExport(cfg, jar, token) {
  const first = await request(cfg, jar, cfg.exportPath);
  if (first.status === 200) return Buffer.from(await first.arrayBuffer()); // already warm
  if (first.status !== 503) fail(3, `Unexpected status ${first.status} kicking off the export.`);

  if (!await pollUntilReady(cfg, jar, token)) {
    fail(3, 'Export never reported "finished" within the poll window.');
  }
  const res = await request(cfg, jar, cfg.exportPath);
  if (res.status !== 200) fail(3, `Export not served after "finished" (status ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

// ----------------------------------------------------------- sanity check --
// TLC mislabels the CSV response as spreadsheetml — trust the BYTES, never
// the Content-Type. A real xlsx is a zip and starts "PK\x03\x04".
function detectFormat(buf) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return 'xlsx';
  const head = buf.subarray(0, 300).toString('utf8').replace(/^﻿/, ''); // strip BOM
  if (/^\s*<(!doctype|html)/i.test(head)) return 'html';
  return 'csv';
}

// TLC multi-role accounts resume their LAST-USED role at login, and the
// member export needs a role with member-list access (e.g. Troopmaster).
// We have no verified way to detect/switch the active role over HTTP, so a
// wrong role surfaces as one of the sanity failures below — every message
// points at it as a likely cause.
const ROLE_HINT = ' If the TLC account has multiple roles: TLC signs in under the LAST-USED role, ' +
  'and the export needs one with member-list access (e.g. Troopmaster) — log into TLC in a browser, ' +
  'switch to that role, and try again.';

// Throws FetchError(4) on anything suspicious. prevRows comes from the last
// successful fetch; the guard exists because the realistic failure mode is a
// PARTIAL export (stale TLC filter) parsing cleanly and mass-deactivating
// the roster — not a crash.
function sanityCheck(buf, { prevRows = null, rowTolerance = 0.2 } = {}) {
  if (buf.length < 512) fail(4, `File is only ${buf.length} bytes — almost certainly an error page.`);

  const format = detectFormat(buf);
  if (format === 'html') fail(4, 'Got HTML, not a roster — the session probably expired or the login flow changed.' + ROLE_HINT);

  let rows;
  if (format === 'xlsx') {
    const XLSX = require('xlsx');
    let wb;
    try { wb = XLSX.read(buf, { type: 'buffer' }); }
    catch { fail(4, 'File has the xlsx signature but does not parse as a workbook.'); }
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) fail(4, 'Workbook has no sheets.');
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    // header row located by "Member Number" — the same rule as the importer,
    // so a TLC format change breaks both together, never silently.
    const headerIdx = grid.findIndex((r) => r.some((c) => /member number/i.test(String(c))));
    if (headerIdx < 0) fail(4, 'No "Member Number" header found — export format changed?' + ROLE_HINT);
    rows = grid.length - headerIdx - 1;
  } else {
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    const headerIdx = lines.findIndex((l) => /member number/i.test(l));
    if (headerIdx < 0) fail(4, 'No "Member Number" header found — export format changed?' + ROLE_HINT);
    rows = lines.length - headerIdx - 1;
  }

  if (rows < 5) fail(4, `Only ${rows} data rows — refusing to import.` + ROLE_HINT);

  if (prevRows && rows < prevRows * (1 - rowTolerance)) {
    fail(4, `Row count dropped from ${prevRows} to ${rows} (more than ${Math.round(rowTolerance * 100)}%). ` +
            'Refusing — this would mass-deactivate the roster (stale TLC filter? wrong TLC role?). ' +
            'If the drop is real, upload the export by hand in Admin → Import.' + ROLE_HINT);
  }
  return { rows, format };
}

// ----------------------------------------------------------------- state ---
const readState = (cfg) => {
  try { return JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); } catch { return {}; }
};
const writeState = (cfg, patch) => {
  const s = { ...readState(cfg), ...patch };
  fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
  fs.writeFileSync(cfg.stateFile, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
};

function pruneOldExports(cfg) {
  const cutoff = Date.now() - cfg.retainDays * 86400000;
  let pruned = 0;
  for (const f of fs.existsSync(cfg.outDir) ? fs.readdirSync(cfg.outDir) : []) {
    const p = path.join(cfg.outDir, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { force: true }); pruned++; }
    } catch { /* ignore */ }
  }
  return pruned;
}

// ------------------------------------------------------------------- run ---
// Returns a result object; throws FetchError on failure. Never logs or
// includes credentials anywhere.
async function runFetch(env = process.env) {
  const cfg = makeConfig(env);
  if (!cfg.enabled) return { skipped: true, reason: 'TLC_ENABLED=false' };

  fs.mkdirSync(cfg.outDir, { recursive: true });

  // Admin-saved credentials (DB, entered in Admin → Import) take precedence
  // over .env; .env stays the fallback. Guarded: if the DB is unreachable in
  // this context, fall back to env values rather than failing differently.
  try {
    const saved = require('../lib/rosterSync').getTlcCredentials();
    if (saved) { cfg.email = saved.email; cfg.password = saved.password; }
  } catch { /* no DB here — env credentials apply */ }

  const jar = new CookieJar();
  const token = await login(cfg, jar);
  const buf = await fetchExport(cfg, jar, token);
  const prev = readState(cfg).last_rows || null;
  const { rows, format } = sanityCheck(buf, { prevRows: prev, rowTolerance: cfg.rowTolerance });

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const outFile = path.join(cfg.outDir, `roster-${stamp}.${format}`);
  fs.writeFileSync(outFile, buf, { mode: 0o600 });
  const pruned = pruneOldExports(cfg);

  // Stage the PENDING IMPORT: preview only, replacing any existing pending.
  // The commit decision always belongs to a human in the admin UI.
  let staged;
  try {
    staged = require('../lib/rosterSync').stagePending(outFile, buf, 'sync');
  } catch (e) {
    writeState(cfg, {
      last_run: new Date().toISOString(), last_status: 'failed',
      last_error: `Fetched and saved OK, but staging the pending import failed: ${e.message}`,
    });
    fail(5, `File saved to ${outFile}, but staging the pending import failed: ${e.message}`);
  }

  writeState(cfg, {
    last_run: new Date().toISOString(), last_status: 'ok', last_error: null,
    last_rows: rows, last_file: outFile, last_format: format,
  });

  if (cfg.healthcheckUrl) await fetch(cfg.healthcheckUrl).catch(() => {});
  return { rows, format, file: outFile, pruned, ...staged };
}

// ------------------------------------------------------------------- CLI ---
module.exports = {
  FetchError, makeConfig, CookieJar, request, csrfFrom, decodeHtml,
  login, pollUntilReady, fetchExport, detectFormat, sanityCheck,
  readState, writeState, pruneOldExports, runFetch,
};

if (require.main === module) {
  runFetch().then((r) => {
    if (r.skipped) console.log(`[fetch-roster] skipped: ${r.reason}`);
    else console.log(`[fetch-roster] ok: ${r.file} (${r.rows} rows, ${r.format}` +
      `${r.replaced ? `, replaced ${r.replaced} pending import(s)` : ''})`);
    process.exit(0);
  }).catch((e) => {
    const code = e instanceof FetchError ? e.code : 3;
    // record the failure so the admin UI can show a silently-broken job
    try {
      const cfg = makeConfig();
      if (!(e instanceof FetchError && e.code === 5)) { // 5 already recorded
        writeState(cfg, {
          last_run: new Date().toISOString(), last_status: 'failed',
          last_error: e instanceof FetchError ? e.message : `Unexpected: ${e.message}`,
        });
      }
    } catch { /* state write is best-effort */ }
    console.error('[fetch-roster] ' + (e instanceof FetchError ? e.message : (e.stack || String(e))));
    process.exit(code);
  });
}
