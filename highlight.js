/**
 * Ü Check page highlight (runs inside each frame of the page).
 * Shows an auditor which elements a check is about: draws numbered boxes over them without changing the page,
 * scrolls to one on request, and can move keyboard focus there. Needs inventory.js, which finds the elements.
 * Defines window.__checkuHL with show(typeId, signature), setCurrent(i), focus(i) and clear().
 */
(function () {
  'use strict';
  if (window.__checkuHL) return;

  let items = [];          // { el, name, selector, tag, role, codes?, color? }
  let many = false;        // true when several groups are shown, each in its own color
  let current = -1;
  let layer = null, tick = 0, tempTab = null;

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.id = '__checku-highlight';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(layer);
    return layer;
  }

  function draw() {
    tick = 0;
    if (!items.length) { if (layer) layer.textContent = ''; return; }
    const root = ensureLayer();
    root.textContent = '';
    // size the layer to the page itself and clip to it, so outlines near an edge never add scrollbars
    root.style.width = Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth) + 'px';
    root.style.height = Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight) + 'px';
    root.style.overflow = 'hidden';
    const sx = window.scrollX, sy = window.scrollY;
    items.forEach((it, i) => {
      const r = it.el.getBoundingClientRect();
      if (!it.el.isConnected) return;
      const isCur = i === current;
      const w = Math.max(r.width, 14), h = Math.max(r.height, 14);
      const col = many ? it.color : '#d6008f';
      const label = many ? it.codes.join(', ') : (isCur ? (i + 1) + ' of ' + items.length : String(i + 1));
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;box-sizing:border-box;pointer-events:none;border-radius:2px;' +
        'left:' + (r.left + sx) + 'px;top:' + (r.top + sy) + 'px;width:' + w + 'px;height:' + h + 'px;' +
        (isCur ? 'outline:4px solid #000;box-shadow:0 0 0 7px #ffea00,0 0 0 9px #000;' : 'outline:3px solid ' + col + ';box-shadow:0 0 0 2px #fff;');
      const tag = document.createElement('div');
      tag.textContent = label;
      tag.style.cssText = 'position:absolute;left:0;bottom:100%;margin-bottom:' + (isCur ? '10' : '3') + 'px;font:700 12px/1.2 system-ui,sans-serif;padding:2px 6px;border-radius:3px;white-space:nowrap;' +
        (isCur ? 'background:#ffea00;color:#000;border:2px solid #000;' : 'background:' + col + ';color:#fff;border:1px solid #fff;');
      box.appendChild(tag);
      root.appendChild(box);
    });
  }
  function redraw() { if (!tick) tick = requestAnimationFrame(draw); }
  window.addEventListener('resize', redraw);
  window.addEventListener('load', redraw);

  function clearTempTab() {
    if (tempTab && tempTab.el) { if (tempTab.had === null) tempTab.el.removeAttribute('tabindex'); else tempTab.el.setAttribute('tabindex', tempTab.had); }
    tempTab = null;
  }

  const brief = it => ({ name: it.name, selector: it.selector, tag: it.tag, role: it.role });

  window.__checkuHL = {
    // Highlight every element in one inventory group. Returns what was found in this frame.
    show(typeId, signature) {
      clearTempTab();
      items = typeof window.__checkuInventory === 'function' && window.__checkuInventory.elementsFor
        ? window.__checkuInventory.elementsFor(typeId, signature) : [];
      current = -1; many = false;
      draw();
      return { count: items.length, items: items.map(brief) };
    },
    // Highlight several groups at once, each in its own color, with the group codes as labels. groups: [{ code, typeId, signature, color }].
    // Returns how many elements each group found in this frame.
    showMany(groups) {
      clearTempTab();
      const found = typeof window.__checkuInventory === 'function' && window.__checkuInventory.findGroups
        ? window.__checkuInventory.findGroups(groups.map(g => ({ code: g.code, typeId: g.typeId, signature: g.signature }))) : {};
      const merged = new Map();                       // an element in two groups gets one box with both codes
      const counts = {};
      groups.forEach(g => {
        const list = found[g.code] || [];
        counts[g.code] = list.length;
        list.forEach(it => { const m = merged.get(it.el) || merged.set(it.el, { ...it, codes: [], color: g.color }).get(it.el); m.codes.push(g.code); });
      });
      items = [...merged.values()]; current = -1;
      many = true;
      draw();
      return { counts, total: items.length };
    },
    // Mark one element as the current one and scroll it into view. -1 clears the "current" mark.
    setCurrent(i) {
      current = i >= 0 && i < items.length ? i : -1;
      draw();
      if (current >= 0) items[current].el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      return current >= 0 ? brief(items[current]) : null;
    },
    // Move keyboard focus to the element on the page (adds a temporary tabindex if it cannot take focus).
    focus(i) {
      const it = items[i];
      if (!it) return { ok: false };
      clearTempTab();
      if (!it.el.matches('a[href],button,input,select,textarea,summary,[tabindex]')) { tempTab = { el: it.el, had: it.el.getAttribute('tabindex') }; it.el.setAttribute('tabindex', '-1'); }
      it.el.addEventListener('blur', clearTempTab, { once: true });
      it.el.focus({ preventScroll: false });
      current = i; draw();
      return { ok: document.activeElement === it.el, ...brief(it) };
    },
    clear() { clearTempTab(); items = []; current = -1; many = false; if (layer) { layer.remove(); layer = null; } return true; },
  };
})();
