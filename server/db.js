'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'troop.db');
const SIG_DIR = path.join(DATA_DIR, 'signatures');
const UPLOAD_DIR = path.join(DATA_DIR, 'roster-uploads');

for (const d of [DATA_DIR, SIG_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

module.exports = { db, DATA_DIR, DB_PATH, SIG_DIR, UPLOAD_DIR };
