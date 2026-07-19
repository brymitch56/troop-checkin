'use strict';
/* Admin SPA — roster, guardians, events, transactions, imports. */

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDT = (s) => s ? new Date(s).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

let me = null;

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { credentials: 'same-origin', ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `Request failed (${res.status})`); e.body = body; e.status = res.status; throw e; }
  return body;
}
const jpost = (p, d) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
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
const loaders = { dash: loadDash, people: loadPeople, events: loadEvents, txns: loadTxns, import: loadImport };
$('tabs').onclick = (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
};
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== `tab-${name}`;
  loaders[name]();
}

// ------------------------------------------------------------ dashboard ----
async function loadDash() {
  const s = await api('/admin/status');
  const cards = [
    [s.youth_active, 'active youth'], [s.adults_active, 'active adults'],
    [s.visitors, 'visitors'], [s.open_signins, 'on site now'],
    [s.events, 'events'], [s.txns, 'transactions'],
  ];
  $('dash-cards').innerHTML = cards.map(([n, l]) => `<div class="card"><b>${n}</b><span>${l}</span></div>`).join('');
  $('tool-status').textContent = s.last_ical_sync
    ? `Last iCal sync ${fmtDT(s.last_ical_sync.at)}: +${s.last_ical_sync.added} / ~${s.last_ical_sync.updated} / flagged ${s.last_ical_sync.flagged}`
    : 'iCal has not synced yet.';

  const open = await api('/onsite');
  $('dash-open').innerHTML = open.length ? `<table><tr><th>Name</th><th>Patrol</th><th>Event</th><th>In since</th><th></th></tr>` +
    open.map((r) => `<tr><td>${esc(r.first_name)} ${esc(r.last_name)}</td><td>${esc(r.patrol || '')}</td>
      <td>${esc(r.event_title)}</td><td>${fmtDT(r.signed_at)}</td>
      <td><button class="btn ghost small" data-close="${r.id}">Admin close</button></td></tr>`).join('') + '</table>'
    : '<p class="hint left">Nobody is on site.</p>';
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
async function loadPeople() {
  const q = new URLSearchParams();
  if ($('pp-q').value.trim()) q.set('q', $('pp-q').value.trim());
  if ($('pp-type').value) q.set('type', $('pp-type').value);
  if ($('pp-status').value) q.set('status', $('pp-status').value);
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
}

async function openPerson(id) {
  const p = await api(`/admin/people/${id}`);
  const d = $('pp-detail'); d.hidden = false;
  const f = (label, field, val) => `<div><label>${label}</label><input data-f="${field}" value="${esc(val || '')}"></div>`;
  d.innerHTML = `
    <h3>${esc(p.first_name)} ${esc(p.last_name)}
      <span class="tag ${p.is_youth ? 'youth' : 'adult'}">${p.is_youth ? 'youth' : 'adult'}</span>
      ${p.member_id ? `<span class="tag off">#${esc(p.member_id)}</span>` : '<span class="tag warn">no member #</span>'}
    </h3>
    <div class="kv">
      ${f('First name', 'first_name', p.first_name)}${f('Last name', 'last_name', p.last_name)}
      ${f('Nickname', 'nickname', p.nickname)}
      ${p.is_youth ? f('Patrol', 'patrol', p.patrol) + f('Level', 'level', p.level) : f('Role', 'role', p.role)}
      ${f('Mobile', 'phone_mobile', p.phone_mobile)}${f('Email', 'email', p.email)}
      <div><label>Status</label>
        <select data-f="status">
          ${['active', 'inactive', 'visitor'].map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
      <div><label>Notes</label><input data-f="notes" value="${esc(p.notes || '')}"></div>
    </div>
    <div class="row wrap">
      <button class="btn primary small" id="pp-save">Save</button>
      ${p.is_youth && !p.member_id ? '<button class="btn ghost small" id="pp-merge">Merge into roster member…</button>' : ''}
      <button class="btn ghost small" id="pp-close">Close</button>
    </div>
    ${p.is_youth ? guardianBlock(p) : wardBlock(p)}`;

  $('pp-save').onclick = async () => {
    const body = {};
    d.querySelectorAll('[data-f]').forEach((el) => (body[el.dataset.f] = el.value));
    try { await jpatch(`/admin/people/${id}`, body); toast('Saved'); loadPeople(); }
    catch (e) { toast(e.message, true); }
  };
  $('pp-close').onclick = () => (d.hidden = true);

  if ($('pp-merge')) $('pp-merge').onclick = async () => {
    const q = prompt('Merge this visitor into which roster member? Type part of their name:');
    if (!q) return;
    const hits = (await api('/admin/people?type=youth&q=' + encodeURIComponent(q)))
      .filter((x) => x.id !== id && x.member_id);
    if (!hits.length) return toast('No matching roster youth.', true);
    const pick = hits[0];
    if (!confirm(`Merge into ${pick.first_name} ${pick.last_name} (#${pick.member_id})? Attendance history transfers; this cannot be undone.`)) return;
    try { await jpost('/admin/merge', { from_id: id, into_id: pick.id }); toast('Merged'); d.hidden = true; loadPeople(); }
    catch (e) { toast(e.message, true); }
  };

  d.querySelectorAll('[data-gact]').forEach((b) => (b.onclick = () => guardianAction(p, b)));
  if ($('pp-gadd')) $('pp-gadd').onclick = async () => {
    const q = prompt('Add which adult as guardian? Type part of their name:');
    if (!q) return;
    const hits = (await api('/admin/people?type=adult&q=' + encodeURIComponent(q))).filter((x) => x.status !== 'merged');
    if (!hits.length) return toast('No matching adult.', true);
    const rel = prompt(`Adding ${hits[0].first_name} ${hits[0].last_name}. Relationship (optional):`) || null;
    try { await jpost(`/admin/people/${p.id}/guardians`, { guardian_id: hits[0].id, relationship: rel }); openPerson(p.id); }
    catch (e) { toast(e.message, true); }
  };
}

function guardianBlock(p) {
  return `<h3>Guardians &amp; authorized pickup</h3>
  <p class="hint left">Your edits here are authoritative — roster imports never change them.</p>
  <div class="tbl"><table><tr><th>Name</th><th>Relationship</th><th>Phone</th><th>Authorized</th><th>Primary</th><th>Source</th><th></th></tr>
  ${p.guardians.map((g) => `<tr>
    <td>${esc(g.first_name)} ${esc(g.last_name)}</td><td>${esc(g.relationship || '')}</td>
    <td>${esc(g.phone_mobile || '')}</td>
    <td><button class="btn ghost small" data-gact="auth" data-gid="${g.id}" data-val="${g.authorized ? 0 : 1}">
      ${g.authorized ? '✓ yes — revoke' : '✗ no — authorize'}</button></td>
    <td>${g.is_primary ? '★' : `<button class="btn ghost small" data-gact="primary" data-gid="${g.id}">make primary</button>`}</td>
    <td>${esc(g.source)}</td>
    <td>${g.source === 'manual' ? `<button class="btn ghost small" data-gact="del" data-gid="${g.id}">remove</button>` : ''}</td>
  </tr>`).join('')}</table></div>
  <button class="btn ghost small" id="pp-gadd">+ Add guardian</button>`;
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
    if (btn.dataset.gact === 'del') {
      if (!confirm('Remove this manually-added guardian link?')) return;
      await jdel(`/admin/people/${p.id}/guardians/${gid}`);
    }
    openPerson(p.id);
  } catch (e) { toast(e.message, true); }
}

// --------------------------------------------------------------- events ----
async function loadEvents() {
  const rows = await api('/admin/events');
  $('ev-list').innerHTML = `<table><tr><th>Title</th><th>Starts</th><th>Ends</th><th>Source</th><th>Adults</th><th>Txns</th><th></th></tr>` +
    rows.map((e) => `<tr data-id="${e.id}">
      <td>${esc(e.title)}${e.removed_from_feed ? ' <span class="tag warn">gone from feed</span>' : ''}</td>
      <td>${fmtDT(e.start_at)}</td><td>${fmtDT(e.end_at)}</td>
      <td>${e.source}</td><td>${e.track_adults ? '✓ tracked' : '—'}</td><td>${e.txn_count}</td>
      <td>${e.txn_count === 0 ? `<button class="btn ghost small" data-del="${e.id}">delete</button>` : ''}</td></tr>`).join('') + '</table>';
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
  const d = $('ev-detail'); d.hidden = false;
  d.innerHTML = `<h3>${e ? 'Edit' : 'New'} event ${e && e.source === 'ical' ? '<span class="tag off">from iCal — times resync nightly</span>' : ''}</h3>
    <div class="kv">
      <div><label>Title</label><input id="evf-title" value="${esc(e?.title || '')}"></div>
      <div><label>Location</label><input id="evf-loc" value="${esc(e?.location || '')}"></div>
      <div><label>Starts</label><input id="evf-start" type="datetime-local" value="${toLocal(e?.start_at)}"></div>
      <div><label>Ends</label><input id="evf-end" type="datetime-local" value="${toLocal(e?.end_at)}"></div>
      <div><label>Adult attendance</label><select id="evf-adults">
        <option value="0" ${!e?.track_adults ? 'selected' : ''}>Not tracked</option>
        <option value="1" ${e?.track_adults ? 'selected' : ''}>Tracked (headcount)</option></select></div>
    </div>
    <div class="row wrap">
      <button class="btn primary small" id="evf-save">Save</button>
      <button class="btn ghost small" id="evf-close">Close</button>
    </div>`;
  $('evf-close').onclick = () => (d.hidden = true);
  $('evf-save').onclick = async () => {
    const body = {
      title: $('evf-title').value.trim(), location: $('evf-loc').value.trim(),
      start_at: new Date($('evf-start').value).toISOString(),
      end_at: new Date($('evf-end').value).toISOString(),
      track_adults: $('evf-adults').value === '1',
    };
    try {
      if (e) await jpatch(`/admin/events/${e.id}`, body);
      else await jpost('/events', body);
      d.hidden = true; loadEvents(); toast('Saved');
    } catch (err) { toast(err.message, true); }
  };
}
$('ev-new').onclick = () => openEvent(null);

// ----------------------------------------------------------------- txns ----
async function loadTxns() {
  const events = await api('/admin/events');
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
      <td>${fmtDT(t.signed_at)}</td>
      <td><span class="tag ${t.direction === 'in' ? 'youth' : 'warn'}">${t.direction.toUpperCase()}</span></td>
      <td>${esc(t.people || '')}</td><td>${esc(t.event_title)}</td>
      <td>${esc(t.signer_name || t.signer_name_override || '')}</td><td>${esc(t.staff_name)}</td>
      <td>${t.voided_by_txn_id ? '<span class="tag warn">voided</span>' : ''}
          ${t.forced ? '<span class="tag warn">override</span>' : ''}
          ${t.close_method === 'admin_close' ? '<span class="tag off">admin</span>' : ''}</td></tr>`).join('') + '</table>';
  $('tx-list').onclick = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openTxn(Number(tr.dataset.id));
  };
}
async function openTxn(id) {
  const t = await api(`/admin/txns/${id}`);
  const d = $('tx-detail'); d.hidden = false;
  d.innerHTML = `<h3>Transaction #${t.id} — ${t.direction.toUpperCase()} · ${esc(t.event_title)}</h3>
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
  $('tx-close').onclick = () => (d.hidden = true);
  if ($('tx-void')) $('tx-void').onclick = async () => {
    if (!confirm('Void this transaction? A correcting record is added; nothing is deleted.')) return;
    try { await jpost(`/admin/txns/${id}/void`, {}); toast('Voided'); d.hidden = true; renderTxns(); }
    catch (e) { toast(e.message, true); }
  };
}

// --------------------------------------------------------------- import ----
async function loadImport() {
  $('imp-commit').disabled = true;
  $('imp-result').innerHTML = '';
  const log = await api('/admin/imports');
  $('imp-log').innerHTML = log.length ? `<table><tr><th>When</th><th>File</th><th>By</th><th>Added</th><th>Updated</th><th>Deactivated</th><th>Linked</th></tr>` +
    log.map((r) => `<tr><td>${fmtDT(r.imported_at)}</td><td>${esc(r.filename)}</td><td>${esc(r.staff_name || '')}</td>
      <td>${r.added}</td><td>${r.updated}</td><td>${r.deactivated}</td><td>${r.linked_guardians}</td></tr>`).join('') + '</table>'
    : '<p class="hint left">No imports yet.</p>';
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
