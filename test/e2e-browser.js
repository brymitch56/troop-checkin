'use strict';
// Browser E2E for the kiosk PWA (login → scan/search → cart → sign → onsite).
// Not part of `npm test` (puppeteer is not a dependency). Run with:
//   npm install --no-save puppeteer && node test/e2e-browser.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-e2e-'));

const { buildWorkbookBuffer } = require('../server/scripts/make-synthetic-roster');
const roster = require('../server/lib/rosterImport');
const auth = require('../server/auth');
const { db } = require('../server/db');

async function main() {
  const puppeteer = require('puppeteer');

  // seed: staff, roster, an event happening now
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, pin_hash) VALUES ('Door Tester', 'door', ?)`)
    .run(auth.hashSecret('1234'));
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin Tester', 'admin', ?)`)
    .run(auth.hashSecret('adminpass'));
  const people = roster.parseWorkbook(buildWorkbookBuffer());
  roster.applyImport(people, roster.suggestLinks(people), null, 'e2e.xlsx', null);
  db.prepare(`UPDATE person SET badge_code = 'Y-2001 | tokE2E' WHERE member_id = 'Y-2001'`).run();
  db.prepare(`INSERT INTO event (source, title, start_at, end_at)
              VALUES ('manual', 'E2E Meeting', datetime('now', '-1 hour'), datetime('now', '+2 hours'))`).run();

  const app = require('../server/index');
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1400 });
  page.on('dialog', (d) => d.accept()); // staff-override confirm
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  const step = (msg) => console.log('  ✓', msg);
  // DOM click: kiosk buttons can sit outside the emulated viewport
  const click = (sel) => page.$eval(sel, (el) => el.click());
  // wait for a *fresh* visible search result containing `name`, then click it
  // (the results box keeps stale children while hidden — don't click those)
  const searchHit = async (pg, name) => {
    await pg.waitForFunction((n) => {
      const box = document.getElementById('search-results');
      return !box.hidden && [...box.querySelectorAll('button')].some((b) => b.textContent.includes(n));
    }, {}, name);
    await pg.evaluate((n) => {
      [...document.querySelectorAll('#search-results button')].find((b) => b.textContent.includes(n)).click();
    }, name);
  };

  await page.goto(base, { waitUntil: 'networkidle0' });
  // branding is applied from /api/config after load (env-driven, no hardcoding)
  await page.waitForFunction(() => document.title.endsWith('Check-In') &&
    document.querySelector('[data-brand-id]').textContent !== 'TROOP');
  step('page loads with env branding');

  // -- login ----------------------------------------------------------------
  await page.waitForSelector('#staff-list button');
  // Regression guard (modal-scrim bug): the element a real tap lands on at the
  // staff tile's center must be the tile itself — no overlay intercepting.
  const hitTest = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#staff-list button')]
      .find((b) => b.textContent === 'Door Tester');
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { intercepted: hit !== btn, hitDesc: hit ? hit.id || hit.className || hit.tagName : 'none' };
  });
  assert.equal(hitTest.intercepted, false, `an overlay intercepts taps on the login tiles: ${hitTest.hitDesc}`);
  // real mouse click (NOT DOM .click()) so pointer interception would fail loudly
  const tile = await page.evaluateHandle(() =>
    [...document.querySelectorAll('#staff-list button')].find((b) => b.textContent === 'Door Tester'));
  const tileBox = await tile.asElement().boundingBox();
  await page.mouse.click(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
  await page.type('#pin-input', '1234', { delay: 60 }); // human speed — faster would look like a scanner burst
  await click('#pin-go');
  await page.waitForSelector('#screen-main:not([hidden])');
  step('PIN login');

  // single current event auto-selects
  await page.waitForFunction(() => document.getElementById('event-pill').textContent === 'E2E Meeting');
  step('event auto-selected');

  // -- badge scan via keyboard wedge (fast burst + Enter) --------------------
  await page.keyboard.type('Y-2001 | tokE2E', { delay: 5 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#cart-list .cart-name')].some((n) => n.textContent.includes('Dan')));
  step('wedge scan adds Danny to cart');

  // wedge burst into a focused input must not pollute it
  await page.focus('#search-input');
  await page.keyboard.type('Y-2001 | tokE2E', { delay: 5 });
  await page.keyboard.press('Enter'); // duplicate scan -> toast, cart unchanged
  const leaked = await page.$eval('#search-input', (el) => el.value);
  assert.equal(leaked, '', `scanner chars leaked into search input: "${leaked}"`);
  step('wedge burst scrubbed from focused input');

  // -- unlinked reprinted badge offers to link ------------------------------
  await page.evaluate(() => window.handleScanTest ? null : null); // no-op; scan Emma via wedge
  await click('body'); // blur input
  await page.keyboard.type('Y-2002 | tokNEW', { delay: 5 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('#modal-link:not([hidden])');
  await click('#link-confirm');
  await page.waitForFunction(() => document.querySelectorAll('#cart-list li').length === 2);
  step('reprinted badge links and adds Emma');

  // Emma's synthetic membership expires ~20 days out -> orange warning tag on
  // her cart row (non-blocking); Danny's is far-future -> no tag on his
  const expTags = await page.$$eval('#cart-list .exp-tag', (els) => els.map((e) => e.textContent));
  assert.equal(expTags.length, 1, 'exactly one membership-expiry tag expected');
  assert.match(expTags[0], /Membership expiring/);
  step('membership-expiry warning tag on cart row (non-blocking)');

  // -- search adds a third youth --------------------------------------------
  await page.type('#search-input', 'Frank', { delay: 60 });
  await searchHit(page, 'Frank');
  await page.waitForFunction(() => document.querySelectorAll('#cart-list li').length === 3);
  step('name search adds Frank');

  // -- sign modal: signer union, signature pad, staff override ---------------
  await click('#btn-sign');
  await page.waitForSelector('#modal-sign:not([hidden])');
  // Emma's expiry note appears in the sign modal (informational, never blocks)
  const expLine = await page.$eval('#sign-membership', (el) => ({ hidden: el.hidden, text: el.textContent }));
  assert.equal(expLine.hidden, false);
  assert.match(expLine.text, /Emma.*Membership expires .* renewal due/);
  step('membership-expiry note in sign modal');
  // pick Alice (authorized only for Danny -> partial warning, then 422 -> confirm override)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#signer-list button')]
      .find((b) => b.textContent.includes('Alice'));
    btn.click();
  });
  const box = await (await page.$('#sig-canvas')).boundingBox();
  await page.mouse.move(box.x + 20, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height - 30, { steps: 8 });
  await page.mouse.up();
  await click('#sign-submit');
  await page.waitForFunction(() => document.getElementById('onsite-pill').textContent === 'On site: 3');
  step('sign-in with signature + override → 3 on site');

  // -- onsite screen ---------------------------------------------------------
  await click('#onsite-pill');
  await page.waitForSelector('#screen-onsite:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('#onsite-list .person').length === 3);
  // patrol filter
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#patrol-filters button')].find((x) => x.textContent === 'Hawks');
    b.click();
  });
  await page.waitForFunction(() => document.querySelectorAll('#onsite-list .person').length === 1);
  step('onsite list + patrol filter');
  await click('#onsite-back');

  // -- sign out --------------------------------------------------------------
  await page.type('#search-input', 'Danny', { delay: 60 });
  await searchHit(page, 'Dan');
  await page.waitForFunction(() => document.querySelectorAll('#cart-list li').length === 1);
  await click('#btn-sign');
  await page.waitForSelector('#modal-sign:not([hidden])');
  await page.evaluate(() => {
    [...document.querySelectorAll('#signer-list button')].find((b) => b.textContent.includes('Alice')).click();
  });
  const box2 = await (await page.$('#sig-canvas')).boundingBox();
  await page.mouse.move(box2.x + 30, box2.y + 40);
  await page.mouse.down();
  await page.mouse.move(box2.x + 200, box2.y + 90, { steps: 6 });
  await page.mouse.up();
  await click('#sign-submit');
  await page.waitForFunction(() => document.getElementById('onsite-pill').textContent === 'On site: 2');
  step('sign-out closes open stay → 2 on site');

  // -- station mode: scope roster view to one patrol -------------------------
  await click('#station-pill');
  await page.waitForFunction(() => document.getElementById('station-pill').textContent.startsWith('Station:'));
  const station = await page.$eval('#station-pill', (el) => el.textContent);
  await page.type('#search-input', 'mil', { delay: 60 }); // Frank Miller — Eagles
  await new Promise((r) => setTimeout(r, 500));
  const visible = await page.evaluate(() => {
    const box = document.getElementById('search-results');
    return box.hidden ? [] : [...box.querySelectorAll('button')].map((b) => b.textContent.trim());
  });
  if (station.includes('Eagles')) assert.ok(visible.some((v) => v.includes('Frank')));
  else assert.equal(visible.length, 0, `station ${station} should hide Frank (Eagles): ${visible}`);
  await page.$eval('#search-input', (el) => (el.value = ''));
  // reset to all patrols for a clean state
  await page.evaluate(() => localStorage.removeItem('station-patrol'));
  step(`station mode scopes search (${station.trim()})`);

  // -- admin UI smoke --------------------------------------------------------
  const admin = await browser.newPage();
  await admin.setViewport({ width: 1200, height: 1400 });
  admin.on('pageerror', (e) => errors.push('admin: ' + e));
  await admin.goto(base + '/admin.html', { waitUntil: 'networkidle0' });
  await admin.waitForSelector('#login-staff option');
  await admin.type('#login-pass', 'adminpass', { delay: 20 });
  await admin.$eval('#login-form button', (el) => el.click());
  await admin.waitForSelector('#screen-app:not([hidden])');
  await admin.waitForFunction(() => document.querySelectorAll('#dash-cards .card').length >= 6);
  step('admin login + dashboard');

  await admin.$eval('[data-tab="people"]', (el) => el.click());
  await admin.waitForFunction(() => document.querySelectorAll('#pp-list tr[data-id]').length >= 6);
  await admin.$eval('#pp-list tr[data-id]', (el) => el.click());
  await admin.waitForSelector('#person-modal:not([hidden])');
  await admin.waitForFunction(() => document.querySelectorAll('#pp-detail [data-f]').length > 0);
  // layered dialog: open the family/consent modal on top, then close both
  const isYouthDetail = await admin.$('#pp-family');
  if (isYouthDetail) {
    await admin.$eval('#pp-family', (el) => el.click());
    await admin.waitForSelector('#adm-modal:not([hidden])');
    await admin.waitForFunction(() => document.querySelectorAll('#fam-ylist input').length > 0);
    await admin.$eval('#fam-close', (el) => el.click());
    await admin.waitForSelector('#adm-modal[hidden]');
  }
  await admin.$eval('#person-close', (el) => el.click());
  await admin.waitForSelector('#person-modal[hidden]');
  step('admin people list + person dialog + layered family dialog');

  // -- sortable / filterable tables (tabletools) ----------------------------
  // sort the People table by name descending, then multi-select filter the
  // type column down to youth only; both act on the rendered rows.
  await admin.click('#pp-list th.tt-th');
  await admin.waitForSelector('.tt-menu');
  await admin.click('.tt-menu [data-tt-sort="desc"]');
  const descFirst = await admin.$eval('#pp-list tr[data-id]:not(.tt-hidden) td', (td) => td.textContent.trim());
  await admin.evaluate(() => {
    const ths = [...document.querySelectorAll('#pp-list th.tt-th')];
    ths[1].click(); // Type column
  });
  await admin.waitForSelector('.tt-menu');
  await admin.evaluate(() => {
    const boxes = [...document.querySelectorAll('.tt-menu .tt-vals input')];
    boxes.forEach((b) => (b.checked = b.value === 'youth'));
    document.querySelector('.tt-menu [data-tt-apply]').click();
  });
  const onlyYouth = await admin.$$eval('#pp-list tr[data-id]:not(.tt-hidden) td:nth-child(2)',
    (tds) => tds.map((t) => t.textContent.trim()));
  assert.ok(onlyYouth.length && onlyYouth.every((t) => t === 'youth'),
    `type filter should leave only youth rows, got ${JSON.stringify(onlyYouth)}`);
  const chip = await admin.$eval('#pp-list .tt-chips', (e) => e.textContent);
  assert.match(chip, /youth/, 'active-filter chip should name the filtered value');
  await admin.click('#pp-list .tt-clear-all');
  const cleared = await admin.$$eval('#pp-list tr[data-id]:not(.tt-hidden)', (r) => r.length);
  assert.ok(cleared > onlyYouth.length, 'clearing filters restores hidden rows');
  assert.ok(descFirst.length, 'sorted table still renders rows');
  step('admin tables: header sort + multi-select filter + clear');

  await admin.$eval('[data-tab="txns"]', (el) => el.click());
  await admin.waitForFunction(() => document.querySelectorAll('#tx-list tr[data-id]').length >= 2);
  await admin.$eval('#tx-list tr[data-id]', (el) => el.click());
  await admin.waitForSelector('#tx-detail:not([hidden])');
  const hasSig = await admin.$('#tx-detail img.sig-view');
  assert.ok(hasSig, 'txn detail shows the signature image');
  step('admin txn browser + signature view');

  // -- offline round-trip (Phase 4) -----------------------------------------
  // wait for SW install + roster snapshot, then cut the network
  await page.bringToFront();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => window.Offline && !!(await window.Offline.takenAt()));
  await page.setOfflineMode(true);

  await page.reload({ waitUntil: 'load' }).catch(() => {});
  await page.waitForSelector('#screen-main:not([hidden])', { timeout: 8000 });
  step('offline: shell loads from SW, session restored from cache');

  // event picker may open (events/current served from snapshot); pick the meeting
  await page.evaluate(() => {
    const modal = document.getElementById('modal-events');
    if (modal && !modal.hidden) {
      [...document.querySelectorAll('#event-list button')].find((b) => b.textContent.includes('E2E Meeting'))?.click();
    }
  });
  await page.waitForFunction(() => document.getElementById('event-pill').textContent === 'E2E Meeting');

  // offline name search from the snapshot, then a queued sign-in
  // (Danny was signed out earlier, so this queues an IN)
  await page.type('#search-input', 'Danny', { delay: 60 });
  await searchHit(page, 'Dan');
  await page.waitForFunction(() => document.querySelectorAll('#cart-list li').length === 1);
  step('offline: snapshot search adds Danny');

  await click('#btn-sign');
  await page.waitForSelector('#modal-sign:not([hidden])');
  await page.evaluate(() => {
    [...document.querySelectorAll('#signer-list button')].find((b) => b.textContent.includes('Alice')).click();
  });
  const box3 = await (await page.$('#sig-canvas')).boundingBox();
  await page.mouse.move(box3.x + 30, box3.y + 40);
  await page.mouse.down();
  await page.mouse.move(box3.x + 250, box3.y + 100, { steps: 6 });
  await page.mouse.up();
  await click('#sign-submit');
  await page.waitForFunction(() => !document.getElementById('queue-pill').hidden &&
    document.getElementById('queue-pill').textContent.includes('1'));
  step('offline: sign-in queued in IndexedDB, queue pill shows');

  // back online: the queue flushes and the server records the txn
  await page.setOfflineMode(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.getElementById('queue-pill').hidden, { timeout: 25000 });
  const dannyOpen = db.prepare(
    `SELECT 1 FROM txn_person tp JOIN txn t ON t.id = tp.txn_id
      WHERE tp.person_id = (SELECT id FROM person WHERE member_id = 'Y-2001')
        AND tp.open = 1 AND t.voided_by_txn_id IS NULL`).get();
  assert.ok(dannyOpen, 'queued sign-in reached the server after reconnect');
  step('offline: queue synced on reconnect, server has the record');

  // -- admin document strategy (tc-v22) --------------------------------------
  // The admin document must be NETWORK-first (so an expired Cloudflare Access
  // session shows the login instead of a silently-empty cached page) while
  // the kiosk shell stays CACHE-first (offline check-in). Prove it by editing
  // the served files on disk: a reload must pick up the admin change but NOT
  // the kiosk change. Files are restored immediately after.
  const pubDir = path.join(__dirname, '..', 'public');
  const adminPath = path.join(pubDir, 'admin.html');
  const indexPath = path.join(pubDir, 'index.html');
  const adminOrig = fs.readFileSync(adminPath, 'utf8');
  const indexOrig = fs.readFileSync(indexPath, 'utf8');
  try {
    fs.writeFileSync(adminPath, adminOrig + '\n<!-- e2e-marker-admin -->');
    fs.writeFileSync(indexPath, indexOrig + '\n<!-- e2e-marker-kiosk -->');

    await admin.reload({ waitUntil: 'load' });
    await admin.waitForSelector('#screen-login, #screen-app', { timeout: 8000 });
    const adminHtml = await admin.content();
    assert.ok(adminHtml.includes('e2e-marker-admin'), 'admin document must be served network-first');
    step('admin document is network-first (Access re-login can happen)');

    await page.reload({ waitUntil: 'load' });
    const kioskHtml = await page.content();
    assert.ok(!kioskHtml.includes('e2e-marker-kiosk'), 'kiosk shell must stay cache-first');
    step('kiosk shell still cache-first');

    // offline: admin falls back to the cached copy instead of failing
    await admin.setOfflineMode(true);
    await admin.reload({ waitUntil: 'load' }).catch(() => {});
    await admin.waitForSelector('#screen-login, #screen-app', { timeout: 8000 });
    step('offline: admin falls back to the cached shell');
    await admin.setOfflineMode(false);
  } finally {
    fs.writeFileSync(adminPath, adminOrig);
    fs.writeFileSync(indexPath, indexOrig);
  }

  // -- plain LAN HTTP (insecure context) parity ------------------------------
  // Phones at a meeting hit http://<pi-ip>:3000 — an INSECURE context where
  // secure-context-only APIs (crypto.randomUUID, serviceWorker, camera) don't
  // exist. This section proves the core sign path never depends on them.
  const os = require('os');
  const lanIp = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && !i.internal && i.family === 'IPv4')?.address;
  if (lanIp) {
    const lan = await browser.newPage();
    await lan.setViewport({ width: 1024, height: 1400 });
    lan.on('pageerror', (e) => errors.push('lan: ' + e));
    lan.on('dialog', (d) => d.accept());
    await lan.goto(`http://${lanIp}:${server.address().port}`, { waitUntil: 'networkidle0' });
    const ctx = await lan.evaluate(() => ({ secure: window.isSecureContext, hasUUID: !!crypto.randomUUID }));
    assert.equal(ctx.secure, false, 'LAN IP must be an insecure context for this test to mean anything');
    assert.equal(ctx.hasUUID, false);
    await lan.waitForSelector('#staff-list button');
    await lan.evaluate(() => {
      [...document.querySelectorAll('#staff-list button')].find((b) => b.textContent === 'Door Tester').click();
    });
    await lan.type('#pin-input', '1234', { delay: 60 });
    await lan.$eval('#pin-go', (el) => el.click());
    await lan.waitForSelector('#screen-main:not([hidden])');
    await lan.type('#search-input', 'Frank', { delay: 60 });
    await lan.waitForFunction(() => {
      const box = document.getElementById('search-results');
      return !box.hidden && [...box.querySelectorAll('button')].some((b) => b.textContent.includes('Frank'));
    });
    await lan.evaluate(() => {
      [...document.querySelectorAll('#search-results button')].find((b) => b.textContent.includes('Frank')).click();
    });
    await lan.waitForFunction(() => document.querySelectorAll('#cart-list li').length === 1);
    await lan.$eval('#btn-sign', (el) => el.click());
    await lan.waitForSelector('#modal-sign:not([hidden])');
    await lan.evaluate(() => {
      [...document.querySelectorAll('#signer-list button')].find((b) => b.textContent.includes('Carol')).click();
    });
    const b4 = await (await lan.$('#sig-canvas')).boundingBox();
    await lan.mouse.move(b4.x + 30, b4.y + 40);
    await lan.mouse.down();
    await lan.mouse.move(b4.x + 200, b4.y + 90, { steps: 6 });
    await lan.mouse.up();
    await lan.$eval('#sign-submit', (el) => el.click());
    // save must complete: modal closes (this is what silently failed pre-fix)
    await lan.waitForFunction(() => document.getElementById('modal-root').hidden === true, { timeout: 8000 });
    step('plain LAN http (insecure context): signature save completes');
  } else {
    console.log('  - skipped LAN insecure-context test (no non-internal IPv4)');
  }

  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);

  await browser.close();
  server.close();
  console.log('\nE2E: all steps passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
