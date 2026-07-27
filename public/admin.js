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
  loaders[name]();
}

// ------------------------------------------------------------ dashboard ----
async function loadDash() {
  const s = await api('/admin/status');
  const cards = [
    [s.youth_active, 'active youth'], [s.adults_active, 'active adults'],
    [s.visitors, 'visitors'], [s.open_signins, 'on site now'],
    [s.events, 'events'], [s.txns, 'transactions'],
    [s.expiring_30 || 0, 'renewals due ≤30 days', s.expiring_30 ? 'card-warn' : ''],
  ];
  $('dash-cards').innerHTML = cards.map(([n, l, cls]) => `<div class="card ${cls || ''}"><b>${n}</b><span>${l}</span></div>`).join('');
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
  const forms = p.is_youth ? await api('/admin/consent-forms').catch(() => []) : [];
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
      <div><label>Status</label>
        <select data-f="status">
          ${['active', 'inactive', 'visitor'].map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
      <div><label>Notes</label><input data-f="notes" value="${esc(p.notes || '')}"></div>
    </div>
    <p class="hint left">${locked.length
      ? `🔒 Locked against imports: ${locked.join(', ')} <button class="btn ghost small" id="pp-unlock">let imports manage these again</button>`
      : 'Fields you edit here are locked so roster re-imports never overwrite them.'}</p>
    <div class="row wrap">
      <button class="btn primary small" id="pp-save">Save</button>
      ${p.is_youth && !p.member_id ? '<button class="btn ghost small" id="pp-merge">Merge into roster member…</button>' : ''}
      <button class="btn ghost small" id="pp-close">Close</button>
    </div>
    ${p.is_youth ? guardianBlock(p, forms) : wardBlock(p)}`;

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
    const q = prompt('Merge this visitor into which roster member? Type part of their name:');
    if (!q) return;
    const hits = (await api('/admin/people?type=youth&q=' + encodeURIComponent(q)))
      .filter((x) => x.id !== id && x.member_id);
    if (!hits.length) return toast('No matching roster youth.', true);
    const pick = hits[0];
    if (!confirm(`Merge into ${pick.first_name} ${pick.last_name} (#${pick.member_id})? Attendance history transfers; this cannot be undone.`)) return;
    try { await jpost('/admin/merge', { from_id: id, into_id: pick.id }); toast('Merged'); closePersonModal(); loadPeople(); }
    catch (e) { toast(e.message, true); }
  };

  d.querySelectorAll('[data-gact]').forEach((b) => (b.onclick = () => guardianAction(p, b)));
  wireGuardianForms(p);
}

function smsCell(g, forms) {
  const tag = g.sms_opt_in === 'yes'
    ? `<span class="tag youth">✓ opted in</span>`
    : g.sms_opt_in === 'stop' ? `<span class="tag warn">STOP</span>` : `<span class="tag off">no consent</span>`;
  const formRef = g.consent_form_id
    ? ` <a href="/consent-forms/${esc(g.consent_file)}" target="_blank" title="signed by ${esc(g.consent_signed_by || '?')}">form #${g.consent_form_id}</a>` : '';
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
const fam = { fromPerson: null, guardianId: null, youths: [] };

async function openFamilyModal(p) {
  fam.fromPerson = p;
  fam.guardianId = null;
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
    forms.map((f) => `<option value="${f.id}">#${f.id} ${esc(f.signed_by || f.file_path)}${f.signed_on ? ` (${esc(f.signed_on)})` : ''}</option>`).join('');
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
          $('fam-gpicked').textContent = `Selected: ${a.first_name} ${a.last_name}`;
          $('fam-gpicked').hidden = false;
          box.innerHTML = ''; $('fam-gsearch').value = '';
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
  $('ev-list').innerHTML = `<table><tr><th>Title</th><th>Starts</th><th>Ends</th><th>Source</th><th>Adults</th><th>Txns</th><th></th></tr>` +
    rows.map((e) => `<tr data-id="${e.id}">
      <td>${esc(e.title)}${e.removed_from_feed ? ' <span class="tag warn">gone from feed</span>' : ''}</td>
      <td>${fmtDT(e.start_at)}</td><td>${fmtDT(e.end_at)}</td>
      <td>${e.source}${e.is_past ? ' <span class="tag off">past</span>' : ''}</td>
      <td>${e.track_adults ? '✓ tracked' : '—'}</td><td>${e.txn_count}</td>
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
      <div><label>SMS reminder delay (min after end; blank = default 30)</label>
        <input id="evf-notify" type="number" min="0" value="${e?.notify_after_min ?? ''}"></div>
    </div>
    <div class="row wrap">
      <button class="btn primary small" id="evf-save">Save</button>
      <button class="btn ghost small" id="evf-close">Close</button>
    </div>`;
  d.hidden = false;
  $('event-modal').hidden = false;
  $('evf-close').onclick = closeEventModal;
  $('evf-save').onclick = async () => {
    const body = {
      title: $('evf-title').value.trim(), location: $('evf-loc').value.trim(),
      start_at: new Date($('evf-start').value).toISOString(),
      end_at: new Date($('evf-end').value).toISOString(),
      track_adults: $('evf-adults').value === '1',
      notify_after_min: $('evf-notify').value === '' ? null : Number($('evf-notify').value),
    };
    try {
      if (e) await jpatch(`/admin/events/${e.id}`, body);
      else await jpost('/events', body);
      closeEventModal(); loadEvents(); toast('Saved');
    } catch (err) { toast(err.message, true); }
  };
}
function closeEventModal() { $('event-modal').hidden = true; $('ev-detail').hidden = true; }
$('ev-new').onclick = () => openEvent(null);
$('ev-past').onchange = loadEvents;

// ---------------------------------------------------------------- staff ----
async function loadStaff() {
  const rows = await api('/admin/staff');
  $('st-list').innerHTML = `<table><tr><th>Name</th><th>Role</th><th>Signs in with</th><th>Status</th><th></th></tr>` +
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
async function loadMessages() {
  const rows = await api('/admin/messages');
  const kindTag = (m) => m.direction === 'in'
    ? (m.kind === 'reply' ? '<span class="tag warn">reply</span>' : '<span class="tag off">keyword</span>')
    : (m.kind === 'custom' ? '<span class="tag youth">broadcast</span>' : '<span class="tag off">pickup alert</span>');
  $('msg-list').innerHTML = rows.length
    ? `<table><tr><th></th><th>When</th><th>Who</th><th>Type</th><th>Message</th><th>Status</th><th></th></tr>` +
      rows.map((m) => `<tr class="${m.direction === 'in' && m.kind === 'reply' ? 'msg-reply' : ''}">
        <td>${m.direction === 'in' ? '📥' : '📤'}</td>
        <td>${fmtDT(m.at)}</td>
        <td>${esc(m.guardian_name || m.phone || '?')}</td>
        <td>${kindTag(m)}</td>
        <td class="msg-body">${esc(m.body || '')}</td>
        <td>${esc(m.status || '')}</td>
        <td>${m.direction === 'in' && m.guardian_id
          ? `<button class="btn ghost small" data-msgreply="${m.guardian_id}" data-msgname="${esc(m.guardian_name || m.phone)}">Reply</button>` : ''}</td>
      </tr>`).join('') + '</table>'
    : '<p class="hint left">No messages yet.</p>';
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
  loadExpiring();
  const log = await api('/admin/notifications');
  $('rp-notifications').innerHTML = log.length
    ? `<table><tr><th>When</th><th>Youth</th><th>Guardian</th><th>Event</th><th>Status</th></tr>` +
      log.map((n) => `<tr><td>${fmtDT(n.sent_at)}</td><td>${esc(n.youth_name)}</td>
        <td>${esc(n.guardian_name)}</td><td>${esc(n.event_title)}</td>
        <td><span class="tag ${n.status === 'failed' ? 'warn' : n.status === 'replied_y' ? 'youth' : 'off'}">${esc(n.status)}</span></td></tr>`).join('') + '</table>'
    : '<p class="hint left">No notifications yet (SMS is off until Twilio is configured).</p>';
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
        <td>${p.days_left < 0 ? `<span class="tag warn">expired ${-p.days_left}d ago</span>` : p.days_left}</td>
      </tr>`).join('') + '</table>'
    : `<p class="hint left">Nobody expires within ${days} days. 🎉</p>`;
}
document.addEventListener('change', (e) => {
  if (e.target.id === 'mx-days') loadExpiring();
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
        <td>${fmtDT(r.first_seen)}</td><td>${fmtDT(r.last_seen)}</td></tr>`).join('') + '</table>'
    : '<p class="hint left">No attendance in that range.</p>';
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
      ? `Using credentials saved here: <b>${esc(c.email)}</b> (updated ${fmtDT(c.updated_at)}). Password is stored but never displayed.`
      : c.source === 'env'
        ? `Using credentials from <code>.env</code> on the server (<b>${esc(c.email)}</b>). Saving here will override them without touching the file.`
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

// --------------------------------------------------------------- import ----
async function loadImport() {
  $('imp-commit').disabled = true;
  $('imp-result').innerHTML = '';
  loadSync();
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
