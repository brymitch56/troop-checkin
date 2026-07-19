'use strict';
/* NY-2911 Troop Check-In kiosk */

const $ = (id) => document.getElementById(id);
const state = {
  me: null,
  event: null,           // selected event
  cart: [],              // [{person, guardians[], emerg1, emerg2}]
  direction: null,       // 'in' | 'out' — set by first cart entry
  signerId: null,
  signerOther: null,
  pendingLink: null,     // {code, person}
  patrol: null,
};

// ---------------------------------------------------------------- utils ----
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { credentials: 'same-origin', ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `Request failed (${res.status})`); e.body = body; e.status = res.status; throw e; }
  return body;
}
const jpost = (path, data) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

let toastTimer;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
}
function show(screen) {
  for (const s of ['screen-login', 'screen-main', 'screen-onsite']) $(s).hidden = s !== screen;
}
function openModal(page) {
  $('modal-root').hidden = false;
  for (const p of document.querySelectorAll('.modal-page')) p.hidden = p.id !== page;
}
function closeModal() { $('modal-root').hidden = true; }
const displayName = (p) => `${p.nickname || p.first_name} ${p.last_name}`;

// ---------------------------------------------------------------- login ----
async function boot() {
  try {
    state.me = await api('/me');
    await enterKiosk();
  } catch { await renderLogin(); }
}

async function renderLogin() {
  show('screen-login');
  $('pin-panel').hidden = true;
  const list = await api('/staff-list').catch(() => []);
  const grid = $('staff-list');
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = '<p class="hint">No staff yet — run the create-staff script on the Pi.</p>';
    return;
  }
  for (const s of list) {
    const b = document.createElement('button');
    b.textContent = s.name;
    b.onclick = () => {
      $('pin-panel').hidden = false;
      $('pin-staff-name').textContent = s.name;
      $('pin-input').value = ''; $('pin-input').dataset.staffId = s.id;
      $('login-error').textContent = '';
      $('pin-input').focus();
    };
    grid.appendChild(b);
  }
}

