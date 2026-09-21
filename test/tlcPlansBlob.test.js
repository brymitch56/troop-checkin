'use strict';
// readBlob pulls `$.name = <json>;` out of a portal HTML fragment. The portal
// lays these out differently per fragment, and a reader tied to one layout
// silently returns nothing for the other: the plan guard then believes no one
// on the roster is eligible for advancement and never warns or holds.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readBlob, parseUsers } = require('../server/lib/tlcPlans');

const USERS = { ufakeuser0001: { id: 'ufakeuser0001', level_id: 'lvlfox000001', patrol_id: null },
  ufakeuser0002: { id: 'ufakeuser0002', level_id: 'lvladv000001', patrol_id: 'patfake00001' } };

test('user-list layout: on the same line as <script>, CRLF line endings', () => {
  const html = `<div>roster…</div>\r\n<script>$.users = ${JSON.stringify(USERS)};\r\n</script>\r\n`;
  assert.deepEqual(readBlob(html, 'users'), USERS);
  const users = parseUsers(html);
  assert.equal(users.size, 2);
  assert.deepEqual(users.get('ufakeuser0002'), { level_id: 'lvladv000001', patrol_id: 'patfake00001' });
});

test('lesson-plan layout: each blob on its own indented line', () => {
  const html = `<script>\n    $.lessons = [{"id":"l1","title":"Knots"}];\n    $.levels = {"wt":"Woodlands Trail"};\n</script>`;
  assert.deepEqual(readBlob(html, 'lessons'), [{ id: 'l1', title: 'Knots' }]);
  assert.deepEqual(readBlob(html, 'levels'), { wt: 'Woodlands Trail' });
});

test('several assignments on one line, and no trailing semicolon', () => {
  const html = `<script>$.a = {"x":1}; $.users = ${JSON.stringify(USERS)}; $.b = [1,2]</script>`;
  assert.deepEqual(readBlob(html, 'users'), USERS);
  assert.deepEqual(readBlob(html, 'b'), [1, 2]);
});

test('brackets, braces, quotes and semicolons INSIDE strings do not end the value early', () => {
  const tricky = { t: 'a "quoted" } ] ; { [ value', u: 'back\\slash"', n: { deep: ['}', ']'] } };
  const html = `<script>$.lessons = ${JSON.stringify(tricky)};</script>`;
  assert.deepEqual(readBlob(html, 'lessons'), tricky);
});

test('a name is matched whole: $.users is not $.usersById', () => {
  const html = `<script>$.usersById = {"wrong":1};\n$.users = {"right":{"id":"right"}};</script>`;
  assert.deepEqual(readBlob(html, 'users'), { right: { id: 'right' } });
});

test('not plain JSON, missing, or truncated -> null, never a throw', () => {
  assert.equal(readBlob('<script>$.flatBadges = Object.assign({}, $.badges);</script>', 'flatBadges'), null);
  assert.equal(readBlob('<script>$.levels = {"wt":"x"};</script>', 'users'), null);
  assert.equal(readBlob('<script>$.users = {"a":{"id":"a"', 'users'), null);
  assert.equal(readBlob('', 'users'), null);
  assert.equal(readBlob(null, 'users'), null);
  assert.equal(parseUsers('<p>no script at all</p>').size, 0);
});

test('skips a non-JSON assignment of the same name and finds the real one after it', () => {
  const html = `<script>$.users = window.cached || {};\n$.users = {"u1":{"id":"u1","level_id":"l","patrol_id":null}};</script>`;
  assert.deepEqual(Object.keys(readBlob(html, 'users')), ['u1']);
});
