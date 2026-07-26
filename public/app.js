'use strict';
/* NY-2911 Troop Check-In kiosk */

const $ = (id) => document.getElementById(id);

// crypto.randomUUID only exists in secure contexts (https / localhost); on
// plain LAN http (http://<pi-ip>:3000) it's undefined. getRandomValues works
// everywhere, so fall back to a manual v4 UUID.
function newUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const state = {
  me: null,
  event: null,           // selected event
  cart: [],              // [{person, guardians[], emerg1, emerg2}]
  direction: null,       // 'in' | 'out' — set by first cart entry
  signerId: null,
  signerOther: null,
  pendingLink: null,     // {code, person}
  patrol: null,
  station: localStorage.getItem('station-patrol') || null, // per-device patrol scope
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
  // branding comes from server config (.env) — nothing troop-specific in source
  api('/config').then((cfg) => {
    document.querySelectorAll('[data-brand-id]').forEach((el) => (el.textContent = cfg.troop_id));
    document.querySelectorAll('[data-brand-name]').forEach((el) => (el.textContent = cfg.troop_name));
    document.title = `${cfg.troop_id} Check-In`;
  }).catch(() => {});
  try {
    state.me = await api('/me');
    await enterKiosk();
  } catch (e) {
    if (!e.status && localStorage.getItem('last-me')) {
      // network down but we had a session — enter offline kiosk mode
      state.me = JSON.parse(localStorage.getItem('last-me'));
      state.offline = true;
      toast('Offline — working from the saved roster. Records will sync when back online.', true);
      await enterKiosk();
      return;
    }
    await renderLogin();
  }
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
      const inp = $('pin-input');
      inp.value = ''; inp.dataset.staffId = s.id;
      // door staff (and admins who set a PIN) get the numeric keypad;
      // admins without a PIN type their full password
      if (s.has_pin) {
        inp.placeholder = 'PIN'; inp.maxLength = 8;
        inp.setAttribute('inputmode', 'numeric');
      } else {
        inp.placeholder = 'Password'; inp.maxLength = 64;
        inp.setAttribute('inputmode', 'text');
      }
      $('login-error').textContent = '';
      inp.focus();
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
  if (!state.offline) localStorage.setItem('last-me', JSON.stringify(state.me));
  $('staff-pill').textContent = state.me.name;
  renderStationPill();
  renderCart();
  refreshOnsiteCount();
  refreshSnapshot();
  flushQueue();
  updateQueuePill();
  await pickEventAuto();
}

// -------------------------------------------------------- offline sync ----
async function refreshSnapshot() {
  try { await Offline.saveSnapshot(await api('/roster-snapshot')); } catch { /* offline */ }
}
async function flushQueue() {
  const r = await Offline.flush((payload) => jpost('/txn', payload)).catch(() => null);
  if (r && r.sent) {
    toast(`Synced ${r.sent} offline record${r.sent > 1 ? 's' : ''} ✓`);
    refreshSnapshot(); refreshOnsiteCount();
  }
  if (r && r.conflicts) {
    toast(`${r.conflicts} offline record(s) could not sync — tap the ⚠ pill.`, true);
  }
  updateQueuePill();
}
async function updateQueuePill() {
  const q = await Offline.queueSize().catch(() => 0);
  const c = await Offline.conflictCount().catch(() => 0);
  const pill = $('queue-pill');
  pill.hidden = !q && !c;
  pill.textContent = c ? `⚠ ${c}${q ? ` · ⏳ ${q}` : ''}` : `⏳ ${q} queued`;
}
$('queue-pill').onclick = async () => {
  const conflicts = await Offline.conflictList();
  if (!conflicts.length) return toast('Queued records will sync automatically when back online.');
  const lines = conflicts.map((c) =>
    `${c.direction.toUpperCase()} — ${(c.entries || []).length} people — ${c._error}`).join('\n');
  if (confirm(`These offline records were rejected when syncing (usually because another station already handled them):\n\n${lines}\n\nClear them? (The server state is authoritative.)`)) {
    for (const c of conflicts) await Offline.clearConflict(c.client_uuid);
    updateQueuePill();
  }
};
window.addEventListener('online', flushQueue);
setInterval(async () => { if (await Offline.queueSize().catch(() => 0)) flushQueue(); }, 20_000);