$('pin-go').onclick = doLogin;
$('pin-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('pin-cancel').onclick = () => ($('pin-panel').hidden = true);
async function doLogin() {
  try {
    state.me = await jpost('/login', { staff_id: Number($('pin-input').dataset.staffId), pin: $('pin-input').value });
    await enterKiosk();
  } catch (e) { $('login-error').textContent = e.message; }
}

$('staff-pill').onclick = async () => {
  await jpost('/logout', {}).catch(() => {});
  state.me = null; state.cart = []; state.direction = null;
  renderLogin();
};

// ---------------------------------------------------------------- kiosk ----
async function enterKiosk() {
  show('screen-main');
  $('staff-pill').textContent = state.me.name;
  renderCart();
  refreshOnsiteCount();
  await pickEventAuto();
}

async function pickEventAuto() {
  const { matching } = await api('/events/current');
  if (matching.length === 1) setEvent(matching[0]);
  else if (state.event == null) openEventPicker();
}
function setEvent(ev) {
  state.event = ev;
  $('event-pill').textContent = ev ? ev.title : 'Choose event';
}
$('event-pill').onclick = openEventPicker;

async function openEventPicker() {
  const { matching, nearby } = await api('/events/current');
  const wrap = $('event-list'); wrap.innerHTML = '';
  const add = (ev, tag) => {
    const b = document.createElement('button');
    const start = new Date(ev.start_at), end = new Date(ev.end_at);
    b.innerHTML = `<b>${ev.title}</b>${tag ? ` <span class="when">· ${tag}</span>` : ''}<br>
      <span class="when">${start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      – ${end.toLocaleString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
    b.onclick = () => { setEvent(ev); closeModal(); };
    wrap.appendChild(b);
  };
  matching.forEach((ev) => add(ev, 'now'));
  nearby.forEach((ev) => add(ev));
  if (!matching.length && !nearby.length) wrap.innerHTML = '<p class="hint">Nothing on the calendar — create one below.</p>';
  openModal('modal-events');
}
$('events-close').onclick = closeModal;
$('ev-create').onclick = async () => {
  try {
    const ev = await jpost('/events', {
      title: $('ev-title').value.trim(),
      start_at: new Date($('ev-start').value).toISOString(),
      end_at: new Date($('ev-end').value).toISOString(),
    });
    setEvent(ev); closeModal(); toast('Event created');
  } catch (e) { toast(e.message, true); }
};

// ------------------------------------------------------------ scanning ----
// Bluetooth HID keyboard-wedge: rapid keystrokes ending in Enter.
let wedgeBuf = '', wedgeLast = 0;
window.addEventListener('keydown', (e) => {
  const typingInField = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '') &&
                        document.activeElement !== document.body;
  const now = Date.now();
  if (now - wedgeLast > 120) wedgeBuf = '';
  wedgeLast = now;
  if (e.key === 'Enter') {
    if (wedgeBuf.length >= 6) {
      const code = wedgeBuf; wedgeBuf = '';
      e.preventDefault();
      handleScan(code);
    }
    return;
  }
  if (e.key.length === 1) {
    wedgeBuf += e.key;
    // scanner burst into a focused input: keep the field clean
    if (typingInField && wedgeBuf.length === 8 && now - wedgeLast < 30) e.preventDefault();
  }
});

async function handleScan(rawCode) {
  const code = rawCode.trim();
  if (!code) return;
  try {
    const r = await api('/badge/' + encodeURIComponent(code));
    if (r.match === 'badge') return addToCart(r.person);
    if (r.match === 'member') {
      state.pendingLink = { code, person: r.person };
      $('link-text').textContent =
        `This badge isn't linked yet, but its member number matches ${displayName(r.person)}. Link it? (New/reprinted badge.)`;
      return openModal('modal-link');
    }
    toast('Badge not recognized — use name search or add a visitor.', true);
  } catch (e) { toast(e.message, true); }
}
$('link-cancel').onclick = () => { state.pendingLink = null; closeModal(); };
$('link-confirm').onclick = async () => {
  const { code, person } = state.pendingLink || {};
  try {
    await jpost('/badge/link', { person_id: person.id, code });
    closeModal(); state.pendingLink = null;
    addToCart(person); toast('Badge linked');
  } catch (e) { toast(e.message, true); }
};

// camera scanning: BarcodeDetector native, else jsQR (vendor locally for Phase 4 offline)
let camStream = null, camLoop = null;
$('btn-camera').onclick = async () => {
  openModal('modal-camera');
  const video = $('cam-video');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = camStream;
    await video.play();
    if ('BarcodeDetector' in window) {
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      camLoop = setInterval(async () => {
        try {
          const codes = await det.detect(video);
          if (codes.length) onCameraHit(codes[0].rawValue);
        } catch { /* frame not ready */ }
      }, 250);
    } else {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js');
      const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
      camLoop = setInterval(() => {
        if (!video.videoWidth) return;
        cv.width = video.videoWidth; cv.height = video.videoHeight;
        cx.drawImage(video, 0, 0);
        const img = cx.getImageData(0, 0, cv.width, cv.height);
        const hit = window.jsQR(img.data, img.width, img.height);
        if (hit && hit.data) onCameraHit(hit.data);
      }, 300);
    }
  } catch (e) {
    $('cam-status').textContent = 'Camera unavailable: ' + e.message;
  }
};
let lastCamHit = 0;
function onCameraHit(value) {
  const now = Date.now();
  if (now - lastCamHit < 1500) return; // debounce repeated frames
  lastCamHit = now;
  if (navigator.vibrate) navigator.vibrate(60);
  handleScan(value);
  $('cam-status').textContent = 'Scanned — keep going or close.';
}
function stopCamera() {
  if (camLoop) clearInterval(camLoop), (camLoop = null);
  if (camStream) camStream.getTracks().forEach((t) => t.stop()), (camStream = null);
}
$('cam-close').onclick = () => { stopCamera(); closeModal(); };
function loadScript(src) {
  return new Promise((ok, no) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => no(new Error('Could not load scanner library — check internet.'));
    document.head.appendChild(s);
  });
}

