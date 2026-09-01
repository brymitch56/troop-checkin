'use strict';
/* Admin SPA — roster, guardians, events, transactions, imports. */

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// SQLite's datetime('now') defaults (audit timestamps: imports, fetches,
// messages…) are UTC but carry NO zone marker; parsing them as local shifted
// every such time into the future ("fetched tomorrow"). Detect the naive
// "YYYY-MM-DD HH:MM[:SS]" shape and pin it to UTC; client-generated ISO
// strings (with Z/offset) parse as before. Rendering is the viewer's local.
const fmtDT = (s) => {
  if (!s) return '';
  const naive = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s);
  const d = new Date(naive ? s.replace(' ', 'T') + 'Z' : s);
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};
// A date cell: shows the friendly local string, sorts chronologically
// (tabletools reads data-sort when present).
const dtCell = (s) => `<td data-sort="${esc(s || '')}">${fmtDT(s)}</td>`;
// Enhance a just-rendered table with sort + multi-select filtering.
// `cap` (optional) explains a server-side row limit in the count line.
function enhanceTable(id, cap) {
  const el = $(id);
  if (!el) return;
  if (cap) el.dataset.ttCap = cap; else delete el.dataset.ttCap;
  if (window.TableTools) window.TableTools.enhance(el);
}

let me = null;

// Cloudflare Access expiry: background API calls bounce to the Access login
// (a cross-origin redirect fetch can't use) and the page silently empties.
// Detect the bounce and force ONE full-page reload — with the network-first
// SW (tc-v22) that navigation goes through Access and shows the login. If a
// reload doesn't fix it, show a visible message instead of looping.
const accessGuard = window.AccessGuard && window.AccessGuard.create({
  storage: window.sessionStorage,
  reload: () => window.location.reload(),
  onStuck: () => {
    if (document.getElementById('access-stuck')) return;
    const b = document.createElement('div');
    b.id = 'access-stuck';
    b.textContent = 'Session expired or server unreachable — reload this page to sign in again.';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#B3261E;' +
      'color:#fff;text-align:center;padding:10px 14px;font-weight:600';
    document.body.appendChild(b);
  },
});

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch('/api' + path, { credentials: 'same-origin', ...opts });
  } catch (err) {
    // genuinely offline: keep the old behavior (offline UI, no reload loop)
    if (accessGuard && navigator.onLine !== false) accessGuard.handleBounce();
    throw err;
  }
  if (accessGuard && accessGuard.isBounce(res)) {
    accessGuard.handleBounce();
    const e = new Error('Session expired — signing you back in…'); e.status = 401; throw e;
  }
  // read text once, then parse: a non-JSON error body (proxy/tunnel HTML,
  // plain-text crash) must still yield a USEFUL toast, not "failed (502)" —
  // the server's own JSON errors name the problem precisely; show them
  const text = await res.text().catch(() => '');
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    const snippet = text && !/^\s*</.test(text) ? ` — ${text.slice(0, 160)}` : '';
    const e = new Error(body.error || `Request failed (${res.status})${snippet}`);
    e.body = body; e.status = res.status; throw e;
  }
  if (accessGuard) accessGuard.markGood();
  return body;
}
const jpost = (p, d) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
const jput = (p, d) => api(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
const jpatch = (p, d) => api(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
const jdel = (p) => api(p, { method: 'DELETE' });

let toastTimer;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------------------------------------------------------------- login ----
async function boot() {
  const cfg = await api('/config').catch(() => null);
  if (cfg) {
    document.querySelectorAll('[data-brand-id]').forEach((el) => (el.textContent = cfg.troop_id));
    document.title = `Admin · ${cfg.troop_id}`;
  }
  try {
    me = await api('/me');
    if (me.role !== 'admin') throw new Error('door session');
    enterApp();
  } catch { renderLogin(); }
}

async function renderLogin() {
  $('screen-login').hidden = false; $('screen-app').hidden = true;
  const list = await api('/staff-list').catch(() => []);
  const sel = $('login-staff');
  sel.innerHTML = list.filter((s) => s.role === 'admin')
    .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') ||
    '<option value="">No admin accounts — run create-staff on the Pi</option>';
}
$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    me = await jpost('/login', { staff_id: Number($('login-staff').value), pin: $('login-pass').value });
    if (me.role !== 'admin') { $('login-error').textContent = 'That account is door staff — admin required.'; return; }
    enterApp();
  } catch (err) { $('login-error').textContent = err.message; }
};
$('logout').onclick = async () => { await jpost('/logout', {}).catch(() => {}); me = null; renderLogin(); };

function enterApp() {
  $('screen-login').hidden = true; $('screen-app').hidden = false;
  $('logout').textContent = `${me.name} · sign out`;
  showTab('dash');
}

// ----------------------------------------------------------------- tabs ----
const loaders = { dash: loadDash, people: loadPeople, events: loadEvents, txns: loadTxns, messages: loadMessages, reports: loadReports, import: loadImport, staff: loadStaff };
$('tabs').onclick = (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
};
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== `tab-${name}`;
  // keep the active tab visible when the tab row scrolls sideways (phones)
  const active = document.querySelector('#tabs button.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // returned so callers (the dashboard card jumps) can wait for the tab's
  // data to land before scrolling — a fixed timer loses to slow responses
  return loaders[name]();
}

// ------------------------------------------------------------ dashboard ----
async function loadDash() {
  const s = await api('/admin/status');
  const cards = [
    [s.youth_active, 'active youth'], [s.adults_active, 'active adults'],
    [s.visitors, 'visitors'], [s.open_signins, 'on site now'],
    [s.events, 'events'], [s.txns, 'transactions'],
    // clickable tally cards: each jumps to its Reports panel preset to the
    // matching view (renewals template, tc-v43)
    [s.expiring_30 || 0, 'renewals due ≤30 days ›', s.expiring_30 ? 'card-warn' : '', 'renewals'],
    [s.health_missing || 0, 'health forms not on file ›', '', 'health-missing'],
    [s.health_expiring_30 || 0, 'health forms expiring ≤30 days ›', s.health_expiring_30 ? 'card-warn' : '', 'health-expiring'],
    [s.high_risk_missing || 0, 'High Risk forms not on file ›', '', 'hr-missing'],
    [s.high_risk_expiring_30 || 0, 'High Risk forms expiring ≤30 days ›', s.high_risk_expiring_30 ? 'card-warn' : '', 'hr-expiring'],
    [s.optin_missing || 0, 'youth: no messaging opt-in on file ›', '', 'optin-missing'],
    [s.optin_declined || 0, 'youth: messaging declined ›', '', 'optin-declined'],
  ];
  $('dash-cards').innerHTML = cards.map(([n, l, cls, jump]) =>
    `<div class="card ${cls || ''}${jump ? ' card-link' : ''}" ${jump ? `data-jump="${jump}" role="button" tabindex="0" title="Open this list in Reports"` : ''}><b>${n}</b><span>${l}</span></div>`).join('');
  // jump target -> [panel anchor, preset that sets the panel's controls].
  // Presets run BEFORE loadReports() so its own pass fetches the right view
  // (no double fetch); the scroll waits for the data, not a timer — on slow
  // links the old 80ms timer scrolled an empty page, and the panels growing
  // above the target then pushed it back below the fold (tc-v50 fix).
  const jumps = {
    renewals: ['mx-list', null],
    'health-missing': ['hf-list', () => { $('hf-form').value = 'health'; $('hf-view').value = 'missing'; }],
    'health-expiring': ['hf-list', () => { $('hf-form').value = 'health'; $('hf-view').value = '30'; }],
    'hr-missing': ['hf-list', () => { $('hf-form').value = 'high_risk'; $('hf-view').value = 'missing'; }],
    'hr-expiring': ['hf-list', () => { $('hf-form').value = 'high_risk'; $('hf-view').value = '30'; }],
    'optin-missing': ['ov-list', () => { $('ov-view').value = 'missing'; }],
    'optin-declined': ['ov-list', () => { $('ov-view').value = 'declined'; }],
  };
  $('dash-cards').onclick = async (e) => {
    const c = e.target.closest('[data-jump]');
    if (!c || !jumps[c.dataset.jump]) return;
    const [anchor, preset] = jumps[c.dataset.jump];
    if (preset) preset();
    try { await showTab('reports'); } catch { /* partial load — still scroll */ }
    const panel = $(anchor).closest('.panel');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.classList.add('panel-flash');
    setTimeout(() => panel.classList.remove('panel-flash'), 1600);
  };
  $('tool-status').textContent = s.last_ical_sync
    ? `Last iCal sync ${fmtDT(s.last_ical_sync.at)}: +${s.last_ical_sync.added} / ~${s.last_ical_sync.updated} / flagged ${s.last_ical_sync.flagged}`
    : 'iCal has not synced yet.';

  const open = await api('/onsite');
  $('dash-open').innerHTML = open.length ? `<table><tr><th>Name</th><th>Patrol</th><th>Event</th><th>In since</th><th data-nofilter></th></tr>` +
    open.map((r) => `<tr><td>${esc(r.first_name)} ${esc(r.last_name)}</td><td>${esc(r.patrol || '')}</td>
      <td>${esc(r.event_title)}</td>${dtCell(r.signed_at)}
      <td><button class="btn ghost small" data-close="${r.id}">Admin close</button></td></tr>`).join('') + '</table>'
    : '<p class="hint left">Nobody is on site.</p>';
  enhanceTable('dash-open');
  $('dash-open').onclick = async (e) => {
    const b = e.target.closest('button[data-close]');
    if (!b) return;
    if (!confirm('Close this open sign-in without a guardian signature? This is recorded as an admin action.')) return;
    try { await jpost('/admin/close-open', { person_id: Number(b.dataset.close) }); toast('Closed'); loadDash(); }
    catch (err) { toast(err.message, true); }
  };
}
$('tool-backup').onclick = async () => {
  try { const r = await jpost('/admin/backup', {}); toast(`Backup written (${r.signature_count} signatures)`); }
  catch (e) { toast(e.message, true); }
};
$('tool-ical').onclick = async () => {
  try {
    const r = await jpost('/admin/sync-ical', {});
    toast(`Synced: +${r.added} new, ${r.updated} updated, ${r.flagged} flagged, ${r.deleted} removed`);
  } catch (e) { toast(e.message, true); }
};

