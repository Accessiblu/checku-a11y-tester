/**
 * Content Script for WCAG 2.2 Accessibility Tester
 *
 * Runs in the context of web pages with full DOM access.
 */

let axeLoaded = false;
let highlightedElements = [];
let tabOrderBadges = [];
let headingBadges = [];

// Generic badge groups keyed by type name (landmark, list, icon, nav)
const badgeGroups = {};

function clearBadgeGroup(type) {
  (badgeGroups[type] || []).forEach(({ badge, outline }) => {
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    if (outline) {
      outline.el.style.outline = outline.original;
      outline.el.style.outlineOffset = outline.originalOffset;
    }
  });
  badgeGroups[type] = [];
}

function injectBadge(el, label, color, type) {
  // Outline the element
  const originalOutline = el.style.outline;
  const originalOffset  = el.style.outlineOffset;
  el.style.outline = `2px solid ${color}`;
  el.style.outlineOffset = '2px';

  // Badge label
  const badge = document.createElement('div');
  badge.className = 'a11y-generic-badge';
  badge.textContent = label;
  badge.style.background = color;

  const rect = el.getBoundingClientRect();
  badge.style.top  = `${rect.top  + window.scrollY}px`;
  badge.style.left = `${rect.left + window.scrollX}px`;
  document.body.appendChild(badge);

  if (!badgeGroups[type]) badgeGroups[type] = [];
  badgeGroups[type].push({
    badge,
    outline: { el, original: originalOutline, originalOffset }
  });
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'runTest') {
    runAccessibilityTest(request.level, request.scope)
      .then(results => sendResponse({ success: true, results }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'highlightIssues') {
    highlightAccessibilityIssues(request.violations);
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'clearHighlights') {
    clearHighlights();
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'showTabOrder') {
    const result = showTabOrder();
    sendResponse({ success: true, result });
    return false;
  }

  if (request.action === 'clearTabOrder') {
    clearTabOrder();
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getHeadings') {
    const result = getHeadings();
    sendResponse({ success: true, result });
    return false;
  }

  if (request.action === 'clearHeadings') {
    clearHeadings();
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getImageAlt') {
    const result = getImageAlt();
    sendResponse({ success: true, result });
    return false;
  }

  if (request.action === 'getLandmarks') {
    const result = getLandmarks();
    sendResponse({ success: true, result });
    return false;
  }

  if (request.action === 'clearLandmarks') {
    clearBadgeGroup('landmark');
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getLists') {
    const result = getLists();
    sendResponse({ success: true, result });
    return false;
  }

  if (request.action === 'clearLists') {
    clearBadgeGroup('list');
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getIcons') {
    const result = getIcons();
    sendResponse({ success: true, result });
    return false;
  }

  if (request.action === 'clearIcons') {
    clearBadgeGroup('icon');
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getNavs') {
    const result = getNavs();
    sendResponse({ success: true, result });
    return false;
  }

  if (request.action === 'clearNavs') {
    clearBadgeGroup('nav');
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getContrastData') {
    const result = getContrastData();
    sendResponse({ success: true, result });
    return false;
  }

  if (request.action === 'clearContrast') {
    clearContrast();
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getAriaUsage') {
    const result = getAriaUsage();
    sendResponse({ success: true, result });
    return false;
  }

  if (request.action === 'clearAriaHighlights') {
    clearAriaHighlights();
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'startLiveRegionWatch') {
    sendResponse({ success: true, result: startLiveRegionWatch() });
    return false;
  }

  if (request.action === 'getLiveRegionLog') {
    sendResponse({ success: true, result: getLiveRegionLog() });
    return false;
  }

  if (request.action === 'stopLiveRegionWatch') {
    stopLiveRegionWatch();
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getFocusIndicators') {
    const result = getFocusIndicators();
    sendResponse({ success: true, result });
    return false;
  }

  if (request.action === 'clearFocusIndicators') {
    clearBadgeGroup('focus');
    sendResponse({ success: true });
    return false;
  }
});

// ---------------------------------------------------------------------------
// axe-core loader
// ---------------------------------------------------------------------------

async function loadAxe() {
  if (typeof axe === 'undefined') {
    throw new Error('axe-core not available');
  }
}

// ---------------------------------------------------------------------------
// Overlay detection
// ---------------------------------------------------------------------------

const OVERLAY_SIGNATURES = [
  {
    name: 'AccessiBe',
    url: 'https://overlayfactsheet.com',
    scriptPatterns: ['acsbapp.com', 'accessibe.com'],
    selectors: ['#acsb-trigger', '.acsb-trigger', '#acsb-root']
  },
  {
    name: 'UserWay',
    url: 'https://overlayfactsheet.com',
    scriptPatterns: ['userway.org'],
    selectors: ['#userwayAccessibilityWidget', '.userway_buttons_wrapper', '#userway-icon']
  },
  {
    name: 'AudioEye',
    url: 'https://overlayfactsheet.com',
    scriptPatterns: ['audioeye.com'],
    selectors: ['#ae-launcher', '.ae-launcher', '#ae-tooltip']
  },
  {
    name: 'EqualWeb',
    url: 'https://overlayfactsheet.com',
    scriptPatterns: ['equalweb.com', 'nagich.com'],
    selectors: ['#INDmenu-btn', '.INDmenu-btn']
  },
  {
    name: 'MaxAccess',
    url: 'https://overlayfactsheet.com',
    scriptPatterns: ['maxaccess', 'max-access'],
    selectors: ['.maxaccess-button', '#maxaccess']
  },
  {
    name: 'Lisio',
    url: 'https://overlayfactsheet.com',
    scriptPatterns: ['lisio.io'],
    selectors: ['.lisio-widget']
  },
  {
    name: 'BrowseAloud',
    url: 'https://overlayfactsheet.com',
    scriptPatterns: ['browsealoud.com'],
    selectors: ['#ba-toolbar', '.ba-toolbar-toggle']
  },
  {
    name: 'Recite Me',
    url: 'https://overlayfactsheet.com',
    scriptPatterns: ['reciteme.com'],
    selectors: ['#recite-wrapper', '.recite-btn']
  },
  {
    name: 'Texthelp / Reachability',
    url: 'https://overlayfactsheet.com',
    scriptPatterns: ['texthelp.com'],
    selectors: ['#texthelp-toolbar']
  },
  {
    name: 'Facil\'iti',
    url: 'https://overlayfactsheet.com',
    scriptPatterns: ['faciliti.com'],
    selectors: ['#faciliti-wdgt']
  }
];

