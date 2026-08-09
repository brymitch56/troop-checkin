'use strict';
/* Offline-first layer (Phase 4): IndexedDB roster snapshot + transaction
   queue. The kiosk keeps working with no connectivity: lookups hit the
   snapshot, transactions queue locally and sync (client_uuid makes retries
   idempotent server-side); rejected syncs land in a conflicts store. */

(function () {
  const DB_NAME = 'tc-offline', DB_VER = 1;
  let dbp = null;

  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('people', { keyPath: 'id' });
        d.createObjectStore('kv');
        d.createObjectStore('queue', { keyPath: 'client_uuid' });
        d.createObjectStore('conflicts', { keyPath: 'client_uuid' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  const tx = async (store, mode, fn) => {
    const d = await openDb();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  };
  const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
  const kvGet = (key) => tx('kv', 'readonly', (s) => s.get(key));
  const kvSet = (key, val) => tx('kv', 'readwrite', (s) => s.put(val, key));

  // ------------------------------------------------------------- snapshot ----
  async function saveSnapshot(snap) {
    const d = await openDb();
    await new Promise((resolve, reject) => {
      const t = d.transaction(['people', 'kv'], 'readwrite');
      const ps = t.objectStore('people');
      ps.clear();
      for (const p of snap.people) ps.put(p);
      const kv = t.objectStore('kv');
      kv.put(snap.links, 'links');
      kv.put(snap.badges, 'badges');
      kv.put(snap.events, 'events');
      kv.put(snap.taken_at, 'taken_at');
      t.oncomplete = resolve; t.onerror = () => reject(t.error);
    });
  }

  const norm = (s) => String(s || '').toLowerCase();
  async function searchPeople(q) {
    const n = norm(q);
    if (n.length < 2) return [];
    return (await getAll('people'))
      .filter((p) => norm(p.first_name).includes(n) || norm(p.last_name).includes(n) || norm(p.nickname).includes(n))
      .sort((a, b) => (b.is_youth - a.is_youth) || a.last_name.localeCompare(b.last_name))
      .slice(0, 20);
  }
  async function findByBadge(code) {
    const badges = (await kvGet('badges')) || [];
    const hit = badges.find((b) => b.badge_code === code);
    if (hit) return { match: 'badge', person: await tx('people', 'readonly', (s) => s.get(hit.id)) };
    const memberId = String(code).split('|')[0].trim();
    if (memberId) {
      const byId = (await getAll('people')).find((p) => p.member_id === memberId);
      if (byId) return { match: 'member', person: byId };
    }
    return { match: 'none' };
  }
  async function guardiansOf(youthId) {
    const links = (await kvGet('links')) || [];
    const mine = links.filter((l) => l.youth_id === youthId);
    const out = [];
    for (const l of mine) {
      const g = await tx('people', 'readonly', (s) => s.get(l.guardian_id));
      if (g) out.push({ ...g, relationship: l.relationship, authorized: l.authorized, is_primary: l.is_primary });
    }
    return out.filter((g) => g.authorized !== 0 || true).sort((a, b) => (b.is_primary - a.is_primary));
  }
  async function currentEvents() {
    // mirror the server's shape: live / upcoming (not past yet, day-granular) / past
    const events = (await kvGet('events')) || [];
    const now = Date.now();
    const todayStart = new Date(new Date().toDateString()).getTime();
    const matching = events.filter((e) => new Date(e.start_at) <= now && new Date(e.end_at) >= now);
    const upcoming = events.filter((e) => !matching.includes(e) && new Date(e.end_at) >= todayStart)
      .sort((a, b) => new Date(a.start_at) - new Date(b.start_at)).slice(0, 20);
    const past = events.filter((e) => new Date(e.end_at) < todayStart)
      .sort((a, b) => new Date(b.start_at) - new Date(a.start_at)).slice(0, 20);
    return { matching, upcoming, past };
  }
  async function markOpen(personId, open) {
    const p = await tx('people', 'readonly', (s) => s.get(personId));
    if (p) { p.open = open; await tx('people', 'readwrite', (s) => s.put(p)); }
  }
  async function onsite() {
    return (await getAll('people')).filter((p) => p.open);
  }
  const getPerson = (id) => tx('people', 'readonly', (s) => s.get(id));

  // ---------------------------------------------------------------- queue ----
  async function queueTxn(payload) {
    await tx('queue', 'readwrite', (s) => s.put({ ...payload, _queued_at: new Date().toISOString() }));
    // optimistic local state so direction auto-detect keeps working
    const evs = (await kvGet('events')) || [];
    const ev = evs.find((e) => e.id === payload.event_id);
    for (const en of payload.entries) {
      await markOpen(en.person_id, payload.direction === 'in'
        ? { in_txn_id: null, event_id: payload.event_id, event_title: ev ? ev.title : 'Queued event' }
        : null);
    }
  }
  const queueSize = async () => (await getAll('queue')).length;
  const conflictCount = async () => (await getAll('conflicts')).length;
  const conflictList = () => getAll('conflicts');

  let flushing = false;
  // post(payload) must resolve {ok} | reject Error with .status for rejections
  async function flush(post) {
    if (flushing) return { sent: 0, conflicts: 0, remaining: await queueSize() };
    flushing = true;
    let sent = 0, conflicts = 0;
    try {
      const items = (await getAll('queue'))
        .sort((a, b) => a._queued_at.localeCompare(b._queued_at));
      for (const item of items) {
        const { _queued_at, ...payload } = item;
        try {
          await post(payload);
          await tx('queue', 'readwrite', (s) => s.delete(payload.client_uuid));
          sent++;
        } catch (e) {
          if (e && e.status) {
            // server rejected it (409 race, 422 authorization, 400): conflict —
            // pull it out of the retry loop and flag for a human
            await tx('conflicts', 'readwrite', (s) => s.put({ ...item, _error: e.message, _detail: e.body || null }));
            await tx('queue', 'readwrite', (s) => s.delete(payload.client_uuid));
            // roll back the optimistic open-state change
            for (const en of payload.entries) await markOpen(en.person_id, payload.direction === 'in' ? null : undefined);
            conflicts++;
          } else {
            break; // still offline — retry later, keep order
          }
        }
      }
    } finally { flushing = false; }
    return { sent, conflicts, remaining: await queueSize() };
  }
  const clearConflict = (uuid) => tx('conflicts', 'readwrite', (s) => s.delete(uuid));

  window.Offline = {
    saveSnapshot, searchPeople, findByBadge, guardiansOf, currentEvents,
    markOpen, onsite, getPerson, queueTxn, queueSize, flush,
    conflictCount, conflictList, clearConflict,
    takenAt: () => kvGet('taken_at'),
  };
})();