// --------------------------------------------------------------- people ----
let ppTimer;
for (const id of ['pp-q', 'pp-type', 'pp-status']) {
  $(id).addEventListener('input', () => { clearTimeout(ppTimer); ppTimer = setTimeout(loadPeople, 250); });
}
// Same-name records: the traps behind wrong-person TLC pushes and the
// duplicates worth merging. Cached per session; refreshed after merges.
let dupesAt = 0;
async function loadDupes(force) {
  if (!force && Date.now() - dupesAt < 60000) return; // don't refetch per keystroke
  dupesAt = Date.now();
  const groups = await api('/admin/duplicate-names').catch(() => []);
  const box = $('pp-dupes');
  if (!groups.length) { box.innerHTML = ''; return; }
  const line = (p) => `<button class="btn ghost small" data-dup="${p.id}">
      ${p.is_youth ? 'youth' : 'adult'}${p.member_id ? ` #${esc(p.member_id)}` : ' · no member #'}
      · ${esc(p.is_youth ? (p.patrol || '—') : (p.role || '—'))} · ${p.status}
      ${p.tlc_user_id ? ' · <span class="tag youth" title="TLC id set — write-back can\'t confuse this one">TLC ✓</span>' : ' · <span class="tag warn" title="No TLC id — a same-name push must fail or guess; set the id in the editor">no TLC id</span>'}
    </button>`;
  box.innerHTML = `<details class="panel">
    <summary>⚠ ${groups.length} name${groups.length > 1 ? 's' : ''} shared by more than one person —
      set TLC ids (or merge true duplicates) so the write-back can't pick the wrong one</summary>
    ${groups.map((g) => `<p><b>${esc(g.name)}</b> ${g.people.map(line).join(' ')}</p>`).join('')}
  </details>`;
  box.querySelectorAll('[data-dup]').forEach((b) => (b.onclick = () => openPerson(Number(b.dataset.dup))));
}

async function loadPeople() {
  const q = new URLSearchParams();
  if ($('pp-q').value.trim()) q.set('q', $('pp-q').value.trim());
  if ($('pp-type').value) q.set('type', $('pp-type').value);
  if ($('pp-status').value) q.set('status', $('pp-status').value);
  loadDupes(); // same-name surfacing rides along with the People tab
  const rows = await api('/admin/people?' + q);
  $('pp-list').innerHTML = `<table><tr><th>Name</th><th>Type</th><th>Member #</th><th>Patrol / role</th><th>Status</th><th>Badge</th></tr>` +
    rows.map((p) => `<tr data-id="${p.id}">
      <td>${esc(p.last_name)}, ${esc(p.first_name)}${p.nickname ? ` “${esc(p.nickname)}”` : ''}</td>
      <td><span class="tag ${p.is_youth ? 'youth' : 'adult'}">${p.is_youth ? 'youth' : 'adult'}</span></td>
      <td>${esc(p.member_id || '')}</td><td>${esc(p.is_youth ? p.patrol || '' : p.role || '')}</td>
      <td>${p.status === 'active' ? '' : `<span class="tag warn">${esc(p.status)}</span>`}</td>
      <td>${p.has_badge ? '✓' : ''}</td></tr>`).join('') + '</table>';
  $('pp-list').onclick = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openPerson(Number(tr.dataset.id));
  };
  enhanceTable('pp-list', rows.length >= 500
    ? 'server limit 500 — narrow with the search box above' : '');
}

async function openPerson(id) {
  const p = await api(`/admin/people/${id}`);
  // consent forms feed youth pair opt-ins AND adult self-consent
  const forms = await api('/admin/consent-forms').catch(() => []);
  const d = $('pp-detail');
  $('person-modal').hidden = false; // person editor is a dialog; family/consent layers above it
  let locked = [];
  try { locked = JSON.parse(p.manual_fields || '[]'); } catch { /* ignore */ }
  const lockTag = (field) => locked.includes(field) ? ' <span class="tag off" title="Hand-edited — roster imports will not change this field">🔒</span>' : '';
  const f = (label, field, val) => `<div><label>${label}${lockTag(field)}</label><input data-f="${field}" value="${esc(val || '')}"></div>`;
  d.innerHTML = `
    <h3>${esc(p.first_name)} ${esc(p.last_name)}
      <span class="tag ${p.is_youth ? 'youth' : 'adult'}">${p.is_youth ? 'youth' : 'adult'}</span>
      ${p.member_id ? `<span class="tag off">#${esc(p.member_id)}</span>` : '<span class="tag warn">no member #</span>'}
    </h3>
    ${p.is_youth ? `<div class="photo-row">
      ${p.photo_path ? `<img class="person-photo" src="/photos/${esc(p.photo_path)}" alt="photo">` : '<div class="person-photo empty">no photo</div>'}
      <input id="pp-photo-file" type="file" accept="image/*" hidden>
      <button class="btn ghost small" id="pp-photo-up">${p.photo_path ? 'Replace photo' : 'Add photo'}</button>
      ${p.photo_path ? '<button class="btn ghost small" id="pp-photo-del">Remove</button>' : ''}
    </div>` : ''}
    <div class="kv">
      ${f('First name', 'first_name', p.first_name)}${f('Last name', 'last_name', p.last_name)}
      ${f('Nickname', 'nickname', p.nickname)}
      ${p.is_youth ? f('Patrol', 'patrol', p.patrol) + f('Level', 'level', p.level) : f('Role', 'role', p.role)}
      ${f('Mobile', 'phone_mobile', p.phone_mobile)}${f('Home phone', 'phone_home', p.phone_home)}
      ${f('Work phone', 'phone_work', p.phone_work)}${f('Birthdate', 'birthdate', p.birthdate)}
      ${f('Email', 'email', p.email)}
      ${f('Membership expires (YYYY-MM-DD)', 'membership_expires', p.membership_expires)}
      ${f('Health form submitted (YYYY-MM-DD)', 'health_form_date', p.health_form_date)}
      ${f('High Risk form submitted (YYYY-MM-DD)', 'high_risk_form_date', p.high_risk_form_date)}
      ${f('TLC user id (blank = match by name)', 'tlc_user_id', p.tlc_user_id)}
      <div><label>Status</label>
        <select data-f="status">
          ${['active', 'inactive', 'visitor'].map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
      <div><label>Notes</label><input data-f="notes" value="${esc(p.notes || '')}"></div>
    </div>
    <div class="row wrap">
      <button class="btn ghost small" id="pp-tlc-find">Find TLC id from an event roster…</button>
      <select id="pp-tlc-event" hidden></select>
    </div>
    <div id="pp-tlc-results"></div>
    <p class="hint left">The TLC user id pins this person to one Trail Life Connect profile for the
    attendance write-back — set it whenever two people share a name (e.g. a youth and a parent).
    When set, it is the final answer: if that profile is not on an event's TLC roster, the push
    fails visibly instead of guessing by name.</p>
    <p class="hint left">${locked.length
      ? `🔒 Locked against imports: ${locked.join(', ')} <button class="btn ghost small" id="pp-unlock">let imports manage these again</button>`
      : 'Fields you edit here are locked so roster re-imports never overwrite them.'}</p>
    <div class="row wrap">
      <button class="btn primary small" id="pp-save">Save</button>
      ${!p.member_id ? '<button class="btn ghost small" id="pp-merge">Merge into another record…</button>' : ''}
      <button class="btn ghost small" id="pp-close">Close</button>
    </div>
    ${p.is_youth ? guardianBlock(p, forms) : adultSmsBlock(p, forms) + wardBlock(p)}`;

  $('pp-save').onclick = async () => {
    const body = {};
    d.querySelectorAll('[data-f]').forEach((el) => (body[el.dataset.f] = el.value));
    try { await jpatch(`/admin/people/${id}`, body); toast('Saved'); loadPeople(); openPerson(id); }
    catch (e) { toast(e.message, true); }
  };
  $('pp-close').onclick = closePersonModal;
  if ($('pp-unlock')) $('pp-unlock').onclick = async () => {
    if (!confirm('Unlock all fields on this person? The next roster import may overwrite them with file values.')) return;
    try { await jpatch(`/admin/people/${id}`, { clear_manual: true }); openPerson(id); }
    catch (e) { toast(e.message, true); }
  };

  if ($('pp-photo-up')) {
    $('pp-photo-up').onclick = () => $('pp-photo-file').click();
    $('pp-photo-file').onchange = async () => {
      const file = $('pp-photo-file').files[0];
      if (!file) return;
      const form = new FormData();
      form.append('photo', file);
      const r = await fetch(`/api/admin/people/${id}/photo`, { method: 'POST', body: form, credentials: 'same-origin' });
      if (!r.ok) return toast((await r.json()).error || 'Upload failed', true);
      openPerson(id);
    };
  }
  if ($('pp-photo-del')) $('pp-photo-del').onclick = async () => {
    await api(`/admin/people/${id}/photo`, { method: 'DELETE' }).catch((e) => toast(e.message, true));
    openPerson(id);
  };

  if ($('pp-merge')) $('pp-merge').onclick = async () => {
    const kind = p.is_youth ? 'youth' : 'adult';
    // targets: any OTHER same-type record — roster member OR another
    // unregistered record (duplicate visitor-created parents, open-house
    // finding 2026-08-30; the server always allowed it, the picker didn't)
    const q = prompt(`Merge this record into which other ${kind}? Type part of their name:\n\n(Use this when the same individual has two records — a parent record plus a registered-leader record, or two visitor-created copies of the same parent. Keep the record with the better phone/email/links; merge the other INTO it.)`);
    if (!q) return;
    const hits = (await api(`/admin/people?type=${kind}&q=` + encodeURIComponent(q)))
      .filter((x) => x.id !== id && x.status !== 'merged');
    if (!hits.length) return toast(`No other matching ${kind}.`, true);
    for (const pick of hits) {
      const who = pick.member_id
        ? `${pick.first_name} ${pick.last_name} (roster #${pick.member_id})`
        : `${pick.first_name} ${pick.last_name} (unregistered record${pick.phone_mobile ? `, ${pick.phone_mobile}` : ''})`;
      if (confirm(`Merge into ${who}? Attendance history, guardian links, badge, and TLC mapping transfer to it; this record is retired. Cannot be undone.` +
        (hits.length > 1 ? '\n\n(Cancel to see the next match.)' : ''))) {
        try { await jpost('/admin/merge', { from_id: id, into_id: pick.id }); toast('Merged'); closePersonModal(); loadDupes(true); loadPeople(); }
        catch (e) { toast(e.message, true); }
        return;
      }
    }
  };

  // TLC id lookup: read an event roster from TLC and offer same-surname
  // candidates; clicking one fills the field (Save still commits it).
  $('pp-tlc-find').onclick = () => runTlcLookup(p, id, null);
  async function runTlcLookup(person, personId, eventId) {
    const out = $('pp-tlc-results');
    out.innerHTML = '<p class="hint left">Reading the event roster from Trail Life Connect…</p>';
    // populate the event picker once — linked events only
    const sel = $('pp-tlc-event');
    if (sel.hidden) {
      const evs = (await api('/admin/events?include_past=1').catch(() => []))
        .filter((e) => e.tlc_event_id);
      sel.innerHTML = '<option value="">Auto (nearest linked event)</option>' +
        evs.map((e) => `<option value="${e.id}">${esc(e.title)} — ${new Date(e.start_at).toLocaleDateString()}</option>`).join('');
      sel.hidden = false;
      sel.onchange = () => runTlcLookup(person, personId, sel.value || null);
    }
    try {
      const r = await jpost('/admin/tlc-attendance/lookup', { person_id: personId, event_id: eventId });
      if (!r.candidates.length) {
        out.innerHTML = `<p class="hint left">No one named “${esc(person.last_name)}” on the TLC roster of
          <b>${esc(r.event.title)}</b> — try another event above.</p>`;
        return;
      }
      out.innerHTML = `<p class="hint left">On <b>${esc(r.event.title)}</b>
        (${new Date(r.event.start_at).toLocaleDateString()}) — click to use:</p>` +
        r.candidates.map((c) => `
          <button class="btn ghost small tlc-cand" data-hash="${esc(c.hash)}" ${c.assigned_to ? 'disabled' : ''}>
            ${esc(c.name)} · <code>${esc(c.hash)}</code>
            ${c.exact ? '<span class="tag youth">name matches</span>' : '<span class="tag off">same surname</span>'}
            ${c.current ? '<span class="tag">current</span>' : ''}
            ${c.assigned_to ? `<span class="tag warn">already assigned to ${esc(c.assigned_to)}</span>` : ''}
          </button>`).join(' ') +
        (r.candidates.length > 1 ? '<p class="hint left">⚠ More than one — check which TLC profile (youth vs. adult) is really this person before picking.</p>' : '');
      out.querySelectorAll('.tlc-cand').forEach((b) => (b.onclick = () => {
        d.querySelector('input[data-f="tlc_user_id"]').value = b.dataset.hash;
        toast('TLC id filled in — press Save to keep it.');
      }));
    } catch (e) {
      out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  d.querySelectorAll('[data-gact]').forEach((b) => (b.onclick = () => guardianAction(p, b)));
  d.querySelectorAll('[data-aact]').forEach((b) => (b.onclick = async () => {
    try {
      if (b.dataset.aact === 'on') {
        const formId = $('pp-aform').value ? Number($('pp-aform').value) : null;
        if (!formId) return toast('Pick a stored consent form, or upload the scan right here with "Upload scan & opt in".', true);
        await jpatch(`/admin/people/${id}/opt-in`, { sms_opt_in: 'yes', consent_form_id: formId });
      } else if (b.dataset.aact === 'upload') {
        // adult self-consent: upload the scan and opt in, one step — the
        // signer IS this adult (no youth, no guardian links involved)
        const file = $('pp-afile').files[0];
        if (!file) return toast('Choose the scanned form file first (PDF or photo).', true);
        const signedOn = $('pp-asigned-on').value || new Date().toISOString().slice(0, 10);
        // default filename Last_First_date, same convention as the family modal
        const clean = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9-]/g, '');
        const who = [clean(p.last_name), clean(p.first_name)].filter(Boolean).join('_');
        const form = new FormData();
        form.append('file', file);
        form.append('signed_by', `${p.first_name} ${p.last_name}`);
        form.append('signed_on', signedOn);
        form.append('file_name', who ? `${who}_${signedOn}` : '');
        const r = await fetch('/api/admin/consent-forms', { method: 'POST', body: form, credentials: 'same-origin' });
        const body = await r.json();
        if (!r.ok) return toast(body.error || 'Consent form upload failed.', true);
        await jpatch(`/admin/people/${id}/opt-in`, { sms_opt_in: 'yes', consent_form_id: body.id });
        toast('Form stored and opt-in recorded.');
      } else {
        if (!confirm('Revoke SMS opt-in for this adult?')) return;
        await jpatch(`/admin/people/${id}/opt-in`, { sms_opt_in: 'unknown' });
      }
      openPerson(id);
    } catch (e) { toast(e.message, true); }
  }));
  wireGuardianForms(p);
}