function detectOverlays() {
  const scriptSrcs = Array.from(document.querySelectorAll('script[src]'))
    .map(s => s.getAttribute('src') || '');

  const detected = [];

  for (const overlay of OVERLAY_SIGNATURES) {
    const scriptMatch = overlay.scriptPatterns.find(pattern =>
      scriptSrcs.some(src => src.toLowerCase().includes(pattern))
    );
    const elementMatch = overlay.selectors.find(sel => document.querySelector(sel));
    const detectedVia = scriptMatch
      ? `script src contains "${scriptMatch}"`
      : elementMatch
        ? `element "${elementMatch}" found in DOM`
        : null;

    if (!detectedVia) continue;

    // Find the actual element to use as the node target
    const targetEl = elementMatch
      ? document.querySelector(elementMatch)
      : document.querySelector(`script[src*="${scriptMatch}"]`);

    detected.push({
      id: 'accessibility-overlay',
      impact: 'critical',
      isOverlay: true,
      overlayName: overlay.name,
      detectedVia,
      description:
        `The "${overlay.name}" accessibility overlay is installed on this page. ` +
        `Overlays do not fix underlying accessibility issues and are known to introduce ` +
        `new barriers for screen reader and keyboard users. ` +
        `Removal of the overlay is required in order to meet WCAG standards and comply with accessibility laws.`,
      help: `Accessibility Overlay Detected: ${overlay.name}`,
      helpUrl: overlay.url,
      tags: ['overlay', 'best-practice'],
      wcagTags: [],
      nodes: [{
        html: targetEl ? targetEl.outerHTML.substring(0, 200) : `<!-- ${overlay.name} overlay -->`,
        target: elementMatch ? [elementMatch] : [`script[src*="${scriptMatch}"]`],
        failureSummary: `"${overlay.name}" overlay detected via ${detectedVia}.`,
        any: [], all: [], none: []
      }]
    });
  }

  return detected;
}

// ---------------------------------------------------------------------------
// role="application" review
//
// JAWS's own ARIA support documentation calls this out as a named
// anti-pattern: role="application" hands ALL arrow-key and Escape handling
// to page JavaScript, disabling the screen reader's normal text-review
// navigation for that whole region. Correct on a canvas editor or game;
// silently disabling for a user when misapplied to a block of static text
// with no visible caret. axe-core has no way to judge "does this region
// really manage its own keyboard interaction," so this always needs a
// human — hence it's surfaced as a review item, not a violation.
// ---------------------------------------------------------------------------

function detectApplicationRegions() {
  const nodes = [];
  document.querySelectorAll('[role="application"]').forEach(el => {
    nodes.push({
      html: el.outerHTML.substring(0, 200),
      target: [generateSelector(el)],
      failureSummary:
        'role="application" hands arrow-key and Escape handling entirely to page JavaScript. ' +
        'Confirm this region fully implements its own keyboard interaction model — if it does not ' +
        '(for example, a block of plain text with no visible caret), remove the role. Screen reader ' +
        'users otherwise lose the ability to read the region with the arrow keys, with no visual cue ' +
        'that anything changed.',
      any: [], all: [], none: []
    });
  });

  if (!nodes.length) return null;

  return {
    id: 'role-application-review',
    impact: 'moderate',
    description:
      'role="application" was found on this page. This role is appropriate only for regions that ' +
      'implement their own complete keyboard interaction (e.g. a canvas-based editor or game). ' +
      'Applied to ordinary content, it silently strips a screen reader user\'s ability to review the ' +
      'region\'s text with the arrow keys.',
    help: 'role="application" found — verify it manages its own full keyboard interaction',
    helpUrl: 'https://www.w3.org/TR/wai-aria-1.2/#application',
    tags: ['cat.keyboard', 'best-practice'],
    wcagTags: ['wcag211', 'wcag412'],
    nodes
  };
}

// ---------------------------------------------------------------------------
// Drag interaction review (WCAG 2.5.7 — Dragging Movements)
//
// JAWS's own ARIA documentation is explicit that a screen reader only ever
// narrates a drag operation (grabbable/grabbed/droppable) — it never
// performs the drag itself, and the keyboard-operable alternative WCAG 2.5.7
// requires is entirely the page author's responsibility. axe-core can't
// judge whether that alternative exists or works, so this is a heuristic
// detector feeding the manual-review queue, not a pass/fail check.
// ---------------------------------------------------------------------------

const DRAG_LIBRARY_SIGNATURES = [
  { name: 'Sortable.js',              scriptPatterns: ['sortable.min.js', 'sortable.js', 'sortablejs'], selectors: ['.sortable', '[class*="sortable-"]'] },
  { name: 'react-beautiful-dnd',      scriptPatterns: ['react-beautiful-dnd'], selectors: ['[data-rbd-droppable-id]', '[data-rbd-draggable-id]'] },
  { name: 'dnd-kit',                  scriptPatterns: ['dnd-kit'], selectors: ['[data-dnd-kit]'] },
  { name: 'interact.js',              scriptPatterns: ['interact.min.js', 'interactjs'], selectors: [] },
  { name: 'jQuery UI Sortable/Draggable', scriptPatterns: ['jquery-ui'], selectors: ['.ui-sortable', '.ui-draggable'] }
];

