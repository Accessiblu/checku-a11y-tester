/**
 * Ü Check element inventory (runs inside each frame of the page).
 *
 * Counts every instance of each element type used by the check map, as
 * accurately as automated counting can. It never estimates: whatever it cannot
 * count is reported in `limits`, and anything uncertain is kept separate in
 * `approximate` so it never inflates a count.
 *
 * Defines window.__checkuInventory(options) and returns plain JSON.
 */
(function () {
  'use strict';
  if (typeof window.__checkuInventory === 'function') return;

  // Display names must match the "Element type" names in the check map.
  const TYPE_DEFS = [
    { id: 'link',     name: 'Links',
      sel: 'a[href], area[href], [role="link"]' },
    { id: 'button',   name: 'Buttons and button-like controls',
      sel: 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], summary' },
    { id: 'image',    name: 'Images, icons, and graphics',
      sel: 'img, svg, [role="img"], canvas' },
    { id: 'form',     name: 'Form fields',
      sel: 'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="hidden"]), select, textarea, ' +
           '[role="textbox"], [role="combobox"], [role="listbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="spinbutton"], [role="searchbox"]' },
    { id: 'heading',  name: 'Headings',
      sel: 'h1, h2, h3, h4, h5, h6, [role="heading"]' },
    { id: 'landmark', name: 'Landmarks and skip links',
      sel: 'main, nav, aside, header, footer, form, section, [role="banner"], [role="navigation"], [role="main"], [role="complementary"], [role="contentinfo"], [role="search"], [role="region"], [role="form"]' },
    { id: 'list',     name: 'Lists',
      sel: 'ul, ol, dl, [role="list"]' },
    { id: 'table',    name: 'Tables',
      sel: 'table, [role="table"], [role="grid"], [role="treegrid"]' },
    { id: 'widget',   name: 'Interactive widgets',
      sel: '[role="tab"], [role="tablist"], [role="menu"], [role="menubar"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
           '[role="tree"], [role="treeitem"], [role="grid"], [role="slider"], [role="combobox"], [role="listbox"], [role="option"], [role="tooltip"], [role="switch"], ' +
           '[aria-expanded], [aria-haspopup], details' },
    { id: 'dialog',   name: 'Dialogs and popovers',
      sel: '[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], [popover]' },
    { id: 'motion',   name: 'Moving, blinking, and auto-updating content',
      sel: 'marquee, blink, video[autoplay], audio[autoplay], [aria-live="polite"], [aria-live="assertive"], [role="marquee"], [role="timer"], [role="log"], [role="status"], [role="alert"]' },
    { id: 'media',    name: 'Audio and video',
      sel: 'video, audio, object[type^="video"], object[type^="audio"], ' +
           'iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"], iframe[src*="wistia"], iframe[src*="brightcove"], iframe[src*="dailymotion"], iframe[src*="soundcloud"], iframe[src*="spotify"]' },
    { id: 'frame',    name: 'iframes and embeds',
      sel: 'iframe, frame, embed, object' },
  ];

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'TITLE', 'HEAD', 'BASE']);
  const ELEMENT_CAP_FOR_STYLE_SCAN = 25000;

  // ------------------------------------------------------------------ helpers

  function parentOf(n) {
    if (n.parentElement) return n.parentElement;
    const root = n.getRootNode && n.getRootNode();
    return root && root.host ? root.host : null;      // step out of an open shadow root
  }

  function collectElements() {
    const out = [];
    let shadowRoots = 0;
    const stack = [{ root: document, inShadow: false }];
    while (stack.length) {
      const { root, inShadow } = stack.pop();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        if (!SKIP_TAGS.has(node.tagName)) {
          out.push({ el: node, inShadow });
          if (node.shadowRoot) { shadowRoots++; stack.push({ root: node.shadowRoot, inShadow: true }); }
        }
        node = walker.nextNode();
      }
    }
    return { elements: out, shadowRoots };
  }

  function isRendered(el) {
    if (typeof el.checkVisibility === 'function') {
      if (el.checkVisibility({ checkVisibilityCSS: true })) return true;
      // display:contents has no box, so checkVisibility reports false. The element
      // is still rendered through its children unless an ancestor is hidden.
      const cs = getComputedStyle(el);
      if (cs.display === 'contents') { const p = parentOf(el); return p ? isRendered(p) : true; }
      return false;
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    return cs.display === 'contents' || el.getClientRects().length > 0;
  }

  function hiddenReason(el) {
    let n = el;
    while (n) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return n === el ? 'display:none' : 'inside a display:none container';
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return n === el ? 'visibility:hidden' : 'inside a visibility:hidden container';
      if (n !== el && n.tagName === 'DETAILS' && !n.open) {
        const summary = n.querySelector(':scope > summary');
        if (!(summary && summary.contains(el))) return 'inside closed details (hidden until opened)';
      }
      if (n !== el && n.tagName === 'DIALOG' && !n.open) return 'inside a closed dialog (hidden until opened)';
      n = parentOf(n);
    }
    if (el.tagName === 'DIALOG' && !el.open) return 'closed dialog (hidden until opened)';
    return 'not rendered (for example content-visibility)';
  }

  function ariaHiddenReason(el) {
    let n = el;
    while (n) {
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
      if (n.inert) return 'inert';
      n = parentOf(n);
    }
    return '';
  }

  // With a zero-size viewport (for example a minimized or background window) every box measures 0,
  // so the visually-hidden test is meaningless. It is skipped and reported in `limits`.
  function viewportUsable() { return window.innerWidth > 0 && window.innerHeight > 0; }

  function isVisuallyHidden(el) {
    if (!viewportUsable()) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.opacity === '0') return true;
    if (r.width <= 1 || r.height <= 1) return true;                       // clipped or collapsed (screen-reader-only text)
    const absLeft = r.left + window.scrollX, absTop = r.top + window.scrollY;
    return absLeft + r.width <= 0 || absTop + r.height <= 0;               // positioned off-screen
  }

  function textOfIds(el, attr) {
    return (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean).map(id => {
      const root = el.getRootNode();
      const t = (root.getElementById ? root.getElementById(id) : document.getElementById(id));
      return t ? (t.textContent || '').trim() : '';
    }).filter(Boolean).join(' ');
  }

  function clean(s, max) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > (max || 80) ? s.slice(0, (max || 80) - 1) + '…' : s;
  }

  // An approximation of the accessible name. The browser's accessibility tree is the authority.
  function approxName(el) {
    let v = textOfIds(el, 'aria-labelledby');
    if (v) return clean(v);
    v = el.getAttribute('aria-label');
    if (v && v.trim()) return clean(v);
    const tag = el.tagName.toLowerCase();
    if (el.labels && el.labels.length) { v = Array.from(el.labels).map(l => l.textContent).join(' '); if (v.trim()) return clean(v); }
    if (tag === 'img' || tag === 'area' || (tag === 'input' && el.type === 'image')) { if (el.hasAttribute('alt')) return el.getAttribute('alt') === '' ? '(empty alt)' : clean(el.getAttribute('alt')); }
    if (tag === 'input' && /^(button|submit|reset)$/.test(el.type)) return clean(el.value || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : ''));
    if (tag === 'svg') { const t = el.querySelector('title'); if (t && t.textContent.trim()) return clean(t.textContent); }
    v = el.textContent;
    if (v && v.trim()) return clean(v);
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img && img.getAttribute('alt').trim()) return clean(img.getAttribute('alt'));
    v = el.getAttribute('title');
    if (v && v.trim()) return clean(v);
    return '(no name found)';
  }

  function signature(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const type = el.getAttribute('type') || '';
    const aria = Array.from(el.attributes).map(a => a.name).filter(n => n.indexOf('aria-') === 0).sort().join(',');
    const cls = Array.from(el.classList).filter(c => /^[a-z][a-z-]{2,}$/.test(c)).sort().slice(0, 4).join('.');
    const kids = Array.from(el.children).slice(0, 6).map(c => c.tagName.toLowerCase()).join('>');
    const hasText = (el.textContent || '').trim() ? 't' : '';
    return [tag, role, type, aria, cls, kids, hasText].join('|');
  }

  function cssPath(el) {
    const parts = [];
    let n = el, depth = 0;
    while (n && n.nodeType === 1 && depth < 5) {
      let p = n.tagName.toLowerCase();
      if (n.id) {
        const sel = '#' + CSS.escape(n.id);
        const root = n.getRootNode();
        if (root.querySelectorAll && root.querySelectorAll(sel).length === 1) { parts.unshift(sel); break; }
      }
      const parent = n.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === n.tagName);
        if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(p);
      n = parent; depth++;
    }
    return parts.join(' > ');
  }

  // header/footer are landmarks only when not scoped inside sectioning content;
  // form/section only when they have an accessible name (HTML-AAM).
  function isRealLandmark(el) {
    const tag = el.tagName.toLowerCase();
    if (el.hasAttribute('role')) return true;
    if (tag === 'header' || tag === 'footer') return !el.closest('article, section, aside, main, nav, [role="article"], [role="region"], [role="complementary"], [role="main"], [role="navigation"]');
    if (tag === 'form' || tag === 'section') {
      return !!((el.getAttribute('aria-label') || '').trim() || (el.getAttribute('aria-labelledby') || '').trim());
    }
    return true;
  }

  const SKIP_LINK_RE = /\b(skip|jump)\b.*\b(content|main|navigation|nav|menu)\b|\bskip to\b/i;
  const ICON_FONT_RE = /(^|\s)(fa|fas|far|fab|fal|fad|glyphicon|material-icons|material-symbols|bi|ion|icon|icons)(\s|-|$)|(^|\s)(fa|icon|bi|ion)-/;

  // ------------------------------------------------------------------ find a group's elements again

  // Finds the rendered elements the scan counted in each of several groups, in ONE pass over the page, using the
  // same rules the scan used. `wanted` is a list of { code, typeId, signature }, where signature is the group's
  // signature as saved in Ü Monitor: the scan's signature, with "|<frame url>" added for elements inside an iframe.
  // Returns { [code]: [{ el, name, selector, tag, role }] }. Used by Ü Check to show the auditor what a check is about.
  function findGroups(wanted) {
    const here = window === window.top ? '' : '|' + location.href;
    const byKey = new Map();                                    // "typeId|signature" -> [codes]
    const typeIds = new Set();
    wanted.forEach(w => { const k = w.typeId + '|' + w.signature; (byKey.get(k) || byKey.set(k, []).get(k)).push(w.code); typeIds.add(w.typeId); });
    const out = {}; wanted.forEach(w => { out[w.code] = []; });
    const defs = TYPE_DEFS.filter(d => typeIds.has(d.id));
    const { elements } = collectElements();
    const styleScan = elements.length <= ELEMENT_CAP_FOR_STYLE_SCAN;
    for (const { el } of elements) {
      let sig = null;
      const keys = [];
      for (const d of defs) {
        let m = false; try { m = el.matches(d.sel); } catch (e) { m = false; }
        if (!m || (d.id === 'landmark' && !isRealLandmark(el))) continue;
        sig = sig || signature(el);
        keys.push(d.id + '|' + sig + here);
      }
      if (typeIds.has('landmark') && el.tagName === 'A' && el.getAttribute('href') && el.getAttribute('href').charAt(0) === '#' && el.getAttribute('href').length > 1
          && SKIP_LINK_RE.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''))) keys.push('landmark|skip-link-candidate' + here);
      if (typeIds.has('motion') && styleScan) {
        const cs = getComputedStyle(el);
        if (cs.animationName && cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0) keys.push('motion|css-animation' + here);
      }
      const codes = [];
      for (const k of keys) { const c = byKey.get(k); if (c) codes.push(...c); }
      if (!codes.length || !isRendered(el)) continue;           // the scan counted only rendered elements in a group
      const rec = { el, name: approxName(el), selector: cssPath(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '' };
      codes.forEach(c => out[c].push(rec));
    }
    return out;
  }
  function elementsFor(typeId, wanted) { return findGroups([{ code: 'g', typeId, signature: wanted }]).g; }

  // ------------------------------------------------------------------ main

  window.__checkuInventory = function (options) {
    options = options || {};
    const started = performance.now();
    const { elements, shadowRoots } = collectElements();
    const styleScan = elements.length <= ELEMENT_CAP_FOR_STYLE_SCAN;

    const types = TYPE_DEFS.map(d => ({
      id: d.id, name: d.name, rendered: 0, hidden: 0, hiddenReasons: {},
      ariaHiddenRendered: 0, visuallyHiddenRendered: 0, inShadow: 0, groupsMap: {}
    }));
    const byId = Object.fromEntries(types.map(t => [t.id, t]));

    function addInstance(typeId, rec, sigOverride, descOverride) {
      const t = byId[typeId];
      if (rec.rendered) {
        t.rendered++;
        if (rec.ariaHidden) t.ariaHiddenRendered++;
        if (rec.visuallyHidden) t.visuallyHiddenRendered++;
        if (rec.inShadow) t.inShadow++;
      } else {
        t.hidden++;
        t.hiddenReasons[rec.hiddenReason] = (t.hiddenReasons[rec.hiddenReason] || 0) + 1;
      }
      const key = sigOverride || rec.sig;
      const g = t.groupsMap[key] || (t.groupsMap[key] = { signature: key, description: descOverride || '', count: 0, hiddenCount: 0, sampleNames: [], sampleSelectors: [] });
      if (rec.rendered) {
        g.count++;
        if (g.sampleNames.length < 3 && g.sampleNames.indexOf(rec.name) === -1) g.sampleNames.push(rec.name);
        if (g.sampleSelectors.length < 2) g.sampleSelectors.push((rec.inShadow ? '(shadow DOM) ' : '') + rec.selector());
      } else g.hiddenCount++;
    }

    const approximate = { cssBackground: 0, iconFont: 0, animatedCss: 0 };
    const frameEntries = [];

    for (const { el, inShadow } of elements) {
      const matched = TYPE_DEFS.filter(d => { try { return el.matches(d.sel); } catch (e) { return false; } });
      const isSkip = el.tagName === 'A' && el.getAttribute('href') && el.getAttribute('href').charAt(0) === '#' && el.getAttribute('href').length > 1 && SKIP_LINK_RE.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''));
      const wantsFrames = el.tagName === 'IFRAME' || el.tagName === 'FRAME';
      if (!matched.length && !isSkip && !wantsFrames && !styleScan) continue;

      const rendered = isRendered(el);
      let rec = null;
      const need = () => rec || (rec = {
        el, inShadow, rendered,
        hiddenReason: rendered ? '' : hiddenReason(el),
        ariaHidden: rendered ? !!ariaHiddenReason(el) : false,
        visuallyHidden: rendered ? isVisuallyHidden(el) : false,
        name: approxName(el), sig: signature(el),
        selector: () => cssPath(el)
      });

      for (const d of matched) {
        if (d.id === 'landmark' && !isRealLandmark(el)) continue;
        const r = need();
        const desc = '<' + el.tagName.toLowerCase() + '>' + (el.getAttribute('role') ? ' role=' + el.getAttribute('role') : '') + (el.getAttribute('type') ? ' type=' + el.getAttribute('type') : '');
        addInstance(d.id, r, null, desc);
      }
      if (isSkip) { const r = need(); addInstance('landmark', r, 'skip-link-candidate', 'Skip link (candidate: link to an in-page anchor with skip wording)'); }

      if (wantsFrames) {
        let abs = ''; try { abs = new URL(el.getAttribute('src') || '', location.href).href; } catch (e) { abs = el.getAttribute('src') || ''; }
        frameEntries.push({ src: abs, rendered });
      }

      if (rendered && styleScan) {
        const cs = getComputedStyle(el);
        if (cs.backgroundImage && cs.backgroundImage.indexOf('url(') !== -1 && !['IMG', 'SVG', 'PICTURE', 'VIDEO', 'CANVAS'].includes(el.tagName.toUpperCase())) approximate.cssBackground++;
        if (cs.animationName && cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0) {
          const r = need();
          addInstance('motion', r, 'css-animation', 'Element with a running CSS animation (check whether it pauses, and for flashing)');
          approximate.animatedCss++;
        }
        const tag = el.tagName.toLowerCase();
        if ((tag === 'i' || tag === 'span' || tag === 'em') && ICON_FONT_RE.test(el.getAttribute('class') || '') && !(el.textContent || '').trim()) approximate.iconFont++;
      }
    }

    const outTypes = types.map(t => ({
      id: t.id, name: t.name, rendered: t.rendered, hidden: t.hidden, hiddenReasons: t.hiddenReasons,
      ariaHiddenRendered: t.ariaHiddenRendered, visuallyHiddenRendered: t.visuallyHiddenRendered, inShadow: t.inShadow,
      groups: Object.values(t.groupsMap).sort((a, b) => b.count - a.count || b.hiddenCount - a.hiddenCount)
    }));

    const limits = [
      'Accessible names shown here are approximations, not the browser accessibility tree.',
      'Content that is hidden until it is opened (menus, dialogs, tabs, accordions) is not rendered. Open it and scan again with a new scan label.',
      'Closed shadow roots cannot be read. Open shadow roots are included.',
      'Content that loads as you scroll (infinite lists) is counted only as far as it has loaded. Scroll to load it, then scan again.',
      'The contents of canvas elements are not counted.'
    ];
    if (!viewportUsable()) limits.push('The page window has no visible area (width or height is 0), so the visually hidden counts could not be measured and show as 0. Make the window visible and scan again.');
    if (!styleScan) limits.push('The page has more than ' + ELEMENT_CAP_FOR_STYLE_SCAN + ' elements, so CSS background images, animations, and icon fonts were not scanned.');

    return {
      frameUrl: location.href,
      title: document.title || '',
      lang: document.documentElement.getAttribute('lang') || '',
      timestamp: new Date().toISOString(),
      scanLabel: options.scanLabel || 'Default state',
      viewport: { width: window.innerWidth, height: window.innerHeight },
      totalElementsScanned: elements.length,
      openShadowRoots: shadowRoots,
      types: outTypes,
      approximate: [
        { id: 'css-background', typeName: 'Images, icons, and graphics', label: 'Elements with a CSS background image (could be decorative or informative; check visually)', count: approximate.cssBackground },
        { id: 'icon-font', typeName: 'Images, icons, and graphics', label: 'Possible icon-font icons with no text (check that each has a name or is hidden)', count: approximate.iconFont }
      ].filter(a => a.count > 0),
      frameEntries,
      limits,
      scanMs: Math.round(performance.now() - started)
    };
  };
  window.__checkuInventory.elementsFor = elementsFor;
  window.__checkuInventory.findGroups = findGroups;
})();
