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
  assert.equal(await page.title(), 'NY-2911 Check-In');
  step('page loads');

  // -- login ----------------------------------------------------------------
  await page.waitForSelector('#staff-list button');
  await click('#staff-list button');
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

  // -- search adds a third youth --------------------------------------------
  await page.type('#search-input', 'Frank', { delay: 60 });
  await searchHit(page, 'Frank');
  await page.waitForFunction(() => document.querySelectorAll('#cart-list li').length === 3);
  step('name search adds Frank');

  // -- sign modal: signer union, signature pad, staff override ---------------
  await click('#btn-sign');
  await page.waitForSelector('#modal-sign:not([hidden])');
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

  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);

  await browser.close();
  server.close();
  console.log('\nE2E: all steps passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