// ------------------------------------------------------ idle auto-logout ----
let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  const mins = Number(localStorage.getItem('idle-minutes')) || 20;
  idleTimer = setTimeout(async () => {
    // never dump a half-finished cart or an offline session
    if (!state.me || state.cart.length || state.offline) return resetIdle();
    await jpost('/logout', {}).catch(() => {});
    state.me = null;
    renderLogin();
    toast('Signed out after inactivity.');
  }, mins * 60 * 1000);
}
for (const evt of ['pointerdown', 'keydown']) window.addEventListener(evt, resetIdle, { passive: true });
resetIdle();

// ------------------------------------------------------- station mode ----
// Per-device patrol scope (persists on this device): the roster view and
// on-site list narrow to one patrol; scanned badges are ALWAYS accepted.
function renderStationPill() {
  $('station-pill').textContent = state.station ? `Station: ${state.station}` : 'All patrols';
  $('station-pill').classList.toggle('active', !!state.station);
}
$('station-pill').onclick = async () => {
  const patrols = await api('/patrols').catch(() => []);
  const cycle = [null, ...patrols];
  const next = cycle[(cycle.indexOf(state.station) + 1) % cycle.length];
  state.station = next;
  if (next) localStorage.setItem('station-patrol', next);
  else localStorage.removeItem('station-patrol');
  renderStationPill();
  refreshOnsiteCount();
  toast(next ? `This station now shows ${next} only (scans still accept anyone).` : 'Showing all patrols.');
};
const stationFilter = (rows) =>
  state.station ? rows.filter((p) => !p.is_youth || (p.patrol || '') === state.station) : rows;

const eventsCurrent = () =>
  api('/events/current').catch((e) => { if (e.status) throw e; return Offline.currentEvents(); });

async function pickEventAuto() {
  const { matching } = await eventsCurrent();
  if (matching.length === 1) setEvent(matching[0]);
  else if (state.event == null) openEventPicker();
}
function setEvent(ev) {
  state.event = ev;
  $('event-pill').textContent = ev ? ev.title : 'Choose event';
}
$('event-pill').onclick = openEventPicker;

