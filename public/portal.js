'use strict';
/* Portal labels. The markup and scripts are written for Trail Life Connect
 * ("TLC"); an instance configured for a sibling portal (AHGfamily) gets the
 * same UI with the right product name. Portal.set(cfg.portal) — from
 * /api/config — relabels the page once and then keeps relabeling whatever
 * later renders (MutationObserver), so per-string edits aren't needed.
 * On a Trail Life instance the labels equal the defaults and this file does
 * nothing at all. Env-var names (TLC_EMAIL) are never touched: \bTLC\b(?!_). */
(function () {
  const DEF = { name: 'Trail Life Connect', short: 'TLC' };
  let cur = { ...DEF };
  let active = false;
  const RX_NAME = /Trail\s+Life\s+Connect/g; // markup wraps lines mid-phrase
  const RX_SHORT = /\bTLC\b(?!_)/g;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);
  const ATTRS = ['placeholder', 'title', 'aria-label'];

  const fix = (s) => String(s).replace(RX_NAME, cur.name).replace(RX_SHORT, cur.short);
  const needs = (s) => !!s && /Trail\s+Life\s+Connect|\bTLC\b(?!_)/.test(s);

  function fixText(node) {
    if (needs(node.data)) node.data = fix(node.data);
  }
  function fixEl(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (needs(v)) el.setAttribute(a, fix(v));
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return fixText(root);
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (SKIP.has(root.tagName)) return; fixEl(root); }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === 1 && SKIP.has(n.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) (n.nodeType === 3 ? fixText : fixEl)(n);
  }

  const observer = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') fixText(r.target);
      else if (r.type === 'attributes') fixEl(r.target);
      else r.addedNodes.forEach(walk);
    }
  }) : null;

  function set(p) {
    if (!p || !p.name) return;
    cur = { name: String(p.name), short: String(p.short || p.name) };
    if (cur.name === DEF.name && cur.short === DEF.short) return; // nothing to do — stay inert
    if (active) { walk(document.body); return; }
    active = true;
    walk(document.body);
    if (document.title) document.title = fix(document.title);
    if (observer) observer.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
  }

  // Remember the label per origin so an offline kiosk (no /api/config) still
  // shows the right portal name; /api/config overrides it whenever it loads.
  const KEY = 'tc-portal';
  function persist(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode etc. */ } }
  function restore() {
    try { const p = JSON.parse(localStorage.getItem(KEY) || 'null'); if (p) set(p); } catch { /* ignore */ }
  }
  const setAndPersist = (p) => { set(p); if (p && p.name) persist({ name: cur.name, short: cur.short }); };
  if (document.body) restore(); else document.addEventListener('DOMContentLoaded', restore);

  window.Portal = {
    get name() { return cur.name; },
    get short() { return cur.short; },
    get active() { return active; },
    t: (s) => (active ? fix(s) : String(s)), // for confirm()/prompt() text, which never touches the DOM
    set: setAndPersist,
  };
})();