// -------------------------------------------------------------- search ----
let searchTimer;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (q.length < 2) { $('search-results').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const rows = await api('/search?q=' + encodeURIComponent(q)).catch(() => []);
    const box = $('search-results'); box.innerHTML = '';
    for (const p of rows) {
      const b = document.createElement('button');
      b.innerHTML = `<span>${displayName(p)}</span>
        <span class="sub">${p.is_youth ? (p.patrol || 'Youth') : 'Adult'}${p.open ? ' · ON SITE' : ''}</span>`;
      b.onclick = () => { addToCart(p); $('search-input').value = ''; box.hidden = true; };
      box.appendChild(b);
    }
    box.hidden = !rows.length;
  }, 200);
});

// ---------------------------------------------------------------- cart ----
async function addToCart(person) {
  if (state.cart.some((c) => c.person.id === person.id)) return toast(`${displayName(person)} is already in the cart.`);
  const dir = person.open ? 'out' : 'in';
  if (!state.cart.length) state.direction = dir;
  else if (dir !== state.direction) {
    return toast(
      state.direction === 'in'
        ? `${displayName(person)} is already ON SITE — finish this sign-in first, then sign them out.`
        : `${displayName(person)} isn't signed in — finish this sign-out first.`,
      true
    );
  }
  let guardians = [];
  if (person.is_youth) guardians = await api(`/person/${person.id}/guardians`).catch(() => []);
  const primary = guardians.find((g) => g.is_primary);
  state.cart.push({
    person, guardians,
    emerg1: person.last_emerg_phone_1 || (primary && primary.phone_mobile) || '',
    emerg2: person.last_emerg_phone_2 || '',
  });
  if (navigator.vibrate) navigator.vibrate(30);
  renderCart();
}

function renderCart() {
  const list = $('cart-list'); list.innerHTML = '';
  $('cart-empty').hidden = !!state.cart.length;
  $('btn-clear').hidden = !state.cart.length;
  const hasYouth = state.cart.some((c) => c.person.is_youth);
  const btn = $('btn-sign');
  btn.disabled = !state.cart.length;
  btn.textContent = !state.cart.length ? 'Sign'
    : hasYouth ? (state.direction === 'in' ? `Sign IN (${state.cart.length})` : `Sign OUT (${state.cart.length})`)
    : `Record ${state.direction === 'in' ? 'arrival' : 'departure'}`;

  state.cart.forEach((c, i) => {
    const li = document.createElement('li');
    const p = c.person;
    li.innerHTML = `
      <span class="dir-chip ${state.direction}">${state.direction.toUpperCase()}</span>
      <span><span class="cart-name">${displayName(p)}</span><br>
        <span class="cart-sub">${p.is_youth ? (p.patrol || 'Youth') : 'Adult'}${p.open ? ` · in: ${p.open.event_title}` : ''}</span></span>
      <button class="cart-remove" aria-label="Remove">✕</button>`;
    li.querySelector('.cart-remove').onclick = () => {
      state.cart.splice(i, 1);
      if (!state.cart.length) state.direction = null;
      renderCart();
    };
    if (p.is_youth && state.direction === 'in') {
      const wrap = document.createElement('div');
      wrap.className = 'emerg-wrap';
      wrap.innerHTML = `
        <input type="tel" placeholder="Emergency phone" value="${c.emerg1}">
        <input type="tel" placeholder="2nd phone (optional)" value="${c.emerg2}">`;
      const [i1, i2] = wrap.querySelectorAll('input');
      i1.oninput = () => (c.emerg1 = i1.value);
      i2.oninput = () => (c.emerg2 = i2.value);
      li.appendChild(wrap);
    }
    list.appendChild(li);
  });
}
$('btn-clear').onclick = () => { state.cart = []; state.direction = null; renderCart(); };

// ------------------------------------------------------------- signing ----
$('btn-sign').onclick = () => {
  if (!state.cart.length) return;
  if (state.direction === 'in' && !state.event) { toast('Pick an event first.', true); return openEventPicker(); }
  const hasYouth = state.cart.some((c) => c.person.is_youth);
  if (!hasYouth) return submitTxn({}); // adult-only: no signer/signature
  openSignModal();
};

