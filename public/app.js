'use strict';
/* Troop Check-In kiosk (troop identity comes from /api/config) */

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
// Every kiosk request carries a timeout (field lesson, 2026-08 campout: on a
// WEAK signal fetch neither succeeds nor fails — it hangs, so none of the
// offline fallbacks ever fired and the app just froze). An aborted request
// throws without a .status, which is exactly the shape every `.catch((e) =>
// e.status ? … : Offline.…)` fallback already treats as "network down" — so
// slow network now behaves like no network. Writes get a longer budget than
// lookups; queued txns are idempotent server-side (client_uuid), so a
// timed-out POST that actually landed is safe to retry from the queue.
const API_TIMEOUT_MS = 6000, API_WRITE_TIMEOUT_MS = 12000;
// The block-screen TLC re-check is a deliberate round trip to Trail Life
// Connect (login + export fetch, 15–25s on the Pi) — not a kiosk save. The
// 12s write budget aborted it client-side while the server finished anyway,
// so the retry then showed a STALE forms-as-of time (live finding
// 2026-08-30). That one call gets a longer leash.
const TLC_RECHECK_TIMEOUT_MS = 45000;
function timeoutSignal(ms) {
  if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
async function api(path, opts = {}) {
  const { timeoutMs, ...rest } = opts;
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    signal: timeoutSignal(timeoutMs || API_TIMEOUT_MS),
    ...rest,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `Request failed (${res.status})`); e.body = body; e.status = res.status; throw e; }
  return body;
}
const jpost = (path, data, timeoutMs) =>
  api(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data), timeoutMs: timeoutMs || API_WRITE_TIMEOUT_MS,
  });

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
    // health-form badge switch (admin-set, default off); cached for offline boots
    state.flagHealthForms = !!cfg.flag_health_forms;
    state.permForms = !!cfg.permission_forms_enabled;
    try {
      localStorage.setItem('flag-health-forms', state.flagHealthForms ? '1' : '0');
      localStorage.setItem('flag-perm-forms', state.permForms ? '1' : '0');
    } catch { /* ignore */ }
  }).catch(() => {
    try {
      state.flagHealthForms = localStorage.getItem('flag-health-forms') === '1';
      state.permForms = localStorage.getItem('flag-perm-forms') === '1';
    } catch { /* ignore */ }
  });
  try {
    state.me = await api('/me');
    await enterKiosk();
  } catch (e) {
    if (!e.status && offlineWindowOpen()) {
      // network down/slow but this device has a session that the server will
      // still honor (door sessions cover the event + 12h) — enter offline
      state.me = JSON.parse(localStorage.getItem('last-me'));
      state.offline = true;
      toast('Offline — working from the saved roster. Records will sync when back online.', true);
      await enterKiosk();
      return;
    }
    await renderLogin(!e.status);
  }
}

// The offline-entry window: how long this device may enter the kiosk without
// reaching the server. It equals the cached session's server-side expiry
// (door sessions: event end + 12h), so anything recorded offline still syncs
// on a valid cookie once signal returns.
function offlineWindowOpen() {
  try {
    const me = JSON.parse(localStorage.getItem('last-me') || 'null');
    if (!me) return false;
    if (!me.session_expires_at) return true; // pre-upgrade cache — keep old behavior
    return new Date(me.session_expires_at) > new Date();
  } catch { return false; }
}