async function openEventPicker() {
  // sorted now → furthest away; past events hidden behind a toggle
  const { matching, upcoming, past } = await eventsCurrent();
  const wrap = $('event-list'); wrap.innerHTML = '';
  const add = (parent, ev, tag) => {
    const b = document.createElement('button');
    const start = new Date(ev.start_at), end = new Date(ev.end_at);
    b.innerHTML = `<b>${ev.title}</b>${tag ? ` <span class="when">· ${tag}</span>` : ''}<br>
      <span class="when">${start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      – ${end.toLocaleString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
    b.onclick = () => { setEvent(ev); closeModal(); };
    parent.appendChild(b);
  };
  matching.forEach((ev) => add(wrap, ev, 'now'));
  upcoming.forEach((ev) => add(wrap, ev));
  if (!matching.length && !upcoming.length) {
    wrap.innerHTML = '<p class="hint">Nothing current or upcoming — create one below.</p>';
  }
  if (past.length) {
    const det = document.createElement('details');
    det.className = 'past-events';
    det.innerHTML = '<summary>Show past events</summary>';
    past.forEach((ev) => add(det, ev, 'past'));
    wrap.appendChild(det);
  }
  openModal('modal-events');
}
$('events-close').onclick = closeModal;
$('ev-create').onclick = async () => {
  try {
    const ev = await jpost('/events', {
      title: $('ev-title').value.trim(),
      start_at: new Date($('ev-start').value).toISOString(),
      end_at: new Date($('ev-end').value).toISOString(),
      track_adults: $('ev-adults').checked,
    });
    setEvent(ev); closeModal(); toast('Event created');
  } catch (e) { toast(e.message, true); }
};

// ------------------------------------------------------------ scanning ----
// Bluetooth HID keyboard-wedge: rapid keystrokes ending in Enter.
// wedgeFast stays true only while every inter-key gap looks like a scanner
// (<35ms); human typing (even fast) breaks it, so we never eat typed input.
// Chars that leak into a focused field before the burst is recognized are
// counted and scrubbed from the field when the scan completes.
let wedgeBuf = '', wedgeLast = 0, wedgeFast = true, wedgeLeaked = 0;
window.addEventListener('keydown', (e) => {
  const el = document.activeElement;
  const typingInField = /INPUT|TEXTAREA/.test(el?.tagName || '');
  const now = Date.now();
  const gap = now - wedgeLast;
  if (gap > 120) { wedgeBuf = ''; wedgeFast = true; wedgeLeaked = 0; }
  wedgeLast = now;
  if (e.key === 'Enter') {
    if (wedgeBuf.length >= 6 && wedgeFast) {
      const code = wedgeBuf; wedgeBuf = '';
      e.preventDefault();
      if (typingInField && wedgeLeaked && typeof el.value === 'string') {
        el.value = el.value.slice(0, el.value.length - wedgeLeaked); // scrub leaked burst chars
      }
      wedgeLeaked = 0;
      handleScan(code);
    }
    return;
  }
  if (e.key.length === 1) {
    if (wedgeBuf) wedgeFast = wedgeFast && gap < 35;
    wedgeBuf += e.key;
    if (typingInField) {
      if (wedgeFast && wedgeBuf.length >= 4) e.preventDefault(); // burst confirmed: suppress
      else wedgeLeaked++;
    }
  }
});

async function handleScan(rawCode) {
  const code = rawCode.trim();
  if (!code) return;
  try {
    const r = await api('/badge/' + encodeURIComponent(code))
      .catch((e) => { if (e.status) throw e; return Offline.findByBadge(code); }); // offline: snapshot
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
      await loadScript('/vendor/jsqr.min.js'); // vendored — works offline / on iOS
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
    const raw = await api('/search?q=' + encodeURIComponent(q))
      .catch((e) => (e.status ? [] : Offline.searchPeople(q))); // offline: snapshot
    const rows = stationFilter(await raw);
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
  // FR-12: adults are only tracked at designated events (server enforces too)
  if (!person.is_youth && dir === 'in' && state.event && !state.event.track_adults) {
    return toast(`${displayName(person)}: this event doesn't track adult attendance.`, true);
  }
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
  if (person.is_youth) {
    guardians = await api(`/person/${person.id}/guardians`)
      .catch((e) => (e.status ? [] : Offline.guardiansOf(person.id))); // offline: snapshot
  }
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
  // photos (when on file) give visual confirmation at pickup
  $('sign-names').innerHTML = state.cart.map((c) => {
    const p = c.person;
    return `<span class="sign-person">${p.photo_path ? `<img src="/photos/${p.photo_path}" alt="">` : ''}<span>${displayName(p)}</span></span>`;
  }).join('');
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
    client_uuid: newUuid(),
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
    refreshSnapshot(); // keep the offline snapshot's open-state current
  } catch (e) {
    if (!e.status) {
      // network is down: queue locally, sync later (client_uuid dedupes retries)
      await Offline.queueTxn(payload);
      closeModal();
      toast(`Saved offline — will sync when back online (${state.direction === 'in' ? 'IN' : 'OUT'} ✓)`);
      state.cart = []; state.direction = null;
      renderCart(); refreshOnsiteCount(); updateQueuePill();
      return;
    }
    if (e.status === 422 && e.body.unauthorized) {
      const ok = confirm(`Signer is not on the authorized list for: ${e.body.unauthorized.join(', ')}.\n\nStaff override — record anyway?`);
      if (ok) return submitTxn(extra, true);
      $('sign-error').textContent = 'Choose a different signer.';
    } else if (e.status === 422 && e.body.adults) {
      toast(`${e.body.error} Remove: ${e.body.adults.join(', ')}.`, true);
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
  const q = state.station ? '?patrol=' + encodeURIComponent(state.station) : '';
  const rows = await api('/onsite' + q).catch(async (e) => {
    if (e.status) return [];
    const local = await Offline.onsite().catch(() => []); // offline: snapshot + queued
    return state.station ? local.filter((p) => (p.patrol || '') === state.station) : local;
  });
  $('onsite-pill').textContent = `On site: ${rows.length}`;
}
$('onsite-pill').onclick = async () => {
  if (state.station && state.patrol == null) state.patrol = state.station; // station scope is the default view
  show('screen-onsite');
  await renderOnsite();
};
$('onsite-back').onclick = () => { show('screen-main'); refreshOnsiteCount(); };

// Guardian texting from the on-site screen. One text per guardian (a parent
// with several youth on site gets a single message covering all of them);
// the results modal lists exactly who was NOT contacted and why.
function renderNotifyResults(r) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const box = $('notify-results');
  box.innerHTML =
    (r.sent.length
      ? `<h4>✅ Texted (${r.sent.length} message${r.sent.length > 1 ? 's' : ''})</h4>` +
        r.sent.map((x) => `<div class="notify-row">${esc(x.guardian)} ← ${esc(x.youths.join(', '))}</div>`).join('')
      : '<p class="hint">No texts sent.</p>') +
    (r.skipped.length
      ? `<h4 class="warn-text">⚠️ Not contacted — reach these families another way</h4>` +
        r.skipped.map((x) => `<div class="notify-row">${esc(x.youth || (x.youths || []).join(', '))} — <span class="warn-text">${esc(x.reason)}</span></div>`).join('')
      : '');
  openModal('modal-notify');
}
$('onsite-notify').onclick = async () => {
  if (!confirm('Text the guardians of everyone still on site' +
    (state.patrol ? ` in ${state.patrol}` : '') + '? Each family gets one message.')) return;
  try {
    renderNotifyResults(await jpost('/notify-onsite', { patrol: state.patrol || undefined }));
  } catch (e) { toast(e.message, true); }
};
$('notify-close').onclick = closeModal;

