'use strict';
// Portal display labels. The code, env vars, DB columns and docs say "TLC"
// (Trail Life Connect — the platform the integrations were built against),
// but a sibling instance configured for AHGfamily should not show troop
// leaders the wrong product name. Every user-facing string that names the
// portal goes through here; the browser side (public/portal.js) relabels
// static markup the same way from /api/config.portal.
const env = require('./env');

function label() {
  const name = env.ROSTER_SOURCE_NAME;
  // short form for terse UI ("TLC id", "re-check TLC"): the historic
  // abbreviation for Trail Life Connect, otherwise the name itself
  const short = process.env.ROSTER_SOURCE_SHORT || (name === 'Trail Life Connect' ? 'TLC' : name);
  return { name, short };
}

// Rewrite a message written with the default labels — lets error strings
// stay readable in source and still come out right on every instance.
function t(s) {
  const { name, short } = label();
  if (name === 'Trail Life Connect' && short === 'TLC') return s;
  return String(s).replace(/Trail Life Connect/g, name).replace(/\bTLC\b(?!_)/g, short);
}

module.exports = { label, t };
