'use strict';
// Env-driven theming. THEME picks a preset palette; individual THEME_<VAR>
// env values override single colors on top of it (the /setup wizard writes
// these when the installer customizes a preset). The palette is served three
// ways: /theme.css (CSS-variable overrides loaded after styles.css), the
// dynamic PWA manifest colors, and /icon.svg (the app mark, below).
//
// The 'traillife' preset is byte-identical to the :root defaults in
// public/styles.css, so the default render on every pre-theming install is
// pixel-identical to before theming existed.
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
  // American Heritage Girls: red, white & blue from the AHG Master Brand
  // Guidelines (2026) primary palette — PMS 2945 blue (RGB 0 97 171) and
  // PMS 485 red (RGB 226 59 40) on white. Blue is the primary UI color,
  // brand red takes the attention/still-on-site role (semantic meaning
  // unchanged), signed-in green stays. pine-2 is an 80% tint of 2945;
  // focus a darkened 2945. Every color remains customizable in the wizard.
  ahg: {
    'pine': '#0061AB', 'pine-2': '#3380BC', 'paper': '#F4F6F8', 'card': '#FFFFFF',
    'ink': '#1C232B', 'muted': '#5B6570', 'line': '#D5D9DE', 'blaze': '#E23B28',
    'in': '#2E7D4F', 'focus': '#00477E',
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

// The app mark: a rounded box with a check, drawn in the palette's own
// colors. Two instances on one Pi otherwise show an identical icon in the
// browser tab strip, and picking the wrong tab means running a door on the
// wrong troop's roster — so the mark follows the theme the same way the UI
// does. Geometry is traced from public/icon-512.png (still shipped for iOS
// home screens and as the pre-SVG fallback), and that PNG's two colors ARE
// the traillife --pine and --paper, so the default instance renders the
// same mark it always had.
function iconSvg() {
  const p = palette();
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Check-in">'
    + `<rect width="512" height="512" fill="${p.pine}"/>`
    + `<rect x="70" y="70" width="372" height="372" rx="30" fill="none" stroke="${p.paper}" stroke-width="12"/>`
    + `<path d="M156 273 L230 342 L366 183" fill="none" stroke="${p.paper}"`
    + ' stroke-width="21" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>\n';
}

module.exports = { PRESETS, VARS, palette, themeCss, iconSvg, envName };
