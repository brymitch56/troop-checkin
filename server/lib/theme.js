'use strict';
// Env-driven theming. THEME picks a preset palette; individual THEME_<VAR>
// env values override single colors on top of it (the /setup wizard writes
// these when the installer customizes a preset). The palette is served two
// ways: /theme.css (CSS-variable overrides loaded after styles.css) and the
// dynamic PWA manifest colors.
//
// The 'traillife' preset is byte-identical to the :root defaults in
// public/styles.css, so the default render — including troop NY-2911's Pi —
// is pixel-identical to before theming existed.
//
// Semantic colors keep their meaning across presets: --blaze (orange) is
// always "still on site / attention", --in (green) is always "signed in".
// Presets restyle the brand/neutral colors; semantics only change if an
// installer explicitly overrides them.

const VARS = ['pine', 'pine-2', 'paper', 'card', 'ink', 'muted', 'line', 'blaze', 'in', 'focus'];

const PRESETS = {
  // Trail Life: pine green / paper / blaze orange (the original palette)
  traillife: {
    'pine': '#17402C', 'pine-2': '#235B3F', 'paper': '#F4F3EC', 'card': '#FFFFFF',
    'ink': '#1C241E', 'muted': '#5C6A60', 'line': '#D7D9CE', 'blaze': '#DF5A12',
    'in': '#2E7D4F', 'focus': '#123322',
  },
  // American Heritage Girls: navy primary with warm paper. Placeholder-safe
  // defaults — confirm exact values against AHG brand guidance; every color
  // is customizable in the wizard.
  ahg: {
    'pine': '#1B365D', 'pine-2': '#27497C', 'paper': '#F7F4EF', 'card': '#FFFFFF',
    'ink': '#1D2430', 'muted': '#5C6470', 'line': '#D9D7D0', 'blaze': '#DF5A12',
    'in': '#2E7D4F', 'focus': '#12213B',
  },
  // Generic: neutral slate for any other troop/program
  generic: {
    'pine': '#37474F', 'pine-2': '#455A64', 'paper': '#F5F5F2', 'card': '#FFFFFF',
    'ink': '#20262A', 'muted': '#5F6A70', 'line': '#D6D8D4', 'blaze': '#DF5A12',
    'in': '#2E7D4F', 'focus': '#263238',
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

// css var name -> env override name: --pine-2 -> THEME_PINE_2
function envName(v) { return 'THEME_' + v.toUpperCase().replace(/-/g, '_'); }

// Effective palette: preset (unknown preset falls back to traillife) plus
// any valid THEME_* single-color overrides.
function palette() {
  const preset = PRESETS[(process.env.THEME || 'traillife').toLowerCase()] || PRESETS.traillife;
  const out = { ...preset };
  for (const v of VARS) {
    const o = process.env[envName(v)];
    if (o && HEX.test(o)) out[v] = o.toUpperCase();
  }
  return out;
}

function themeCss() {
  const p = palette();
  return ':root {\n' + VARS.map((v) => `  --${v}: ${p[v]};`).join('\n') + '\n}\n';
}

module.exports = { PRESETS, VARS, palette, themeCss, envName };
