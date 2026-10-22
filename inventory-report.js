/**
 * Ü Check element inventory: merge per-frame results and build exports.
 * Pure functions (no DOM, no chrome.*), so they can be tested in Node.
 */
(function (root) {
  'use strict';

  // Merge the results from every frame of the page into one inventory.
  // frames: [{ frameId, result }]  (frameId 0 is the top frame)
  function mergeFrames(frames) {
    const usable = (frames || []).filter(f => f && f.result);
    if (!usable.length) return null;
    const top = usable.find(f => f.frameId === 0) || usable[0];

    // A frame is "hidden in the page" only when every iframe element pointing at its URL is not rendered.
    const entries = [].concat(...usable.map(f => f.result.frameEntries || []));
    const bySrc = {};
    entries.forEach(e => { (bySrc[e.src] = bySrc[e.src] || []).push(e.rendered); });
    const parentHidden = url => !!bySrc[url] && bySrc[url].length > 0 && bySrc[url].every(r => !r);

    const typeOrder = top.result.types.map(t => ({ id: t.id, name: t.name }));
    const types = typeOrder.map(t => ({
      id: t.id, name: t.name, rendered: 0, hidden: 0, hiddenReasons: {},
      ariaHiddenRendered: 0, visuallyHiddenRendered: 0, inShadow: 0, groups: []
    }));
    const byId = Object.fromEntries(types.map(t => [t.id, t]));

    const frameSummaries = [];
    const approximate = [];

    usable.forEach(f => {
      const r = f.result;
      const isTop = f.frameId === 0;
      const hiddenFrame = !isTop && parentHidden(r.frameUrl);
      frameSummaries.push({ frameId: f.frameId, url: r.frameUrl, title: r.title, isTop, hiddenInPage: hiddenFrame, elementsScanned: r.totalElementsScanned });
      const where = isTop ? '' : r.frameUrl;
      r.types.forEach(ft => {
        const t = byId[ft.id]; if (!t) return;
        if (hiddenFrame) {
          t.hidden += ft.rendered + ft.hidden;
          t.hiddenReasons['inside an iframe that is hidden in the page'] = (t.hiddenReasons['inside an iframe that is hidden in the page'] || 0) + ft.rendered + ft.hidden;
        } else {
          t.rendered += ft.rendered; t.hidden += ft.hidden;
          t.ariaHiddenRendered += ft.ariaHiddenRendered; t.visuallyHiddenRendered += ft.visuallyHiddenRendered; t.inShadow += ft.inShadow;
          Object.keys(ft.hiddenReasons).forEach(k => { t.hiddenReasons[k] = (t.hiddenReasons[k] || 0) + ft.hiddenReasons[k]; });
        }
        ft.groups.forEach(g => t.groups.push(Object.assign({}, g, { frameUrl: where, hiddenFrame })));
      });
      (r.approximate || []).forEach(a => approximate.push(Object.assign({}, a, { frameUrl: where, hiddenFrame })));
    });

    types.forEach(t => t.groups.sort((a, b) => b.count - a.count));

    const limits = Array.from(new Set([].concat(...usable.map(f => f.result.limits || []))));
    const hiddenFrames = frameSummaries.filter(f => f.hiddenInPage).length;
    if (hiddenFrames) limits.push(hiddenFrames + ' iframe(s) are hidden in the page. Their content is listed as hidden, not counted.');
    limits.push('Frames that could not be scanned (for example sandboxed or blocked frames) are not included. ' + frameSummaries.length + ' frame(s) were scanned.');

    return {
      pageUrl: top.result.frameUrl, pageTitle: top.result.title, lang: top.result.lang,
      timestamp: top.result.timestamp, scanLabel: top.result.scanLabel, viewport: top.result.viewport,
      openShadowRoots: usable.reduce((n, f) => n + (f.result.openShadowRoots || 0), 0),
      totalElementsScanned: usable.reduce((n, f) => n + (f.result.totalElementsScanned || 0), 0),
      types, approximate: approximate.filter(a => !a.hiddenFrame), frames: frameSummaries, limits
    };
  }

  function csvCell(v) { return typeof v === 'number' ? String(v) : '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
  function reasonText(r) { const k = Object.keys(r || {}); return k.length ? k.map(x => x + ': ' + r[x]).join('; ') : 'none'; }

  // Rows shaped like the Inventory tab of the audit sheet. Group IDs are placeholders to rename.
  function inventoryCsv(merged) {
    const headers = ['Group ID', 'Element type', 'Description of the group', 'Where found', 'Instances in group (N)', 'Identical copies on other listed pages', 'Notes'];
    const rows = [headers];
    let n = 0;
    const id = () => 'G-' + String(++n).padStart(3, '0');
    merged.types.forEach(t => {
      if (!t.rendered && !t.hidden) return;
      t.groups.forEach((g, i) => {
        if (!g.count && !g.hiddenCount) return;
        const notes = [];
        if (i === 0) notes.push('Type totals: ' + t.rendered + ' rendered; ' + t.hidden + ' hidden, not counted (' + reasonText(t.hiddenReasons) + '); ' +
          t.ariaHiddenRendered + ' rendered but aria-hidden or inert; ' + t.visuallyHiddenRendered + ' rendered but visually hidden (screen-reader-only or off-screen); ' + t.inShadow + ' in open shadow DOM.');
        if (g.hiddenCount) notes.push(g.hiddenCount + ' hidden instance(s) of this group not counted.');
        if (g.sampleNames && g.sampleNames.length) notes.push('Example names (approximate): ' + g.sampleNames.join(' | '));
        if (g.sampleSelectors && g.sampleSelectors.length) notes.push('Example location: ' + g.sampleSelectors.join(' ; '));
        notes.push('Scan: ' + merged.scanLabel + '.');
        rows.push([
          id(), t.name, g.description || g.signature, merged.pageUrl + (g.frameUrl ? ' (inside frame ' + g.frameUrl + ')' : ''),
          g.count, 0, notes.join(' ')
        ]);
      });
    });
    merged.approximate.forEach(a => {
      rows.push([id(), a.typeName, a.label, merged.pageUrl + (a.frameUrl ? ' (inside frame ' + a.frameUrl + ')' : ''), a.count, 0,
        'APPROXIMATE. This is a detection, not an exact count. Confirm manually before using it as N. Scan: ' + merged.scanLabel + '.']);
    });
    return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  }

  function summaryText(merged) {
    const parts = merged.types.filter(t => t.rendered || t.hidden)
      .map(t => t.rendered + ' ' + t.name.toLowerCase() + (t.hidden ? ' (' + t.hidden + ' hidden)' : ''));
    return parts.length ? parts.join(', ') : 'No elements found.';
  }

  const api = { mergeFrames, inventoryCsv, summaryText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CheckuInventoryReport = api;
})(typeof window !== 'undefined' ? window : globalThis);