async function renderLogin(networkDown) {
  show('screen-login');
  $('pin-panel').hidden = true;
  // staff list: live when possible, cached copy when the network is down —
  // the login screen must render offline (field lesson, 2026-08 campout)
  const list = await api('/staff-list').then((l) => {
    localStorage.setItem('staff-list-cache', JSON.stringify(l));
    return l;
  }).catch((e) => {
    if (e.status) return [];
    networkDown = true;
    try { return JSON.parse(localStorage.getItem('staff-list-cache') || '[]'); } catch { return []; }
  });
  const grid = $('staff-list');
  grid.innerHTML = '';

  // one-tap offline entry for the person who last logged in on this device
  if (networkDown && offlineWindowOpen()) {
    const me = JSON.parse(localStorage.getItem('last-me'));
    const cont = document.createElement('button');
    cont.className = 'continue-offline';
    cont.textContent = `Continue offline as ${me.name}`;
    cont.onclick = async () => {
      state.me = me; state.offline = true;
      toast('Offline — working from the saved roster. Records will sync when back online.', true);
      await enterKiosk();
    };
    grid.appendChild(cont);
  }
  if (networkDown) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = list.length
      ? 'No connection — PINs can\'t be checked offline. Use "Continue offline" above if it\'s shown, or reconnect.'
      : 'No connection and no saved roster on this device yet — connect to the network once first.';
    grid.appendChild(hint);
    if (!list.length) return;
  } else if (!list.length) {
    grid.innerHTML = '<p class="hint">No staff yet — create accounts in Admin → Staff (or the create-staff script).</p>';
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
  } catch (e) {
    $('login-error').textContent = e.status
      ? e.message
      : 'No connection — PINs can\'t be verified offline. Reconnect, or use "Continue offline" if it\'s shown.';
    if (!e.status) renderLogin(true); // surface the continue-offline option
  }
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
  // the snapshot is the whole roster — give it the write budget on slow links
  try { await Offline.saveSnapshot(await api('/roster-snapshot', { timeoutMs: API_WRITE_TIMEOUT_MS })); } catch { /* offline */ }
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
  // The server suggests the best match (30 min before start → 60 min after
  // end; overlaps resolved toward the nearest sign-in/sign-out rush). The
  // pill always lets staff switch to any other event.
  const { matching, suggested_id } = await eventsCurrent();
  const pick = matching.find((e) => e.id === suggested_id) || (matching.length === 1 ? matching[0] : null);
  if (pick) setEvent(pick);
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
  // One scan per open: close the camera BEFORE handling, so any follow-up
  // dialog (e.g. "Link badge?") opens on a clean screen. Most families scan
  // one badge; reopening for a sibling beats a camera that lingers.
  stopCamera();
  closeModal();
  handleScan(value);
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

// ------------------------------------------- membership expiry warning ----
// Warn (never block) when a youth's Trail Life membership has expired or
// expires within 30 days. Day-granular like the events past-rule. The date
// is normalized to ISO on import but parsed defensively here; works offline
// because membership_expires rides along in the roster snapshot.
function membershipExpiry(p) {
  if (!p || !p.is_youth || !p.membership_expires) return null;
  const v = String(p.membership_expires);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
  if (isNaN(d)) return null;
  const now = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate())
    - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  if (days > 30) return null;
  const when = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return {
    days,
    tag: days < 0 ? 'Membership expired' : 'Membership expiring',
    line: days < 0
      ? `Membership expired ${when} — renewal overdue`
      : `Membership expires ${when} — renewal due`,
  };
}

// ------------------------------------------------- form badges (sign-in) ----
// Calm informational flags, never blocks (handoff §4b, 2026-08-29):
//   - health form: required at EVERY event for registered members, but the
//     badge only shows when the admin switch is on (default off — sparse TLC
//     data until the backfill) — the switch arrives via /api/config;
//   - High Adventure form: only on events with requires_high_adventure_form
//     (app-owned checkbox in the admin event editor).
// Missing or expired flags; unparseable stored dates count as on file
// (defensive, same as the reports). Sign-in only — pickup stays uncluttered.
const FORM_VALID_DAYS = 365; // 12 months from submission; matches server lib/healthForms.js

function formExpiredDays(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateStr));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(dateStr);
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + FORM_VALID_DAYS);
  const now = new Date();
  return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate())
    - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000); // >0 = expired
}