function detectDragInteractions() {
  const nodes = [];
  const seen = new Set();

  document.querySelectorAll('[draggable="true"]').forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);
    nodes.push({
      html: el.outerHTML.substring(0, 200),
      target: [generateSelector(el)],
      failureSummary:
        'draggable="true" found. Confirm a full, single-pointer, non-drag alternative exists ' +
        '(e.g. Move Up / Move Down buttons, a cut-and-paste style flow) and that drag state is ' +
        'exposed to assistive technology. Screen readers announce drag state — they never perform ' +
        'the drag or provide the alternative for you.',
      any: [], all: [], none: []
    });
  });

  const scriptSrcs = Array.from(document.querySelectorAll('script[src]'))
    .map(s => s.getAttribute('src') || '');

  DRAG_LIBRARY_SIGNATURES.forEach(lib => {
    const scriptMatch = lib.scriptPatterns.find(p =>
      scriptSrcs.some(src => src.toLowerCase().includes(p.toLowerCase()))
    );
    const elementMatch = lib.selectors.find(sel => {
      try { return document.querySelector(sel); } catch (e) { return false; }
    });
    if (!scriptMatch && !elementMatch) return;

    const targetEl = elementMatch ? document.querySelector(elementMatch) : null;
    if (targetEl && seen.has(targetEl)) return;
    if (targetEl) seen.add(targetEl);

    nodes.push({
      html: targetEl ? targetEl.outerHTML.substring(0, 200) : `<!-- ${lib.name} detected via script tag -->`,
      target: elementMatch ? [elementMatch] : [`script[src*="${scriptMatch}"]`],
      failureSummary:
        `${lib.name} drag-and-drop library detected. Confirm a full keyboard alternative and ` +
        `ARIA drag state (or an APG-compliant pattern) accompany the drag interaction.`,
      any: [], all: [], none: []
    });
  });

  if (!nodes.length) return null;

  return {
    id: 'drag-interaction-review',
    impact: 'serious',
    description:
      'A drag-and-drop interaction was detected. WCAG 2.5.7 (Dragging Movements) requires every ' +
      'drag operation to have a single-pointer, non-drag alternative. Screen readers only ever ' +
      'narrate drag state (grabbable, grabbed, droppable) — they never perform the drag themselves ' +
      'or supply the required alternative.',
    help: 'Drag interaction detected — verify a keyboard alternative exists (WCAG 2.5.7)',
    helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html',
    tags: ['cat.sensory-and-visual-cues', 'wcag22aa'],
    wcagTags: ['wcag257'],
    nodes
  };
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

function getTagsForLevel(level) {
  const base = ['wcag2a', 'wcag21a', 'wcag22a', 'best-practice'];
  if (level === 'A')   return base;
  if (level === 'AA')  return [...base, 'wcag2aa', 'wcag21aa', 'wcag22aa'];
  if (level === 'AAA') return [...base, 'wcag2aa', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'wcag21aaa', 'wcag22aaa'];
  return base;
}

async function runAccessibilityTest(level = 'AA', scope = 'page') {
  await loadAxe();

  let context = document;
  if (scope === 'selection') {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const el = range.commonAncestorContainer;
      context = el.nodeType === 1 ? el : el.parentElement;
    }
  }

  const results = await axe.run(context, {
    runOnly: { type: 'tag', values: getTagsForLevel(level) },
    resultTypes: ['violations', 'passes', 'incomplete', 'inapplicable'],
    reporter: 'v2'
  });

  // Prepend overlay violations (always run on full document)
  const overlayViolations = detectOverlays();
  const violations = [...overlayViolations, ...processResults(results.violations)];

  // Heuristic checks axe-core structurally can't judge on its own — these
  // always need a human, so they join the manual-review queue rather than
  // the violations list. See detectApplicationRegions / detectDragInteractions
  // above for why each one exists. Their rule IDs are also registered against
  // WCAG 2.1.1 and 2.5.7 in the VPAT Matrix's WCAG_2_2_CRITERIA list.
  const reviewFindings = [detectApplicationRegions(), detectDragInteractions()].filter(Boolean);
  const incomplete = [...reviewFindings, ...processResults(results.incomplete)];

  return {
    url: window.location.href,
    timestamp: new Date().toISOString(),
    level,
    violations,
    passes: processResults(results.passes),
    incomplete,
    inapplicable: processResults(results.inapplicable),
    summary: {
      violations: violations.length,
      passes: results.passes.length,
      incomplete: incomplete.length,
      inapplicable: results.inapplicable.length,
      totalIssues: violations.reduce((sum, v) => sum + v.nodes.length, 0)
    }
  };
}

function processResults(results) {
  return results.map(r => ({
    id: r.id,
    impact: r.impact,
    description: r.description,
    help: r.help,
    helpUrl: r.helpUrl,
    tags: r.tags,
    wcagTags: r.tags.filter(t => t.startsWith('wcag')),
    nodes: r.nodes.map(n => ({
      html: n.html,
      target: n.target,
      failureSummary: n.failureSummary,
      any: n.any, all: n.all, none: n.none
    }))
  }));
}

// ---------------------------------------------------------------------------
// Highlight violations on page
// ---------------------------------------------------------------------------

function highlightAccessibilityIssues(violations) {
  clearHighlights();

  violations.forEach(violation => {
    violation.nodes.forEach(node => {
      if (!node.target) return;

      // axe-core target items are either a CSS string (regular DOM) or a nested
      // array of strings (shadow-DOM piercing path, e.g. ["host-sel", "inner-sel"]).
      // Use the last segment of any path — that's the selector for the actual
      // element within its host. Passing a whole array to querySelectorAll would
      // coerce it to "host-sel,inner-sel", matching the wrong elements.
      const selectors = node.target.map(t => Array.isArray(t) ? t[t.length - 1] : t);

      let matched = false;
      for (const sel of selectors) {
        try {
          document.querySelectorAll(sel).forEach(el => {
            highlightElement(el, violation.impact, violation.help, violation.isOverlay, violation.overlayName);
            matched = true;
          });
        } catch (_) {
          // Selector may contain characters that are invalid in CSS
          // (e.g. Tailwind arbitrary values like "text-[#FF0000]").
          // Fall through to the ID-based fallback below.
        }
      }

      // Fallback: if no element was resolved — either because every selector
      // threw, the element lives inside a shadow root, or the page mutated
      // after the test — extract the id attribute from the HTML snippet and
      // try getElementById as a last resort.
      if (!matched && node.html) {
        const idMatch = node.html.match(/\sid="([^"]*)"/i);
        if (idMatch) {
          const el = document.getElementById(idMatch[1]);
          if (el) highlightElement(el, violation.impact, violation.help, violation.isOverlay, violation.overlayName);
        }
      }
    });
  });
}