function smsCell(g, forms) {
  const tag = g.sms_opt_in === 'yes'
    ? `<span class="tag youth">✓ opted in</span>`
    : g.sms_opt_in === 'stop' ? `<span class="tag warn">STOP</span>` : `<span class="tag off">no consent</span>`;
  const formRef = g.consent_form_id
    ? ` <a href="/consent-forms/${esc(g.consent_file)}" target="_blank" title="signed by ${esc(g.consent_signed_by || '?')}">${esc(g.consent_file)}</a>` : '';
  const sel = `<select data-gform="${g.id}">
      <option value="">— consent form —</option>
      ${forms.map((f) => `<option value="${f.id}" ${f.id === g.consent_form_id ? 'selected' : ''}>#${f.id} ${esc(f.signed_by || f.file_path)}${f.signed_on ? ` (${esc(f.signed_on)})` : ''}</option>`).join('')}
    </select>`;
  const btn = g.sms_opt_in === 'yes'
    ? `<button class="btn ghost small" data-gact="smsoff" data-gid="${g.id}">revoke opt-in</button>`
    : `<button class="btn ghost small" data-gact="smson" data-gid="${g.id}">opt in</button>`;
  return `${tag}${formRef}<br>${sel} ${btn}`;
}

function guardianBlock(p, forms) {
  return `<h3>Guardians &amp; authorized pickup</h3>
  <p class="hint left">Your edits here are authoritative — roster imports never change them. Consent-form
  designees who aren't in Trail Life Connect can be added below; they don't need to share a last name or email.
  <b>SMS is strictly opt-in per youth/guardian pair</b> — opting in requires attaching the signed consent form
  (one uploaded form can cover several pairs and several youth).</p>
  <div class="tbl"><table><tr><th>Name</th><th>Relationship</th><th>Phone</th><th>Authorized</th><th>Primary</th><th>SMS consent</th><th>Source</th><th></th></tr>
  ${p.guardians.map((g) => `<tr>
    <td>${esc(g.first_name)} ${esc(g.last_name)}</td><td>${esc(g.relationship || '')}</td>
    <td>${esc(g.phone_mobile || '')}</td>
    <td><button class="btn ghost small" data-gact="auth" data-gid="${g.id}" data-val="${g.authorized ? 0 : 1}">
      ${g.authorized ? '✓ yes — revoke' : '✗ no — authorize'}</button></td>
    <td>${g.is_primary ? '★ primary' : `<button class="btn ghost small" data-gact="primary" data-gid="${g.id}">make primary</button>`}</td>
    <td>${smsCell(g, forms)}</td>
    <td>${esc(g.source)}</td>
    <td>${g.source === 'manual' ? `<button class="btn ghost small" data-gact="del" data-gid="${g.id}">remove</button>` : ''}</td>
  </tr>`).join('')}</table></div>

  <button class="btn primary small" id="pp-family">＋ Add guardian / consent (one or many youth)…</button>
  <p class="hint left">Opens a form where you pick or create the adult, tick every youth it applies to,
  and attach the signed consent form once for all of them.</p>`;
}

function wireGuardianForms(p) {
  if ($('pp-family')) $('pp-family').onclick = () => openFamilyModal(p);
}

// ------------------------------------- family guardian/consent modal ----
// Apply one adult + opt-in + consent form to any number of youth at once.
// Convention: closes automatically on a successful save (with a toast);
// stays open showing the error otherwise.
const fam = { fromPerson: null, guardianId: null, guardianName: null, youths: [], fnameEdited: false, signedByEdited: false };

// "Signed by" follows the selected adult (or the new-adult name fields)
// until the operator types their own value — same convention as the
// suggested file name below.
function famSuggestSignedBy() {
  if (fam.signedByEdited) return;
  let name = '';
  if ($('fam-gmode-new').checked) {
    name = `${$('fam-nfirst').value.trim()} ${$('fam-nlast').value.trim()}`.trim();
  } else if (fam.guardianName) {
    name = `${fam.guardianName.first} ${fam.guardianName.last}`;
  }
  $('fam-signed-by').value = name;
}

// Default consent-form file name: Guardian Last_First + signed-on date
// (falls back to today's upload date). Live-updates until the operator
// types their own name into the field.
function famSuggestFname() {
  if (fam.fnameEdited) return;
  let last = '', first = '';
  if ($('fam-gmode-new').checked) {
    last = $('fam-nlast').value.trim(); first = $('fam-nfirst').value.trim();
  } else if (fam.guardianName) {
    ({ last, first } = fam.guardianName);
  } else {
    const parts = $('fam-signed-by').value.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) { last = parts[parts.length - 1]; first = parts.slice(0, -1).join(' '); }
    else first = parts[0] || '';
  }
  const clean = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9-]/g, '');
  const who = [clean(last), clean(first)].filter(Boolean).join('_');
  const date = $('fam-signed-on').value || new Date().toISOString().slice(0, 10);
  $('fam-fname').value = who ? `${who}_${date}` : '';
}

async function openFamilyModal(p) {
  fam.fromPerson = p;
  fam.guardianId = null;
  fam.guardianName = null;
  fam.fnameEdited = false;
  fam.signedByEdited = false;
  $('fam-fname').value = '';
  $('fam-error').textContent = '';
  $('fam-gsearch').value = ''; $('fam-gresults').innerHTML = '';
  $('fam-gpicked').hidden = true;
  $('fam-nfirst').value = ''; $('fam-nlast').value = ''; $('fam-nphone').value = '';
  $('fam-rel').value = ''; $('fam-primary').checked = false;
  $('fam-optin').checked = false; $('fam-consent-wrap').hidden = true;
  $('fam-file').value = ''; $('fam-signed-by').value = ''; $('fam-signed-on').value = '';
  $('fam-gmode-existing').checked = true;
  $('fam-existing-wrap').hidden = false; $('fam-new-wrap').hidden = true;
  $('fam-ysearch').value = '';

  const [youths, forms] = await Promise.all([
    api('/admin/people?type=youth'),
    api('/admin/consent-forms').catch(() => []),
  ]);
  fam.youths = youths.filter((y) => y.status !== 'merged');
  $('fam-form').innerHTML = '<option value="">— pick an uploaded form —</option>' +
    forms.map((f) => `<option value="${f.id}">${esc(f.file_path)}${f.signed_by ? ` · ${esc(f.signed_by)}` : ''}${f.signed_on ? ` (${esc(f.signed_on)})` : ''}</option>`).join('');
  renderFamYouthList(p ? [p.id] : []);
  $('adm-modal').hidden = false;
}

function renderFamYouthList(preChecked) {
  const q = $('fam-ysearch').value.trim().toLowerCase();
  const checked = new Set(preChecked ||
    [...document.querySelectorAll('#fam-ylist input:checked')].map((c) => Number(c.value)));
  $('fam-ylist').innerHTML = fam.youths
    .filter((y) => !q || `${y.first_name} ${y.last_name} ${y.nickname || ''}`.toLowerCase().includes(q))
    .map((y) => `<label><input type="checkbox" value="${y.id}" ${checked.has(y.id) ? 'checked' : ''}>
      ${esc(y.last_name)}, ${esc(y.first_name)}${y.patrol ? ` <span class="tag off">${esc(y.patrol)}</span>` : ''}</label>`)
    .join('') || '<p class="hint left">No youth match.</p>';
}

// keep the suggested "Signed by" + file name current until the operator
// edits them (clearing a field hands it back to the auto-suggestion)
$('fam-fname').oninput = () => { fam.fnameEdited = $('fam-fname').value.trim() !== ''; };
$('fam-signed-on').onchange = famSuggestFname;
$('fam-signed-by').oninput = () => {
  fam.signedByEdited = $('fam-signed-by').value.trim() !== '';
  famSuggestFname();
};
$('fam-nfirst').oninput = () => { famSuggestSignedBy(); famSuggestFname(); };
$('fam-nlast').oninput = () => { famSuggestSignedBy(); famSuggestFname(); };
$('fam-file').onchange = famSuggestFname;

function closeFamilyModal() { $('adm-modal').hidden = true; }
function closePersonModal() { $('person-modal').hidden = true; }
// Esc closes the top-most layer; clicking the dark backdrop closes that layer
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('adm-modal').hidden) closeFamilyModal();
  else if (!$('person-modal').hidden) closePersonModal();
  else if (!$('event-modal').hidden) closeEventModal();
  else if (!$('txn-modal').hidden) closeTxnModal();
});
document.addEventListener('mousedown', (e) => {
  if (e.target.id === 'adm-modal') closeFamilyModal();
  if (e.target.id === 'person-modal') closePersonModal();
  if (e.target.id === 'event-modal') closeEventModal();
  if (e.target.id === 'txn-modal') closeTxnModal();
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'ev-modal-close') closeEventModal();
  if (e.target.id === 'tx-modal-close') closeTxnModal();
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'fam-ysearch') renderFamYouthList();
  if (e.target.id === 'fam-gsearch') {
    clearTimeout(fam.timer);
    fam.timer = setTimeout(async () => {
      const q = $('fam-gsearch').value.trim();
      const box = $('fam-gresults'); box.innerHTML = '';
      if (q.length < 2) return;
      for (const a of (await api('/admin/people?type=adult&q=' + encodeURIComponent(q))).slice(0, 6)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${a.first_name} ${a.last_name}${a.member_id ? ` (#${a.member_id})` : ''}`;
        b.onclick = () => {
          fam.guardianId = a.id;
          fam.guardianName = { last: a.last_name, first: a.first_name };
          $('fam-gpicked').textContent = `Selected: ${a.first_name} ${a.last_name}`;
          $('fam-gpicked').hidden = false;
          box.innerHTML = ''; $('fam-gsearch').value = '';
          famSuggestSignedBy();
          famSuggestFname();
        };
        box.appendChild(b);
      }
    }, 250);
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'fam-gmode-existing' || e.target.id === 'fam-gmode-new') {
    const useNew = $('fam-gmode-new').checked;
    $('fam-existing-wrap').hidden = useNew;
    $('fam-new-wrap').hidden = !useNew;
    famSuggestSignedBy(); famSuggestFname();
  }
  if (e.target.id === 'fam-optin') $('fam-consent-wrap').hidden = !$('fam-optin').checked;
});
document.addEventListener('click', async (e) => {
  if (e.target.id === 'person-close') closePersonModal();
  if (e.target.id === 'fam-close' || e.target.id === 'fam-cancel') closeFamilyModal();
  if (e.target.id !== 'fam-apply') return;
  const err = (m) => ($('fam-error').textContent = m);
  const youthIds = [...document.querySelectorAll('#fam-ylist input:checked')].map((c) => Number(c.value));
  if (!youthIds.length) return err('Tick at least one youth.');
  const useNew = $('fam-gmode-new').checked;
  if (!useNew && !fam.guardianId) return err('Search and select the adult (or switch to "New adult").');
  if (useNew && (!$('fam-nfirst').value.trim() || !$('fam-nlast').value.trim())) {
    return err('Enter the new adult\'s first and last name.');
  }
  let consentFormId = null;
  if ($('fam-optin').checked) {
    const file = $('fam-file').files[0];
    if (file) {
      const form = new FormData();
      form.append('file', file);
      form.append('signed_by', $('fam-signed-by').value.trim());
      form.append('signed_on', $('fam-signed-on').value);
      form.append('file_name', $('fam-fname').value.trim());
      const r = await fetch('/api/admin/consent-forms', { method: 'POST', body: form, credentials: 'same-origin' });
      const body = await r.json();
      if (!r.ok) return err(body.error || 'Consent form upload failed.');
      consentFormId = body.id;
    } else if ($('fam-form').value) {
      consentFormId = Number($('fam-form').value);
    } else {
      return err('Opt-in needs a consent form — pick one or upload the scan.');
    }
  }
  try {
    const r = await jpost('/admin/guardian-bulk', {
      guardian_id: useNew ? undefined : fam.guardianId,
      new_guardian: useNew ? {
        first_name: $('fam-nfirst').value.trim(),
        last_name: $('fam-nlast').value.trim(),
        phone_mobile: $('fam-nphone').value.trim() || null,
      } : undefined,
      youth_ids: youthIds,
      relationship: $('fam-rel').value.trim() || undefined,
      is_primary: $('fam-primary').checked,
      opt_in: $('fam-optin').checked,
      consent_form_id: consentFormId || undefined,
    });
    closeFamilyModal();
    toast(`Applied to ${r.applied} youth ✓`);
    if (fam.fromPerson) openPerson(fam.fromPerson.id);
    loadPeople();
  } catch (e2) { err(e2.message); }
});
// Adult self-consent for SMS — same strictly-opt-in rule as youth pairs:
// opting in requires a stored signed consent form. Used when messaging
// adults at adult-tracked events.
function adultSmsBlock(p, forms) {
  const tag = p.sms_opt_in === 'yes'
    ? `<span class="tag youth">✓ opted in</span>`
    : p.sms_opt_in === 'stop' ? `<span class="tag warn">STOP</span>` : `<span class="tag off">no consent</span>`;
  const form = forms.find((x) => x.id === p.consent_form_id);
  const formRef = form
    ? ` <a href="/consent-forms/${esc(form.file_path)}" target="_blank" title="signed by ${esc(form.signed_by || '?')}">${esc(form.file_path)}</a>` : '';
  const sel = `<select id="pp-aform">
      <option value="">— consent form —</option>
      ${forms.map((x) => `<option value="${x.id}" ${x.id === p.consent_form_id ? 'selected' : ''}>#${x.id} ${esc(x.signed_by || x.file_path)}${x.signed_on ? ` (${esc(x.signed_on)})` : ''}</option>`).join('')}
    </select>`;
  const btn = p.sms_opt_in === 'yes'
    ? `<button class="btn ghost small" data-aact="off">revoke opt-in</button>`
    : `<button class="btn ghost small" data-aact="on">opt in</button>`;
  return `<h3>SMS messaging (this adult)</h3>
  <p class="hint left">Adults at adult-tracked events can be texted directly — <b>strictly opt-in</b>, same as
  youth families: opting in requires attaching their signed consent form. Upload their own signed form
  right here (works for adults with no youth in the troop), or reuse a stored family form that names them.</p>
  <div class="row wrap">${tag}${formRef} ${sel} ${btn}</div>
  <div class="row wrap">
    <input id="pp-afile" type="file" accept=".pdf,image/*" aria-label="Scanned consent form">
    <label for="pp-asigned-on">Date signed
      <input id="pp-asigned-on" type="date" title="The date the form was signed — used in the file name (today's date if left blank)"></label>
    <button class="btn primary small" data-aact="upload">Upload scan &amp; opt in</button>
  </div>
  <p class="hint left">The upload files under this adult's own name (signed by ${esc(p.first_name)} ${esc(p.last_name)})
  and opts them in — one step, no youth involved. The form joins the shared consent-form list like any other.</p>`;
}

function wardBlock(p) {
  if (!p.wards.length) return '';
  return `<h3>Authorized for</h3><div class="tbl"><table><tr><th>Youth</th><th>Patrol</th><th>Authorized</th></tr>
    ${p.wards.map((w) => `<tr><td>${esc(w.first_name)} ${esc(w.last_name)}</td><td>${esc(w.patrol || '')}</td>
      <td>${w.authorized ? '✓' : '✗'}${w.is_primary ? ' · primary' : ''}</td></tr>`).join('')}</table></div>`;
}
async function guardianAction(p, btn) {
  const gid = btn.dataset.gid;
  try {
    if (btn.dataset.gact === 'auth') await jpatch(`/admin/people/${p.id}/guardians/${gid}`, { authorized: btn.dataset.val === '1' });
    if (btn.dataset.gact === 'primary') await jpatch(`/admin/people/${p.id}/guardians/${gid}`, { is_primary: true });
    if (btn.dataset.gact === 'smson') {
      const sel = document.querySelector(`select[data-gform="${gid}"]`);
      const formId = sel && sel.value ? Number(sel.value) : null;
      if (!formId) return toast('Pick the signed consent form first (upload it below if needed).', true);
      await jpatch(`/admin/people/${p.id}/guardians/${gid}`, { sms_opt_in: 'yes', consent_form_id: formId });
    }
    if (btn.dataset.gact === 'smsoff') {
      if (!confirm('Revoke SMS opt-in for this guardian on this youth?')) return;
      await jpatch(`/admin/people/${p.id}/guardians/${gid}`, { sms_opt_in: 'unknown' });
    }
    if (btn.dataset.gact === 'del') {
      if (!confirm('Remove this manually-added guardian link?')) return;
      await jdel(`/admin/people/${p.id}/guardians/${gid}`);
    }
    openPerson(p.id);
  } catch (e) { toast(e.message, true); }
}

// --------------------------------------------------------------- events ----
async function loadEvents() {
  const rows = await api('/admin/events' + ($('ev-past').checked ? '?include_past=1' : ''));
  $('ev-list').innerHTML = `<table><tr><th>Title</th><th>Starts</th><th>Ends</th><th>Source</th><th>Adults</th><th>Txns</th><th data-nofilter></th></tr>` +
    rows.map((e) => `<tr data-id="${e.id}">
      <td>${esc(e.title)}${e.removed_from_feed ? ' <span class="tag warn">gone from feed</span>' : ''}</td>
      ${dtCell(e.start_at)}${dtCell(e.end_at)}
      <td>${e.source}${e.is_past ? ' <span class="tag off">past</span>' : ''}</td>
      <td>${e.track_adults ? '✓ tracked' : '—'}</td><td>${e.txn_count}</td>
      <td>${e.txn_count === 0 ? `<button class="btn ghost small" data-del="${e.id}">delete</button>` : ''}</td></tr>`).join('') + '</table>';
  enhanceTable('ev-list');
  $('ev-list').onclick = async (ev) => {
    const del = ev.target.closest('button[data-del]');
    if (del) {
      if (!confirm('Delete this event?')) return;
      try { await jdel(`/admin/events/${del.dataset.del}`); loadEvents(); } catch (e) { toast(e.message, true); }
      return;
    }
    const tr = ev.target.closest('tr[data-id]');
    if (tr) openEvent(rows.find((r) => r.id === Number(tr.dataset.id)));
  };
}
const toLocal = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function openEvent(e) {
  // popout dialog like the person editor — no more inline panel under the list
  $('ev-modal-title').innerHTML =
    `${e ? 'Edit' : 'New'} event ${e && e.source === 'ical' ? '<span class="tag off">from iCal — times resync nightly</span>' : ''}`;
  const d = $('ev-detail');
  d.innerHTML = `
    <div class="kv">
      <div><label>Title</label><input id="evf-title" value="${esc(e?.title || '')}"></div>
      <div><label>Location</label><input id="evf-loc" value="${esc(e?.location || '')}"></div>
      <div><label>Starts</label><input id="evf-start" type="datetime-local" value="${toLocal(e?.start_at)}"></div>
      <div><label>Ends</label><input id="evf-end" type="datetime-local" value="${toLocal(e?.end_at)}"></div>
      <div><label>Adult attendance</label><select id="evf-adults">
        <option value="0" ${!e?.track_adults ? 'selected' : ''}>Not tracked</option>
        <option value="1" ${e?.track_adults ? 'selected' : ''}>Tracked (headcount)</option></select></div>
      <div><label>High Adventure medical form ${e && e.source === 'ical' ? '<span class="tag off" title="App-owned — the iCal sync never changes this">app-owned</span>' : ''}</label>
        <select id="evf-haform">
        <option value="0" ${!e?.requires_high_adventure_form ? 'selected' : ''}>Not required</option>
        <option value="1" ${e?.requires_high_adventure_form ? 'selected' : ''}>Required — kiosk flags missing/expired at sign-in</option></select></div>
      <div><label>Parent permission form
          ${e?.permission_form_source === 'manual' ? '<span class="tag off" title="Hand-set — the TLC sweep will not change this">manual</span>' : ''}</label>
        <select id="evf-perm">
        <option value="auto" ${e?.permission_form_source !== 'manual' ? 'selected' : ''}>Auto from TLC (currently: ${e?.requires_permission_form ? 'required' : 'not required'})</option>
        <option value="1" ${e?.permission_form_source === 'manual' && e?.requires_permission_form ? 'selected' : ''}>Required (manual)</option>
        <option value="0" ${e?.permission_form_source === 'manual' && !e?.requires_permission_form ? 'selected' : ''}>Not required (manual)</option></select></div>
      <div><label>Unsigned permission forms at check-in
          ${e?.permission_block_source === 'manual' ? '<span class="tag off" title="Hand-set — the global default and the sweep will not change this">manual</span>' : ''}</label>
        <select id="evf-permblock">
        <option value="auto" ${e?.permission_block_source !== 'manual' ? 'selected' : ''}>Follow global default (currently: ${e?.permission_block ? 'Block' : 'Warn'})</option>
        <option value="0" ${e?.permission_block_source === 'manual' && !e?.permission_block ? 'selected' : ''}>Warn (manual) — banner only, never blocks</option>
        <option value="1" ${e?.permission_block_source === 'manual' && e?.permission_block ? 'selected' : ''}>Block (manual) — until re-check clears or staff overrides (recorded)</option></select></div>
      <div><label>SMS reminder delay (min after end; blank = default 30)</label>
        <input id="evf-notify" type="number" min="0" value="${e?.notify_after_min ?? ''}"></div>
      ${e ? `<div><label>TLC attendance push ${e.tlc_event_id ? '<span class="tag" title="Matched to a Trail Life Connect event through the iCal feed">linked ✓</span>' : '<span class="tag off" title="Manual events have no TLC calendar entry to push to">not linked</span>'}</label>
        <select id="evf-tlc" ${e.tlc_event_id ? '' : 'disabled'}>
          <option value="" ${e.tlc_push == null ? 'selected' : ''}>Follow global setting</option>
          <option value="0" ${e.tlc_push === 0 ? 'selected' : ''}>Never push this event</option>
          <option value="1" ${e.tlc_push === 1 ? 'selected' : ''}>Always push this event</option></select></div>` : ''}
    </div>
    ${e ? '<div id="evf-forms"></div>' : ''}
    <div class="row wrap">
      <button class="btn primary small" id="evf-save">Save</button>
      <button class="btn ghost small" id="evf-close">Close</button>
    </div>`;
  d.hidden = false;
  $('event-modal').hidden = false;
  if (e) loadEventForms(e.id);
  $('evf-close').onclick = closeEventModal;
  $('evf-save').onclick = async () => {
    const body = {
      title: $('evf-title').value.trim(), location: $('evf-loc').value.trim(),
      start_at: new Date($('evf-start').value).toISOString(),
      end_at: new Date($('evf-end').value).toISOString(),
      track_adults: $('evf-adults').value === '1',
      requires_high_adventure_form: $('evf-haform').value === '1',
      notify_after_min: $('evf-notify').value === '' ? null : Number($('evf-notify').value),
    };
    // permission requirement: only a manual choice takes the flag over from
    // the TLC sweep; picking Auto hands it back
    const perm = $('evf-perm').value;
    if (perm === 'auto') {
      if (e && e.permission_form_source === 'manual') body.permission_form_source = 'auto';
    } else {
      body.requires_permission_form = perm === '1';
    }
    // Warn/Block: same manual-wins dance against the global default
    const pblock = $('evf-permblock').value;
    if (pblock === 'auto') {
      if (e && e.permission_block_source === 'manual') body.permission_block_source = 'auto';
    } else {
      body.permission_block = pblock === '1';
    }
    if (e && $('evf-tlc')) {
      body.tlc_push = $('evf-tlc').value === '' ? null : Number($('evf-tlc').value);
    }
    try {
      if (e) await jpatch(`/admin/events/${e.id}`, body);
      else await jpost('/events', body);
      closeEventModal(); loadEvents(); toast('Saved');
    } catch (err) { toast(err.message, true); }
  };
}
// per-event permission-form status: per-youth signed list + fetched_at,
// TLC refresh, and the manual export-upload fallback
async function loadEventForms(id) {
  const box = $('evf-forms');
  if (!box) return;
  const s = await api(`/admin/events/${id}/form-status`).catch(() => null);
  if (!s) { box.innerHTML = ''; return; }
  if (!s.required) {
    // the refresh affordance must be reachable from here too — right after
    // enabling the switch NOTHING is flagged yet, and refreshEvent() sweeps
    // the grid first when the slug is missing, so this button also flips
    // the requirement on if TLC says so (live Phase-A finding)
    box.innerHTML = s.enabled
      ? `<p class="hint left">No parent permission form required for this event (per TLC — override above if
           that's wrong).</p>
         ${s.linked ? '<div class="row wrap"><button class="btn ghost small" id="evf-forms-refresh">Check TLC now</button></div>' : ''}`
      : '<p class="hint left">Permission-form tracking is off (enable it on the Import tab).</p>';
    if ($('evf-forms-refresh')) $('evf-forms-refresh').onclick = async () => {
      try { await jpost(`/admin/events/${id}/refresh-forms`, {}); toast('Checked TLC'); loadEventForms(id); }
      catch (e) { toast(e.message, true); }
    };
    return;
  }
  const signed = s.youth.filter((y) => y.signed);
  box.innerHTML = `
    <h4>Permission forms — ${signed.length} signed of ${s.youth.length} youth on file
      ${s.block ? '<span class="tag warn">blocking</span>' : ''}</h4>
    <p class="hint left">${s.fetched_at ? `As of ${fmtDT(s.fetched_at)}.` : 'Never fetched yet.'}
      Parents often sign at the last minute — refresh before departure.
      ${s.linked ? '' : '⚠ This event isn\'t linked to a TLC calendar entry, so only a manual upload can populate it.'}</p>
    <div class="row wrap">
      ${s.enabled && s.linked ? '<button class="btn ghost small" id="evf-forms-refresh">Refresh from TLC now</button>' : ''}
      <input id="evf-forms-file" type="file" accept=".xlsx" aria-label="Event participants export">
      <button class="btn ghost small" id="evf-forms-upload">Upload participants export</button>
    </div>
    <div class="tbl">${s.youth.length
      ? '<table><tr><th>Youth</th><th>Patrol</th><th>Signed</th></tr>' + s.youth.map((y) => `<tr>
          <td>${esc(y.last_name)}, ${esc(y.first_name)}</td><td>${esc(y.patrol || '')}</td>
          <td data-sort="${y.signed}">${y.signed ? '✓' : '<span class="tag warn">not signed</span>'}</td>
        </tr>`).join('') + '</table>'
      : '<p class="hint left">No per-youth data yet — refresh from TLC or upload the export.</p>'}</div>`;
  if ($('evf-forms-refresh')) $('evf-forms-refresh').onclick = async () => {
    try { await jpost(`/admin/events/${id}/refresh-forms`, {}); toast('Refreshed'); loadEventForms(id); }
    catch (e) { toast(e.message, true); }
  };
  $('evf-forms-upload').onclick = async () => {
    const file = $('evf-forms-file').files[0];
    if (!file) return toast('Choose the participants export first (TLC → event → export).', true);
    const form = new FormData();
    form.append('file', file);
    const r = await fetch(`/api/admin/events/${id}/form-upload`, { method: 'POST', body: form, credentials: 'same-origin' });
    const body = await r.json();
    if (!r.ok) return toast(body.error || 'Upload failed.', true);
    toast(`Stored ${body.stored} youth statuses.`); loadEventForms(id);
  };
}

function closeEventModal() { $('event-modal').hidden = true; $('ev-detail').hidden = true; }
$('ev-new').onclick = () => openEvent(null);
$('ev-past').onchange = loadEvents;

// ---------------------------------------------------------------- staff ----
async function loadStaff() {
  const rows = await api('/admin/staff');
  $('st-list').innerHTML = `<table><tr><th>Name</th><th>Role</th><th>Signs in with</th><th>Status</th><th data-nofilter></th></tr>` +
    rows.map((s) => `<tr>
      <td>${esc(s.name)}</td>
      <td><span class="tag ${s.role === 'admin' ? 'warn' : 'youth'}">${s.role}</span></td>
      <td>${s.has_pin ? 'PIN' + (s.has_password ? ' <span class="tag off" title="PIN overrides the password">overrides password</span>' : '') : s.has_password ? 'password' : '<span class="tag warn">no credential!</span>'}</td>
      <td>${s.active ? 'active' : '<span class="tag off">inactive</span>'}</td>
      <td class="row wrap">
        <button class="btn ghost small" data-sact="pin" data-sid="${s.id}">${s.has_pin ? 'Change PIN' : 'Set PIN'}</button>
        ${s.has_pin ? `<button class="btn ghost small" data-sact="clearpin" data-sid="${s.id}">Clear PIN</button>` : ''}
        ${s.role === 'admin' || s.has_password ? `<button class="btn ghost small" data-sact="password" data-sid="${s.id}">Set password</button>` : ''}
        <button class="btn ghost small" data-sact="rename" data-sid="${s.id}">Rename</button>
        <button class="btn ghost small" data-sact="active" data-sid="${s.id}" data-val="${s.active ? 0 : 1}">${s.active ? 'Deactivate' : 'Reactivate'}</button>
      </td></tr>`).join('') + '</table>';
  $('st-list').querySelectorAll('button[data-sact]').forEach((b) => (b.onclick = () => staffAction(b, rows)));
  enhanceTable('st-list');
}
async function staffAction(btn, rows) {
  const id = Number(btn.dataset.sid);
  const s = rows.find((r) => r.id === id);
  try {
    if (btn.dataset.sact === 'pin') {
      const pin = prompt(`New PIN for ${s.name} (4–8 digits):${s.role === 'admin' ? '\n\nNote: setting a PIN means it replaces their password at sign-in.' : ''}`);
      if (!pin) return;
      await jpatch(`/admin/staff/${id}`, { pin });
    }
    if (btn.dataset.sact === 'clearpin') {
      if (!confirm(`Clear ${s.name}'s PIN?${s.has_password ? ' They will sign in with their password again.' : ' They have NO password — they will be locked out until you set a credential.'}`)) return;
      await jpatch(`/admin/staff/${id}`, { clear_pin: true });
    }
    if (btn.dataset.sact === 'password') {
      const password = prompt(`New password for ${s.name}:`);
      if (!password) return;
      await jpatch(`/admin/staff/${id}`, { password });
    }
    if (btn.dataset.sact === 'rename') {
      const name = prompt('New name:', s.name);
      if (!name || name === s.name) return;
      await jpatch(`/admin/staff/${id}`, { name });
    }
    if (btn.dataset.sact === 'active') {
      const activating = btn.dataset.val === '1';
      if (!activating && !confirm(`Deactivate ${s.name}? They are signed out everywhere immediately.`)) return;
      await jpatch(`/admin/staff/${id}`, { active: activating });
    }
    toast('Saved'); loadStaff();
  } catch (e) { toast(e.message, true); }
}
document.addEventListener('change', (e) => {
  if (e.target.id === 'st-role') {
    $('st-secret').placeholder = e.target.value === 'admin' ? 'Password' : 'PIN';
  }
});
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'st-add') return;
  const role = $('st-role').value;
  try {
    await jpost('/admin/staff', {
      name: $('st-name').value.trim(), role,
      pin: role === 'door' ? $('st-secret').value.trim() : undefined,
      password: role === 'admin' ? $('st-secret').value.trim() : undefined,
    });
    $('st-name').value = ''; $('st-secret').value = ''; $('st-error').textContent = '';
    toast('Staff added'); loadStaff();
  } catch (err) { $('st-error').textContent = err.message; }
});