function formNotes(p) {
  const notes = [];
  // registered members only — visitors and pickup-only designees are out of scope
  if (!p || p.status !== 'active' || (!p.is_youth && !p.member_id)) return notes;
  const note = (dateStr, label) => {
    if (dateStr == null) return notes.push(`${label} not on file — collect one`);
    const over = formExpiredDays(dateStr);
    if (over != null && over > 0) notes.push(`${label} expired ${over}d ago — collect an updated one`);
  };
  if (state.flagHealthForms) note(p.health_form_date, 'Health form');
  if (state.event && state.event.requires_high_adventure_form) {
    note(p.high_risk_form_date, 'High Adventure medical form');
  }
  return notes;
}

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
    const exp = membershipExpiry(p); // orange, clearly visible, never blocks
    li.innerHTML = `
      <span class="dir-chip ${state.direction}">${state.direction.toUpperCase()}</span>
      <span><span class="cart-name">${displayName(p)}</span>${exp ? ` <span class="exp-tag">⚠ ${exp.tag}</span>` : ''}<br>
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
    if (p.is_youth && state.direction === 'out') {
      // Advancement verification for the TLC write-back: defaults to yes;
      // unchecking records attendance on TLC WITHOUT advancement credit for
      // this youth only (they didn't finish what the event had planned).
      const wrap = document.createElement('label');
      wrap.className = 'check adv-check';
      wrap.innerHTML = `<input type="checkbox" ${c.advancement !== false ? 'checked' : ''}>
        Completed all planned requirements for this event`;
      const cb = wrap.querySelector('input');
      cb.onchange = () => (c.advancement = cb.checked);
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
  // membership expiry notes (informational only — check-in is never blocked)
  const expLines = state.cart
    .map((c) => ({ p: c.person, exp: membershipExpiry(c.person) }))
    .filter((x) => x.exp)
    .map((x) => `⚠ ${displayName(x.p)}: ${x.exp.line}`);
  // form badges: sign-in only, flag never block (handoff §4b)
  if (state.direction === 'in') {
    for (const c of state.cart) {
      for (const n of formNotes(c.person)) expLines.push(`⚠ ${displayName(c.person)}: ${n}`);
    }
  }
  renderPermissionBanner(); // async — fills #sign-permission when it applies
  $('sign-membership').innerHTML = expLines.join('<br>');
  $('sign-membership').hidden = !expLines.length;
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

// ------------------------------------- permission-form banner (sign-in) ----
// Prominent, per-event, youth-only. Data comes live from /form-status when
// online, or from the roster snapshot offline (where blocking never applies
// — banner only, by design). "As of" is always shown: parents sign late.
async function renderPermissionBanner() {
  const box = $('sign-permission');
  if (!box) return;
  box.hidden = true; box.innerHTML = '';
  if (state.direction !== 'in' || !state.permForms) return;
  if (!state.event || !state.event.requires_permission_form) return;
  const youth = state.cart.filter((c) => c.person.is_youth).map((c) => c.person);
  if (!youth.length) return;
  let signedIds = null, fetchedAt = null;
  try {
    const s = await api('/form-status?event_id=' + state.event.id);
    if (!s.enabled || !s.required) return;
    signedIds = new Set(s.signed_ids); fetchedAt = s.fetched_at;
  } catch (e) {
    if (e.status) return; // server said no (404 etc.) — no banner
    const rows = await Offline.formStatus(state.event.id).catch(() => []);
    signedIds = new Set(rows.filter((r) => r.signed).map((r) => r.person_id));
    fetchedAt = rows.length ? rows[0].fetched_at : null;
  }
  const unsigned = youth.filter((p) => !signedIds.has(p.id));
  if (!unsigned.length) return;
  const when = fetchedAt ? new Date(fetchedAt + (fetchedAt.endsWith('Z') ? '' : 'Z'))
    .toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  box.innerHTML = `<b>⚠ Permission form NOT signed</b> — ${unsigned.map((p) => esc2(displayName(p))).join(', ')}.
    <br>${when ? `Forms as of ${when}.` : 'No form data fetched for this event yet.'}
    ${state.event.permission_block ? ' Check-in will be <b>blocked</b> until a re-check finds the signature or staff records an override.' : ' Ask the family to sign in Trail Life Connect.'}`;
  box.hidden = false;
}
const esc2 = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function submitTxn(extra, force) {
  const payload = {
    client_uuid: newUuid(),
    direction: state.direction,
    // 'in' requires the event; on 'out' it is a hint so someone signed into
    // two overlapping events is signed out of the SELECTED one
    event_id: state.event ? state.event.id : undefined,
    signed_at: new Date().toISOString(),
    entries: state.cart.map((c) => ({
      person_id: c.person.id,
      emerg_phone_1: c.emerg1 || undefined,
      emerg_phone_2: c.emerg2 || undefined,
      // sign-out only: TLC advancement verification (default yes)
      advancement: state.direction === 'out' ? c.advancement !== false : undefined,
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
    if (e.status === 422 && e.body.permission_unsigned) {
      return handlePermissionBlock(extra || {}, force, e.body);
    }
    if (e.status === 422 && e.body.unauthorized) {
      const ok = confirm(`Signer is not on the authorized list for: ${e.body.unauthorized.join(', ')}.\n\nStaff override — record anyway?`);
      if (ok) return submitTxn(extra, true);
      $('sign-error').textContent = 'Choose a different signer.';
    } else if (e.status === 422 && e.body.adults) {
      toast(`${e.body.error} Remove: ${e.body.adults.join(', ')}.`, true);
    } else if (e.status === 409 && e.body.multi_open && state.direction === 'in') {
      const who = e.body.multi_open.map((m) => `${m.name} (${m.events.join(', ')})`).join('\n');
      const ok = confirm(`Still signed into another event:\n\n${who}\n\nAlso sign into ${state.event.title}? They will be on-site in BOTH events until each is signed out.`);
      if (ok) return submitTxn({ ...extra, allow_multi: true }, force);
      $('sign-error').textContent = 'Sign-in cancelled.';
    } else if (e.status === 409 && e.body.multi_open) {
      toast(`${e.body.error} (${e.body.multi_open.map((m) => m.name).join(', ')})`, true);
    } else if (e.status === 409 && e.body.conflicts) {
      toast(`${e.body.error} ${e.body.conflicts.join(', ')} — refresh the cart.`, true);
      state.cart = []; state.direction = null; renderCart(); closeModal(); refreshOnsiteCount();
    } else {
      $('sign-error').textContent = e.message; toast(e.message, true);
    }
  }
}

// Soft-block resolution: offer a fresh TLC re-check first (the parent may
// have just signed on their phone), then a RECORDED staff override. Never a
// dead end (handoff decision 2026-08-30).
async function handlePermissionBlock(extra, force, body) {
  const names = (body.permission_unsigned || []).join(', ');
  const when = body.fetched_at ? ` (forms as of ${new Date(body.fetched_at + 'Z')
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : '';
  if (!extra.__rechecked &&
      confirm(`Permission form not signed for: ${names}${when}.\n\nRe-check Trail Life Connect now? A parent may have just signed.`)) {
    try {
      await jpost('/event-forms-refresh', { event_id: state.event.id }, TLC_RECHECK_TIMEOUT_MS);
      toast('Re-checked — trying again…');
    } catch (err) {
      // rate-limited or TLC down: fall through to override. An abort has no
      // .status — name the situation instead of the raw "signal timed out".
      toast(err.status ? err.message
        : 'TLC re-check timed out — retry in a minute or use the recorded override.', true);
    }
    return submitTxn({ ...extra, __rechecked: true }, force);
  }
  // Say plainly when a SUCCESSFUL re-check simply found no new signature —
  // in live testing the silent fall-through to the override dialog read as
  // "the re-check failed" (Phase C finding, 2026-08-30).
  const lead = extra.__rechecked
    ? `Re-checked Trail Life Connect — ${names} still NOT signed${when}.`
    : `Permission form not signed for: ${names}${when}.`;
  if (confirm(`${lead}\n\nSign in anyway WITHOUT a signed permission form?\nStaff override — this is recorded for review.`)) {
    return submitTxn({ ...extra, force_permission: 1 }, force);
  }
  $('sign-error').textContent = extra.__rechecked
    ? 'Blocked — re-checked TLC, still not signed.'
    : 'Blocked — permission form not signed.';
  renderPermissionBanner();
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
// Siblings share one parent record: "Add + another youth" saves this child,
// keeps the parent fields (locked) and clears only the child's name, and
// every following child is linked to the SAME guardian (open-house finding
// 2026-08-30 — re-typing the parent per child created duplicate parents).
let visitorGuardian = null; // {id, name} while chaining siblings
function setVisitorParentLock(g) {
  visitorGuardian = g;
  for (const id of ['vis-guardian', 'vis-phone', 'vis-email']) $(id).readOnly = !!g;
  $('vis-parent-note').hidden = !g;
  if (g) $('vis-parent-note').textContent = `Same parent as the last child (${g.name}) — just add the next child's name.`;
}
$('btn-visitor').onclick = () => {
  for (const id of ['vis-first', 'vis-last', 'vis-guardian', 'vis-phone', 'vis-email']) $(id).value = '';
  $('vis-error').textContent = '';
  $('vis-youth').checked = true; $('vis-guardian-wrap').hidden = false;
  setVisitorParentLock(null);
  openModal('modal-visitor');
};
$('vis-youth').onchange = () => {
  $('vis-guardian-wrap').hidden = !$('vis-youth').checked;
  $('vis-save-more').hidden = !$('vis-youth').checked; // siblings are a youth thing
};
$('vis-cancel').onclick = () => { setVisitorParentLock(null); closeModal(); };
async function saveVisitor(andAnother) {
  // Youth visitors: EVERY field is required (name, parent name, phone, email)
  // — open-house follow-up depends on complete contact info. Adults: name only.
  // When chaining a sibling the locked parent fields already satisfied that.
  if (!$('vis-first').value.trim() || !$('vis-last').value.trim()) {
    return ($('vis-error').textContent = 'First and last name are required.');
  }
  const youth = $('vis-youth').checked;
  if (youth && !visitorGuardian &&
      (!$('vis-guardian').value.trim() || !$('vis-phone').value.trim() || !$('vis-email').value.trim())) {
    return ($('vis-error').textContent = "Parent/guardian name, phone, AND email are all required for a youth visitor.");
  }
  try {
    const r = await jpost('/visitor', {
      is_youth: youth,
      first_name: $('vis-first').value.trim(),
      last_name: $('vis-last').value.trim(),
      guardian_id: youth && visitorGuardian ? visitorGuardian.id : undefined,
      guardian_name: $('vis-guardian').value.trim() || undefined,
      guardian_phone: $('vis-phone').value.trim() || undefined,
      guardian_email: $('vis-email').value.trim() || undefined,
    });
    addToCart(r.person);
    if (andAnother && youth && r.guardian_id) {
      setVisitorParentLock({ id: r.guardian_id, name: r.guardian_name || $('vis-guardian').value.trim() });
      $('vis-first').value = ''; $('vis-last').value = ''; $('vis-error').textContent = '';
      $('vis-first').focus();
      toast(`${displayName(r.person)} added — next child for the same parent.`);
      return;
    }
    setVisitorParentLock(null); closeModal();
  } catch (e) { $('vis-error').textContent = e.message; }
}
$('vis-save').onclick = () => saveVisitor(false);
$('vis-save-more').onclick = () => saveVisitor(true);

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
        r.sent.map((x) => `<div class="notify-row">${x.adult
          ? `${esc(x.adult)} (adult)`
          : `${esc(x.guardian)} ← ${esc(x.youths.join(', '))}`}</div>`).join('')
      : '<p class="hint">No texts sent.</p>') +
    (r.skipped.length
      ? `<h4 class="warn-text">⚠️ Not contacted — reach these families another way</h4>` +
        r.skipped.map((x) => `<div class="notify-row">${esc(x.youth || x.adult || (x.youths || []).join(', '))}${x.adult ? ' (adult)' : ''} — <span class="warn-text">${esc(x.reason)}</span></div>`).join('')
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
  // adults option only where it can apply: an adult-tracked selected event
  // (off by default every time — including adults is an explicit choice)
  $('msg-adults').checked = false;
  $('msg-adults-wrap').hidden = !(state.event && state.event.track_adults);
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
      include_adults: !$('msg-adults-wrap').hidden && $('msg-adults').checked ? 1 : undefined,
    }));
  } catch (e) { $('msg-error').textContent = e.message; }
};