function highlightElement(element, impact, message, isOverlay = false, overlayName = '') {
  const originalOutline = element.style.outline;
  const colors = { critical: '#dc2626', serious: '#ea580c', moderate: '#d97706', minor: '#65a30d' };
  const color = isOverlay ? '#7c3aed' : (colors[impact] || colors.moderate);

  element.style.outline = `3px solid ${color}`;
  element.style.outlineOffset = '2px';

  const tooltip = document.createElement('div');
  tooltip.className = 'a11y-tester-tooltip';

  if (isOverlay) {
    tooltip.innerHTML = `<span class="a11y-overlay-chip">OVERLAY</span> ${overlayName}: ${message}`;
  } else {
    tooltip.textContent = message;
  }

  tooltip.style.cssText = `
    position: absolute;
    background: ${color};
    color: white;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    z-index: 999999;
    max-width: 320px;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;

  const rect = element.getBoundingClientRect();
  tooltip.style.top  = `${rect.top + window.scrollY - 30}px`;
  tooltip.style.left = `${rect.left + window.scrollX}px`;
  document.body.appendChild(tooltip);

  highlightedElements.push({ element, tooltip, originalStyles: { outline: originalOutline } });
}

function clearHighlights() {
  highlightedElements.forEach(({ element, tooltip, originalStyles }) => {
    element.style.outline = originalStyles.outline;
    if (tooltip && tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
  });
  highlightedElements = [];
}

// ---------------------------------------------------------------------------
// Tab / focus order visualizer
// ---------------------------------------------------------------------------

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
  '[contenteditable="true"]'
].join(',');

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}

function showTabOrder() {
  clearTabOrder();

  const candidates = Array.from(document.querySelectorAll(FOCUSABLE)).filter(el => {
    const ti = parseInt(el.getAttribute('tabindex'), 10);
    return (isNaN(ti) || ti >= 0) && isVisible(el);
  });

  // tabindex > 0 first (sorted), then natural DOM order (tabindex 0 or absent)
  const positive = candidates
    .filter(el => parseInt(el.getAttribute('tabindex'), 10) > 0)
    .sort((a, b) => parseInt(a.getAttribute('tabindex')) - parseInt(b.getAttribute('tabindex')));
  const natural = candidates.filter(el => {
    const ti = parseInt(el.getAttribute('tabindex'), 10);
    return isNaN(ti) || ti === 0;
  });

  const tabOrder = [...positive, ...natural];

  tabOrder.forEach((el, idx) => {
    const isPositive = parseInt(el.getAttribute('tabindex'), 10) > 0;
    const badge = document.createElement('div');
    badge.className = 'a11y-tab-badge';
    badge.textContent = idx + 1;
    badge.style.background = isPositive ? '#f59e0b' : '#3b82f6';
    badge.style.borderColor  = isPositive ? '#d97706' : '#2563eb';

    const rect = el.getBoundingClientRect();
    badge.style.top  = `${rect.top  + window.scrollY - 10}px`;
    badge.style.left = `${rect.left + window.scrollX - 10}px`;
    document.body.appendChild(badge);
    tabOrderBadges.push(badge);
  });

  return {
    total: tabOrder.length,
    positiveTabindex: positive.length,
    naturalOrder: natural.length,
    elements: tabOrder.map((el, idx) => ({
      position: idx + 1,
      tag: el.tagName,
      text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim().substring(0, 50),
      tabindex: el.getAttribute('tabindex'),
      isPositiveTabindex: parseInt(el.getAttribute('tabindex'), 10) > 0,
      selector: generateSelector(el)
    }))
  };
}

function clearTabOrder() {
  tabOrderBadges.forEach(b => b.parentNode && b.parentNode.removeChild(b));
  tabOrderBadges = [];
}

// ---------------------------------------------------------------------------
// Heading structure visualizer
// ---------------------------------------------------------------------------

const HEADING_COLORS = {
  1: '#dc2626', 2: '#ea580c', 3: '#d97706',
  4: '#16a34a', 5: '#0284c7', 6: '#7c3aed'
};

function getHeadings() {
  clearHeadings();

  const headingEls = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  let prevLevel = 0;
  const headings = headingEls.map(el => {
    const level = parseInt(el.tagName[1], 10);
    const skipWarning = prevLevel > 0 && level > prevLevel + 1;
    const skipFrom = skipWarning ? prevLevel : null;
    const skipTo   = skipWarning ? level : null;
    prevLevel = level;

    // Inject page badge
    const badge = document.createElement('div');
    badge.className = 'a11y-heading-badge';
    badge.textContent = `H${level}`;
    badge.style.background = HEADING_COLORS[level] || '#666';

    const rect = el.getBoundingClientRect();
    badge.style.top  = `${rect.top  + window.scrollY}px`;
    badge.style.left = `${rect.left + window.scrollX - 30}px`;
    document.body.appendChild(badge);
    headingBadges.push(badge);

    return {
      level,
      text: el.textContent.trim().substring(0, 80),
      hasId: !!el.id,
      selector: generateSelector(el),
      skipWarning,
      skipFrom,
      skipTo
    };
  });

  const h1Count = headings.filter(h => h.level === 1).length;
  return {
    headings,
    summary: {
      total: headings.length,
      h1Count,
      skips: headings.filter(h => h.skipWarning).length,
      multipleH1: h1Count > 1
    }
  };
}

function clearHeadings() {
  headingBadges.forEach(b => b.parentNode && b.parentNode.removeChild(b));
  headingBadges = [];
}

// ---------------------------------------------------------------------------
// Image alt text inspector
// ---------------------------------------------------------------------------

function getImageAlt() {
  const images = Array.from(document.querySelectorAll('img'));

  const REDUNDANT = /^(image|photo|picture|graphic|icon|screenshot) of /i;
  const LOOKS_LIKE_FILENAME = /\.(jpe?g|png|gif|svg|webp|bmp|avif)$/i;

  const imageData = images.map(img => {
    const altAttr = img.getAttribute('alt'); // null = missing, '' = empty
    const role    = img.getAttribute('role');
    const src     = img.src || img.getAttribute('src') || '';
    const srcShort = src.split('/').pop().split('?')[0].substring(0, 60);

    const isDecorativeByRole = role === 'presentation' || role === 'none';
    const isDecorativeByAlt  = altAttr === '';
    const isMissing          = altAttr === null;

    let category, status, note;

    if (isDecorativeByRole || isDecorativeByAlt) {
      category = 'decorative';
      status   = 'pass';
      note     = isDecorativeByRole
        ? `Marked decorative via role="${role}"`
        : 'Marked decorative via empty alt=""';
    } else if (isMissing) {
      category = 'missing';
      status   = 'fail';
      note     = 'No alt attribute — screen readers will announce the filename or URL';
    } else {
      category = 'meaningful';
      if (REDUNDANT.test(altAttr)) {
        status = 'review';
        note   = 'Alt text starts with a redundant phrase like "image of"';
      } else if (LOOKS_LIKE_FILENAME.test(altAttr)) {
        status = 'review';
        note   = 'Alt text looks like a filename';
      } else if (altAttr.length > 150) {
        status = 'review';
        note   = `Alt text is very long (${altAttr.length} chars) — consider a longer description pattern`;
      } else {
        status = 'pass';
        note   = '';
      }
    }

    return {
      src,
      srcShort,
      alt: altAttr,
      category,
      status,
      note,
      width:  img.naturalWidth,
      height: img.naturalHeight,
      context: img.parentElement ? img.parentElement.tagName.toLowerCase() : '',
      selector: generateSelector(img)
    };
  });

  return {
    images: imageData,
    summary: {
      total:       imageData.length,
      decorative:  imageData.filter(i => i.category === 'decorative').length,
      missing:     imageData.filter(i => i.category === 'missing').length,
      meaningful:  imageData.filter(i => i.category === 'meaningful').length,
      needsReview: imageData.filter(i => i.status === 'review').length,
      fail:        imageData.filter(i => i.status === 'fail').length
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSelector(element) {
  if (!element) return null;
  if (element.id) return `#${element.id}`;

  const path = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let selector = current.nodeName.toLowerCase();

    if (current.id) {
      path.unshift(`#${current.id}`);
      break;
    }

    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).slice(0, 2);
      if (classes[0]) selector += '.' + classes.join('.');
    }

    const siblings = Array.from(current.parentNode ? current.parentNode.children : []);
    const sameTag  = siblings.filter(s => s.nodeName === current.nodeName);
    if (sameTag.length > 1) selector += `:nth-of-type(${sameTag.indexOf(current) + 1})`;

    path.unshift(selector);
    current = current.parentNode;
    if (path.length > 5) break;
  }

  return path.join(' > ');
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

