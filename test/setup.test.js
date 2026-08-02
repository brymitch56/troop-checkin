'use strict';
// First-run /setup wizard: gate behavior while unconfigured, the one-POST
// configuration flow, and the permanent-disable latch afterwards. Runs with
// an isolated DATA_DIR and an isolated ENV_FILE so a real .env in the repo
// (dev machines, the Pi) can never leak into the test.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-setup-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.ENV_FILE = path.join(TMP, 'config', '.env'); // does not exist => unconfigured

let server, base;

async function req(method, url, { body, cookie, redirect } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: redirect || 'manual',
  });
  let json = null;
  try { json = await res.clone().json(); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers, text: await res.text() };
}

before(async () => {
  const app = require('../server/index'); // NOTE: no migrate, no staff — a truly fresh install
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

test('unconfigured: pages redirect to /setup, APIs answer 503, healthz stays up', async () => {
  const home = await req('GET', '/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/setup');

  const admin = await req('GET', '/admin.html');
  assert.equal(admin.status, 302);

  const api = await req('GET', '/api/events');
  assert.equal(api.status, 503);

  const hz = await req('GET', '/healthz');
  assert.equal(hz.status, 200);

  const page = await req('GET', '/setup');
  assert.equal(page.status, 200);
  assert.match(page.text, /first-time setup/);
});

test('setup state exposes presets; traillife palette matches styles.css exactly', async () => {
  const r = await req('GET', '/api/setup/state');
  assert.equal(r.status, 200);
  assert.ok(r.json.presets.traillife && r.json.presets.ahg && r.json.presets.generic);

  // pixel-identical guard: the default preset must equal the :root block
  // shipped in styles.css, var for var
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const root = /:root\s*{([^}]*)}/.exec(css)[1];
  for (const [v, hex] of Object.entries(r.json.presets.traillife)) {
    const m = new RegExp(`--${v}:\\s*(#[0-9a-fA-F]{6})`).exec(root);
    assert.ok(m, `--${v} present in styles.css`);
    assert.equal(hex.toUpperCase(), m[1].toUpperCase(), `--${v} matches styles.css`);
  }
});

test('validation: bad payloads are rejected with 422', async () => {
  const cases = [
    {}, // everything missing
    { troop_id: 'X', troop_name: 'T', program: 'nope', timezone: 'America/New_York', admin_name: 'A', admin_password: 'longenough' },
    { troop_id: 'X', troop_name: 'T', program: 'traillife', timezone: 'Not/AZone', admin_name: 'A', admin_password: 'longenough' },
    { troop_id: 'X', troop_name: 'T', program: 'traillife', timezone: 'America/New_York', admin_name: 'A', admin_password: 'short' },
    { troop_id: 'X', troop_name: 'T', program: 'traillife', timezone: 'America/New_York', admin_name: 'A', admin_password: 'longenough', colors: { pine: 'green' } },
  ];
  for (const body of cases) {
    const r = await req('POST', '/api/setup', { body });
    assert.equal(r.status, 422, JSON.stringify(body));
  }
  // still unconfigured after every rejected attempt
  assert.equal((await req('GET', '/')).status, 302);
});

test('a valid POST configures the instance end to end', async () => {
  const r = await req('POST', '/api/setup', {
    body: {
      troop_id: 'ZZ-1234', troop_name: 'Test Troop', program: 'ahg',
      timezone: 'America/Chicago',
      colors: { pine: '#102030' }, // custom primary
      admin_name: 'First Admin', admin_password: 'a-good-password',
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  // .env written at ENV_FILE with the choices (custom color as THEME_* override)
  const env = fs.readFileSync(process.env.ENV_FILE, 'utf8');
  assert.match(env, /^TROOP_ID=ZZ-1234$/m);
  assert.match(env, /^TROOP_NAME=Test Troop$/m);
  assert.match(env, /^TZ=America\/Chicago$/m);
  assert.match(env, /^THEME=ahg$/m);
  assert.match(env, /^THEME_PINE=#102030$/m);
  assert.match(env, /^ROSTER_SOURCE_NAME=AHGfamily$/m);

  // live process picked it up: config, theme.css, manifest colors
  const cfg = await req('GET', '/api/config');
  assert.equal(cfg.json.troop_id, 'ZZ-1234');
  assert.equal(cfg.json.theme, 'ahg');
  const css = await req('GET', '/theme.css');
  assert.match(css.text, /--pine: #102030;/);
  const man = await req('GET', '/manifest.webmanifest');
  assert.equal(man.json.theme_color, '#102030');
  assert.match(man.json.name, /ZZ-1234/);

  // the admin account works through the normal login
  const staffList = await req('GET', '/api/staff-list');
  const admin = (staffList.json || []).find((s) => s.name === 'First Admin');
  assert.ok(admin, 'wizard-created admin appears in the login picker');
  const login = await req('POST', '/api/login', { body: { staff_id: admin.id, pin: 'a-good-password' } });
  assert.equal(login.status, 200);
  assert.equal(login.json.role, 'admin');
});

test('configured: /setup is permanently disabled, app serves normally', async () => {
  const home = await req('GET', '/');
  assert.equal(home.status, 200); // index served, no redirect

  const page = await req('GET', '/setup');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/');

  const post = await req('POST', '/api/setup', {
    body: { troop_id: 'HACK', troop_name: 'x', program: 'generic', timezone: 'UTC', admin_name: 'x', admin_password: 'xxxxxxxx' },
  });
  assert.equal(post.status, 403);

  const state = await req('GET', '/api/setup/state');
  assert.equal(state.status, 403);
});
