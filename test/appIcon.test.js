'use strict';
// The themed app mark (/icon.svg). Two instances on one server otherwise show
// an identical browser-tab icon; the mark takes the palette's own colors so
// they are told apart at a glance. The traillife render must stay the mark
// the PNG has always been.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-icon-'));

const auth = require('../server/auth');
const { db } = require('../server/db');
const theme = require('../server/lib/theme');

let server, base;
const saved = {};
const setEnv = (k, v) => { if (!(k in saved)) saved[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; };

before(async () => {
  require('../server/migrate');
  db.prepare(`INSERT INTO staff (name, role, password_hash) VALUES ('Admin I', 'admin', ?)`).run(auth.hashSecret('adminpass'));
  const app = require('../server/index');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  server && server.close();
});

test('default (traillife) draws the historic mark: pine ground, paper strokes', () => {
  setEnv('THEME', null);
  const svg = theme.iconSvg();
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"/);
  assert.match(svg, /fill="#17402C"/);            // --pine, the PNG's ground
  assert.equal((svg.match(/#F4F3EC/g) || []).length, 2); // --paper: box + check
  assert.match(svg, /<\/svg>\n$/);
  // no external references — it has to render as a favicon and offline
  assert.doesNotMatch(svg, /<image|xlink:href|url\(|<script/i);
});

test('THEME=ahg recolors the same geometry (blue ground, no pine left)', () => {
  setEnv('THEME', 'ahg');
  const ahg = theme.iconSvg();
  assert.match(ahg, /fill="#0061AB"/);   // AHG brand blue, PMS 2945
  assert.doesNotMatch(ahg, /#17402C/);

  setEnv('THEME', null);
  const traillife = theme.iconSvg();

  // Same drawing, different paint: with the colors blanked out the two are
  // byte-identical, so a preset can never quietly reshape the mark.
  const geometry = (s) => s.replace(/#[0-9A-F]{6}/g, '#');
  assert.equal(geometry(ahg), geometry(traillife));
  assert.notEqual(ahg, traillife);
});

test('a THEME_PINE override reaches the icon, so a customized install stays consistent', () => {
  setEnv('THEME', 'ahg');
  setEnv('THEME_PINE', '#123456');
  assert.match(theme.iconSvg(), /fill="#123456"/);
  setEnv('THEME_PINE', null);
});

test('GET /icon.svg serves the themed mark as image/svg+xml', async () => {
  setEnv('THEME', null);
  const r = await fetch(base + '/icon.svg');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
  // must not be cached hard: the palette can change without the file changing
  assert.match(r.headers.get('cache-control') || '', /no-cache/);
  const body = await r.text();
  assert.equal(body, theme.iconSvg());
});

test('the manifest offers the themed mark alongside the PNG fallbacks', async () => {
  const m = await (await fetch(base + '/manifest.webmanifest')).json();
  const svg = m.icons.find((i) => i.src === '/icon.svg');
  assert.ok(svg, '/icon.svg is listed');
  assert.equal(svg.type, 'image/svg+xml');
  assert.equal(svg.sizes, 'any');
  // the PNGs stay for iOS home screens and anything that cannot take an SVG
  assert.ok(m.icons.some((i) => i.src === '/icon-512.png'));
});

test('every page that has a favicon link offers the themed one first', () => {
  for (const f of ['index.html', 'admin.html', 'guide.html', 'setup.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" sizes="any" href="\/icon\.svg">/,
      `${f} links the themed icon`);
    // sizes="any" is what makes a browser prefer it over the 192px PNG link
    assert.ok(html.indexOf('/icon.svg') < html.indexOf('/favicon.ico'), `${f} lists it before the .ico fallback`);
  }
});

test('the shell precaches it, so the tab icon survives offline and version bumps', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(sw, /'\/icon\.svg'/);
});
