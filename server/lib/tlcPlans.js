'use strict';
// TLC activity plans — read side only (docs/12-attendance-writeback.md).
//
// Marking someone Attended is the moment TLC applies advancement, and it is
// one-way: the app never posts value=0 and never re-posts a member already
// showing attended=1, so a mis-scoped plan costs that youth the credit with
// no error anywhere. `toggle-attendance` takes no level parameter, so the app
// cannot steer the grant — all it can do is read the plan first and refuse to
// spend the one chance when the credit would not land.
//
// Endpoint (same Yii2 AJAX conventions as the rest of the write-back):
//   GET /calendar/attendance-lesson-plans?eventId=<hashid>
// The response is an HTML fragment whose <script> block carries the real
// data as `$.<name> = <json>;` assignments:
//   $.lessons             the plan rows: {id,title,level_id[],patrol_id[],
//                         badge_id[],items_id[],type}
//   $.levels / $.patrols  id -> display name ("Fox|fox_logo.svg" / "Hawk 1")
//   $.items               badgeId -> {itemId: title}
//   $.wtIds               the concrete level ids behind the "wt" umbrella
//   $.advancementsByUser  userHashid -> [itemId, …] already held
// The visible HTML ALSO contains a static "No activity plans have been added
// to event." empty-state that Alpine hides, so reading the stripped text
// instead of the script block gives the exact opposite answer.
//
// Two plan shapes are known to credit nobody, both observed live 2026-09-19
// on an event whose plan looked correct in the Manage Event UI:
//   - level_id containing "wt": the umbrella is expanded to $.wtIds by the
//     PAGE, for display only. Stored as the literal string it matched no
//     member of any Woodlands level.
//   - patrol_id containing "": an untouched select2 serialises to [""], the
//     server counts that as a patrol selection (it reports the plan back as
//     type:"patrol" even when the author picked Levels), and the only member
//     credited was the one with no patrol assigned at all.
// The model below reproduces that observed behaviour rather than the
// behaviour the UI implies, and reports both shapes as warnings to fix.

const UMBRELLA = 'wt';

// `$.name = <json>;` wherever it sits. The portal is not consistent about
// layout: the lesson-plan fragment gives each blob its own line, but the
// user-list fragment writes `<script>$.users = {…};` — the assignment starts
// after the tag, mid-line. A reader that wanted it at the start of a line read
// NOBODY from that map, which left the plan guard with no one it considered
// applicable, so it could never warn or hold. The JSON is therefore found by
// its own brackets, not by where the line happens to break. Anything that is
// not plain JSON (e.g. `$.flatBadges = Object.assign(...)`) yields null
// rather than throwing.
function jsonEnd(src, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function readBlob(html, name) {
  const src = String(html || '');
  const re = new RegExp(`\\$\\.${name}\\s*=\\s*`, 'g');
  for (let m; (m = re.exec(src));) {
    const start = m.index + m[0].length;
    if (src[start] !== '{' && src[start] !== '[') continue;
    const end = jsonEnd(src, start);
    if (end < 0) continue;
    try { return JSON.parse(src.slice(start, end + 1)); } catch { /* not plain JSON — keep looking */ }
  }
  return null;
}

const displayName = (s) => String(s || '').split('|')[0];

// One plan row, reduced to what decides who gets credit.
function normalisePlan(lesson) {
  const levels = (lesson.level_id || []).map(String);
  const patrols = (lesson.patrol_id || []).map(String);
  return {
    id: lesson.id,
    title: lesson.title || 'Activity plan',
    // the umbrella matches nobody server-side, so it is not a level here
    levels: levels.filter((x) => x && x !== UMBRELLA),
    patrols: patrols.filter((x) => x),
    usesUmbrella: levels.includes(UMBRELLA),
    blankPatrol: patrols.some((x) => x === ''),
    badges: (lesson.badge_id || []).map(String),
    items: (lesson.items_id || []).map(String),
  };
}

// Parse the fragment into everything the guard needs.
function parsePlans(html) {
  const lessons = readBlob(html, 'lessons') || [];
  const itemsByBadge = readBlob(html, 'items') || {};
  const itemTitles = new Map();
  for (const items of Object.values(itemsByBadge)) {
    for (const [id, title] of Object.entries(items || {})) itemTitles.set(id, title);
  }
  return {
    plans: lessons.map(normalisePlan),
    levels: readBlob(html, 'levels') || {},
    patrols: readBlob(html, 'patrols') || {},
    wtIds: readBlob(html, 'wtIds') || [],
    itemTitles,
    // userHashid -> Set(itemId) already held at the member's current level
    held: new Map(Object.entries(readBlob(html, 'advancementsByUser') || {})
      .map(([hash, ids]) => [hash, new Set(ids || [])])),
  };
}

// The user-list fragment carries `$.users` — the people the portal will credit
// advancement to: every youth, plus any adult who still holds a level. Other
// adults are on the roster but not in the map. Each entry has the level and
// patrol the grant is
// matched against. Free: that fragment is already fetched for every push.
function parseUsers(html) {
  const raw = readBlob(html, 'users') || {};
  const out = new Map();
  for (const [hash, u] of Object.entries(raw)) {
    out.set(hash, { level_id: u.level_id || null, patrol_id: u.patrol_id || null });
  }
  return out;
}

async function fetchPlans(fetcher, session, tlcEventId) {
  const res = await fetcher.request(session.cfg, session.jar,
    '/calendar/attendance-lesson-plans?eventId=' + encodeURIComponent(tlcEventId), {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: '*/*',
        Referer: session.cfg.base + '/attendance',
      },
    });
  const html = await res.text();
  if (res.status !== 200 || /LoginForm\[password\]/.test(html)) {
    throw new Error(`TLC activity plans failed for event ${tlcEventId} (status ${res.status}).`);
  }
  return parsePlans(html);
}