// ----------------------------------------------------------------- txns ----
async function loadTxns() {
  const events = await api('/admin/events?include_past=1'); // txn/report filters need history
  const sel = $('tx-event');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All events</option>' +
    events.map((e) => `<option value="${e.id}">${esc(e.title)} · ${fmtDT(e.start_at)}</option>`).join('');
  sel.value = cur;
  sel.onchange = renderTxns;
  renderTxns();
}
async function renderTxns() {
  const evId = $('tx-event').value;
  $('tx-csv').href = '/api/admin/export/attendance.csv' + (evId ? `?event_id=${evId}` : '');
  const rows = await api('/admin/txns' + (evId ? `?event_id=${evId}` : ''));
  $('tx-list').innerHTML = `<table><tr><th>When</th><th>Dir</th><th>People</th><th>Event</th><th>Signer</th><th>Staff</th><th>Flags</th></tr>` +
    rows.map((t) => `<tr data-id="${t.id}">
      ${dtCell(t.signed_at)}
      <td data-sort="${t.direction}"><span class="tag ${t.direction === 'in' ? 'youth' : 'warn'}">${t.direction.toUpperCase()}</span></td>
      <td>${esc(t.people || '')}</td><td>${esc(t.event_title)}</td>
      <td>${esc(t.signer_name || t.signer_name_override || '')}</td><td>${esc(t.staff_name)}</td>
      <td>${t.voided_by_txn_id ? '<span class="tag warn">voided</span>' : ''}
          ${t.forced ? '<span class="tag warn">override</span>' : ''}
          ${t.close_method === 'admin_close' ? '<span class="tag off">admin</span>' : ''}</td></tr>`).join('') + '</table>';
  $('tx-list').onclick = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openTxn(Number(tr.dataset.id));
  };
  enhanceTable('tx-list', rows.length >= 200
    ? 'newest 200 — pick an event above to see more' : '');
}
async function openTxn(id) {
  const t = await api(`/admin/txns/${id}`);
  // popout dialog like the person editor — no more inline panel under the list
  $('tx-modal-title').textContent = `Transaction #${t.id} — ${t.direction.toUpperCase()} · ${t.event_title}`;
  const d = $('tx-detail');
  d.innerHTML = `
    <div class="kv">
      <div><label>Signed at</label><div>${fmtDT(t.signed_at)}</div></div>
      <div><label>Staff</label><div>${esc(t.staff_name)}</div></div>
      <div><label>Signer</label><div>${esc(t.signer_name || t.signer_name_override || '—')}</div></div>
      <div><label>Flags</label><div>${t.forced ? 'override ' : ''}${t.close_method || ''}${t.voided_by_txn_id ? ` · voided by #${t.voided_by_txn_id}` : ''}</div></div>
    </div>
    <div class="tbl"><table><tr><th>Person</th><th>Patrol</th><th>Emergency phones</th><th>Open</th></tr>
      ${t.entries.map((e) => `<tr><td>${esc(e.first_name)} ${esc(e.last_name)}</td><td>${esc(e.patrol || '')}</td>
        <td>${esc([e.emerg_phone_1, e.emerg_phone_2].filter(Boolean).join(' / '))}</td>
        <td>${e.open ? 'still on site' : ''}</td></tr>`).join('')}</table></div>
    ${t.signature_path ? `<h3>Signature</h3><img class="sig-view" src="/signatures/${esc(t.signature_path)}" alt="signature">` : ''}
    <div class="row wrap">
      ${!t.voided_by_txn_id && !t.client_uuid.startsWith('void-') ? '<button class="btn ghost small" id="tx-void">Void (append-only correction)</button>' : ''}
      <button class="btn ghost small" id="tx-close">Close</button>
    </div>`;
  d.hidden = false;
  $('txn-modal').hidden = false;
  $('tx-close').onclick = closeTxnModal;
  if ($('tx-void')) $('tx-void').onclick = async () => {
    if (!confirm('Void this transaction? A correcting record is added; nothing is deleted.')) return;
    try { await jpost(`/admin/txns/${id}/void`, {}); toast('Voided'); closeTxnModal(); renderTxns(); }
    catch (e) { toast(e.message, true); }
  };
}
function closeTxnModal() { $('txn-modal').hidden = true; $('tx-detail').hidden = true; }

// ------------------------------------------------------------- messages ----
let msgTimer = null;
$('sms-recipients').onchange = async () => {
  const mode = $('sms-recipients').value;
  if (mode === 'all' && !confirm('Text ALL opted-in guardians of each youth?\n\nOnly adults whose own link is opted in (with a stored signed form) are ever texted — a second parent must have signed their own form. Each guardian still gets one text per message.')) {
    $('sms-recipients').value = 'primary';
    return;
  }
  try {
    const r = await jput('/admin/sms-recipients', { mode });
    toast(r.mode === 'all' ? 'Texting all opted-in guardians.' : 'Texting the primary guardian only.');
  } catch (e) { toast(e.message, true); }
};
async function loadMessages() {
  api('/admin/sms-recipients').then((s) => {
    if (document.activeElement !== $('sms-recipients')) $('sms-recipients').value = s.mode;
  }).catch(() => {});
  const rows = await api('/admin/messages');
  const kindTag = (m) => m.direction === 'in'
    ? (m.kind === 'reply' ? '<span class="tag warn">reply</span>' : '<span class="tag off">keyword</span>')
    : (m.kind === 'custom' ? '<span class="tag youth">broadcast</span>' : '<span class="tag off">pickup alert</span>');
  $('msg-list').innerHTML = rows.length
    ? `<table><tr><th>In/Out</th><th>When</th><th>Who</th><th>Type</th><th>Message</th><th>Status</th><th data-nofilter></th></tr>` +
      rows.map((m) => `<tr class="${m.direction === 'in' && m.kind === 'reply' ? 'msg-reply' : ''}">
        <td data-sort="${m.direction}">${m.direction === 'in' ? '📥' : '📤'}</td>
        ${dtCell(m.at)}
        <td>${esc(m.guardian_name || m.phone || '?')}</td>
        <td>${kindTag(m)}</td>
        <td class="msg-body">${esc(m.body || '')}</td>
        <td>${esc(m.status || '')}</td>
        <td>${m.direction === 'in' && m.guardian_id
          ? `<button class="btn ghost small" data-msgreply="${m.guardian_id}" data-msgname="${esc(m.guardian_name || m.phone)}">Reply</button>` : ''}</td>
      </tr>`).join('') + '</table>'
    : '<p class="hint left">No messages yet.</p>';
  enhanceTable('msg-list', rows.length >= 200 ? 'newest 200' : '');
  $('msg-list').querySelectorAll('button[data-msgreply]').forEach((b) => (b.onclick = () => {
    $('msg-compose').hidden = false;
    $('msg-compose').dataset.gid = b.dataset.msgreply;
    $('msg-compose-to').textContent = `Reply to ${b.dataset.msgname}`;
    $('msg-compose-text').value = '';
    $('msg-compose-error').textContent = '';
    $('msg-compose-text').focus();
  }));
  // live-ish refresh while the tab is open
  clearInterval(msgTimer);
  msgTimer = setInterval(() => {
    if ($('tab-messages').hidden) return clearInterval(msgTimer);
    loadMessages();
  }, 15000);
}
document.addEventListener('click', async (e) => {
  if (e.target.id === 'msg-refresh') loadMessages();
  if (e.target.id === 'msg-compose-cancel') $('msg-compose').hidden = true;
  if (e.target.id === 'msg-compose-send') {
    const message = $('msg-compose-text').value.trim();
    if (!message) return ($('msg-compose-error').textContent = 'Type the reply first.');
    try {
      await jpost('/admin/sms-reply', { guardian_id: Number($('msg-compose').dataset.gid), message });
      $('msg-compose').hidden = true;
      toast('Reply sent');
      loadMessages();
    } catch (err) { $('msg-compose-error').textContent = err.message; }
  }
});

// -------------------------------------------------------------- reports ----
let rpPersonId = null;
async function loadReports() {
  const events = await api('/admin/events?include_past=1'); // txn/report filters need history
  $('rp-event').innerHTML = '<option value="">All events</option>' +
    events.map((e) => `<option value="${e.id}">${esc(e.title)} · ${fmtDT(e.start_at)}</option>`).join('');
  renderReportLinks();
  // awaited so loadReports() resolving means the panels are populated and
  // the layout has settled — the dashboard card jumps scroll after this
  await Promise.all([loadExpiring(), loadHealthForms(), loadOptin()]);
  const log = await api('/admin/notifications');
  $('rp-notifications').innerHTML = log.length
    ? `<table><tr><th>When</th><th>Youth</th><th>Guardian</th><th>Event</th><th>Status</th></tr>` +
      log.map((n) => `<tr>${dtCell(n.sent_at)}<td>${esc(n.youth_name)}</td>
        <td>${esc(n.guardian_name)}</td><td>${esc(n.event_title)}</td>
        <td data-sort="${esc(n.status)}"><span class="tag ${n.status === 'failed' ? 'warn' : n.status === 'replied_y' ? 'youth' : 'off'}">${esc(n.status)}</span></td></tr>`).join('') + '</table>'
    : '<p class="hint left">No notifications yet (SMS is off until Twilio is configured).</p>';
  enhanceTable('rp-notifications');
}
// membership renewals: expired or expiring within the selected window
async function loadExpiring() {
  const days = $('mx-days').value;
  $('mx-csv').href = `/api/admin/export/expiring.csv?days=${days}`;
  const rows = await api(`/admin/expiring?days=${days}`).catch(() => []);
  $('mx-list').innerHTML = rows.length
    ? `<table><tr><th>Name</th><th>Type</th><th>Member #</th><th>Patrol / role</th><th>Expires</th><th>Days left</th></tr>` +
      rows.map((p) => `<tr>
        <td>${esc(p.last_name)}, ${esc(p.first_name)}</td>
        <td><span class="tag ${p.is_youth ? 'youth' : 'adult'}">${p.is_youth ? 'youth' : 'adult'}</span></td>
        <td>${esc(p.member_id || '')}</td>
        <td>${esc(p.is_youth ? p.patrol || '' : p.role || '')}</td>
        <td>${esc(p.membership_expires)}</td>
        <td data-sort="${p.days_left}">${p.days_left < 0 ? `<span class="tag warn">expired ${-p.days_left}d ago</span>` : p.days_left}</td>
      </tr>`).join('') + '</table>'
    : `<p class="hint left">Nobody expires within ${days} days. 🎉</p>`;
  enhanceTable('mx-list');
}
// health & medical forms: not-on-file / expired-or-expiring, per form kind
async function loadHealthForms() {
  const form = $('hf-form').value;
  const view = $('hf-view').value; // 'missing' or a day window
  const missing = view === 'missing';
  const q = missing ? `form=${form}&view=missing` : `form=${form}&view=expiring&days=${view}`;
  $('hf-csv').href = `/api/admin/export/health-forms.csv?${q}`;
  const rows = await api(`/admin/health-forms?${q}`).catch(() => []);
  const label = form === 'health' ? 'health form' : 'High Risk form';
  api('/admin/checkin-flags').then((f) => {
    if (document.activeElement !== $('hf-flag-checkin')) $('hf-flag-checkin').checked = !!f.health_form;
  }).catch(() => {});
  $('hf-list').innerHTML = rows.length
    ? `<table><tr><th>Name</th><th>Type</th><th>Member #</th><th>Patrol / role</th>${missing ? '' : '<th>Submitted</th><th>Expires</th><th>Days left</th>'}</tr>` +
      rows.map((p) => `<tr>
        <td>${esc(p.last_name)}, ${esc(p.first_name)}</td>
        <td><span class="tag ${p.is_youth ? 'youth' : 'adult'}">${p.is_youth ? 'youth' : 'adult'}</span></td>
        <td>${esc(p.member_id || '')}</td>
        <td>${esc(p.is_youth ? p.patrol || '' : p.role || '')}</td>
        ${missing ? '' : `<td>${esc(p.submitted_on)}</td><td>${esc(p.expires_on || '')}</td>
        <td data-sort="${p.days_left}">${p.days_left < 0 ? `<span class="tag warn">expired ${-p.days_left}d ago</span>` : p.days_left}</td>`}
      </tr>`).join('') + '</table>'
    : `<p class="hint left">${missing ? `Everyone active has a ${label} on file. 🎉` : `No ${label} expires within ${view} days. 🎉`}</p>`;
  enhanceTable('hf-list');
}