// Offline shape adapter: Offline.onsite() returns snapshot people with
// p.open = {in_txn_id, event_id, event_title}; map to the server row shape.
async function onsiteRowsOffline() {
  const local = await Offline.onsite().catch(() => []);
  return local
    .filter((p) => !state.patrol || (p.patrol || '') === state.patrol)
    .map((p) => ({
      id: p.id, first_name: p.first_name, last_name: p.last_name, nickname: p.nickname,
      patrol: p.patrol, is_youth: p.is_youth ? 1 : 0,
      event_id: p.open.event_id, event_title: p.open.event_title, signed_at: null,
    }));
}

// On-site sort (open-house request 2026-08-30): default LAST NAME within each
// event group; Sign-in time / Patrol / First name selectable; remembered per
// device like the station patrol. Client-side so it works offline — offline
// rows have no signed_at, so the time sort falls back to name order instead
// of scrambling.
const ONSITE_SORTS = [
  ['last', 'Last name'], ['time', 'Sign-in time'], ['patrol', 'Patrol'], ['first', 'First name'],
];
let onsiteSort = localStorage.getItem('onsite-sort') || 'last';
function onsiteComparator(key) {
  const name = (r) => `${r.last_name}|${r.first_name}`.toLowerCase();
  const byName = (a, b) => name(a).localeCompare(name(b));
  if (key === 'first') return (a, b) => `${a.first_name}|${a.last_name}`.toLowerCase()
    .localeCompare(`${b.first_name}|${b.last_name}`.toLowerCase());
  if (key === 'patrol') return (a, b) => {
    // no patrol (adults, visitors) sorts LAST, then alphabetical, then by name
    if (!a.patrol !== !b.patrol) return a.patrol ? -1 : 1;
    return (a.patrol || '').localeCompare(b.patrol || '') || byName(a, b);
  };
  if (key === 'time') return (a, b) => {
    const ta = a.signed_at ? new Date(a.signed_at).getTime() : null;
    const tb = b.signed_at ? new Date(b.signed_at).getTime() : null;
    if (ta != null && tb != null && ta !== tb) return ta - tb;
    return byName(a, b);
  };
  return byName;
}
function renderOnsiteSortPills() {
  const box = $('onsite-sort'); box.innerHTML = '';
  const lab = document.createElement('span'); lab.className = 'sort-label'; lab.textContent = 'Sort:';
  box.appendChild(lab);
  for (const [key, label] of ONSITE_SORTS) {
    const b = document.createElement('button');
    b.className = 'pill ghost-pill' + (onsiteSort === key ? ' active' : '');
    b.textContent = label;
    b.onclick = () => {
      onsiteSort = key;
      try { localStorage.setItem('onsite-sort', key); } catch { /* ignore */ }
      renderOnsite();
    };
    box.appendChild(b);
  }
}