// custom broadcast (ETA updates etc.) — to on-site youth's guardians, or to
// everyone who attended the current event (even if already picked up)
$('onsite-message').onclick = () => {
  $('msg-text').value = '';
  $('msg-error').textContent = '';
  $('msg-scope-onsite').checked = true;
  $('msg-scope-attended').disabled = !state.event;
  $('msg-scope-attended-label').textContent = state.event
    ? `Everyone who attended: ${state.event.title}`
    : 'Everyone who attended (pick an event first)';
  $('msg-scope').textContent = state.patrol ? `Limited to patrol: ${state.patrol}.` : '';
  openModal('modal-message');
};
$('msg-cancel').onclick = closeModal;
$('msg-send').onclick = async () => {
  const message = $('msg-text').value.trim();
  if (!message) return ($('msg-error').textContent = 'Type the message first.');
  const attended = $('msg-scope-attended').checked;
  try {
    renderNotifyResults(await jpost('/message-onsite', {
      message,
      patrol: state.patrol || undefined,
      scope: attended ? 'attended' : 'onsite',
      event_id: attended && state.event ? state.event.id : undefined,
    }));
  } catch (e) { $('msg-error').textContent = e.message; }
};

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
    wrap.appendChild(div);
    for (const r of g.rows) {
      const el = document.createElement('div');
      el.className = 'person';
      const since = new Date(r.signed_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      el.innerHTML = `<span>${r.nickname || r.first_name} ${r.last_name}
          ${r.is_youth ? '' : '<span class="adult-tag">adult</span>'}</span>
        <span class="since">${r.patrol || ''} · in ${since}</span>`;
      div.appendChild(el);
    }
  }
}

// ------------------------------------------------------ field debugging ----
// A thrown error must never look like "the button does nothing" — surface it.
window.addEventListener('error', (e) => toast(`App error: ${e.message}`, true));
window.addEventListener('unhandledrejection', (e) =>
  toast(`App error: ${e.reason && e.reason.message ? e.reason.message : e.reason}`, true));

// ---------------------------------------------------------------- PWA -----
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

boot();