// messaging opt-in: youth families + a separate adults section
async function loadOptin() {
  const view = $('ov-view').value;
  $('ov-csv').href = `/api/admin/export/optin.csv?view=${view}`;
  const r = await api(`/admin/optin-report?view=${view}`).catch(() => ({ youth: [], adults: [] }));
  const youthTbl = r.youth.length
    ? `<table><tr><th>Name</th><th>Patrol</th><th>Authorized guardians</th></tr>` +
      r.youth.map((p) => `<tr>
        <td>${esc(p.last_name)}, ${esc(p.first_name)}</td>
        <td>${esc(p.patrol || '')}</td>
        <td data-sort="${p.guardian_count}">${p.guardian_count === 0 ? '<span class="tag warn">no guardians linked</span>' : p.guardian_count}</td>
      </tr>`).join('') + '</table>'
    : `<p class="hint left">${view === 'declined' ? 'No families have declined. 🎉' : 'Every youth family has answered. 🎉'}</p>`;
  const adultTbl = r.adults.length
    ? `<table><tr><th>Name</th><th>Role</th><th>Mobile</th></tr>` +
      r.adults.map((p) => `<tr>
        <td>${esc(p.last_name)}, ${esc(p.first_name)}</td>
        <td>${esc(p.role || '')}</td>
        <td>${esc(p.phone_mobile || '')}</td>
      </tr>`).join('') + '</table>'
    : `<p class="hint left">${view === 'declined' ? 'No adults have opted out.' : 'Every active adult has answered.'}</p>`;
  $('ov-list').innerHTML =
    `<h4>Youth families</h4><div id="ov-youth" class="tbl">${youthTbl}</div>
     <h4>Adults (their own consent)</h4><div id="ov-adults" class="tbl">${adultTbl}</div>`;
  enhanceTable('ov-youth'); enhanceTable('ov-adults');
}