async function renderOnsite() {
  let offlineData = false;
  const rows = await api('/onsite' + (state.patrol ? '?patrol=' + encodeURIComponent(state.patrol) : ''))
    .catch(async (e) => {
      if (e.status) throw e;
      offlineData = true; // network down/slow: snapshot + queued (field lesson, 2026-08)
      return onsiteRowsOffline();
    });
  const patrols = await api('/patrols').catch(async (e) => {
    if (e.status) return [];
    // offline: derive the filter choices from the local snapshot
    const all = await Offline.onsite().catch(() => []);
    return [...new Set(all.map((p) => p.patrol).filter(Boolean))].sort();
  });
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
  renderOnsiteSortPills();

  const wrap = $('onsite-list'); wrap.innerHTML = '';
  if (offlineData) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Offline — showing the saved roster plus anything recorded on this device.';
    wrap.appendChild(note);
  }
  if (!rows.length) { wrap.innerHTML += '<p class="hint">Nobody is signed in right now.</p>'; return; }
  const byEvent = new Map();
  for (const r of rows) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, { title: r.event_title, rows: [] });
    byEvent.get(r.event_id).rows.push(r);
  }
  const cmp = onsiteComparator(onsiteSort);
  for (const g of byEvent.values()) {
    const div = document.createElement('div');
    div.className = 'group';
    div.innerHTML = `<h4>${g.title} · ${g.rows.length}</h4>`;
    wrap.appendChild(div);
    for (const r of [...g.rows].sort(cmp)) {
      const el = document.createElement('button');
      el.className = 'person onsite-person';
      el.type = 'button';
      const since = r.signed_at
        ? ' · in ' + new Date(r.signed_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : '';
      el.innerHTML = `<span>${r.nickname || r.first_name} ${r.last_name}
          ${r.is_youth ? '' : '<span class="adult-tag">adult</span>'}</span>
        <span class="since">${r.patrol || ''}${since}</span>`;
      el.onclick = () => showEmergencyInfo(r.id); // tap → emergency contacts
      div.appendChild(el);
    }
  }
}