function openSignModal() {
  state.signerId = null; state.signerOther = null;
  $('sign-title').textContent = state.direction === 'in' ? 'Sign in' : 'Sign out';
  $('sign-names').textContent = state.cart.map((c) => displayName(c.person)).join(' · ');
  $('sign-error').textContent = '';
  $('signer-other').hidden = true; $('signer-other').value = '';

  // union of guardians across youth in the cart, flagging partial authorization
  const youth = state.cart.filter((c) => c.person.is_youth);
  const byId = new Map();
  for (const y of youth) for (const g of y.guardians) {
    if (!g.authorized) continue;
    if (!byId.has(g.id)) byId.set(g.id, { g, count: 0 });
    byId.get(g.id).count++;
  }
  const list = $('signer-list'); list.innerHTML = '';
  for (const { g, count } of byId.values()) {
    const b = document.createElement('button');
    const partial = count < youth.length;
    b.innerHTML = `${g.first_name} ${g.last_name}${g.relationship ? ` · ${g.relationship}` : ''}
      ${partial ? `<span class="warn">Not on the list for every youth in this cart</span>` : ''}`;
    b.onclick = () => selectSigner(b, g.id, null);
    list.appendChild(b);
  }
  const other = document.createElement('button');
  other.textContent = 'Other adult…';
  other.onclick = () => { selectSigner(other, null, ''); $('signer-other').hidden = false; $('signer-other').focus(); };
  list.appendChild(other);

  sigClear();
  openModal('modal-sign');
}
function selectSigner(btn, id, otherVal) {
  state.signerId = id; state.signerOther = otherVal;
  for (const b of $('signer-list').children) b.classList.toggle('selected', b === btn);
  if (id != null) $('signer-other').hidden = true;
}
$('sign-cancel').onclick = closeModal;
$('sign-submit').onclick = async () => {
  const hasYouth = state.cart.some((c) => c.person.is_youth);
  const other = $('signer-other').hidden ? null : $('signer-other').value.trim();
  if (hasYouth && state.signerId == null && !other) return ($('sign-error').textContent = 'Select who is signing.');
  if (hasYouth && sigEmpty) return ($('sign-error').textContent = 'A signature is required.');
  await submitTxn({
    signer_person_id: state.signerId || undefined,
    signer_name_override: other || undefined,
    signature_data: $('sig-canvas').toDataURL('image/png'),
  });
};

async function submitTxn(extra, force) {
  const payload = {
    client_uuid: crypto.randomUUID(),
    direction: state.direction,
    event_id: state.direction === 'in' ? state.event.id : undefined,
    signed_at: new Date().toISOString(),
    entries: state.cart.map((c) => ({
      person_id: c.person.id,
      emerg_phone_1: c.emerg1 || undefined,
      emerg_phone_2: c.emerg2 || undefined,
    })),
    force: force || undefined,
    ...extra,
  };
  try {
    await jpost('/txn', payload);
    closeModal();
    toast(state.direction === 'in' ? 'Signed in ✓' : 'Signed out ✓');
    state.cart = []; state.direction = null;
    renderCart(); refreshOnsiteCount();
  } catch (e) {
    if (e.status === 422 && e.body.unauthorized) {
      const ok = confirm(`Signer is not on the authorized list for: ${e.body.unauthorized.join(', ')}.\n\nStaff override — record anyway?`);
      if (ok) return submitTxn(extra, true);
      $('sign-error').textContent = 'Choose a different signer.';
    } else if (e.status === 409 && e.body.conflicts) {
      toast(`${e.body.error} ${e.body.conflicts.join(', ')} — refresh the cart.`, true);
      state.cart = []; state.direction = null; renderCart(); closeModal(); refreshOnsiteCount();
    } else {
      $('sign-error').textContent = e.message; toast(e.message, true);
    }
  }
}