document.addEventListener('change', async (e) => {
  if (['il-from', 'il-to', 'il-limit'].includes(e.target.id)) loadImport();
  if (['pl-from', 'pl-to', 'pl-limit'].includes(e.target.id)) loadPushLog();
  if (e.target.id === 'mx-days') loadExpiring();
  if (e.target.id === 'hf-form' || e.target.id === 'hf-view') loadHealthForms();
  if (e.target.id === 'ov-view') loadOptin();
  if (e.target.id === 'hf-flag-checkin') {
    try {
      await jput('/admin/checkin-flags', { health_form: e.target.checked ? 1 : 0 });
      toast(e.target.checked
        ? 'Check-in badge ON — kiosks flag missing/expired health forms on sign-in.'
        : 'Check-in badge off.');
    } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
  }
});

function reportQuery() {
  const q = new URLSearchParams();
  if ($('rp-from').value) q.set('from', $('rp-from').value);
  if ($('rp-to').value) q.set('to', $('rp-to').value);
  if ($('rp-event').value) q.set('event_id', $('rp-event').value);
  if (rpPersonId) q.set('person_id', rpPersonId);
  return q.toString();
}
function renderReportLinks() {
  const q = reportQuery();
  $('rp-csv-detail').href = '/api/admin/export/attendance.csv' + (q ? `?${q}` : '');
  $('rp-csv-summary').href = '/api/admin/export/summary.csv' + (q ? `?${q}` : '');
}
let rpTimer;
document.addEventListener('input', (e) => {
  if (['rp-from', 'rp-to', 'rp-event'].includes(e.target.id)) renderReportLinks();
  if (e.target.id === 'rp-person') {
    clearTimeout(rpTimer);
    rpPersonId = null; $('rp-person-pick').hidden = true; renderReportLinks();
    rpTimer = setTimeout(async () => {
      const q = $('rp-person').value.trim();
      const box = $('rp-person-results'); box.innerHTML = '';
      if (q.length < 2) return;
      for (const a of (await api('/admin/people?q=' + encodeURIComponent(q))).slice(0, 6)) {
        const b = document.createElement('button');
        b.textContent = `${a.first_name} ${a.last_name}${a.member_id ? ` (#${a.member_id})` : ''}`;
        b.onclick = () => {
          rpPersonId = a.id;
          $('rp-person-pick').textContent = `filtering: ${a.first_name} ${a.last_name} ✕`;
          $('rp-person-pick').hidden = false;
          $('rp-person').value = ''; box.innerHTML = '';
          renderReportLinks();
        };
        box.appendChild(b);
      }
    }, 250);
  }
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'rp-person-pick') {
    rpPersonId = null; e.target.hidden = true; renderReportLinks();
  }
  if (e.target.id === 'rp-run') runReport();
});
async function runReport() {
  const q = reportQuery();
  const rows = await api('/admin/report/summary' + (q ? `?${q}` : ''));
  $('rp-result').innerHTML = rows.length
    ? `<table><tr><th>Name</th><th>Type</th><th>Patrol</th><th>Events</th><th>Sign-ins</th><th>First seen</th><th>Last seen</th></tr>` +
      rows.map((r) => `<tr><td>${esc(r.last_name)}, ${esc(r.first_name)}</td>
        <td><span class="tag ${r.type}">${r.type}</span></td><td>${esc(r.patrol || '')}</td>
        <td>${r.events_attended}</td><td>${r.sign_ins}</td>
        ${dtCell(r.first_seen)}${dtCell(r.last_seen)}</tr>`).join('') + '</table>'
    : '<p class="hint left">No attendance in that range.</p>';
  enhanceTable('rp-result');
}