// Which of a plan's rows apply to one member, and how. 'blank-patrol' is the
// accidental match described at the top of the file: real credit, wrong
// reason, and it disappears the moment the plan is fixed.
function matchKind(plan, user) {
  if (user.level_id && plan.levels.includes(user.level_id)) return 'level';
  if (user.patrol_id && plan.patrols.includes(user.patrol_id)) return 'patrol';
  if (!user.patrol_id && plan.blankPatrol) return 'blank-patrol';
  return null;
}

// Whole-event warnings, computed once per event rather than per person.
//
// The year check is a NAMING CONVENTION, not something TLC models: troops
// that split a level into year cohorts name the patrols "<Level> 1" and
// "<Level> 2", while the curriculum items are titled "… Year 1"/"… Year 2".
// When both are readable and they disagree, the plan will credit the wrong
// year — it still pushes, so this only ever warns.
function planWarnings(plans) {
  const out = [];
  for (const p of plans.plans) {
    if (p.usesUmbrella) {
      out.push(`Activity plan “${p.title}” uses the combined "${displayName(plans.levels[UMBRELLA]) || 'umbrella'}" level. ` +
        'That selection is expanded by the web page for display only — on the server it matches nobody. ' +
        'Select the individual levels (or the patrols) instead.');
    }
    if (p.blankPatrol) {
      out.push(`Activity plan “${p.title}” has a blank entry in its patrol list. ` +
        'TLC then treats the plan as patrol-scoped and credits only members who have no patrol assigned. ' +
        'Re-save the plan with the patrol list either properly filled in or genuinely empty.');
    }
    const years = new Set();
    for (const pid of p.patrols) {
      const m = /\s(\d)$/.exec(String(plans.patrols[pid] || ''));
      if (m) years.add(m[1]);
    }
    if (years.size === 1) {
      const patrolYear = [...years][0];
      for (const it of p.items) {
        const m = /Year\s*(\d)/i.exec(plans.itemTitles.get(it) || '');
        if (m && m[1] !== patrolYear) {
          out.push(`Activity plan “${p.title}” covers year-${patrolYear} patrols but carries ` +
            `“${plans.itemTitles.get(it)}”. Those Trailmen would be credited for the wrong year.`);
        }
      }
    }
  }
  return out;
}

// Will this member gain anything from the event's plans?
//
//   applicable  there is at least one plan row to reason about
//   covered     some plan row matches this member
//   gain        item ids that would newly land (matched, minus already held)
//   reason      why nothing would land — the text parked on a held push
function coverageFor(plans, userHash, user) {
  if (!plans.plans.length) return { applicable: false, covered: false, gain: [], how: [], reason: null };
  if (!user) {
    // not in $.users — an adult, or a youth the fragment did not describe.
    // Nothing to judge, so never hold on it.
    return { applicable: false, covered: false, gain: [], how: [], reason: null };
  }
  const held = plans.held.get(userHash) || new Set();
  const matched = [];
  for (const p of plans.plans) {
    const how = matchKind(p, user);
    if (how) matched.push({ plan: p, how });
  }
  const gain = [];
  for (const m of matched) for (const it of m.plan.items) if (!held.has(it) && !gain.includes(it)) gain.push(it);

  if (!matched.length) {
    const where = user.patrol_id
      ? `patrol ${displayName(plans.patrols[user.patrol_id]) || user.patrol_id}`
      : (user.level_id
        ? `level ${displayName(plans.levels[user.level_id]) || user.level_id} (no patrol assigned)`
        : 'their level/patrol');
    return {
      applicable: true,
      covered: false,
      gain: [],
      how: [],
      reason: `The event's activity plan does not cover ${where}, so no advancement would be recorded.`,
    };
  }
  return {
    applicable: true,
    covered: true,
    gain,
    how: matched.map((m) => m.how),
    // Everything the plan offers is already on their record: pushing is a
    // no-op for advancement, which is a perfectly good outcome, not a miss.
    reason: null,
  };
}

module.exports = {
  UMBRELLA, readBlob, displayName, normalisePlan,
  parsePlans, parseUsers, fetchPlans,
  matchKind, planWarnings, coverageFor,
};