// signature pad (pointer events, no dependency)
const sig = $('sig-canvas');
const sctx = sig.getContext('2d');
let sigEmpty = true, drawing = false;
function sigClear() {
  sctx.fillStyle = '#fff'; sctx.fillRect(0, 0, sig.width, sig.height);
  sctx.strokeStyle = '#1C241E'; sctx.lineWidth = 2.5; sctx.lineCap = 'round';
  sigEmpty = true;
}
function sigPos(e) {
  const r = sig.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (sig.width / r.width), y: (e.clientY - r.top) * (sig.height / r.height) };
}
sig.addEventListener('pointerdown', (e) => {
  drawing = true; sigEmpty = false; sig.setPointerCapture(e.pointerId);
  const p = sigPos(e); sctx.beginPath(); sctx.moveTo(p.x, p.y);
});
sig.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const p = sigPos(e); sctx.lineTo(p.x, p.y); sctx.stroke();
});
sig.addEventListener('pointerup', () => (drawing = false));
$('sig-clear').onclick = sigClear;

// ------------------------------------------------------------- visitor ----
$('btn-visitor').onclick = () => {
  for (const id of ['vis-first', 'vis-last', 'vis-guardian', 'vis-phone']) $(id).value = '';
  $('vis-error').textContent = '';
  openModal('modal-visitor');
};
$('vis-youth').onchange = () => ($('vis-guardian-wrap').hidden = !$('vis-youth').checked);
$('vis-cancel').onclick = closeModal;
$('vis-save').onclick = async () => {
  try {
    const { person } = await jpost('/visitor', {
      is_youth: $('vis-youth').checked,
      first_name: $('vis-first').value.trim(),
      last_name: $('vis-last').value.trim(),
      guardian_name: $('vis-guardian').value.trim() || undefined,
      guardian_phone: $('vis-phone').value.trim() || undefined,
    });
    closeModal(); addToCart(person);
  } catch (e) { $('vis-error').textContent = e.message; }
};

// ------------------------------------------------------------- on site ----
async function refreshOnsiteCount() {
  const rows = await api('/onsite').catch(() => []);
  $('onsite-pill').textContent = `On site: ${rows.length}`;
}
$('onsite-pill').onclick = async () => { show('screen-onsite'); await renderOnsite(); };
$('onsite-back').onclick = () => { show('screen-main'); refreshOnsiteCount(); };

async function renderOnsite() {
  const patrols = await api('/patrols').catch(() => []);
  const pf = $('patrol-filters'); pf.innerHTML = '';
  const mk = (label, val) => {
    const b = document.createElement('button');
    b.className = 'pill ghost-pill' + (state.patrol === val ? ' active' : '');
    b.textContent = label;
    b.onclick = () => { state.patrol = val; renderOnsite(); };
    pf.appendChild(b);
  };
  mk('All', null);
  patrols.forEach((p) => mk(p, p));

  const rows = await api('/onsite' + (state.patrol ? '?patrol=' + encodeURIComponent(state.patrol) : ''));
  const wrap = $('onsite-list'); wrap.innerHTML = '';
  if (!rows.length) { wrap.innerHTML = '<p class="hint">Nobody is signed in right now.</p>'; return; }
  const byEvent = new Map();
  for (const r of rows) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, { title: r.event_title, rows: [] });
    byEvent.get(r.event_id).rows.push(r);
  }
  for (const g of byEvent.values()) {
    const div = document.createElement('div');
    div.className = 'group';
    div.innerHTML = `<h4>${g.title} · ${g.rows.length}</h4>`;
    for (const r of g.rows) {
      const el = document.createElement('div');
      el.className = 'person';
      const since = new Date(r.signed_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      el.innerHTML = `<span>${r.nickname || r.first_name} ${r.last_name}
          ${r.is_youth ? '' : '<span class="adult-tag">adult</span>'}</span>
        <span class="since">${r.patrol || ''} · in ${since}</span>`;
      wrap.lastChild === div || wrap.appendChild(div);
      div.appendChild(el);
    }
    wrap.appendChild(div);
  }
}

// ---------------------------------------------------------------- PWA -----
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

boot();