// ---------------------------------------------------- automated sync ----
let syncTimer = null;
async function loadSync() {
  const s = await api('/admin/roster-sync').catch(() => null);
  if (!s) return;
  // status line: make a silently-broken job visible at a glance
  const bits = [];
  if (!s.configured) bits.push('Not configured — save Trail Life Connect credentials below (or set TLC_EMAIL / TLC_PASSWORD in .env on the server).');
  else if (!s.enabled) bits.push('Disabled (TLC_ENABLED=false).');
  if (s.running) bits.push(`⏳ Sync running (started ${fmtDT(s.started_at)})…`);
  if (s.last_run) {
    bits.push(`Last run ${fmtDT(s.last_run)}: ` + (s.last_status === 'ok'
      ? `✅ ok (${s.last_rows} rows)`
      : `❌ ${esc(s.last_error || 'failed')}`));
  } else if (s.configured) {
    bits.push('No runs yet.');
  }
  $('sync-status').innerHTML = bits.join('<br>') || '';
  $('sync-now').disabled = !!s.running || !s.configured;

  const p = s.pending;
  if (!p) {
    $('sync-pending').innerHTML = s.configured
      ? '<p class="hint left">No pending import — nothing fetched yet, or the last one was approved/discarded.</p>' : '';
  } else {
    const pv = p.preview || {};
    const list = (arr) => (arr || []).map(esc).join(', ');
    $('sync-pending').innerHTML = `
      <div class="panel">
        <h4>Pending import — fetched ${fmtDT(p.fetched_at)}
          ${p.replaced_count ? '<span class="tag off" title="A newer fetch replaced the previous pending import">replaced an older pending import</span>' : ''}
        </h4>
        <p><b>${p.rows}</b> people in file (${pv.youth ?? '?'} youth, ${pv.adults ?? '?'} adults) —
          <b>${(pv.added || []).length}</b> new, <b>${(pv.updated || []).length}</b> updated,
          <b>${(pv.deactivated || []).length}</b> would be deactivated.</p>
        ${(pv.added || []).length ? `<p><b>New:</b> ${list(pv.added)}</p>` : ''}
        ${(pv.updated || []).length ? `<p><b>Updated:</b> ${pv.updated.map((u) => `${esc(u.name)} (${u.fields.map(esc).join(', ')})`).join('; ')}</p>` : ''}
        ${(pv.deactivated || []).length ? `<p class="error"><b>Deactivated:</b> ${list(pv.deactivated)}</p>` : ''}
        <p class="hint left">Diff computed when fetched; approving re-checks everything against the current
        roster (locks, guardians, deactivation scoping) exactly like a manual commit.</p>
        <div class="row wrap">
          <button id="sync-approve" class="btn primary small">Approve import</button>
          <button id="sync-discard" class="btn ghost small">Discard</button>
        </div>
      </div>`;
  }
  // credentials block: source + email only — the password never comes back
  const c = s.credentials || {};
  $('sync-creds-info').innerHTML =
    c.source === 'admin'
      ? (c.readable === false
        ? `⚠ Saved credentials for <b>${esc(c.email)}</b> can no longer be decrypted (the server's CRED_KEY changed or was lost). Re-enter the password below.`
        : `Using credentials saved here: <b>${esc(c.email)}</b> (updated ${fmtDT(c.updated_at)}). Password is ${c.encrypted ? 'encrypted at rest 🔐 and ' : ''}never displayed.`)
      : c.source === 'env'
        ? `Using credentials from <code>.env</code> on the server (<b>${esc(c.email)}</b>). Saving here will override them without touching the file (and encrypt the password at rest).`
        : 'No credentials yet — enter the TLC login the troop uses to view the member list.';
  $('sync-cred-clear').hidden = c.source !== 'admin';
  if (document.activeElement !== $('sync-cred-email') && c.source === 'admin') {
    $('sync-cred-email').value = $('sync-cred-email').value || c.email || '';
  }
  $('sync-cred-pass').placeholder = c.source === 'admin' ? 'New password (blank = keep current)' : 'TLC password';

  // poll while a sync is running so the result appears without a manual refresh
  clearTimeout(syncTimer);
  if (s.running && !$('tab-import').hidden) syncTimer = setTimeout(loadSync, 5000);
}
document.addEventListener('click', async (e) => {
  if (e.target.id === 'sync-now') {
    try { await jpost('/admin/roster-sync/run', {}); toast('Sync started — this can take a couple of minutes.'); loadSync(); }
    catch (err) { toast(err.message, true); }
  }
  if (e.target.id === 'sync-approve') {
    const deact = document.querySelector('#sync-pending .error');
    if (!confirm('Approve this import?' + (deact ? '\n\nIt DEACTIVATES the people listed in red — make sure that is expected.' : ''))) return;
    try {
      const r = await jpost('/admin/roster-sync/approve', {});
      toast(`Imported: +${r.added}, ~${r.updated}, −${r.deactivated}, ${r.linked_guardians} guardians linked`);
      loadImport();
    } catch (err) { toast(err.message, true); }
  }
  if (e.target.id === 'sync-discard') {
    if (!confirm('Discard this pending import? The fetched file stays archived; the next sync will stage a fresh one.')) return;
    try { await jpost('/admin/roster-sync/discard', {}); toast('Discarded'); loadSync(); }
    catch (err) { toast(err.message, true); }
  }
  if (e.target.id === 'sync-cred-save') {
    const email = $('sync-cred-email').value.trim();
    const password = $('sync-cred-pass').value;
    if (!email) return toast('Enter the TLC login email.', true);
    try {
      await jput('/admin/roster-sync/credentials', { email, password: password || undefined });
      $('sync-cred-pass').value = '';
      toast('Credentials saved — try a Sync now to verify them.');
      loadSync();
    } catch (err) { toast(err.message, true); }
  }
  if (e.target.id === 'sync-cred-clear') {
    if (!confirm('Remove the saved credentials? The sync falls back to .env values if the server has them, otherwise it stops working until new credentials are saved.')) return;
    try {
      await api('/admin/roster-sync/credentials', { method: 'DELETE' });
      $('sync-cred-email').value = ''; $('sync-cred-pass').value = '';
      toast('Saved credentials removed');
      loadSync();
    } catch (err) { toast(err.message, true); }
  }
});