const LANDMARK_ROLES = {
  main:           { label: 'main',           color: '#0891b2' },
  navigation:     { label: 'nav',            color: '#059669' },
  banner:         { label: 'banner',         color: '#7c3aed' },
  contentinfo:    { label: 'contentinfo',    color: '#be185d' },
  complementary:  { label: 'aside',          color: '#d97706' },
  search:         { label: 'search',         color: '#0066cc' },
  form:           { label: 'form',           color: '#dc2626' },
  region:         { label: 'region',         color: '#4338ca' }
};

// Native element → implicit ARIA role
const IMPLICIT_ROLES = {
  MAIN:    'main',
  NAV:     'navigation',
  HEADER:  'banner',
  FOOTER:  'contentinfo',
  ASIDE:   'complementary',
  FORM:    'form'
};

function getLandmarks() {
  clearBadgeGroup('landmark');

  const found = [];

  // Elements with an explicit role attribute
  Object.keys(LANDMARK_ROLES).forEach(role => {
    document.querySelectorAll(`[role="${role}"]`).forEach(el => {
      const def = LANDMARK_ROLES[role];
      const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '';
      const displayLabel = ariaLabel ? `${def.label}: ${ariaLabel.substring(0, 20)}` : def.label;
      injectBadge(el, displayLabel, def.color, 'landmark');
      found.push({ role, label: displayLabel, selector: generateSelector(el), hasLabel: !!ariaLabel });
    });
  });

  // Native semantic elements (avoid double-counting if they also have explicit role)
  Object.entries(IMPLICIT_ROLES).forEach(([tag, role]) => {
    document.querySelectorAll(tag.toLowerCase()).forEach(el => {
      if (el.hasAttribute('role')) return; // already counted above
      const def = LANDMARK_ROLES[role];
      if (!def) return;
      const ariaLabel = el.getAttribute('aria-label') || '';
      const displayLabel = ariaLabel ? `${def.label}: ${ariaLabel.substring(0, 20)}` : def.label;
      injectBadge(el, displayLabel, def.color, 'landmark');
      found.push({ role, label: displayLabel, selector: generateSelector(el), hasLabel: !!ariaLabel });
    });
  });

  // <section> and <article> only count as landmarks when they have an accessible name
  ['section', 'article'].forEach(tag => {
    document.querySelectorAll(tag).forEach(el => {
      if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) return;
      const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '';
      injectBadge(el, `${tag}: ${label.substring(0, 20)}`, '#4338ca', 'landmark');
      found.push({ role: 'region', label: `${tag}: ${label}`, selector: generateSelector(el), hasLabel: true });
    });
  });

  const unlabelled = found.filter(f => !f.hasLabel && ['navigation', 'complementary', 'form', 'region'].includes(f.role));

  return {
    landmarks: found,
    summary: {
      total: found.length,
      unlabelledMultiple: unlabelled.length,
      byRole: Object.fromEntries(
        Object.keys(LANDMARK_ROLES).map(r => [r, found.filter(f => f.role === r).length])
      )
    }
  };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function getLists() {
  clearBadgeGroup('list');

  const COLORS = { UL: '#4338ca', OL: '#0891b2', DL: '#059669' };
  const found = [];

  ['ul', 'ol', 'dl'].forEach(tag => {
    document.querySelectorAll(tag).forEach(el => {
      const color = COLORS[tag.toUpperCase()];
      const itemCount = tag === 'dl'
        ? el.querySelectorAll('dt').length
        : el.querySelectorAll(':scope > li').length;
      const label = `${tag.toUpperCase()} (${itemCount})`;
      const hasRoleNone = el.getAttribute('role') === 'none' || el.getAttribute('role') === 'presentation';
      injectBadge(el, label, hasRoleNone ? '#999' : color, 'list');
      found.push({
        type: tag.toUpperCase(),
        itemCount,
        hasRoleNone,
        selector: generateSelector(el),
        note: hasRoleNone ? 'role="none" — semantic meaning removed' : ''
      });
    });
  });

  return {
    lists: found,
    summary: {
      total: found.length,
      ul: found.filter(l => l.type === 'UL').length,
      ol: found.filter(l => l.type === 'OL').length,
      dl: found.filter(l => l.type === 'DL').length,
      semanticsRemoved: found.filter(l => l.hasRoleNone).length
    }
  };
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function getIcons() {
  clearBadgeGroup('icon');

  const found = [];

  // Font icons (Font Awesome, Material Icons, etc.)
  const fontIconSelectors = [
    'i.fa', 'i.fas', 'i.far', 'i.fal', 'i.fab', 'i.fad',
    'i.material-icons', 'span.material-icons',
    '[class*="icon-"]', '[class*="-icon"]',
    'i[class*="glyphicon"]'
  ];
  document.querySelectorAll(fontIconSelectors.join(',')).forEach(el => {
    const ariaHidden = el.getAttribute('aria-hidden') === 'true';
    const ariaLabel  = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    const color = ariaHidden ? '#059669' : (!ariaLabel ? '#dc2626' : '#0891b2');
    const label = ariaHidden ? 'icon (hidden)' : ariaLabel ? `icon: ${ariaLabel.substring(0,15)}` : 'icon ⚠';
    injectBadge(el, label, color, 'icon');
    found.push({ type: 'font', ariaHidden, ariaLabel, status: ariaHidden ? 'decorative' : ariaLabel ? 'labelled' : 'unlabelled', selector: generateSelector(el) });
  });

  // SVG icons
  document.querySelectorAll('svg').forEach(el => {
    const ariaHidden = el.getAttribute('aria-hidden') === 'true';
    const ariaLabel  = el.getAttribute('aria-label') || el.querySelector('title')?.textContent || '';
    const role       = el.getAttribute('role');
    const color = ariaHidden ? '#059669' : (ariaLabel || role === 'img') ? '#0891b2' : '#d97706';
    const label = ariaHidden ? 'svg (hidden)' : ariaLabel ? `svg: ${ariaLabel.substring(0,15)}` : 'svg (review)';
    injectBadge(el, label, color, 'icon');
    found.push({ type: 'svg', ariaHidden, ariaLabel, status: ariaHidden ? 'decorative' : ariaLabel ? 'labelled' : 'review', selector: generateSelector(el) });
  });

  // Images used as icons (small images or src contains "icon")
  document.querySelectorAll('img[src*="icon"], img[src*="ico-"], img[width="16"], img[width="24"], img[width="32"]').forEach(el => {
    const alt = el.getAttribute('alt');
    const color = alt === '' ? '#059669' : alt ? '#0891b2' : '#dc2626';
    const label = alt === '' ? 'img icon (deco)' : alt ? `img: ${alt.substring(0,15)}` : 'img icon ⚠';
    injectBadge(el, label, color, 'icon');
    found.push({ type: 'img', ariaHidden: false, ariaLabel: alt || '', status: alt === '' ? 'decorative' : alt ? 'labelled' : 'unlabelled', selector: generateSelector(el) });
  });

  return {
    icons: found,
    summary: {
      total:       found.length,
      decorative:  found.filter(i => i.status === 'decorative').length,
      labelled:    found.filter(i => i.status === 'labelled').length,
      unlabelled:  found.filter(i => i.status === 'unlabelled').length,
      needsReview: found.filter(i => i.status === 'review').length
    }
  };
}

// ---------------------------------------------------------------------------
// Navs & Menus
// ---------------------------------------------------------------------------

function getNavs() {
  clearBadgeGroup('nav');

  const found = [];
  const seen  = new Set();

  function addNav(el, label, color, note) {
    if (seen.has(el)) return;
    seen.add(el);
    injectBadge(el, label, color, 'nav');
    found.push({ label, note, selector: generateSelector(el), hasLabel: !!el.getAttribute('aria-label') });
  }

  // <nav> elements
  document.querySelectorAll('nav').forEach(el => {
    const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '';
    const lower = ariaLabel.toLowerCase();
    const isPrimary   = lower.includes('primary') || lower.includes('main');
    const isSecondary = lower.includes('secondary') || lower.includes('footer') || lower.includes('breadcrumb');
    const color = isPrimary ? '#0d1b8e' : isSecondary ? '#4169e1' : '#0891b2';
    const prefix = isPrimary ? 'Primary Nav' : isSecondary ? 'Secondary Nav' : 'Nav';
    addNav(el, ariaLabel ? `${prefix}: ${ariaLabel.substring(0,18)}` : prefix, color, ariaLabel ? '' : 'No accessible name — add aria-label');
  });

  // role="navigation"
  document.querySelectorAll('[role="navigation"]').forEach(el => {
    const ariaLabel = el.getAttribute('aria-label') || '';
    addNav(el, ariaLabel ? `Nav: ${ariaLabel.substring(0,18)}` : 'Nav (role)', '#0891b2', '');
  });

  // role="menubar" and role="menu"
  document.querySelectorAll('[role="menubar"]').forEach(el => {
    const ariaLabel = el.getAttribute('aria-label') || '';
    addNav(el, ariaLabel ? `Menubar: ${ariaLabel.substring(0,15)}` : 'Menubar', '#7c3aed', '');
  });
  document.querySelectorAll('[role="menu"]').forEach(el => {
    const ariaLabel = el.getAttribute('aria-label') || '';
    addNav(el, ariaLabel ? `Menu: ${ariaLabel.substring(0,18)}` : 'Menu', '#be185d', '');
  });

  // Common nav patterns by aria-label
  document.querySelectorAll('[aria-label*="nav" i], [aria-label*="menu" i], [aria-label*="navigation" i]').forEach(el => {
    if (['NAV', 'UL', 'OL'].includes(el.tagName) || el.hasAttribute('role')) {
      const ariaLabel = el.getAttribute('aria-label') || '';
      addNav(el, `Nav: ${ariaLabel.substring(0,20)}`, '#059669', '');
    }
  });

  const unlabelled = found.filter(f => !f.hasLabel).length;
  const primary    = found.filter(f => f.label.startsWith('Primary')).length;
  const secondary  = found.filter(f => f.label.startsWith('Secondary')).length;

  return {
    navs: found,
    summary: { total: found.length, primary, secondary, unlabelled }
  };
}

// ---------------------------------------------------------------------------
// Color contrast checker
// ---------------------------------------------------------------------------

const contrastHighlights = [];

function parseRgb(rgbStr) {
  if (!rgbStr || rgbStr === 'transparent') return null;
  const m = rgbStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const a = rgbStr.match(/rgba\(.*?,\s*([\d.]+)\)/);
  if (a && parseFloat(a[1]) === 0) return null; // fully transparent
  return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
}

function relativeLuminance(r, g, b) {
  return [r, g, b].reduce((sum, c, i) => {
    c = c / 255;
    c = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return sum + c * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}

function getContrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1.r, c1.g, c1.b);
  const l2 = relativeLuminance(c2.r, c2.g, c2.b);
  const lighter = Math.max(l1, l2);
  const darker  = Math.min(l1, l2);
  return +((lighter + 0.05) / (darker + 0.05)).toFixed(2);
}

function getEffectiveBg(el) {
  let current = el;
  while (current && current !== document.documentElement) {
    const bg = window.getComputedStyle(current).backgroundColor;
    const parsed = parseRgb(bg);
    if (parsed) return parsed;
    current = current.parentElement;
  }
  return { r: 255, g: 255, b: 255 }; // default white
}

function isLargeTextEl(el) {
  const style  = window.getComputedStyle(el);
  const size   = parseFloat(style.fontSize);
  const weight = parseInt(style.fontWeight) || 400;
  const bold   = weight >= 700 || style.fontWeight === 'bold' || style.fontWeight === 'bolder';
  return size >= 24 || (bold && size >= 18.67);
}

function getContrastData() {
  clearContrast();

  const TEXT_SEL = 'p, h1, h2, h3, h4, h5, h6, a, button, label, span, li, td, th, caption, figcaption, dt, dd, blockquote';
  const seen     = new Set();
  const results  = [];

  Array.from(document.querySelectorAll(TEXT_SEL)).forEach(el => {
    if (!isVisible(el)) return;
    const text = el.textContent.trim();
    if (!text.length) return;

    const key = generateSelector(el);
    if (seen.has(key)) return;
    seen.add(key);

    const style = window.getComputedStyle(el);
    const fg    = parseRgb(style.color);
    const bg    = getEffectiveBg(el);
    if (!fg || !bg) return;

    const ratio   = getContrastRatio(fg, bg);
    const large   = isLargeTextEl(el);
    const passAA  = large ? ratio >= 3 : ratio >= 4.5;
    const passAAA = large ? ratio >= 4.5 : ratio >= 7;

    const toHex = c => `#${[c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('')}`;

    results.push({
      selector: key,
      tag:        el.tagName.toLowerCase(),
      text:       text.substring(0, 40),
      fg:         toHex(fg),
      bg:         toHex(bg),
      ratio,
      isLargeText: large,
      passAA,
      passAAA
    });

    if (!passAA) {
      el.dataset.a11yContrastOrig = el.style.outline;
      el.style.outline = '2px dashed #dc2626';
      el.style.outlineOffset = '1px';
      contrastHighlights.push(el);
    }
  });

  const failures = results.filter(r => !r.passAA);
  const passes   = results.filter(r =>  r.passAA);
  return { failures, passes, summary: { total: results.length, failures: failures.length, passes: passes.length } };
}

function clearContrast() {
  contrastHighlights.forEach(el => {
    el.style.outline = el.dataset.a11yContrastOrig || '';
    delete el.dataset.a11yContrastOrig;
  });
  contrastHighlights.length = 0;
}

// ---------------------------------------------------------------------------
// ARIA inspector
// ---------------------------------------------------------------------------

function getAriaUsage() {
  clearAriaHighlights();

  const ATTRS = ['aria-label','aria-labelledby','aria-describedby','aria-hidden',
    'aria-required','aria-expanded','aria-haspopup','aria-controls','aria-live',
    'aria-checked','aria-selected','aria-pressed','aria-disabled','aria-readonly',
    'aria-invalid','aria-errormessage','aria-modal','aria-current','aria-orientation',
    'aria-multiselectable','aria-autocomplete','aria-placeholder','aria-roledescription',
    'aria-valuenow','aria-valuemin','aria-valuemax','aria-valuetext',
    'aria-level','aria-posinset','aria-setsize','aria-owns','aria-activedescendant'];

  const selector = '[role],' + ATTRS.map(a => `[${a}]`).join(',');
  const results  = [];
  const FOCUSABLE_SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

  Array.from(new Set(document.querySelectorAll(selector))).forEach(el => {
    const role            = el.getAttribute('role') || '';
    const ariaLabel       = el.getAttribute('aria-label') || '';
    const ariaLabelledby  = el.getAttribute('aria-labelledby') || '';
    const ariaDescribedby = el.getAttribute('aria-describedby') || '';
    const ariaHidden      = el.getAttribute('aria-hidden') || '';

    // Resolve aria-labelledby IDs
    let resolvedLabel = ariaLabel;
    if (ariaLabelledby && !resolvedLabel) {
      resolvedLabel = ariaLabelledby.split(/\s+/)
        .map(id => {
          const target = document.getElementById(id);
          return target ? target.textContent.trim() : `[broken: #${id}]`;
        })
        .join(' ');
    }

    let labelSource = 'None';
    if (ariaLabel)       labelSource = 'aria-label';
    else if (ariaLabelledby) labelSource = 'aria-labelledby';

    const issues = [];

    if (ariaLabelledby) {
      ariaLabelledby.split(/\s+/).forEach(id => {
        if (id && !document.getElementById(id))
          issues.push(`Broken reference: #${id} not found in DOM`);
      });
    }

    if (ariaDescribedby) {
      ariaDescribedby.split(/\s+/).forEach(id => {
        if (id && !document.getElementById(id))
          issues.push(`Broken aria-describedby: #${id} not found in DOM`);
      });
    }

    if (ariaHidden === 'true' && el.matches(FOCUSABLE_SEL))
      issues.push('Hidden but focusable: aria-hidden="true" on interactive element');

    if ((role === 'none' || role === 'presentation') && el.matches(FOCUSABLE_SEL))
      issues.push(`Conflicting role: role="${role}" on interactive element`);

    const color = issues.length > 0 ? '#dc2626'
                : ariaHidden === 'true' ? '#6b7280'
                : '#0891b2';
    const badgeLabel = role || (ariaHidden === 'true' ? 'hidden' : ariaLabel ? `lbl: ${ariaLabel.substring(0,10)}` : 'aria');

    if (isVisible(el)) injectBadge(el, badgeLabel, color, 'aria');

    results.push({
      selector:      generateSelector(el),
      tag:           el.tagName.toLowerCase(),
      role,
      ariaLabel,
      ariaLabelledby,
      resolvedLabel: resolvedLabel.substring(0, 60),
      ariaDescribedby,
      ariaHidden,
      labelSource,
      issues
    });
  });

  return {
    elements: results,
    summary: {
      total:      results.length,
      withIssues: results.filter(r => r.issues.length > 0).length,
      hidden:     results.filter(r => r.ariaHidden === 'true').length,
      withRole:   results.filter(r => r.role).length,
      withLabel:  results.filter(r => r.resolvedLabel).length
    }
  };
}

function clearAriaHighlights() {
  clearBadgeGroup('aria');
}

// ---------------------------------------------------------------------------
// Live region audit (WCAG 4.1.3 — Status Messages)
//
// A static DOM snapshot — which is all axe-core, and the ARIA Inspector tool
// above, ever see — cannot tell the difference between a live region that
// announces updates correctly and one that never fires at all. The classic
// invisible bug: inserting a fully populated aria-live region in a single
// paint announces nothing, because nothing "changed" after it existed for
// the screen reader to notice. Watching the DOM with a MutationObserver, the
// way an actual screen reader effectively does, is the only way to catch it.
// ---------------------------------------------------------------------------

const LIVE_REGION_SELECTOR = '[aria-live], [role="status"], [role="alert"], [role="log"]';

let liveRegionObserver = null;
let liveRegionLog = [];

function snapshotLiveRegions() {
  return Array.from(document.querySelectorAll(LIVE_REGION_SELECTOR)).map(el => {
    const liveAttr = el.getAttribute('aria-live');
    const role = el.getAttribute('role');
    const politeness = liveAttr || (role === 'alert' ? 'assertive' : (role === 'status' || role === 'log' ? 'polite' : null));
    const hasContentAlready = el.textContent.trim().length > 0;
    return {
      selector: generateSelector(el),
      role: role || '(aria-live attribute only)',
      politeness,
      hasContentAlready,
      note: hasContentAlready
        ? 'Already contains text at scan time. If this text was present when the region was created, rather than injected into an already-empty region afterward, screen readers will not announce it.'
        : ''
    };
  });
}

function startLiveRegionWatch() {
  stopLiveRegionWatch();
  liveRegionLog = [];

  liveRegionObserver = new MutationObserver(mutations => {
    mutations.forEach(m => {
      const raw = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
      if (!raw) return;
      const region = raw.closest(LIVE_REGION_SELECTOR);
      if (!region) return;
      liveRegionLog.push({
        time: new Date().toISOString(),
        selector: generateSelector(region),
        newText: region.textContent.trim().substring(0, 150)
      });
    });
  });

  liveRegionObserver.observe(document.body, { childList: true, characterData: true, subtree: true });

  return {
    watching: true,
    regionCount: document.querySelectorAll(LIVE_REGION_SELECTOR).length,
    staticFindings: snapshotLiveRegions()
  };
}

function stopLiveRegionWatch() {
  if (liveRegionObserver) {
    liveRegionObserver.disconnect();
    liveRegionObserver = null;
  }
}

function getLiveRegionLog() {
  return {
    watching: !!liveRegionObserver,
    log: liveRegionLog,
    staticFindings: snapshotLiveRegions()
  };
}

// ---------------------------------------------------------------------------
// Focus indicator check (WCAG 2.4.7 / 2.4.11)
//
// No screen reader test — JAWS, NVDA, any of them — can ever verify this.
// They announce "button, focused" whether or not a focus ring is visible;
// there is no "indicator visible" property anywhere in the accessibility
// tree for them to read. This has to be checked visually instead, so this
// walks every focusable element, focuses it, and compares computed style
// before/after to flag anything with no detectable visual change at all.
//
// This briefly moves real focus around the live page — expect visible
// flicker while it runs, and re-run if a menu or similar control expands
// on focus and throws off later elements in the same pass.
// ---------------------------------------------------------------------------

function styleSnapshot(el) {
  const s = window.getComputedStyle(el);
  return {
    outlineStyle: s.outlineStyle,
    outlineWidth: s.outlineWidth,
    outlineColor: s.outlineColor,
    boxShadow: s.boxShadow,
    borderColor: s.borderColor,
    borderWidth: s.borderWidth,
    backgroundColor: s.backgroundColor
  };
}

function getFocusIndicators() {
  clearBadgeGroup('focus');

  const previouslyFocused = document.activeElement;
  const candidates = Array.from(document.querySelectorAll(FOCUSABLE)).filter(el => {
    const ti = parseInt(el.getAttribute('tabindex'), 10);
    return (isNaN(ti) || ti >= 0) && isVisible(el);
  });

  const found = candidates.map(el => {
    let before, after;
    try {
      before = styleSnapshot(el);
      el.focus({ preventScroll: true });
      after = styleSnapshot(el);
      el.blur();
    } catch (e) {
      return null;
    }

    const changed = JSON.stringify(before) !== JSON.stringify(after);
    const outlineSuppressed = after.outlineStyle === 'none' || parseFloat(after.outlineWidth) === 0;

    return {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('value') || '').trim().substring(0, 40),
      selector: generateSelector(el),
      hasIndicator: changed,
      note: changed
        ? ''
        : outlineSuppressed
          ? 'outline suppressed (outline: none) with no alternative focus style detected'
          : 'No visible style change detected on focus'
    };
  }).filter(Boolean);

  try { previouslyFocused && previouslyFocused.focus && previouslyFocused.focus({ preventScroll: true }); } catch (e) { /* ignore */ }

  const missing = found.filter(f => !f.hasIndicator);
  missing.forEach(f => {
    try {
      const el = document.querySelector(f.selector);
      if (el) injectBadge(el, 'no focus style ⚠', '#dc2626', 'focus');
    } catch (e) { /* bad selector — skip */ }
  });

  return {
    elements: found,
    summary: { total: found.length, missing: missing.length }
  };
}