// ------------------------------------------- emergency contacts (on-site) ----
// Tap an on-site person → their emergency numbers + guardians, tap-to-call.
// Reads the OFFLINE SNAPSHOT first (it must work with no signal — that's
// when you need it most); the snapshot refreshes on every kiosk entry and
// after every synced transaction.
async function showEmergencyInfo(personId) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const tel = (label, num) => num
    ? `<div class="contact-row"><span>${esc(label)}</span><a href="tel:${esc(String(num).replace(/[^+\d]/g, ''))}">${esc(num)}</a></div>`
    : '';
  let p = await Offline.getPerson(personId).catch(() => null);
  if (!p) { await refreshSnapshot(); p = await Offline.getPerson(personId).catch(() => null); }
  if (!p) { toast('No saved details for this person on this device — connect once to refresh the roster.', true); return; }
  const guardians = await Offline.guardiansOf(personId).catch(() => []);
  const box = $('emergency-body');
  box.innerHTML =
    `<h3>${esc(displayName(p))}${p.patrol ? ` <span class="since">· ${esc(p.patrol)}</span>` : ''}</h3>` +
    `<h4>Emergency contacts (from last sign-in)</h4>` +
    (tel('Emergency 1', p.last_emerg_phone_1) + tel('Emergency 2', p.last_emerg_phone_2) ||
      '<p class="hint">None recorded yet — they\'re captured at sign-in.</p>') +
    (guardians.length
      ? `<h4>Guardians</h4>` + guardians.map((g) =>
          `<div class="contact-guardian">${esc(displayName(g))}` +
          `${g.is_primary ? ' ★' : ''}${g.relationship ? ` <span class="since">(${esc(g.relationship)})</span>` : ''}` +
          tel('Mobile', g.phone_mobile) + tel('Home', g.phone_home) + `</div>`).join('')
      : (p.is_youth ? '<p class="hint">No linked guardians in the saved roster.</p>' : ''));
  openModal('modal-emergency');
}
$('emergency-close').onclick = closeModal;

// ------------------------------------------------------ field debugging ----
// A thrown error must never look like "the button does nothing" — surface it.
window.addEventListener('error', (e) => toast(`App error: ${e.message}`, true));
window.addEventListener('unhandledrejection', (e) =>
  toast(`App error: ${e.reason && e.reason.message ? e.reason.message : e.reason}`, true));

// ---------------------------------------------------------------- PWA -----
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

boot();