// ------------------------------------------- TLC attendance write-back ----
let tlcaTimer = null;
async function loadTlca() {
  const s = await api('/admin/tlc-attendance').catch(() => null);
  if (!s) return;
  if (document.activeElement !== $('tlca-enabled')) $('tlca-enabled').checked = !!s.settings.enabled;
  if (document.activeElement !== $('tlca-lessons')) $('tlca-lessons').checked = !!s.settings.use_lesson_plans;

  const bits = [];
  if (!s.credentials_configured) bits.push('Needs the Trail Life Connect credentials saved above.');
  if (s.running) bits.push('⏳ Push running…');
  if (s.state.auth_failed_at) {
    bits.push(`❌ Paused since ${fmtDT(s.state.auth_failed_at)} — the TLC login was rejected. ` +
      'Re-save the credentials above (or press Push now after fixing the account).');
  }
  if (s.state.last_run) {
    bits.push(`Last push ${fmtDT(s.state.last_run)}: ` + (s.state.last_status === 'ok'
      ? '✅ ok' : `⚠ ${esc(s.state.last_error || s.state.last_status || '')}`));
  }
  bits.push(`Queue: <b>${s.queue.pending}</b> pending · ${s.queue.sent} sent · ` +
    (s.queue.failed ? `<b class="error">${s.queue.failed} failed</b> <button id="tlca-retry" class="btn ghost small">Retry failed</button>` : '0 failed'));
  $('tlca-status').innerHTML = bits.join('<br>');
  $('tlca-push').disabled = !!s.running || !s.credentials_configured || !s.queue.pending;

  renderPushLog(s.recent);

  clearTimeout(tlcaTimer);
  if ((s.running || s.queue.pending) && !$('tab-import').hidden) tlcaTimer = setTimeout(loadTlca, 5000);
}
function renderPushLog(rows) {
  $('tlca-log').innerHTML = rows.length
    ? `<table><tr><th>When</th><th>Person</th><th>Event</th><th>Status</th><th>Detail</th></tr>` +
      rows.map((r) => `<tr>${dtCell(r.sent_at || r.created_at)}<td>${esc(r.person_name)}</td>
        <td>${esc(r.event_title)}</td>
        <td>${r.status === 'sent' ? '✅ sent' : r.status === 'failed' ? '❌ failed' : '⏳ pending'}</td>
        <td>${esc(r.detail || '')}</td></tr>`).join('') + '</table>'
    : '<p class="hint left">Nothing queued yet — sign-ins appear here once the push is enabled (or an event is set to “Always push”).</p>';
  enhanceTable('tlca-log');
}

// push-log history: date range + limit + CSV (older rows stay reachable)
function pushLogQuery() {
  const q = new URLSearchParams();
  if ($('pl-from').value) q.set('from', $('pl-from').value);
  if ($('pl-to').value) q.set('to', $('pl-to').value + 'T23:59:59');
  q.set('limit', $('pl-limit').value);
  return q.toString();
}
async function loadPushLog() {
  $('pl-csv').href = '/api/admin/export/push-log.csv?' + pushLogQuery();
  renderPushLog(await api('/admin/push-log?' + pushLogQuery()).catch(() => []));
}

async function saveTlcaSettings() {
  try {
    await jput('/admin/tlc-attendance/settings', {
      enabled: $('tlca-enabled').checked, use_lesson_plans: $('tlca-lessons').checked,
    });
    toast('Saved'); loadTlca();
  } catch (e) { toast(e.message, true); }
}
$('tlca-enabled').onchange = () => {
  if ($('tlca-enabled').checked &&
      !confirm('Enable attendance write-back?\n\nEvery kiosk sign-in will also mark the person Attended ' +
        'on the matching Trail Life Connect event. The app never un-marks anyone on TLC.')) {
    $('tlca-enabled').checked = false;
    return;
  }
  saveTlcaSettings();
};
$('tlca-lessons').onchange = saveTlcaSettings;
$('pf-enabled').onchange = async () => {
  try {
    const s = await jput('/admin/permission-forms', { enabled: $('pf-enabled').checked ? 1 : 0 });
    $('pf-status').textContent = s.enabled
      ? 'On — requirement sweep runs nightly; per-event status refreshes as events approach.'
      : 'Off — no TLC calls, no kiosk warnings.';
    toast(s.enabled
      ? (s.sweep_started
        ? 'Permission-form tracking ON — sweeping TLC now; flagged events appear within a minute or two.'
        : 'Permission-form tracking ON.')
      : 'Permission-form tracking off.');
  } catch (e) { toast(e.message, true); $('pf-enabled').checked = !$('pf-enabled').checked; }
};
$('pf-block-default').onchange = async () => {
  const val = $('pf-block-default').value === '1';
  if (val && !confirm('Set the GLOBAL default to Block?\n\nEvery future form-required event will refuse ' +
      'check-in for unsigned youth (staff can always re-check or record an override). Hand-set events keep ' +
      'their own setting.')) {
    $('pf-block-default').value = '0';
    return;
  }
  try {
    const s = await jput('/admin/permission-forms', { block_default: val ? 1 : 0 });
    toast(`Default is now ${s.block_default ? 'Block' : 'Warn'} — applied to ${s.block_applied ?? 0} future event(s); hand-set events untouched.`);
  } catch (e) { toast(e.message, true); }
};
document.addEventListener('click', async (e) => {
  if (e.target.id === 'tlca-push') {
    try { await jpost('/admin/tlc-attendance/push', {}); toast('Push started'); loadTlca(); }
    catch (err) { toast(err.message, true); }
  }
  if (e.target.id === 'tlca-retry') {
    try { const r = await jpost('/admin/tlc-attendance/retry', {}); toast(`${r.retried} row(s) queued again`); loadTlca(); }
    catch (err) { toast(err.message, true); }
  }
});

// --------------------------------------------------------------- import ----
async function loadImport() {
  $('imp-commit').disabled = true;
  $('imp-result').innerHTML = '';
  loadSync();
  loadTlca();
  api('/admin/permission-forms').then((s) => {
    if (document.activeElement !== $('pf-enabled')) $('pf-enabled').checked = !!s.enabled;
    if (document.activeElement !== $('pf-block-default')) $('pf-block-default').value = s.block_default ? '1' : '0';
    $('pf-status').textContent = s.enabled
      ? 'On — requirement sweep runs nightly; per-event status refreshes as events approach.'
      : 'Off — no TLC calls, no kiosk warnings.';
  }).catch(() => {});
  const iq = new URLSearchParams();
  if ($('il-from').value) iq.set('from', $('il-from').value);
  if ($('il-to').value) iq.set('to', $('il-to').value + 'T23:59:59');
  iq.set('limit', $('il-limit').value);
  $('il-csv').href = '/api/admin/export/imports.csv?' + iq.toString();
  const log = await api('/admin/imports?' + iq.toString());
  $('imp-log').innerHTML = log.length ? `<table><tr><th>When</th><th>File</th><th>By</th><th>Added</th><th>Updated</th><th>Deactivated</th><th>Linked</th></tr>` +
    log.map((r) => `<tr>${dtCell(r.imported_at)}<td>${esc(r.filename)}</td><td>${esc(r.staff_name || '')}</td>
      <td>${r.added}</td><td>${r.updated}</td><td>${r.deactivated}</td><td>${r.linked_guardians}</td></tr>`).join('') + '</table>'
    : '<p class="hint left">No imports yet.</p>';
  enhanceTable('imp-log');
}
async function uploadRoster(mode) {
  const file = $('imp-file').files[0];
  if (!file) return toast('Choose the xlsx file first.', true);
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/roster/import?mode=${mode}`, { method: 'POST', body: form, credentials: 'same-origin' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Import failed');
  return body;
}
$('imp-preview').onclick = async () => {
  try {
    const r = await uploadRoster('preview');
    $('imp-result').innerHTML = `
      <p><b>${r.total}</b> people in file (${r.youth} youth, ${r.adults} adults) —
        <b>${r.added.length}</b> new, <b>${r.updated.length}</b> updated, <b>${r.deactivated.length}</b> would be deactivated.</p>
      ${r.added.length ? `<p><b>New:</b> ${r.added.map(esc).join(', ')}</p>` : ''}
      ${r.updated.length ? `<p><b>Updated:</b> ${r.updated.map((u) => `${esc(u.name)} (${u.fields.map(esc).join(', ')})`).join('; ')}</p>` : ''}
      ${r.deactivated.length ? `<p class="error"><b>Deactivated:</b> ${r.deactivated.map(esc).join(', ')}</p>` : ''}`;
    $('imp-commit').disabled = false;
  } catch (e) { toast(e.message, true); }
};
$('imp-commit').onclick = async () => {
  try {
    const r = await uploadRoster('commit');
    toast(`Imported: +${r.added}, ~${r.updated}, −${r.deactivated}, ${r.linked_guardians} guardians linked`);
    loadImport();
  } catch (e) { toast(e.message, true); }
};

boot();