// ---------------------------------------------------------------------------
// Injected page styles
// ---------------------------------------------------------------------------

const style = document.createElement('style');
style.textContent = `
  .a11y-tester-tooltip {
    animation: a11y-fade-in 0.2s ease-out;
  }
  .a11y-overlay-chip {
    background: rgba(255,255,255,0.25);
    border: 1px solid rgba(255,255,255,0.5);
    border-radius: 3px;
    padding: 0 4px;
    font-size: 10px;
    font-weight: 700;
    margin-right: 4px;
    vertical-align: middle;
  }
  @keyframes a11y-fade-in {
    from { opacity: 0; transform: translateY(5px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .a11y-tab-badge {
    position: absolute;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: white;
    font-size: 10px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999998;
    pointer-events: none;
    box-shadow: 0 1px 4px rgba(0,0,0,0.35);
    border: 2px solid rgba(255,255,255,0.7);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  }
  .a11y-heading-badge {
    position: absolute;
    padding: 1px 5px;
    border-radius: 3px;
    color: white;
    font-size: 10px;
    font-weight: 700;
    z-index: 999998;
    pointer-events: none;
    box-shadow: 0 1px 4px rgba(0,0,0,0.3);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  }
  .a11y-generic-badge {
    position: absolute;
    padding: 1px 6px;
    border-radius: 3px;
    color: white;
    font-size: 10px;
    font-weight: 700;
    z-index: 999997;
    pointer-events: none;
    box-shadow: 0 1px 4px rgba(0,0,0,0.3);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    white-space: nowrap;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`;
document.head.appendChild(style);

