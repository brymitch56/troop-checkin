'use strict';
// Level groups + program order (parsing and matching: public/level-groups.js,
// shared with the kiosk and admin pages). meta key 'level_groups' holds
// {text}; nothing stored = no groups and alphabetical order, which is how
// every install behaved before this existed.
const { db } = require('../db');
const LG = require('../../public/level-groups');

const KEY = 'level_groups';

function readText() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY);
  if (!row) return '';
  try { return String(JSON.parse(row.value).text || ''); } catch { return ''; }
}

// { text, order, groups } — what the pages need to build filters and sorts
function get() {
  const text = readText();
  const { order, groups } = LG.parse(text);
  return { text, order, groups };
}

// Refuses (returns { errors }) rather than saving a half-understood list.
function save(text) {
  const t = String(text == null ? '' : text).slice(0, 4000);
  const parsed = LG.parse(t);
  if (parsed.errors.length) return { errors: parsed.errors };
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(KEY, JSON.stringify({ text: t }));
  return get();
}

const matcher = () => LG.create(get());

// SQL parameter for `(? IS NULL OR p.level IN (SELECT value FROM json_each(?)))`
// (bind it twice): null = no level filter, otherwise the JSON array of roster
// levels the selection — a group name or one level — stands for.
function sqlParam(sel) {
  const levels = matcher().expand(sel ? String(sel) : null);
  return levels ? JSON.stringify(levels) : null;
}
const LEVEL_SQL = 'p.level IN (SELECT value FROM json_each(?))';

module.exports = { get, save, matcher, sqlParam, LEVEL_SQL };
