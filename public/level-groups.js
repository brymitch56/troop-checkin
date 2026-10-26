'use strict';
// Combined program levels ("level groups") and program order.
//
// Units that meet together get one name that every level filter offers next
// to the individual levels — Trail Life's Woodlands (Fox + Hawk + Mountain
// Lion), AHG's Pioneers + Patriots — and every level sort follows program
// order instead of the alphabet. Both come from ONE admin-edited text, one
// line per level or group, in program order:
//
//   Tenderheart
//   Explorer
//   PiPa = Pioneer, Patriot
//   Pathfinder
//
// Level names must match the roster exactly. Levels the text doesn't mention
// still work; they sort after the listed ones, alphabetically. An empty text
// means no groups and alphabetical order — exactly the pre-groups behavior.
//
// UMD-ish: browser gets window.LevelGroups; the server and node:test require() it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LevelGroups = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const key = (s) => norm(s).toLowerCase();

  // text -> { order, groups, errors }. order lists every named level in
  // program order (group members in place); errors are human sentences.
  function parse(text) {
    const order = [], groups = [], errors = [];
    const seen = new Map(); // key -> 'level' | 'group'
    const claim = (name, kind, lineNo) => {
      const k = key(name);
      if (seen.has(k)) {
        errors.push(`Line ${lineNo}: "${name}" appears more than once — each level and group name can be used only once.`);
        return false;
      }
      seen.set(k, kind);
      return true;
    };
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const line = norm(raw);
      const n = i + 1;
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq < 0) {
        if (claim(line, 'level', n)) order.push(line);
        return;
      }
      const name = norm(line.slice(0, eq));
      const levels = line.slice(eq + 1).split(',').map(norm).filter(Boolean);
      if (!name) { errors.push(`Line ${n}: the group needs a name before "=".`); return; }
      if (levels.length < 2) { errors.push(`Line ${n}: "${name}" needs at least two levels after "=", separated by commas.`); return; }
      if (!claim(name, 'group', n)) return;
      const members = levels.filter((l) => claim(l, 'level', n));
      if (members.length < 2) return;
      groups.push({ name, levels: members });
      order.push(...members);
    });
    return { order, groups, errors };
  }

  // { order, groups } -> the editable text (order is authoritative for
  // placement: a group's line sits where its first member is).
  function format(cfg) {
    const c = cfg || {};
    const groupOf = new Map();
    for (const g of c.groups || []) for (const l of g.levels) groupOf.set(key(l), g);
    const lines = [], done = new Set();
    for (const l of c.order || []) {
      const g = groupOf.get(key(l));
      if (!g) { lines.push(l); continue; }
      if (done.has(g)) continue;
      done.add(g);
      lines.push(`${g.name} = ${g.levels.join(', ')}`);
    }
    return lines.join('\n');
  }

  // A matcher over one config. sel is whatever a level filter holds: '' /
  // null (no filter), a group name, or a single level.
  function create(cfg) {
    const c = cfg || {};
    const groups = c.groups || [];
    const byName = new Map(groups.map((g) => [key(g.name), g]));
    const rankOf = new Map((c.order || []).map((l, i) => [key(l), i]));
    const groupOfLevel = new Map();
    for (const g of groups) for (const l of g.levels) groupOfLevel.set(key(l), g);

    // the roster levels a selection stands for; null = no filter
    const expand = (sel) => {
      if (!sel) return null;
      const g = byName.get(key(sel));
      return g ? g.levels.slice() : [String(sel)];
    };
    const matches = (level, sel) => {
      if (!sel) return true;
      const g = byName.get(key(sel));
      return g ? g.levels.some((l) => key(l) === key(level)) : (level || '') === sel;
    };
    // Program-order comparator: listed levels first in their order, then the
    // rest alphabetically; blank (adults, visitors) always last.
    const compare = (a, b) => {
      if (!a !== !b) return a ? -1 : 1;
      const ra = rankOf.has(key(a)) ? rankOf.get(key(a)) : Infinity;
      const rb = rankOf.has(key(b)) ? rankOf.get(key(b)) : Infinity;
      if (ra !== rb) return ra - rb;
      return String(a || '').localeCompare(String(b || ''));
    };
    // Filter dropdown entries for the levels on the roster: each group just
    // before its first member, the individual levels after, in program order.
    // A group shows only when at least one of its levels is on the roster.
    const options = (levels) => {
      const sorted = [...new Set((levels || []).filter(Boolean))].sort(compare);
      const out = [], shown = new Set();
      for (const l of sorted) {
        const g = groupOfLevel.get(key(l));
        if (g && !shown.has(g)) {
          shown.add(g);
          out.push({ value: g.name, label: `${g.name} (${g.levels.join(' + ')})`, group: true });
        }
        out.push({ value: l, label: g ? `  ${l}` : l, group: false });
      }
      return out;
    };
    return { groups, expand, matches, compare, options, isGroup: (sel) => byName.has(key(sel)) };
  }

  return { parse, format, create };
});
