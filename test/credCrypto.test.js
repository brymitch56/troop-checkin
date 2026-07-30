'use strict';
// At-rest credential encryption: round-trip, tamper/wrong-key rejection,
// key auto-generation into .env, and validation. Uses only fake values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// never let a test touch a real .env: pin a key for the default path
process.env.CRED_KEY = crypto.randomBytes(32).toString('hex');

const cc = require('../server/lib/credCrypto');

test('encrypt/decrypt round-trips and never stores plaintext', () => {
  const box = cc.encrypt('fake-tlc-password-123!');
  assert.equal(box.v, 1);
  assert.ok(box.iv && box.tag && box.data);
  assert.ok(!JSON.stringify(box).includes('fake-tlc-password'));
  assert.equal(cc.decrypt(box), 'fake-tlc-password-123!');
});

test('unique IVs: same plaintext encrypts differently each time', () => {
  const a = cc.encrypt('same-secret');
  const b = cc.encrypt('same-secret');
  assert.notEqual(a.data, b.data);
  assert.notEqual(a.iv, b.iv);
});

test('wrong key or tampered ciphertext decrypts to null, never throws', () => {
  const box = cc.encrypt('secret');
  const wrongKey = crypto.randomBytes(32);
  assert.equal(cc.decrypt(box, wrongKey), null);
  const tampered = { ...box, data: Buffer.from('tampered!').toString('base64') };
  assert.equal(cc.decrypt(tampered), null); // GCM auth catches it
  assert.equal(cc.decrypt(null), null);
  assert.equal(cc.decrypt({ v: 99 }), null);
});

test('loadKey: rejects malformed keys', () => {
  const orig = process.env.CRED_KEY;
  try {
    process.env.CRED_KEY = 'not-hex';
    assert.equal(cc.loadKey(), null);
    process.env.CRED_KEY = 'abcd'; // too short
    assert.equal(cc.loadKey(), null);
    process.env.CRED_KEY = orig;
    assert.ok(Buffer.isBuffer(cc.loadKey()));
  } finally { process.env.CRED_KEY = orig; }
});

test('ensureKey: generates once, appends to .env with 64-hex value, reuses after', () => {
  const orig = process.env.CRED_KEY;
  const tmpEnv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-key-')), '.env');
  fs.writeFileSync(tmpEnv, 'TROOP_ID=NY-0000\n');
  try {
    delete process.env.CRED_KEY;
    const key = cc.ensureKey(tmpEnv);
    assert.equal(key.length, 32);
    const content = fs.readFileSync(tmpEnv, 'utf8');
    assert.match(content, /CRED_KEY=[0-9a-f]{64}\n/);
    assert.match(content, /^TROOP_ID=NY-0000/); // append, never rewrite
    assert.equal(process.env.CRED_KEY, key.toString('hex'));
    // second call returns the same key without touching the file
    const before = fs.statSync(tmpEnv).mtimeMs;
    assert.equal(cc.ensureKey(tmpEnv).toString('hex'), key.toString('hex'));
    assert.equal(fs.statSync(tmpEnv).mtimeMs, before);
  } finally { process.env.CRED_KEY = orig; }
});

test('ensureKey: refuses a malformed existing CRED_KEY instead of overwriting it', () => {
  const orig = process.env.CRED_KEY;
  try {
    process.env.CRED_KEY = 'garbage';
    assert.throws(() => cc.ensureKey('/nonexistent/.env'), /malformed/);
  } finally { process.env.CRED_KEY = orig; }
});
