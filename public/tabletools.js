'use strict';
/* Sortable / filterable admin tables.
   Excel-style: click a column header -> menu with Sort A-Z / Z-A and a
   checkbox list of that column's distinct values (multi-select) + a search
   box. Filters are AND across columns, OR within a column. Purely
   client-side over the rows already rendered — no server changes, so it
   works the same on every admin table, including offline-cached views.

   Usage after rendering a table:  TableTools.enhance(containerEl)
   Re-enhancing the same container is safe (state resets with the new rows).

   Design notes:
   - Sorting is type-aware: numbers, dates, then case-insensitive text.
     Cells can override with data-sort="<value>" (used for dates so the
     display string stays human while sorting stays chronological).
   - Columns can opt out with <th data-nofilter> (e.g. an actions column).
   - Nothing is destroyed: filtered rows are hidden, never removed, so a
     re-render or a click handler bound to a row keeps working. */

(function () {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

  function cellText(row, i) {
    const td = row.cells[i];
    if (!td) return '';
    if (td.dataset && td.dataset.sort !== undefined) return td.dataset.sort;
    return (td.textContent || '').trim();
  }

  // number > date > text, so mixed columns still order sensibly
  function compareValues(a, b) {
    const na = Number(String(a).replace(/[$,%\s]/g, ''));
    const nb = Number(String(b).replace(/[$,%\s]/g, ''));
    if (a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) return na - nb;
    if (DATE_RE.test(a) && DATE_RE.test(b)) return a < b ? -1 : a > b ? 1 : 0;
    const da = Date.parse(a), db = Date.parse(b);
    if (!isNaN(da) && !isNaN(db) && /[0-9]/.test(a) && /[0-9]/.test(b)) return da - db;
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  }

  function closeMenus() {
    document.querySelectorAll('.tt-menu').forEach((m) => m.remove());
    document.querySelectorAll('th.tt-open').forEach((th) => th.classList.remove('tt-open'));
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tt-menu') && !e.target.closest('th.tt-th')) closeMenus();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  function enhance(container) {
    const table = container.querySelector ? container.querySelector('table') : null;
    if (!table) return null;
    const headRow = table.rows[0];
    if (!headRow || !headRow.cells.length) return null;
    const bodyRows = () => [...table.rows].slice(1).filter((r) => r.cells.length > 1);
    if (!bodyRows().length) return null;

    // state lives on the container so a re-render starts clean
    const state = { sort: null, dir: 1, filters: new Map() }; // col -> Set(values)

    function apply() {
      const rows = bodyRows();
      for (const r of rows) {
        let show = true;
        for (const [col, allowed] of state.filters) {
          if (allowed.size && !allowed.has(cellText(r, col))) { show = false; break; }
        }
        r.hidden = !show;
        r.classList.toggle('tt-hidden', !show);
      }
      if (state.sort != null) {
        const sorted = rows.slice().sort((x, y) =>
          state.dir * compareValues(cellText(x, state.sort), cellText(y, state.sort)));
        const tb = sorted[0] && sorted[0].parentNode;
        if (tb) sorted.forEach((r) => tb.appendChild(r));
      }
      // header indicators
      [...headRow.cells].forEach((th, i) => {
        th.classList.toggle('tt-sorted', state.sort === i);
        th.dataset.ttDir = state.sort === i ? (state.dir === 1 ? 'asc' : 'desc') : '';
        const f = state.filters.get(i);
        th.classList.toggle('tt-filtered', !!(f && f.size));
      });
      renderChips();
      renderCount();
    }

    // active-filter chips so a hidden filter is never a mystery
    let chipBar = container.querySelector('.tt-chips');
    function renderChips() {
      const active = [...state.filters].filter(([, s]) => s.size);
      if (!active.length) { if (chipBar) chipBar.innerHTML = ''; return; }
      if (!chipBar) {
        chipBar = document.createElement('div');
        chipBar.className = 'tt-chips';
        container.insertBefore(chipBar, container.firstChild);
      }
      chipBar.innerHTML = active.map(([col, vals]) =>
        `<span class="tt-chip">${escapeHtml(headRow.cells[col].dataset.ttLabel || headRow.cells[col].textContent.trim())}:
          ${escapeHtml([...vals].slice(0, 3).join(', '))}${vals.size > 3 ? ` +${vals.size - 3}` : ''}
          <button data-tt-clear="${col}" aria-label="Clear filter">✕</button></span>`).join('')
        + `<button class="tt-clear-all">Clear all filters</button>`;
      chipBar.querySelectorAll('[data-tt-clear]').forEach((b) => (b.onclick = () => {
        state.filters.delete(Number(b.dataset.ttClear)); apply();
      }));
      const clearAll = chipBar.querySelector('.tt-clear-all');
      if (clearAll) clearAll.onclick = () => { state.filters.clear(); apply(); };
    }

    let countEl = container.querySelector('.tt-count');
    function renderCount() {
      const rows = bodyRows();
      const shown = rows.filter((r) => !r.hidden).length;
      if (!countEl) {
        countEl = document.createElement('div');
        countEl.className = 'tt-count';
        container.appendChild(countEl);
      }
      const capped = container.dataset.ttCap ? ` · ${escapeHtml(container.dataset.ttCap)}` : '';
      countEl.textContent = shown === rows.length
        ? `${rows.length} row${rows.length === 1 ? '' : 's'}${capped}`
        : `${shown} of ${rows.length} rows shown${capped}`;
    }

    function openMenu(th, col) {
      const wasOpen = th.classList.contains('tt-open');
      closeMenus();
      if (wasOpen) return;
      th.classList.add('tt-open');

      const values = [...new Set(bodyRows().map((r) => cellText(r, col)))]
        .sort((a, b) => compareValues(a, b));
      const chosen = state.filters.get(col) || new Set();

      const menu = document.createElement('div');
      menu.className = 'tt-menu';
      menu.innerHTML = `
        <div class="tt-sortrow">
          <button data-tt-sort="asc">↑ Sort A–Z</button>
          <button data-tt-sort="desc">↓ Sort Z–A</button>
        </div>
        <input class="tt-search" type="search" placeholder="Search values…" aria-label="Search values">
        <div class="tt-vals">${values.map((v, n) => `
          <label><input type="checkbox" value="${escapeHtml(v)}" ${chosen.has(v) ? 'checked' : ''}>
            <span>${v === '' ? '<em>(blank)</em>' : escapeHtml(v)}</span></label>`).join('')}</div>
        <div class="tt-actions">
          <button data-tt-all>Select all</button>
          <button data-tt-none>Clear</button>
          <button class="tt-apply" data-tt-apply>Apply</button>
        </div>`;
      document.body.appendChild(menu);
      const r = th.getBoundingClientRect();
      menu.style.top = `${window.scrollY + r.bottom + 4}px`;
      menu.style.left = `${Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 12)}px`;

      const boxes = () => [...menu.querySelectorAll('.tt-vals input[type=checkbox]')];
      menu.querySelector('.tt-search').oninput = (e) => {
        const q = e.target.value.toLowerCase();
        boxes().forEach((b) => {
          b.parentElement.style.display = b.value.toLowerCase().includes(q) ? '' : 'none';
        });
      };
      menu.querySelectorAll('[data-tt-sort]').forEach((b) => (b.onclick = () => {
        state.sort = col; state.dir = b.dataset.ttSort === 'asc' ? 1 : -1;
        closeMenus(); apply();
      }));
      menu.querySelector('[data-tt-all]').onclick = () =>
        boxes().forEach((b) => { if (b.parentElement.style.display !== 'none') b.checked = true; });
      menu.querySelector('[data-tt-none]').onclick = () => boxes().forEach((b) => (b.checked = false));
      menu.querySelector('[data-tt-apply]').onclick = () => {
        const picked = new Set(boxes().filter((b) => b.checked).map((b) => b.value));
        // all (or none) checked = no filter on this column
        if (!picked.size || picked.size === boxes().length) state.filters.delete(col);
        else state.filters.set(col, picked);
        closeMenus(); apply();
      };
      menu.querySelector('.tt-search').focus();
    }

    [...headRow.cells].forEach((th, col) => {
      if (th.dataset.nofilter !== undefined || !th.textContent.trim()) return;
      th.classList.add('tt-th');
      th.dataset.ttLabel = th.textContent.trim();
      th.setAttribute('title', 'Click to sort or filter this column');
      th.onclick = (e) => { e.stopPropagation(); openMenu(th, col); };
    });

    apply();
    return { apply, state };
  }

  const escapeHtml = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  window.TableTools = { enhance };
})();
