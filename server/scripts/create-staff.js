'use strict';
// Usage: node server/scripts/create-staff.js "Full Name" door|admin <PIN or password>
const { db } = require('../db');
const { hashSecret } = require('../auth');

const [, , name, role, secret] = process.argv;
if (!name || !['door', 'admin'].includes(role) || !secret) {
  console.error('Usage: node server/scripts/create-staff.js "Full Name" door|admin <PIN-or-password>');
  process.exit(1);
}
if (role === 'door' && !/^\d{4,8}$/.test(secret)) {
  console.error('Door PINs must be 4-8 digits.');
  process.exit(1);
}
const col = role === 'door' ? 'pin_hash' : 'password_hash';
const hash = hashSecret(secret);
const existing = db.prepare('SELECT id FROM staff WHERE name = ?').get(name);
if (existing) {
  db.prepare(`UPDATE staff SET role = ?, ${col} = ?, active = 1 WHERE id = ?`).run(role, hash, existing.id);
  console.log(`updated staff #${existing.id}: ${name} (${role})`);
} else {
  const r = db.prepare(`INSERT INTO staff (name, role, ${col}) VALUES (?, ?, ?)`).run(name, role, hash);
  console.log(`created staff #${r.lastInsertRowid}: ${name} (${role})`);
}
