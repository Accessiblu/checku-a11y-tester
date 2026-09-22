/**
 * Popup Script for WCAG 2.2 Accessibility Tester
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentResults = null;
let manualReviews  = {};
let activeReviewIndex = null;

let tabOrderActive  = false;
let headingsActive  = false;
let imageAltActive  = false;

// Generic tool toggle state: key = tool name, value = boolean
const activeTools = { landmarks: false, lists: false, icons: false, navs: false, focus: false };

let liveRegionActive = false;

// Inline verdicts recorded directly in the VPAT matrix
// Shape: { "1.1.1": { conformance: "Supports", remark: "..." }, ... }
let vpatVerdicts = {};

// ---------------------------------------------------------------------------
// Pulse integration state
// ---------------------------------------------------------------------------

// { token, baseUrl } — persisted to chrome.storage.local, not per-tab.
let pulseConfig = { token: null, baseUrl: 'http://localhost:3000' };

// Cached result of the last GET /api/extension/context lookup for the
// current tab's URL, so sendVerdictsToPulse() doesn't need to re-fetch it.
let pulseContext = null;

// Extension's VPAT conformance labels use human-readable strings; Pulse's
// CriterionAssessment.vpatConformanceLevel is a fixed enum — map between them.
const PULSE_CONFORMANCE_MAP = {
  'Supports':           'SUPPORTS',
  'Partially Supports': 'PARTIALLY_SUPPORTS',
  'Does Not Support':   'DOES_NOT_SUPPORT',
  'Not Applicable':     'NOT_APPLICABLE',
};

// Guard so renderVpatMatrix() doesn't stack up duplicate event listeners
let _vpatListenerAttached = false;

// Product metadata used to populate the ACR cover page
let vpatProductInfo = {
  productName:  '',
  version:      '',
  organization: '',
  contact:      '',
  notes:        '',
};

// ---------------------------------------------------------------------------
// Expand / resize support
// ---------------------------------------------------------------------------

// Tab ID locked at pop-out time — prevents querying the wrong window
let _resolvedTabId = null;

/**
 * Returns the tab to test against.
 * Side panel  → queries active tab in the current (browser) window.
 * Pop-out     → uses the ID captured when the window was created, passed
 *               via ?tabId= so we never accidentally query the extension window.
 */
async function getActiveTab() {
  if (_resolvedTabId) {
    try { return await chrome.tabs.get(_resolvedTabId); } catch { _resolvedTabId = null; }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function initExpandMode() {
  const params        = new URLSearchParams(window.location.search);
  const isPopOut      = params.has('expanded');
  const tabIdStr      = params.get('tabId');
  const fromShortcut  = params.has('fromShortcut');

  if (isPopOut && tabIdStr) {
    _resolvedTabId = parseInt(tabIdStr, 10);
    document.body.classList.add('expanded');
    const btn = document.getElementById('expandBtn');
    if (btn) btn.style.display = 'none';
  }

  // When opened via Ctrl+Shift+A, Chrome already focused this window.
  // Move keyboard focus to the first interactive control so AT users land
  // directly on "Run Accessibility Test" without tabbing from the browser chrome.
  if (fromShortcut) {
    setTimeout(() => {
      const runBtn = document.getElementById('runTestBtn');
      if (runBtn) runBtn.focus();
    }, 150);
  }

  // When opened as the side panel (not pop-out), announce the keyboard shortcut
  // once so AT users know a more accessible entry point exists.
  if (!isPopOut) {
    chrome.storage.local.get(['atHintShown'], data => {
      if (!data.atHintShown) {
        chrome.storage.local.set({ atHintShown: true });
        setTimeout(() => {
          const hint = document.getElementById('atShortcutHint');
          if (hint) {
            hint.textContent =
              'Tip for screen reader users: press Ctrl+Shift+A to open this tool '
              + 'in a focused window where your screen reader can navigate directly. '
              + 'You can also press F6 to move focus here from the web page.';
          }
        }, 800);
      }
    });
  }

  window.addEventListener('resize', () => {
    const btn = document.getElementById('expandBtn');
    if (btn && !isPopOut) btn.style.display = window.innerWidth > 700 ? 'none' : '';
  });
}

async function openExpanded() {
  const tab  = await getActiveTab();
  const url  = chrome.runtime.getURL('popup.html') + `?expanded=1&tabId=${tab?.id ?? ''}`;
  chrome.windows.create({ url, type: 'popup', width: 960, height: 740, focused: true });
}

// ---------------------------------------------------------------------------
// Accessibility helpers
// ---------------------------------------------------------------------------

/**
 * Announce a message to screen readers via the aria-live region.
 * Clears first so repeated identical messages still fire.
 */
function announce(message) {
  const el = document.getElementById('a11yAnnouncer');
  if (!el) return;
  el.textContent = '';
  // Small delay ensures the DOM change is detected as a new announcement
  setTimeout(() => { el.textContent = message; }, 60);
}

/**
 * Move focus to an element (used for section transitions).
 * Adds tabindex="-1" if needed so non-interactive headings are focusable.
 */
function moveFocusTo(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!el.getAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: false });
}

/**
 * Set aria-pressed on a tool toggle button.
 */
function setPressed(btnId, isPressed) {
  document.getElementById(btnId)?.setAttribute('aria-pressed', isPressed ? 'true' : 'false');
}

/**
 * Arrow-key navigation for the ARIA tablist.
 * Left/Right/Home/End keys move focus between tabs.
 */
function initTabKeyboard() {
  const tablist = document.querySelector('[role="tablist"]');
  if (!tablist) return;
  tablist.addEventListener('keydown', e => {
    const tabs  = Array.from(tablist.querySelectorAll('[role="tab"]'));
    const idx   = tabs.indexOf(document.activeElement);
    if (idx === -1) return;

    let newIdx = idx;
    if      (e.key === 'ArrowRight') { e.preventDefault(); newIdx = (idx + 1) % tabs.length; }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); newIdx = (idx - 1 + tabs.length) % tabs.length; }
    else if (e.key === 'Home')       { e.preventDefault(); newIdx = 0; }
    else if (e.key === 'End')        { e.preventDefault(); newIdx = tabs.length - 1; }
    else return;

    tabs[newIdx].focus();
    switchTab(tabs[newIdx].dataset.tab);
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  const tab = await getActiveTab();
  if (tab) document.getElementById('currentUrl').textContent = tab.url;
  // Load persisted product info then render the product form
  chrome.storage.local.get(['vpatProductInfo'], data => {
    if (data.vpatProductInfo) Object.assign(vpatProductInfo, data.vpatProductInfo);
    renderVpatProductForm();
  });
  await loadPulseConfig();
  renderPulseConnectionUI();
  setupEventListeners();
  initExpandMode();
  initTabKeyboard();
});

function setupEventListeners() {
  document.getElementById('runTestBtn').addEventListener('click', runTest);

  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', e => switchTab(e.target.closest('.tab-btn').dataset.tab))
  );

  document.getElementById('exportJsonBtn').addEventListener('click', exportJSON);
  document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
  document.getElementById('highlightBtn').addEventListener('click', toggleHighlights);
  document.getElementById('newTestBtn').addEventListener('click', resetToConfig);

  // Review section
  document.getElementById('backToResultsBtn').addEventListener('click', () => {
    activeReviewIndex = null;
    showSection('resultsSection');
    switchTab('incomplete');
  });
  document.getElementById('reviewPass').addEventListener('click', () => saveReview('pass'));
  document.getElementById('reviewFail').addEventListener('click', () => saveReview('fail'));
  document.getElementById('reviewNa').addEventListener('click', () => saveReview('na'));

  // Tools tab
  document.getElementById('tabOrderBtn').addEventListener('click', toggleTabOrder);
  document.getElementById('headingsBtn').addEventListener('click', toggleHeadings);
  document.getElementById('imageAltBtn').addEventListener('click', toggleImageAlt);
  document.getElementById('landmarksBtn').addEventListener('click', toggleTool.bind(null, 'landmarks'));
  document.getElementById('listsBtn').addEventListener('click', toggleTool.bind(null, 'lists'));
  document.getElementById('iconsBtn').addEventListener('click', toggleTool.bind(null, 'icons'));
  document.getElementById('navsBtn').addEventListener('click', toggleTool.bind(null, 'navs'));
  document.getElementById('contrastBtn').addEventListener('click', toggleContrast);
  document.getElementById('ariaBtn').addEventListener('click', toggleAriaInspector);
  document.getElementById('focusBtn').addEventListener('click', toggleTool.bind(null, 'focus'));
  document.getElementById('liveRegionBtn').addEventListener('click', toggleLiveRegions);
  document.getElementById('exportReportBtn').addEventListener('click', exportHTMLReport);
  document.getElementById('exportVpatBtn').addEventListener('click', exportVpatCSV);
  document.getElementById('exportAcrBtn').addEventListener('click', exportAcrHtml);

  // Product info form — auto-save to storage on input (debounced)
  let _vpatSaveTimer = null;
  document.getElementById('vpatProductForm')?.addEventListener('input', e => {
    const field = e.target.closest('[data-vpat-field]');
    if (!field) return;
    vpatProductInfo[field.dataset.vpatField] = field.value;
    clearTimeout(_vpatSaveTimer);
    _vpatSaveTimer = setTimeout(() => chrome.storage.local.set({ vpatProductInfo }), 600);
  });

  // Expand button
  document.getElementById('expandBtn')?.addEventListener('click', openExpanded);

  // Pulse tab
  document.getElementById('pulseConnectBtn').addEventListener('click', connectToPulse);
  document.getElementById('pulseDisconnectBtn').addEventListener('click', disconnectFromPulse);
  document.getElementById('pulseSendBtn').addEventListener('click', sendVerdictsToPulse);

  // Delegated handler for dynamically-injected buttons
  document.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'backToResults') showSection('resultsSection');
  });
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runTest() {
  const level = document.getElementById('levelSelect').value;
  const scope = document.querySelector('input[name="scope"]:checked').value;

  manualReviews = {};
  resetToolState();
  showSection('progressSection');
  updateProgress(0, 'Starting test...');

  try {
    const tab = await getActiveTab();
    if (!tab) throw new Error('No active tab found');

    updateProgress(20, 'Running tests...');

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { action: 'runTest', level, scope });
    } catch (e) {
      if (e.message.includes('Receiving end does not exist')) {
        updateProgress(30, 'Injecting scripts...');
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['axe.min.js', 'content.js'] });
        await new Promise(r => setTimeout(r, 500));
        response = await chrome.tabs.sendMessage(tab.id, { action: 'runTest', level, scope });
      } else throw e;
    }

    if (!response.success) throw new Error(response.error || 'Test failed');

    updateProgress(100, 'Complete!');
    currentResults = response.results;
    await new Promise(r => setTimeout(r, 300));
    displayResults();

  } catch (error) {
    alert(`Error: ${error.message}\n\nTry refreshing the page and running the test again.`);
    resetToConfig();
  }
}

// ---------------------------------------------------------------------------
// Results display
// ---------------------------------------------------------------------------

function displayResults() {
  showSection('resultsSection');

  const { violations, passes, incomplete, inapplicable } = currentResults.summary;

  document.getElementById('summary').innerHTML = `
    <div class="summary-item violations">
      <span class="summary-count">${violations}</span>
      <span class="summary-label">Violations</span>
    </div>
    <div class="summary-item passes">
      <span class="summary-count">${passes}</span>
      <span class="summary-label">Passes</span>
    </div>
    <div class="summary-item incomplete">
      <span class="summary-count">${incomplete}</span>
      <span class="summary-label">Needs Review</span>
    </div>
    <div class="summary-item inapplicable">
      <span class="summary-count">${inapplicable}</span>
      <span class="summary-label">N/A</span>
    </div>
  `;

  document.getElementById('violationCount').textContent = violations;
  document.getElementById('passCount').textContent = passes;
  document.getElementById('incompleteCount').textContent = incomplete;

  // Summary meta row — pass rate + total checks
  const total    = violations + passes + incomplete;
  const passRate = total > 0 ? Math.round((passes / (passes + violations)) * 100) : 100;
  const riskLevel = violations === 0 ? 'Low Risk'
    : currentResults.violations.some(v => v.impact === 'critical' || v.isOverlay) ? 'High Risk'
    : violations > 5 ? 'Medium Risk' : 'Low-Medium Risk';
  const riskColor = riskLevel === 'High Risk'   ? '#dc2626'
    : riskLevel === 'Medium Risk'               ? '#d97706'
    : riskLevel === 'Low-Medium Risk'            ? '#ca8a04'
    : '#16a34a';

  const metaEl = document.getElementById('summaryMeta');
  metaEl.classList.remove('hidden');
  metaEl.innerHTML = `
    <div class="summary-meta-stats">
      <span class="meta-stat">
        <strong>${total}</strong> total checks
      </span>
      <span class="meta-divider">·</span>
      <span class="meta-stat">
        Pass rate <strong>${passRate}%</strong>
      </span>
      <span class="meta-divider">·</span>
      <span class="meta-risk" style="color:${riskColor};font-weight:700">${riskLevel}</span>
    </div>
  `;

  populateList('violationsList', currentResults.violations, 'violation');
  populateList('passesList', currentResults.passes, 'pass');
  populateIncompleteList();

  announce(
    `Test complete. ${violations} violation${violations !== 1 ? 's' : ''}, ` +
    `${passes} pass${passes !== 1 ? 'es' : ''}, ` +
    `${incomplete} item${incomplete !== 1 ? 's' : ''} need review.`
  );
}

function populateList(listId, items, type) {
  const list = document.getElementById(listId);
  if (items.length === 0) {
    list.innerHTML = `<p class="hint">No ${type === 'pass' ? 'passing' : type} items found.</p>`;
    return;
  }

  list.innerHTML = items.map(item => {
    const impactClass = type === 'pass' ? 'pass' : (item.impact || 'moderate');
    const wcagTags = (item.wcagTags || []).map(t => `<span class="wcag-tag">${t}</span>`).join('');

    const overlayBanner = item.isOverlay
      ? `<div class="overlay-banner">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
             <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
           </svg>
           OVERLAY DETECTED — ${escapeHtml(item.overlayName)}
         </div>`
      : '';

    return `
      <div class="result-item ${item.isOverlay ? 'critical' : impactClass}">
        ${overlayBanner}
        <div class="result-header">
          <span class="result-title">${escapeHtml(item.help || item.description)}</span>
          ${item.impact ? `<span class="impact-badge ${item.impact}">${item.impact}</span>` : ''}
        </div>
        <p class="result-description">${escapeHtml(item.description)}</p>
        <span class="result-count">${item.nodes.length} element${item.nodes.length !== 1 ? 's' : ''}</span>
        ${wcagTags ? `<div class="result-wcag">${wcagTags}</div>` : ''}
        ${item.helpUrl ? `<a class="help-link" href="${escapeHtml(item.helpUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Learn more about: ${escapeHtml(item.help || item.description)}">Learn more ↗</a>` : ''}
      </div>
    `;
  }).join('');
}

function populateIncompleteList() {
  const list  = document.getElementById('incompleteList');
  const items = currentResults.incomplete;

  if (items.length === 0) {
    list.innerHTML = `<p class="hint">No items need manual review.</p>`;
    return;
  }

  list.innerHTML = items.map((item, index) => {
    const review = manualReviews[index];
    const verdictHtml = review
      ? `<span class="verdict verdict-${review.verdict}">${verdictLabel(review.verdict)}</span>
         ${review.notes ? `<span class="review-note">${review.notes}</span>` : ''}`
      : `<button class="review-btn" data-index="${index}">Review</button>`;
    const wcagTags = (item.wcagTags || []).map(t => `<span class="wcag-tag">${t}</span>`).join('');

    return `
      <div class="result-item moderate ${review ? 'reviewed' : ''}">
        <div class="result-header">
          <span class="result-title">${escapeHtml(item.help || item.description)}</span>
          <span class="impact-badge moderate">manual</span>
        </div>
        <p class="result-description">${escapeHtml(item.description)}</p>
        <span class="result-count">${item.nodes.length} element${item.nodes.length !== 1 ? 's' : ''}</span>
        ${wcagTags ? `<div class="result-wcag">${wcagTags}</div>` : ''}
        <div class="review-status">${verdictHtml}</div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.review-btn').forEach(btn =>
    btn.addEventListener('click', () => openReview(parseInt(btn.dataset.index)))
  );
}

function verdictLabel(v) {
  return v === 'pass' ? 'Pass' : v === 'fail' ? 'Fail' : 'N/A';
}

// ---------------------------------------------------------------------------
// Manual review flow
// ---------------------------------------------------------------------------

function openReview(index) {
  activeReviewIndex = index;
  const item  = currentResults.incomplete[index];
  const total = currentResults.incomplete.length;

  document.getElementById('reviewProgress').textContent =
    `${Object.keys(manualReviews).length} of ${total} reviewed`;

  const nodeSnippets = item.nodes.slice(0, 3)
    .map(n => `<code class="node-snippet">${escapeHtml(n.html)}</code>`).join('');
  const moreNodes = item.nodes.length > 3
    ? `<p class="hint">…and ${item.nodes.length - 3} more.</p>` : '';

  const reasons = item.nodes[0]
    ? [...(item.nodes[0].any || []), ...(item.nodes[0].all || []), ...(item.nodes[0].none || [])]
        .map(r => `<li>${r.message || r.id}</li>`).join('') : '';

  document.getElementById('reviewPrompt').innerHTML = `
    <h3>${escapeHtml(item.help || item.id)}</h3>
    <p class="review-description">${escapeHtml(item.description)}</p>
    ${item.helpUrl ? `<a class="help-link" href="${escapeHtml(item.helpUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Learn more about: ${escapeHtml(item.help || item.id)}">Learn more ↗</a>` : ''}
    <div class="review-block">
      <strong>What to check:</strong>
      ${reasons ? `<ul class="reason-list">${reasons}</ul>` : '<p class="hint">Inspect the elements below and verify they meet the criteria.</p>'}
    </div>
    ${nodeSnippets ? `<div class="review-block"><strong>Affected elements:</strong><div class="node-list">${nodeSnippets}</div>${moreNodes}</div>` : ''}
  `;

  const existing = manualReviews[index];
  document.getElementById('reviewNotes').value = existing ? existing.notes : '';

  // Give verdict buttons descriptive labels so screen readers know what's being judged
  const criterionName = escapeHtml(item.help || item.id);
  document.getElementById('reviewPass').setAttribute('aria-label', `Mark "${criterionName}" as Pass`);
  document.getElementById('reviewFail').setAttribute('aria-label', `Mark "${criterionName}" as Fail`);
  document.getElementById('reviewNa').setAttribute('aria-label', `Mark "${criterionName}" as Not Applicable`);

  showSection('reviewSection');
  announce(`Reviewing: ${item.help || item.id}. Item ${index + 1} of ${total}.`);
}

function saveReview(verdict) {
  if (activeReviewIndex === null) return;
  manualReviews[activeReviewIndex] = {
    verdict,
    notes: document.getElementById('reviewNotes').value.trim()
  };

  const total = currentResults.incomplete.length;
  let next = null;
  for (let i = activeReviewIndex + 1; i < total; i++) {
    if (!manualReviews[i]) { next = i; break; }
  }

  const verdictText = verdict === 'pass' ? 'Pass' : verdict === 'fail' ? 'Fail' : 'Not Applicable';
  announce(`${verdictText} recorded.`);

  if (next !== null) {
    openReview(next);
  } else {
    activeReviewIndex = null;
    announce('All items reviewed. Returning to results.');
    showSection('resultsSection');
    switchTab('incomplete');
    populateIncompleteList();
  }
}

// ---------------------------------------------------------------------------
// Tools — Tab Order
// ---------------------------------------------------------------------------

async function toggleTabOrder() {
  const btn = document.getElementById('tabOrderBtn');
  const panel = document.getElementById('tabOrderPanel');
  const status = document.getElementById('tabOrderStatus');
  const tab = await getActiveTab();

  if (tabOrderActive) {
    await chrome.tabs.sendMessage(tab.id, { action: 'clearTabOrder' });
    tabOrderActive = false;
    btn.textContent = 'Show Tab Order';
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    panel.classList.add('hidden');
    panel.innerHTML = '';
    status.textContent = '';
    status.className = 'tool-status';
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { action: 'showTabOrder' });
  if (!response.success) return;

  tabOrderActive = true;
  btn.textContent = 'Hide Tab Order';
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');

  const { total, positiveTabindex, elements } = response.result;

  if (positiveTabindex > 0) {
    status.textContent = `${total} elements · ${positiveTabindex} with explicit tabindex`;
    status.className = 'tool-status has-issues';
  } else {
    status.textContent = `${total} focusable elements`;
    status.className = 'tool-status all-clear';
  }

  let html = `<div class="tab-order-summary">
    ${total} focusable elements${positiveTabindex > 0
      ? ` · <span style="color:#d97706;font-weight:600">${positiveTabindex} explicit tabindex ⚠</span>`
      : ''}
  </div>`;

  html += elements.map(el => `
    <div class="tab-order-row">
      <span class="tab-num ${el.isPositiveTabindex ? 'explicit' : 'natural'}">${el.position}</span>
      <span class="tab-elem-info">
        <span class="tab-elem-tag">${el.tag.toLowerCase()}</span>
        ${el.text ? ` — ${el.text}` : ''}
        ${el.isPositiveTabindex ? `<span class="explicit-warning"> tabindex="${el.tabindex}"</span>` : ''}
      </span>
    </div>
  `).join('');

  panel.innerHTML = html;
  panel.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Tools — Heading Structure
// ---------------------------------------------------------------------------

const HEADING_CHIP_COLORS = {
  1: '#dc2626', 2: '#ea580c', 3: '#d97706',
  4: '#16a34a', 5: '#0284c7', 6: '#7c3aed'
};

async function toggleHeadings() {
  const btn = document.getElementById('headingsBtn');
  const panel = document.getElementById('headingsPanel');
  const status = document.getElementById('headingsStatus');
  const tab = await getActiveTab();

  if (headingsActive) {
    await chrome.tabs.sendMessage(tab.id, { action: 'clearHeadings' });
    headingsActive = false;
    btn.textContent = 'Show Heading Structure';
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    panel.classList.add('hidden');
    panel.innerHTML = '';
    status.textContent = '';
    status.className = 'tool-status';
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { action: 'getHeadings' });
  if (!response.success) return;

  headingsActive = true;
  btn.textContent = 'Hide Heading Structure';
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');

  const { headings, summary } = response.result;

  const issues = summary.skips + (summary.multipleH1 ? 1 : 0);
  if (issues > 0) {
    status.textContent = `${summary.total} headings · ${issues} issue${issues !== 1 ? 's' : ''}`;
    status.className = 'tool-status has-issues';
  } else {
    status.textContent = `${summary.total} headings`;
    status.className = 'tool-status all-clear';
  }

  let html = `<div class="heading-summary">`;
  html += `${summary.total} heading${summary.total !== 1 ? 's' : ''}`;
  if (summary.h1Count !== 1) html += ` · <span style="color:#dc2626;font-weight:600">${summary.h1Count} H1 elements</span>`;
  if (summary.skips > 0)     html += ` · <span style="color:#d97706;font-weight:600">${summary.skips} level skip${summary.skips !== 1 ? 's' : ''}</span>`;
  html += `</div>`;

  headings.forEach(h => {
    if (h.skipWarning) {
      html += `<div class="heading-skip-warning">⚠ Heading level skips from H${h.skipFrom} to H${h.skipTo}</div>`;
    }
    const indent = (h.level - 1) * 10;
    const color  = HEADING_CHIP_COLORS[h.level] || '#666';
    html += `
      <div class="heading-row" style="padding-left:${indent}px">
        <span class="heading-level-chip" style="background:${color}">H${h.level}</span>
        <span class="heading-text" title="${escapeHtml(h.text)}">${escapeHtml(h.text) || '<em style="color:#999">empty</em>'}</span>
      </div>
    `;
  });

  if (headings.length === 0) html += `<p class="hint">No headings found on this page.</p>`;

  panel.innerHTML = html;
  panel.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Tools — Image Alt Inspector
// ---------------------------------------------------------------------------

async function toggleImageAlt() {
  const btn = document.getElementById('imageAltBtn');
  const panel = document.getElementById('imageAltPanel');
  const status = document.getElementById('imageAltStatus');
  const tab = await getActiveTab();

  if (imageAltActive) {
    imageAltActive = false;
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = 'Inspect Images';
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    panel.classList.add('hidden');
    panel.innerHTML = '';
    status.textContent = '';
    status.className = 'tool-status';
    if (currentResults) currentResults.imageAlt = null;
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { action: 'getImageAlt' });
  if (!response.success) return;

  imageAltActive = true;
  btn.setAttribute('aria-pressed', 'true');
  btn.textContent = 'Clear Images';
  btn.classList.add('active');

  const { images, summary } = response.result;
  if (currentResults) currentResults.imageAlt = response.result;

  if (summary.fail > 0 || summary.needsReview > 0) {
    status.textContent = `${summary.total} images · ${summary.fail} missing · ${summary.needsReview} review`;
    status.className = 'tool-status has-issues';
  } else {
    status.textContent = `${summary.total} images · all have alt`;
    status.className = 'tool-status all-clear';
  }

  let html = `<div class="image-alt-summary">
    ${summary.total} images:
    <span style="color:#dc2626;font-weight:600">${summary.missing} missing</span> ·
    <span style="color:#16a34a">${summary.decorative} decorative</span> ·
    <span style="color:#333">${summary.meaningful} with alt</span>
    ${summary.needsReview > 0 ? `· <span style="color:#d97706;font-weight:600">${summary.needsReview} needs review</span>` : ''}
  </div>`;

  html += images.map(img => {
    let altDisplay, altClass;
    if (img.category === 'missing') {
      altDisplay = 'Missing alt attribute';
      altClass = 'missing';
    } else if (img.category === 'decorative') {
      altDisplay = img.alt === '' ? 'alt="" (decorative)' : `role="${img.context}" (decorative)`;
      altClass = 'decorative';
    } else {
      altDisplay = `"${escapeHtml(img.alt)}"`;
      altClass = '';
    }

    return `
      <div class="image-row">
        <span class="image-status-dot ${img.status}"></span>
        <div class="image-info">
          <div class="image-src" title="${escapeHtml(img.src)}">${escapeHtml(img.srcShort)}</div>
          <div class="image-alt-text ${altClass}">${altDisplay}</div>
          ${img.note ? `<div class="image-note">${img.note}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  if (images.length === 0) html += `<p class="hint">No images found on this page.</p>`;

  panel.innerHTML = html;
  panel.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Tools — Generic toggle (Landmarks, Lists, Icons, Navs)
// ---------------------------------------------------------------------------

const TOOL_CONFIG = {
  landmarks: {
    getAction:   'getLandmarks',
    clearAction: 'clearLandmarks',
    onLabel:  'Hide Landmarks',
    offLabel: 'Show Landmarks',
    renderPanel: renderLandmarks
  },
  lists: {
    getAction:   'getLists',
    clearAction: 'clearLists',
    onLabel:  'Hide Lists',
    offLabel: 'Show Lists',
    renderPanel: renderLists
  },
  icons: {
    getAction:   'getIcons',
    clearAction: 'clearIcons',
    onLabel:  'Hide Icons',
    offLabel: 'Show Icons',
    renderPanel: renderIcons
  },
  navs: {
    getAction:   'getNavs',
    clearAction: 'clearNavs',
    onLabel:  'Hide Nav &amp; Menus',
    offLabel: 'Show Nav &amp; Menus',
    renderPanel: renderNavs
  },
  focus: {
    getAction:   'getFocusIndicators',
    clearAction: 'clearFocusIndicators',
    onLabel:  'Hide Focus Indicators',
    offLabel: 'Check Focus Indicators',
    renderPanel: renderFocusIndicators
  }
};

async function toggleTool(name) {
  const cfg    = TOOL_CONFIG[name];
  const btn    = document.getElementById(`${name}Btn`);
  const panel  = document.getElementById(`${name}Panel`);
  const status = document.getElementById(`${name}Status`);
  const tab = await getActiveTab();

  if (activeTools[name]) {
    await chrome.tabs.sendMessage(tab.id, { action: cfg.clearAction });
    activeTools[name] = false;
    btn.innerHTML = cfg.offLabel;
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    panel.classList.add('hidden');
    panel.innerHTML = '';
    status.textContent = '';
    status.className = 'tool-status';
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { action: cfg.getAction });
  if (!response.success) return;

  activeTools[name] = true;
  btn.innerHTML = cfg.onLabel;
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');

  const { html, statusText, hasIssues } = cfg.renderPanel(response.result);
  panel.innerHTML = html;
  panel.classList.remove('hidden');
  status.textContent = statusText;
  status.className = `tool-status ${hasIssues ? 'has-issues' : 'all-clear'}`;
}

// Render helpers — each returns { html, statusText, hasIssues }

function renderLandmarks({ landmarks, summary }) {
  const COLORS = {
    main: '#0891b2', navigation: '#059669', banner: '#7c3aed',
    contentinfo: '#be185d', complementary: '#d97706', search: '#0049DB',
    form: '#dc2626', region: '#4338ca'
  };

  const issues = summary.unlabelledMultiple;
  let html = `<div class="heading-summary">
    ${summary.total} landmark${summary.total !== 1 ? 's' : ''}
    ${issues > 0 ? `· <span style="color:#d97706;font-weight:600">${issues} unlabelled duplicate${issues !== 1 ? 's' : ''} ⚠</span>` : ''}
  </div>`;

  if (landmarks.length === 0) {
    html += `<p class="hint">No landmarks found. Add landmark elements (main, nav, header, footer, aside) to improve navigation.</p>`;
  } else {
    html += landmarks.map(l => {
      const color = COLORS[l.role] || '#666';
      return `<div class="heading-row">
        <span class="heading-level-chip" style="background:${color}">${l.label.split(':')[0].substring(0,6)}</span>
        <span class="heading-text">${escapeHtml(l.label)}</span>
        ${!l.hasLabel ? `<span style="color:#d97706;font-size:10px">no label</span>` : ''}
      </div>`;
    }).join('');
  }

  return {
    html,
    statusText: `${summary.total} landmarks${issues > 0 ? ` · ${issues} unlabelled` : ''}`,
    hasIssues: issues > 0 || summary.total === 0
  };
}

function renderLists({ lists, summary }) {
  const COLORS = { UL: '#4338ca', OL: '#0891b2', DL: '#059669' };
  let html = `<div class="heading-summary">
    ${summary.total} list${summary.total !== 1 ? 's' : ''}:
    ${summary.ul} UL · ${summary.ol} OL · ${summary.dl} DL
    ${summary.semanticsRemoved > 0 ? `· <span style="color:#d97706;font-weight:600">${summary.semanticsRemoved} semantics removed</span>` : ''}
  </div>`;

  if (lists.length === 0) {
    html += `<p class="hint">No lists found on this page.</p>`;
  } else {
    html += lists.map(l => {
      const color = l.hasRoleNone ? '#999' : (COLORS[l.type] || '#666');
      return `<div class="heading-row">
        <span class="heading-level-chip" style="background:${color}">${l.type}</span>
        <span class="heading-text">${l.itemCount} item${l.itemCount !== 1 ? 's' : ''}</span>
        ${l.hasRoleNone ? `<span style="color:#d97706;font-size:10px">role=none ⚠</span>` : ''}
      </div>`;
    }).join('');
  }

  return {
    html,
    statusText: `${summary.total} lists${summary.semanticsRemoved > 0 ? ` · ${summary.semanticsRemoved} role=none` : ''}`,
    hasIssues: summary.semanticsRemoved > 0
  };
}

function renderIcons({ icons, summary }) {
  let html = `<div class="heading-summary">
    ${summary.total} icon${summary.total !== 1 ? 's' : ''}:
    <span style="color:#16a34a">${summary.decorative} decorative</span> ·
    <span style="color:#0891b2">${summary.labelled} labelled</span>
    ${summary.unlabelled > 0 ? `· <span style="color:#dc2626;font-weight:600">${summary.unlabelled} unlabelled ⚠</span>` : ''}
    ${summary.needsReview > 0 ? `· <span style="color:#d97706;font-weight:600">${summary.needsReview} review</span>` : ''}
  </div>`;

  if (icons.length === 0) {
    html += `<p class="hint">No icons detected on this page.</p>`;
  } else {
    const STATUS_COLORS = { decorative: '#16a34a', labelled: '#0891b2', unlabelled: '#dc2626', review: '#d97706' };
    html += icons.map(i => `
      <div class="heading-row">
        <span class="heading-level-chip" style="background:${STATUS_COLORS[i.status] || '#666'}">${i.type}</span>
        <span class="heading-text">${i.ariaLabel ? escapeHtml(i.ariaLabel.substring(0,40)) : `<em style="color:#999">${i.status}</em>`}</span>
      </div>
    `).join('');
  }

  const issues = summary.unlabelled + summary.needsReview;
  return {
    html,
    statusText: `${summary.total} icons${issues > 0 ? ` · ${issues} issues` : ''}`,
    hasIssues: issues > 0
  };
}

function renderNavs({ navs, summary }) {
  let html = `<div class="heading-summary">
    ${summary.total} nav/menu element${summary.total !== 1 ? 's' : ''}
    ${summary.primary    > 0 ? `· ${summary.primary} primary`    : ''}
    ${summary.secondary  > 0 ? `· ${summary.secondary} secondary` : ''}
    ${summary.unlabelled > 0 ? `· <span style="color:#d97706;font-weight:600">${summary.unlabelled} no label ⚠</span>` : ''}
  </div>`;

  if (navs.length === 0) {
    html += `<p class="hint">No nav or menu elements found on this page.</p>`;
  } else {
    html += navs.map(n => `
      <div class="heading-row">
        <span class="heading-text">${escapeHtml(n.label)}</span>
        ${n.note ? `<span style="color:#d97706;font-size:10px">⚠</span>` : ''}
      </div>
    `).join('');
  }

  return {
    html,
    statusText: `${summary.total} found${summary.unlabelled > 0 ? ` · ${summary.unlabelled} unlabelled` : ''}`,
    hasIssues: summary.unlabelled > 0
  };
}

function renderFocusIndicators({ elements, summary }) {
  let html = `<div class="heading-summary">
    ${summary.total} focusable element${summary.total !== 1 ? 's' : ''}
    ${summary.missing > 0 ? `· <span style="color:#dc2626;font-weight:600">${summary.missing} no visible change on focus ⚠</span>` : '· all showed a visible change on focus'}
  </div>
  <p class="hint">No screen reader test can catch this — JAWS and NVDA both announce "focused" whether or not anything is visible. This flags elements with no detectable style change at all; always confirm visually and check indicator contrast (WCAG 2.4.7 / 2.4.11).</p>`;

  if (elements.length === 0) {
    html += `<p class="hint">No focusable elements found on this page.</p>`;
  } else {
    html += elements.filter(e => !e.hasIndicator).map(e => `
      <div class="heading-row">
        <span class="heading-level-chip" style="background:#dc2626">${e.tag}</span>
        <span class="heading-text">${escapeHtml(e.text) || '<em style="color:#999">(no visible text)</em>'}</span>
        <span style="color:#d97706;font-size:10px">${escapeHtml(e.note)}</span>
      </div>
    `).join('');
    if (summary.missing === 0) {
      html += `<p class="hint">Every focusable element showed a style change on focus. This does not confirm the indicator is visible enough or high-contrast — only that something changes.</p>`;
    }
  }

  return {
    html,
    statusText: `${summary.total} checked${summary.missing > 0 ? ` · ${summary.missing} flagged` : ''}`,
    hasIssues: summary.missing > 0
  };
}

// ---------------------------------------------------------------------------
// Tools — Live Region Watcher
// ---------------------------------------------------------------------------

async function toggleLiveRegions() {
  const btn = document.getElementById('liveRegionBtn');
  const panel = document.getElementById('liveRegionPanel');
  const status = document.getElementById('liveRegionStatus');
  const tab = await getActiveTab();

  if (liveRegionActive) {
    await chrome.tabs.sendMessage(tab.id, { action: 'stopLiveRegionWatch' }).catch(() => {});
    liveRegionActive = false;
    btn.textContent = 'Watch Live Regions';
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    panel.classList.add('hidden');
    panel.innerHTML = '';
    status.textContent = '';
    status.className = 'tool-status';
    return;
  }

  const response = await chrome.tabs.sendMessage(tab.id, { action: 'startLiveRegionWatch' });
  if (!response.success) return;

  liveRegionActive = true;
  btn.textContent = 'Stop Watching';
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');

  renderLiveRegionPanel(response.result.staticFindings, [], response.result.regionCount);

  if (response.result.regionCount > 0) {
    status.textContent = `${response.result.regionCount} region(s) · watching`;
    status.className = 'tool-status has-issues';
  } else {
    status.textContent = 'No live regions found';
    status.className = 'tool-status all-clear';
  }
}

async function refreshLiveRegionLog() {
  const tab = await getActiveTab();
  const response = await chrome.tabs.sendMessage(tab.id, { action: 'getLiveRegionLog' });
  if (!response.success) return;
  renderLiveRegionPanel(response.result.staticFindings, response.result.log, response.result.staticFindings.length);
}

function renderLiveRegionPanel(staticFindings, log, regionCount) {
  const panel = document.getElementById('liveRegionPanel');

  let html = `<div class="heading-summary">${regionCount} live region${regionCount !== 1 ? 's' : ''} found</div>`;
  html += `<p class="hint">Interact with the page now to trigger an update, then press Refresh Log. A region that never fires here — or that had content before you touched anything — won't announce to a real screen reader either.</p>`;
  html += `<button id="refreshLiveRegionBtn" class="tool-btn" style="margin:8px 0;">Refresh Log</button>`;

  if (regionCount === 0) {
    html += `<p class="hint">No <code>aria-live</code>, <code>role="status"</code>, <code>role="alert"</code>, or <code>role="log"</code> elements found on this page.</p>`;
  } else {
    html += `<div class="heading-summary" style="margin-top:8px">Regions found</div>`;
    html += staticFindings.map(f => `
      <div class="heading-row">
        <span class="heading-level-chip" style="background:${f.hasContentAlready ? '#d97706' : '#0891b2'}">${escapeHtml(f.politeness || f.role)}</span>
        <span class="heading-text">${escapeHtml(f.selector)}</span>
        ${f.note ? `<span style="color:#d97706;font-size:10px">⚠ ${escapeHtml(f.note)}</span>` : ''}
      </div>
    `).join('');
  }

  html += `<div class="heading-summary" style="margin-top:8px">Captured announcements (${log.length})</div>`;
  if (log.length === 0) {
    html += `<p class="hint">Nothing captured yet. Trigger the page action that should update one of the regions above, then press Refresh Log.</p>`;
  } else {
    html += log.slice().reverse().map(entry => `
      <div class="heading-row">
        <span class="heading-text">${escapeHtml(entry.selector)}: "${escapeHtml(entry.newText)}"</span>
      </div>
    `).join('');
  }

  panel.innerHTML = html;
  panel.classList.remove('hidden');
  document.getElementById('refreshLiveRegionBtn')?.addEventListener('click', refreshLiveRegionLog);
}

// ---------------------------------------------------------------------------
// Export: JSON
// ---------------------------------------------------------------------------

function exportJSON() {
  if (!currentResults) return;

  const incompleteWithReviews = currentResults.incomplete.map((item, i) => ({
    ...item,
    manualReview: manualReviews[i] || null
  }));

  const report = {
    tool: 'WCAG 2.2 Accessibility Tester',
    exportedAt: new Date().toISOString(),
    url: currentResults.url,
    timestamp: currentResults.timestamp,
    level: currentResults.level,
    summary: {
      ...currentResults.summary,
      overlaysDetected: currentResults.violations.filter(v => v.isOverlay).length,
      manualReviewed: Object.keys(manualReviews).length,
      manualPassed:   Object.values(manualReviews).filter(r => r.verdict === 'pass').length,
      manualFailed:   Object.values(manualReviews).filter(r => r.verdict === 'fail').length
    },
    violations:   currentResults.violations,
    passes:       currentResults.passes,
    incomplete:   incompleteWithReviews,
    inapplicable: currentResults.inapplicable,
    imageAlt:     currentResults.imageAlt || null
  };

  download(JSON.stringify(report, null, 2), `a11y-report-${dateStamp()}.json`, 'application/json');
}

// ---------------------------------------------------------------------------
// Export: CSV
// ---------------------------------------------------------------------------

function exportCSV() {
  if (!currentResults) return;

  const rows = [
    ['Type', 'Rule ID', 'Impact', 'Title', 'Description', 'WCAG Tags', 'Elements Affected', 'Manual Verdict', 'Notes']
  ];

  const addRows = (items, type) => {
    items.forEach((item, i) => {
      const review = type === 'incomplete' ? (manualReviews[i] || null) : null;
      rows.push([
        item.isOverlay ? 'overlay' : type,
        item.id,
        item.impact || '',
        item.help || '',
        item.description,
        (item.wcagTags || []).join(' '),
        item.nodes.length,
        review ? verdictLabel(review.verdict) : '',
        item.isOverlay ? item.detectedVia : (review ? review.notes : '')
      ]);
    });
  };

  addRows(currentResults.violations, 'violation');
  addRows(currentResults.passes, 'pass');
  addRows(currentResults.incomplete, 'incomplete');

  // Image alt rows
  if (currentResults.imageAlt) {
    currentResults.imageAlt.images.forEach(img => {
      rows.push([
        'image-alt',
        'image-alt-text',
        img.status === 'fail' ? 'serious' : img.status === 'review' ? 'moderate' : '',
        img.category,
        img.alt === null ? 'Missing alt attribute' : `alt="${img.alt}"`,
        'wcag111',
        1,
        img.status === 'pass' ? 'Pass' : img.status === 'fail' ? 'Fail' : 'Review',
        img.note || img.srcShort
      ]);
    });
  }

  const csv = rows.map(row =>
    row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');

  download(csv, `a11y-report-${dateStamp()}.csv`, 'text/csv');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function download(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function dateStamp() {
  return new Date().toISOString().split('T')[0];
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function toggleHighlights() {
  const btn = document.getElementById('highlightBtn');
  const tab = await getActiveTab();

  if (btn.textContent.trim() === 'Highlight Issues') {
    await chrome.tabs.sendMessage(tab.id, { action: 'highlightIssues', violations: currentResults.violations });
    btn.textContent = 'Clear Highlights';
  } else {
    await chrome.tabs.sendMessage(tab.id, { action: 'clearHighlights' });
    btn.textContent = 'Highlight Issues';
  }
}

function switchTab(tabName) {
  document.querySelectorAll('[role="tab"]').forEach(btn => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.setAttribute('tabindex', active ? '0' : '-1');
  });
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.getElementById(`${tabName}Tab`)?.classList.remove('hidden');
  if (tabName === 'vpat' && currentResults) renderVpatMatrix();
  if (tabName === 'pulse') {
    renderPulseConnectionUI();
    if (pulseConfig.token) renderPulseSendTab();
  }
}

const SECTION_HEADING = {
  configSection:   'configHeading',
  progressSection: 'progressHeading',
  resultsSection:  'resultsHeading',
  reviewSection:   'reviewHeading',
};

function showSection(sectionId) {
  ['configSection', 'progressSection', 'resultsSection', 'reviewSection'].forEach(id =>
    document.getElementById(id)?.classList.toggle('hidden', id !== sectionId)
  );
  const headingId = SECTION_HEADING[sectionId];
  if (headingId) moveFocusTo(headingId);
}

function updateProgress(percent, text) {
  document.getElementById('progressFill').style.width = `${percent}%`;
  document.getElementById('progressText').textContent = text;
  document.getElementById('progressBar')?.setAttribute('aria-valuenow', percent);
}

async function stopLiveRegionWatchIfActive() {
  if (!liveRegionActive) return;
  liveRegionActive = false;
  try {
    const tab = await getActiveTab();
    if (tab) await chrome.tabs.sendMessage(tab.id, { action: 'stopLiveRegionWatch' });
  } catch (e) { /* tab may already be gone — nothing to clean up */ }
}

function resetToolState() {
  tabOrderActive = false;
  headingsActive = false;
  imageAltActive = false;
  Object.keys(activeTools).forEach(k => { activeTools[k] = false; });
  stopLiveRegionWatchIfActive();

  const allBtns   = ['tabOrderBtn', 'headingsBtn', 'imageAltBtn', 'landmarksBtn', 'listsBtn', 'iconsBtn', 'navsBtn', 'contrastBtn', 'ariaBtn', 'focusBtn', 'liveRegionBtn'];
  const allPanels = ['tabOrderPanel', 'headingsPanel', 'imageAltPanel', 'landmarksPanel', 'listsPanel', 'iconsPanel', 'navsPanel', 'contrastPanel', 'ariaPanel', 'focusPanel', 'liveRegionPanel'];
  const allStatus = ['tabOrderStatus', 'headingsStatus', 'imageAltStatus', 'landmarksStatus', 'listsStatus', 'iconsStatus', 'navsStatus', 'contrastStatus', 'ariaStatus', 'focusStatus', 'liveRegionStatus'];

  allBtns.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('active'); el.setAttribute('aria-pressed', 'false'); }
  });
  allPanels.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
  });
  allStatus.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.className = 'tool-status'; }
  });

  document.getElementById('liveRegionBtn') && (document.getElementById('liveRegionBtn').textContent = 'Watch Live Regions');
}

function resetToConfig() {
  currentResults    = null;
  manualReviews     = {};
  vpatVerdicts      = {};
  activeReviewIndex = null;
  resetToolState();
  document.getElementById('highlightBtn').textContent = 'Highlight Issues';
  showSection('configSection');
}

// ---------------------------------------------------------------------------
// Pulse integration — send VPAT Matrix verdicts into a Pulse page workspace
// ---------------------------------------------------------------------------

function loadPulseConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(['pulseToken', 'pulseBaseUrl'], data => {
      pulseConfig.token   = data.pulseToken || null;
      pulseConfig.baseUrl = data.pulseBaseUrl || 'http://localhost:3000';
      resolve();
    });
  });
}

function renderPulseConnectionUI() {
  const connectSection = document.getElementById('pulseConnectSection');
  const sendSection     = document.getElementById('pulseSendSection');
  const connectedAs     = document.getElementById('pulseConnectedAs');

  const connected = !!pulseConfig.token;
  connectSection.classList.toggle('hidden', connected);
  sendSection.classList.toggle('hidden', !connected);
  if (connected) connectedAs.textContent = `Connected — ${pulseConfig.baseUrl}`;
}

async function connectToPulse() {
  const tokenInput = document.getElementById('pulseTokenInput');
  const urlInput   = document.getElementById('pulseUrlInput');
  const status     = document.getElementById('pulseConnectStatus');

  const token   = tokenInput.value.trim();
  const baseUrl = urlInput.value.trim().replace(/\/+$/, '');

  if (!token) {
    status.textContent = 'Enter a token first.';
    status.className = 'tool-status has-issues';
    return;
  }
  if (!baseUrl) {
    status.textContent = 'Enter the Pulse URL first.';
    status.className = 'tool-status has-issues';
    return;
  }

  status.textContent = 'Verifying…';
  status.className = 'tool-status';

  try {
    const tab = await getActiveTab();
    const testUrl = tab?.url || 'https://example.com';
    const res = await fetch(`${baseUrl}/api/extension/context?url=${encodeURIComponent(testUrl)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) throw new Error('Invalid or revoked token.');
    if (res.status === 403) throw new Error('This account cannot use the extension integration.');
    if (!res.ok) throw new Error(`Unexpected error (${res.status}).`);

    pulseConfig.token = token;
    pulseConfig.baseUrl = baseUrl;
    chrome.storage.local.set({ pulseToken: token, pulseBaseUrl: baseUrl });

    tokenInput.value = '';
    status.textContent = '';
    renderPulseConnectionUI();
    await renderPulseSendTab();
  } catch (err) {
    status.textContent = err.message || 'Could not connect to Pulse.';
    status.className = 'tool-status has-issues';
  }
}

function disconnectFromPulse() {
  pulseConfig.token = null;
  pulseContext = null;
  chrome.storage.local.remove(['pulseToken']);
  renderPulseConnectionUI();
}

async function renderPulseSendTab() {
  if (!pulseConfig.token) return;

  const matchStatus   = document.getElementById('pulseMatchStatus');
  const picker        = document.getElementById('pulseMatchPicker');
  const sendBtn       = document.getElementById('pulseSendBtn');
  const websiteSelect = document.getElementById('pulseWebsiteSelect');
  const auditSelect   = document.getElementById('pulseAuditSelect');
  const sendStatus    = document.getElementById('pulseSendStatus');

  sendStatus.textContent = '';
  sendBtn.disabled = true;
  picker.classList.add('hidden');
  matchStatus.textContent = 'Looking up this page in Pulse…';
  matchStatus.className = 'tool-status';

  const tab = await getActiveTab();
  if (!tab?.url) {
    matchStatus.textContent = 'No active tab.';
    return;
  }

  try {
    const res = await fetch(`${pulseConfig.baseUrl}/api/extension/context?url=${encodeURIComponent(tab.url)}`, {
      headers: { Authorization: `Bearer ${pulseConfig.token}` },
    });
    if (!res.ok) throw new Error(`Lookup failed (${res.status}).`);
    pulseContext = await res.json();

    if (!pulseContext.matches || pulseContext.matches.length === 0) {
      matchStatus.textContent = 'No Pulse website matches this domain yet.';
      return;
    }

    websiteSelect.innerHTML = pulseContext.matches
      .map((m, i) => `<option value="${i}">${escapeHtml(m.organizationName)} — ${escapeHtml(m.websiteName)}</option>`)
      .join('');

    const verdictCount = Object.keys(vpatVerdicts).length;

    const populateAudits = () => {
      const match = pulseContext.matches[Number(websiteSelect.value)];
      if (!match.audits.length) {
        auditSelect.innerHTML = '<option value="">No open audits for this website</option>';
        sendBtn.disabled = true;
        return;
      }
      auditSelect.innerHTML = match.audits
        .map(a => `<option value="${a.id}">${escapeHtml(a.name)} (WCAG ${a.wcagVersion} ${a.targetLevel})</option>`)
        .join('');
      sendBtn.disabled = verdictCount === 0;
    };

    websiteSelect.onchange = populateAudits;
    populateAudits();

    picker.classList.remove('hidden');
    matchStatus.textContent = pulseContext.matches.length === 1
      ? `Matched: ${pulseContext.matches[0].websiteName}`
      : `${pulseContext.matches.length} matching websites — pick one.`;

    if (verdictCount === 0) {
      matchStatus.textContent += ' (Set conformance levels in the VPAT Matrix tab first.)';
    }
  } catch (err) {
    matchStatus.textContent = err.message || 'Lookup failed.';
    matchStatus.className = 'tool-status has-issues';
  }
}

async function sendVerdictsToPulse() {
  const sendStatus    = document.getElementById('pulseSendStatus');
  const websiteSelect = document.getElementById('pulseWebsiteSelect');
  const auditSelect   = document.getElementById('pulseAuditSelect');

  if (!pulseContext || !pulseContext.matches?.length) return;

  const match   = pulseContext.matches[Number(websiteSelect.value)];
  const auditId = auditSelect.value;
  if (!match || !auditId) {
    sendStatus.textContent = 'Pick a website and audit first.';
    sendStatus.className = 'tool-status has-issues';
    return;
  }

  const entries = Object.entries(vpatVerdicts).filter(([, v]) => v && PULSE_CONFORMANCE_MAP[v.conformance]);
  if (entries.length === 0) {
    sendStatus.textContent = 'No VPAT verdicts recorded yet — set conformance levels in the VPAT Matrix tab first.';
    sendStatus.className = 'tool-status has-issues';
    return;
  }

  const tab = await getActiveTab();
  sendStatus.textContent = `Sending ${entries.length} criteria…`;
  sendStatus.className = 'tool-status';

  try {
    const res = await fetch(`${pulseConfig.baseUrl}/api/extension/assessments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pulseConfig.token}` },
      body: JSON.stringify({
        websiteId: match.websiteId,
        auditId,
        pageUrl: tab.url,
        pageTitle: tab.title || null,
        assessments: entries.map(([sc, v]) => ({
          criterionId: sc,
          vpatConformanceLevel: PULSE_CONFORMANCE_MAP[v.conformance],
          notes: v.remark || null,
        })),
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Send failed (${res.status}).`);

    sendStatus.textContent = `Sent ${data.succeeded} of ${data.succeeded + data.failed} criteria to Pulse.`;
    sendStatus.className = 'tool-status all-clear';
  } catch (err) {
    sendStatus.textContent = err.message || 'Send failed.';
    sendStatus.className = 'tool-status has-issues';
  }
}

// ---------------------------------------------------------------------------
// Color contrast checker
// ---------------------------------------------------------------------------

let contrastActive = false;

async function toggleContrast() {
  const btn    = document.getElementById('contrastBtn');
  const panel  = document.getElementById('contrastPanel');
  const status = document.getElementById('contrastStatus');
  const tab = await getActiveTab();

  if (contrastActive) {
    contrastActive = false;
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    panel.classList.add('hidden');
    panel.innerHTML = '';
    status.textContent = '';
    status.className = 'tool-status';
    await chrome.tabs.sendMessage(tab.id, { action: 'clearContrast' }).catch(() => {});
    return;
  }

  contrastActive = true;
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
  status.textContent = 'Scanning…';
  status.className = 'tool-status status-active';

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'getContrastData' });
    if (!res.success) throw new Error(res.error);
    const { failures, passes, summary } = res.result;
    status.textContent = `${summary.failures} failure${summary.failures !== 1 ? 's' : ''} of ${summary.total}`;
    status.className = summary.failures > 0 ? 'tool-status status-fail' : 'tool-status status-pass';

    panel.innerHTML = `
      <div class="contrast-summary">
        <span class="contrast-stat fail">${summary.failures} Failures</span>
        <span class="contrast-stat pass">${summary.passes} Passes</span>
        <span class="contrast-stat total">${summary.total} Total</span>
      </div>
      ${failures.length ? `
        <h4 class="contrast-heading fail-heading">Contrast Failures</h4>
        ${failures.map(f => contrastRow(f, true)).join('')}
      ` : '<p class="hint" style="margin-top:8px">✓ No contrast failures found.</p>'}
      ${passes.length ? `
        <details style="margin-top:10px">
          <summary class="contrast-heading pass-heading">${passes.length} Passing Elements</summary>
          ${passes.map(f => contrastRow(f, false)).join('')}
        </details>
      ` : ''}
    `;
    panel.classList.remove('hidden');
  } catch (e) {
    status.textContent = 'Error';
    status.className = 'tool-status status-fail';
    panel.innerHTML = `<p class="hint">Error: ${escapeHtml(e.message)}</p>`;
    panel.classList.remove('hidden');
  }
}

function contrastRow(item, isFail) {
  const aaLabel  = item.isLargeText ? 'AA Large' : 'AA';
  const aaaLabel = item.isLargeText ? 'AAA Large' : 'AAA';
  return `
    <div class="contrast-row ${isFail ? 'contrast-fail' : 'contrast-pass'}">
      <div class="contrast-swatches">
        <span class="swatch" style="background:${item.fg};border:1px solid #ccc" title="Foreground: ${item.fg}"></span>
        <span class="swatch" style="background:${item.bg};border:1px solid #ccc" title="Background: ${item.bg}"></span>
        <span class="ratio-value">${item.ratio}:1</span>
        <span class="contrast-pill ${item.passAA ? 'pass-pill' : 'fail-pill'}">${aaLabel} ${item.passAA ? '✓' : '✗'}</span>
        <span class="contrast-pill ${item.passAAA ? 'pass-pill' : 'fail-pill'}">${aaaLabel} ${item.passAAA ? '✓' : '✗'}</span>
        ${item.isLargeText ? '<span class="large-text-tag">Large</span>' : ''}
      </div>
      <div class="contrast-text">${escapeHtml(item.text)}</div>
      <div class="contrast-selector">&lt;${item.tag}&gt; ${escapeHtml(item.selector)}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// ARIA inspector
// ---------------------------------------------------------------------------

let ariaActive = false;

async function toggleAriaInspector() {
  const btn    = document.getElementById('ariaBtn');
  const panel  = document.getElementById('ariaPanel');
  const status = document.getElementById('ariaStatus');
  const tab = await getActiveTab();

  if (ariaActive) {
    ariaActive = false;
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    panel.classList.add('hidden');
    panel.innerHTML = '';
    status.textContent = '';
    status.className = 'tool-status';
    await chrome.tabs.sendMessage(tab.id, { action: 'clearAriaHighlights' }).catch(() => {});
    return;
  }

  ariaActive = true;
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
  status.textContent = 'Scanning…';
  status.className = 'tool-status status-active';

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'getAriaUsage' });
    if (!res.success) throw new Error(res.error);
    const { elements, summary } = res.result;

    status.textContent = `${summary.total} elements · ${summary.withIssues} issues`;
    status.className = summary.withIssues > 0 ? 'tool-status status-fail' : 'tool-status status-pass';

    let activeFilter = 'all';
    const render = (filter) => {
      activeFilter = filter;
      let filtered = elements;
      if (filter === 'issues')  filtered = elements.filter(e => e.issues.length > 0);
      if (filter === 'hidden')  filtered = elements.filter(e => e.ariaHidden === 'true');
      if (filter === 'roles')   filtered = elements.filter(e => e.role);

      return `
        <div class="aria-filter-bar">
          <button class="aria-filter-btn ${filter==='all'?'active':''}" data-filter="all">All (${elements.length})</button>
          <button class="aria-filter-btn ${filter==='issues'?'active':''}" data-filter="issues">Issues (${summary.withIssues})</button>
          <button class="aria-filter-btn ${filter==='hidden'?'active':''}" data-filter="hidden">aria-hidden (${summary.hidden})</button>
          <button class="aria-filter-btn ${filter==='roles'?'active':''}" data-filter="roles">Roles (${summary.withRole})</button>
        </div>
        <div style="overflow-x:auto">
          <table class="aria-table">
            <thead><tr>
              <th>Element</th><th>Role</th><th>Label Source</th><th>Resolved Value</th><th>Issues</th>
            </tr></thead>
            <tbody>
              ${filtered.map(e => `
                <tr class="${e.issues.length ? 'aria-issue-row' : ''}">
                  <td>&lt;${escapeHtml(e.tag)}&gt;</td>
                  <td>${escapeHtml(e.role) || '—'}</td>
                  <td>${escapeHtml(e.labelSource)}</td>
                  <td title="${escapeHtml(e.resolvedLabel)}">${escapeHtml(e.resolvedLabel.substring(0,30)) || '—'}</td>
                  <td>${e.issues.length ? e.issues.map(i => `<div class="aria-issue">${escapeHtml(i)}</div>`).join('') : '✓'}</td>
                </tr>
              `).join('')}
              ${filtered.length === 0 ? '<tr><td colspan="5" class="hint">No elements match this filter.</td></tr>' : ''}
            </tbody>
          </table>
        </div>
      `;
    };

    panel.innerHTML = render('all');
    panel.classList.remove('hidden');

    panel.addEventListener('click', e => {
      const btn = e.target.closest('.aria-filter-btn');
      if (btn) {
        panel.innerHTML = render(btn.dataset.filter);
        // re-attach listener
        panel.addEventListener('click', arguments.callee);
      }
    });

  } catch (e) {
    status.textContent = 'Error';
    status.className = 'tool-status status-fail';
    panel.innerHTML = `<p class="hint">Error: ${escapeHtml(e.message)}</p>`;
    panel.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// WCAG 2.2 Criteria map (A + AA)
// ---------------------------------------------------------------------------

const WCAG_2_2_CRITERIA = [
  // Level A
  { sc:'1.1.1', name:'Non-text Content',                      level:'A',  axeRules:['image-alt','input-image-alt','area-alt','object-alt','role-img-alt','svg-img-alt'],          manualRequired:true,
    testMethod: 'Use the Images tool to list every image’s alt text. Confirm meaningful images have alt text that conveys their purpose; decorative images have alt="" or are hidden from assistive tech; complex images (charts, infographics) have a nearby or linked long description.', tool: 'imageAlt' },
  { sc:'1.2.1', name:'Audio-only & Video-only (Prerecorded)', level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'For any audio-only file, confirm a text transcript is provided nearby. For any video-only (silent) file, confirm a text or audio description alternative conveys the same information.', tool: null },
  { sc:'1.2.2', name:'Captions (Prerecorded)',                level:'A',  axeRules:['video-caption'],                                                                               manualRequired:true,
    testMethod: 'Play every prerecorded video with sound on and confirm synchronized captions are available and accurate (auto-generated captions alone are usually not accurate enough).', tool: null },
  { sc:'1.2.3', name:'Audio Description or Media Alt',        level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Play prerecorded video and confirm important visual information not conveyed by the existing audio (on-screen text, silent actions) is available via audio description or a full text alternative.', tool: null },
  { sc:'1.3.1', name:'Info and Relationships',                level:'A',  axeRules:['definition-list','dlitem','list','listitem','label','aria-required-children','aria-required-parent','empty-heading','table-fake-caption','td-has-header','th-has-data-cells','scope-attr-valid','heading-order'], manualRequired:true,
    testMethod: 'Use the Headings and Landmarks tools to confirm structure is built with real semantic markup (headings, lists, tables with headers) rather than visual styling alone — e.g. a bolded line of text isn’t a substitute for a real heading tag.', tool: 'headings' },
  { sc:'1.3.2', name:'Meaningful Sequence',                   level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Disable CSS (or use a screen reader) and confirm content still reads in a logical order that matches the visual layout.', tool: null },
  { sc:'1.3.3', name:'Sensory Characteristics',               level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Check that instructions never rely solely on shape, color, size, or position (e.g. "click the round button" or "see the box on the right") without another identifier like a visible label.', tool: null },
  { sc:'1.4.1', name:'Use of Color',                          level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Confirm color is never the only way information is conveyed (required fields, links within body text, error states, chart legend) — there should also be text, an icon, or an underline.', tool: null },
  { sc:'1.4.2', name:'Audio Control',                         level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'If any audio plays automatically for more than 3 seconds, confirm a visible control lets the user pause, stop, or mute it independent of the system volume.', tool: null },
  { sc:'2.1.1', name:'Keyboard',                              level:'A',  axeRules:['scrollable-region-focusable','role-application-review'],                                        manualRequired:true,
    testMethod: 'Unplug your mouse. Confirm every interactive element (links, buttons, form fields, custom widgets, menus) can be operated using only Tab, Shift+Tab, Enter, Space, and arrow keys. If role="application" was flagged, confirm that region truly implements its own full keyboard interaction — it disables normal screen reader arrow-key reading for everything inside it.', tool: 'tabOrder' },
  { sc:'2.1.2', name:'No Keyboard Trap',                      level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'While tabbing through the page, confirm focus never gets stuck inside a component (modal, embedded widget, date picker) with no way to Tab or Esc back out.', tool: 'tabOrder' },
  { sc:'2.1.4', name:'Character Key Shortcuts',               level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'If the page defines single-key shortcuts (no Ctrl/Alt/Cmd), confirm they can be turned off, remapped, or only activate on focus — otherwise they can misfire for speech-input or single-switch users.', tool: null },
  { sc:'2.2.1', name:'Timing Adjustable',                     level:'A',  axeRules:['meta-refresh'],                                                                               manualRequired:true,
    testMethod: 'If any time limit exists (session timeout, auto-advancing carousel, timed quiz), confirm the user can turn it off, adjust it, or extend it before it expires.', tool: null },
  { sc:'2.2.2', name:'Pause, Stop, Hide',                     level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'For any moving, blinking, scrolling, or auto-updating content lasting more than 5 seconds, confirm a control lets the user pause, stop, or hide it.', tool: null },
  { sc:'2.3.1', name:'Three Flashes or Below Threshold',      level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Watch for flashing content and confirm nothing flashes more than 3 times per second, or that the flashing area is small enough to be within the safe threshold.', tool: null },
  { sc:'2.4.1', name:'Bypass Blocks',                         level:'A',  axeRules:['bypass','landmark-one-main'],                                                                  manualRequired:true,
    testMethod: 'Confirm a "Skip to main content" link (or properly marked-up landmark regions) lets keyboard users bypass repeated navigation and jump straight to page content. Use the Landmarks tool to verify a main region exists.', tool: 'landmarks' },
  { sc:'2.4.2', name:'Page Titled',                           level:'A',  axeRules:['document-title'],                                                                             manualRequired:false,
    testMethod: 'Check the browser tab title — confirm it describes this specific page’s topic or purpose, not just the site name repeated on every page.', tool: null },
  { sc:'2.4.3', name:'Focus Order',                           level:'A',  axeRules:['focus-order-semantics'],                                                                      manualRequired:true,
    testMethod: 'Use the Tab Order tool to see the visual sequence, then tab through the page yourself and confirm the order matches a logical reading order and never jumps unpredictably.', tool: 'tabOrder' },
  { sc:'2.4.4', name:'Link Purpose (In Context)',             level:'A',  axeRules:['link-name','link-in-text-block'],                                                             manualRequired:true,
    testMethod: 'Read each link’s text (plus its surrounding sentence) out of context and confirm you can tell where it goes without needing generic text like "click here" or "read more" alone.', tool: null },
  { sc:'2.5.1', name:'Pointer Gestures',                      level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'For any multi-point or path-based gesture (pinch-zoom, swipe), confirm the same function is also available via a single tap or click.', tool: null },
  { sc:'2.5.2', name:'Pointer Cancellation',                  level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Confirm actions trigger on mouse-up/touch-release (not mouse-down/touch-start), and that moving the pointer off the element before releasing cancels the action.', tool: null },
  { sc:'2.5.3', name:'Label in Name',                         level:'A',  axeRules:['label-content-name-mismatch'],                                                                manualRequired:true,
    testMethod: 'Use the ARIA Inspector to compare each control’s visible label to its accessible name — the visible text must be included in the accessible name so voice-control users can say what they see.', tool: 'aria' },
  { sc:'2.5.4', name:'Motion Actuation',                      level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'If any function is triggered by shaking or tilting the device, confirm it can also be operated by a standard control and that motion-triggering can be disabled.', tool: null },
  { sc:'3.1.1', name:'Language of Page',                      level:'A',  axeRules:['html-has-lang','html-lang-valid','html-xml-lang-mismatch'],                                   manualRequired:false,
    testMethod: 'Check the page’s html lang attribute matches the page’s actual language (already flagged automatically if missing or invalid).', tool: null },
  { sc:'3.2.1', name:'On Focus',                              level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Tab through every element and confirm simply receiving focus never triggers an unexpected change of context (new window, form auto-submit, focus jumping elsewhere).', tool: 'tabOrder' },
  { sc:'3.2.2', name:'On Input',                              level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Change the value of every form field/select and confirm it never auto-submits the form or changes context without warning — a warning should appear first, or the change should require a separate submit action.', tool: null },
  { sc:'3.3.1', name:'Error Identification',                  level:'A',  axeRules:['aria-invalid-value'],                                                                         manualRequired:true,
    testMethod: 'Submit a form with invalid or missing data and confirm errors are identified in text (not color alone) and specifically describe which field is wrong.', tool: 'aria' },
  { sc:'3.3.2', name:'Labels or Instructions',                level:'A',  axeRules:['label'],                                                                                      manualRequired:true,
    testMethod: 'Confirm every form field has a visible label or clear instructions describing what input is expected, especially any required format (e.g. date, phone number).', tool: null },
  { sc:'3.3.7', name:'Redundant Entry',                       level:'A',  axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'In multi-step processes, confirm information the user already entered earlier is auto-populated or re-selectable rather than requiring manual re-entry.', tool: null },
  { sc:'4.1.2', name:'Name, Role, Value',                     level:'A',  axeRules:['button-name','frame-title','input-button-name','link-name','select-name','aria-allowed-attr','aria-allowed-role','aria-command-name','aria-input-field-name','aria-required-attr','aria-roles','aria-toggle-field-name','aria-valid-attr','aria-valid-attr-value','aria-hidden-focus','duplicate-id-aria'], manualRequired:true,
    testMethod: 'Use the ARIA Inspector to confirm every custom widget (not a native HTML control) exposes a correct role, name, and state (expanded/checked/pressed/etc.) so assistive tech can identify and operate it.', tool: 'aria' },
  // Level AA
  { sc:'1.2.4', name:'Captions (Live)',                       level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'For any live audio/video content, confirm real-time captions are provided.', tool: null },
  { sc:'1.2.5', name:'Audio Description (Prerecorded)',       level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Play prerecorded video and confirm audio description is available for important visual information not already covered by the existing dialogue/audio track.', tool: null },
  { sc:'1.3.4', name:'Orientation',                           level:'AA', axeRules:['css-orientation-lock'],                                                                       manualRequired:true,
    testMethod: 'Rotate the device/viewport between portrait and landscape and confirm content and functionality both work in either orientation, unless a specific orientation is essential (e.g. a piano app).', tool: null },
  { sc:'1.3.5', name:'Identify Input Purpose',                level:'AA', axeRules:['autocomplete-valid'],                                                                         manualRequired:true,
    testMethod: 'Check common input fields (name, email, address, etc.) use the correct autocomplete attribute so browsers/assistive tech can auto-fill and identify their purpose.', tool: null },
  { sc:'1.4.3', name:'Contrast (Minimum)',                    level:'AA', axeRules:['color-contrast'],                                                                             manualRequired:true,
    testMethod: 'Use the Color Contrast tool to check text against its background — normal text needs 4.5:1, large text (18pt+, or 14pt+ bold) needs 3:1.', tool: 'contrast' },
  { sc:'1.4.4', name:'Resize Text',                           level:'AA', axeRules:['meta-viewport'],                                                                              manualRequired:true,
    testMethod: 'Zoom the browser to 200% and confirm all text remains readable with no content or functionality lost, and no horizontal scrolling required for body text.', tool: null },
  { sc:'1.4.5', name:'Images of Text',                        level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Confirm text is rendered as real text, not as an image of text, except for logos or where a specific visual presentation is essential.', tool: null },
  { sc:'1.4.10', name:'Reflow',                               level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Zoom to 400% (or set the viewport to 320px wide) and confirm content reflows to a single column with no loss of information and no two-dimensional scrolling, except for content that inherently needs it (data tables, maps).', tool: null },
  { sc:'1.4.11', name:'Non-text Contrast',                    level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Use the Color Contrast tool on UI components (button borders, form field borders, focus indicators) and graphical icons that convey meaning — they need 3:1 contrast against adjacent colors.', tool: 'contrast' },
  { sc:'1.4.12', name:'Text Spacing',                         level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Apply increased line height (1.5x), paragraph spacing (2x), letter spacing (0.12x), and word spacing (0.16x) via a bookmarklet/extension and confirm no text is clipped or overlapping.', tool: null },
  { sc:'1.4.13', name:'Content on Hover or Focus',            level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Trigger any tooltip/popover via hover or focus and confirm it can be dismissed without moving the pointer (e.g. Esc key), stays visible while the pointer moves onto it, and remains visible until dismissed or no longer relevant.', tool: null },
  { sc:'2.4.5', name:'Multiple Ways',                         level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Confirm there are at least two ways to find any given page (e.g. navigation menu + search, or sitemap + breadcrumbs) — not required on pages that are themselves a step in a process.', tool: 'navs' },
  { sc:'2.4.6', name:'Headings and Labels',                   level:'AA', axeRules:['empty-heading','page-has-heading-one'],                                                        manualRequired:true,
    testMethod: 'Use the Headings tool to confirm headings and form labels describe their topic or purpose clearly enough to navigate by, especially for screen reader users jumping heading-to-heading.', tool: 'headings' },
  { sc:'2.4.7', name:'Focus Visible',                         level:'AA', axeRules:['focus-visible'],                                                                              manualRequired:true,
    testMethod: 'Use the Check Focus Indicators tool to Tab through every interactive element and confirm a visible focus indicator appears on each one — nothing should suppress the outline with no visible replacement. No screen reader test can verify this; JAWS and NVDA both announce "focused" whether or not anything is visible.', tool: 'focus' },
  { sc:'2.4.11', name:'Focus Not Obscured (Minimum)',         level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Tab to each focusable element on pages with sticky headers, footers, or cookie banners, and confirm the focused element is never entirely hidden behind that other content — at least some part of it must remain visible.', tool: null },
  { sc:'2.5.7', name:'Dragging Movements',                    level:'AA', axeRules:['drag-interaction-review'],                                                                    manualRequired:true,
    testMethod: 'For any drag-and-drop interaction (reordering, sliders), confirm the same function is also available via a single click/tap, e.g. up/down buttons as an alternative to dragging. Screen readers only ever narrate drag state — they never perform the drag or supply this alternative for you.', tool: null },
  { sc:'2.5.8', name:'Target Size (Minimum)',                 level:'AA', axeRules:['target-size'],                                                                                manualRequired:true,
    testMethod: 'Measure clickable targets (buttons, links, icons) — each needs at least 24×24 CSS pixels, or sufficient spacing from adjacent targets, unless inline in a sentence or a native browser control.', tool: null },
  { sc:'3.1.2', name:'Language of Parts',                     level:'AA', axeRules:['valid-lang'],                                                                                 manualRequired:true,
    testMethod: 'Check any passage in a different language from the page’s main language has its own lang attribute (e.g. a French quote on an English page).', tool: null },
  { sc:'3.2.3', name:'Consistent Navigation',                 level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Use the Nav & Menus tool to compare the main navigation across multiple pages and confirm repeated navigation components appear in the same relative order each time.', tool: 'navs' },
  { sc:'3.2.4', name:'Consistent Identification',             level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Compare components with the same function across the site (e.g. a "Search" icon) and confirm they’re labeled/identified consistently everywhere.', tool: null },
  { sc:'3.2.6', name:'Consistent Help',                       level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'If the site offers help mechanisms (contact info, chat, FAQ link), confirm they appear in the same relative order on every page that has one.', tool: null },
  { sc:'3.3.3', name:'Error Suggestion',                      level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Trigger a form validation error and confirm the message suggests how to fix it (not just that it’s wrong), unless doing so would compromise security (e.g. login failures).', tool: null },
  { sc:'3.3.4', name:'Error Prevention (Legal, Financial)',   level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'For any submission with legal/financial consequences or that modifies/deletes user data, confirm the user can review, correct, and confirm before final submission, or can reverse/undo afterward.', tool: null },
  { sc:'3.3.8', name:'Accessible Authentication (Minimum)',   level:'AA', axeRules:[],                                                                                             manualRequired:true,
    testMethod: 'Check that login/authentication doesn’t require a cognitive function test (remembering a password, solving a puzzle) unless an alternative exists — e.g. pasting a password isn’t blocked, or a passkey/biometric option is offered.', tool: null },
  { sc:'4.1.3', name:'Status Messages',                       level:'AA', axeRules:['aria-live-region-item'],                                                                      manualRequired:true,
    testMethod: 'Use Watch Live Regions, trigger a status update that doesn’t move focus (e.g. "item added to cart", a save confirmation, a search result count), then press Refresh Log to confirm it was actually announced. A region that already contains text when the page loads — rather than starting empty and having content injected afterward — will not announce anything to a real screen reader even with aria-live present.', tool: 'liveRegions' },
];

// ---------------------------------------------------------------------------
// VPAT Product Info Form
// ---------------------------------------------------------------------------

function renderVpatProductForm() {
  const div = document.getElementById('vpatProductForm');
  if (!div) return;
  const pi = vpatProductInfo;
  div.innerHTML = `
    <details class="vpat-product-details" open>
      <summary class="vpat-product-summary">
        ACR Product Information
        <span class="vpat-product-hint">Required fields for the cover page of your Accessibility Conformance Report</span>
      </summary>
      <div class="vpat-product-fields">
        <div class="vpat-field-row">
          <label class="vpat-field-label" for="vpat-product-name">Product / Software Name <span class="vpat-field-req">*</span></label>
          <input id="vpat-product-name" class="vpat-field-input" type="text"
            placeholder="e.g. My Web Application"
            data-vpat-field="productName"
            value="${escapeHtml(pi.productName || '')}">
        </div>
        <div class="vpat-field-row vpat-field-row-half">
          <div>
            <label class="vpat-field-label" for="vpat-pi-version">Version <span class="vpat-field-req">*</span></label>
            <input id="vpat-pi-version" class="vpat-field-input" type="text"
              placeholder="e.g. 3.1.0"
              data-vpat-field="version"
              value="${escapeHtml(pi.version || '')}">
          </div>
          <div>
            <label class="vpat-field-label" for="vpat-org">Organization / Vendor <span class="vpat-field-req">*</span></label>
            <input id="vpat-org" class="vpat-field-input" type="text"
              placeholder="e.g. Acme Corp"
              data-vpat-field="organization"
              value="${escapeHtml(pi.organization || '')}">
          </div>
        </div>
        <div class="vpat-field-row">
          <label class="vpat-field-label" for="vpat-contact">Contact (Name, Title, Email) <span class="vpat-field-req">*</span></label>
          <input id="vpat-contact" class="vpat-field-input" type="text"
            placeholder="e.g. Jane Smith, Accessibility Lead, jane@example.com"
            data-vpat-field="contact"
            value="${escapeHtml(pi.contact || '')}">
        </div>
        <div class="vpat-field-row">
          <label class="vpat-field-label" for="vpat-notes">Notes (optional)</label>
          <textarea id="vpat-notes" class="vpat-field-textarea" rows="2"
            placeholder="Additional context about the product, scope, or evaluation..."
            data-vpat-field="notes">${escapeHtml(pi.notes || '')}</textarea>
        </div>
      </div>
    </details>
  `;
}

// ---------------------------------------------------------------------------
// Jump from a VPAT Matrix row straight into the matching Audit Tools feature
// ---------------------------------------------------------------------------

// Maps a criterion's `tool` key to the toggle function that turns it on,
// and to the toolbar button whose aria-pressed state tells us if it's
// already active (so we don't accidentally switch it back off).
const TOOL_ACTIVATORS = {
  tabOrder:  { btnId: 'tabOrderBtn',  activate: toggleTabOrder },
  headings:  { btnId: 'headingsBtn',  activate: toggleHeadings },
  imageAlt:  { btnId: 'imageAltBtn',  activate: toggleImageAlt },
  landmarks: { btnId: 'landmarksBtn', activate: () => toggleTool('landmarks') },
  lists:     { btnId: 'listsBtn',     activate: () => toggleTool('lists') },
  icons:     { btnId: 'iconsBtn',     activate: () => toggleTool('icons') },
  navs:      { btnId: 'navsBtn',      activate: () => toggleTool('navs') },
  contrast:  { btnId: 'contrastBtn',  activate: toggleContrast },
  aria:      { btnId: 'ariaBtn',      activate: toggleAriaInspector },
  focus:       { btnId: 'focusBtn',      activate: () => toggleTool('focus') },
  liveRegions: { btnId: 'liveRegionBtn', activate: toggleLiveRegions },
};

async function activateTool(toolKey) {
  const entry = TOOL_ACTIVATORS[toolKey];
  if (!entry) return;

  switchTab('tools');

  const btn = document.getElementById(entry.btnId);
  const alreadyActive = btn?.getAttribute('aria-pressed') === 'true';
  if (!alreadyActive) await entry.activate();

  btn?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  btn?.focus();
}

// ---------------------------------------------------------------------------
// VPAT Readiness Matrix
// ---------------------------------------------------------------------------

function buildVpatMatrix() {
  if (!currentResults) return WCAG_2_2_CRITERIA.map(c => ({
    ...c, automatedEvidence: 'None', passRate: null,
    autoConformance: 'Not Evaluated', conformanceLevel: 'Not Evaluated',
    readiness: 'Not Evaluated', inlineConformance: null, remark: ''
  }));

  // Build rule → result maps for O(1) lookup
  const violationMap = {};
  const passMap      = {};
  currentResults.violations.forEach(v => { violationMap[v.id] = v; });
  currentResults.passes.forEach(p    => { passMap[p.id]       = p; });
  const incompleteIds = new Set(currentResults.incomplete.map(v => v.id));

  return WCAG_2_2_CRITERIA.map(criterion => {
    const rules = criterion.axeRules || [];

    // ── Node-level pass rate for Partially Supports detection ──────────────
    let totalPass = 0, totalFail = 0;
    rules.forEach(ruleId => {
      if (violationMap[ruleId]) totalFail += (violationMap[ruleId].nodes || []).length;
      if (passMap[ruleId])      totalPass += (passMap[ruleId].nodes      || []).length;
    });
    const totalNodes = totalPass + totalFail;
    const passRate   = totalNodes > 0 ? totalPass / totalNodes : null;

    // ── Old-style automated evidence signal (kept for readiness coloring) ──
    let automatedEvidence = 'None';
    if (rules.some(r => violationMap[r]))        automatedEvidence = 'Fail';
    else if (rules.some(r => incompleteIds.has(r))) automatedEvidence = 'Partial';
    else if (rules.some(r => passMap[r]))         automatedEvidence = 'Pass';

    // ── Auto-calculate VPAT conformance level from node pass rate ──────────
    // >99% pass → Supports; 65–99% → Partially Supports; ≤65% → Does Not Support
    let autoConformance = 'Not Evaluated';
    if (passRate !== null) {
      if      (passRate >= 0.99)  autoConformance = 'Supports';
      else if (passRate  > 0.65)  autoConformance = 'Partially Supports';
      else                        autoConformance = 'Does Not Support';
    } else if (automatedEvidence === 'Partial') {
      autoConformance = 'Partially Supports';
    } else if (automatedEvidence === 'Fail') {
      autoConformance = 'Does Not Support';
    }

    // ── Manual review verdicts from the Needs Review workflow ──────────────
    let testerVerdict = null;
    if (currentResults.incomplete) {
      currentResults.incomplete.forEach((item, idx) => {
        if (criterion.axeRules.includes(item.id) && manualReviews[idx]) {
          testerVerdict = manualReviews[idx].verdict;
        }
      });
    }

    // ── Inline verdict set directly in the VPAT matrix ─────────────────────
    const inlineData       = vpatVerdicts[criterion.sc] || null;
    const inlineConformance = inlineData ? inlineData.conformance : null;
    const remark            = inlineData ? (inlineData.remark || '') : '';

    // User override takes precedence over auto-calculated
    const conformanceLevel = inlineConformance || autoConformance;

    // ── Readiness label (used for row background color) ────────────────────
    let readiness;
    if (inlineConformance) {
      readiness = 'Manual Reviewed';
    } else if (automatedEvidence === 'Pass' && !criterion.manualRequired) {
      readiness = 'Evidence Available';
    } else if (automatedEvidence === 'Pass' && testerVerdict === 'pass') {
      readiness = 'High Confidence Candidate';
    } else if (automatedEvidence !== 'None') {
      readiness = 'Needs Manual Verification';
    } else {
      readiness = 'Not Evaluated';
    }

    return { ...criterion, automatedEvidence, passRate, autoConformance,
             conformanceLevel, readiness, testerVerdict, inlineConformance, remark };
  });
}

function renderVpatMatrix() {
  const panel = document.getElementById('vpatPanel');
  if (!panel) return;

  const matrix = buildVpatMatrix();

  // ── Legend counts by VPAT conformance level ──────────────────────────────
  const cCounts = {
    'Supports':           matrix.filter(r => r.conformanceLevel === 'Supports').length,
    'Partially Supports': matrix.filter(r => r.conformanceLevel === 'Partially Supports').length,
    'Does Not Support':   matrix.filter(r => r.conformanceLevel === 'Does Not Support').length,
    'Not Applicable':     matrix.filter(r => r.conformanceLevel === 'Not Applicable').length,
    'Needs Review':       matrix.filter(r => r.readiness === 'Needs Manual Verification' && !r.inlineConformance).length,
    'Not Evaluated':      matrix.filter(r => r.conformanceLevel === 'Not Evaluated').length,
  };

  // ── Conformance level button definitions ─────────────────────────────────
  const CONF_LEVELS = [
    { value: 'Supports',           label: 'Supports',    cls: 'vpat-v-supports' },
    { value: 'Partially Supports', label: 'Partial',     cls: 'vpat-v-partial'  },
    { value: 'Does Not Support',   label: 'Not Supp.',   cls: 'vpat-v-fail'     },
    { value: 'Not Applicable',     label: 'N/A',         cls: 'vpat-v-na'       },
  ];

  // ── Remark placeholder text per conformance level ────────────────────────
  const remarkPlaceholder = (conformance) => ({
    'Supports':           'How was this criterion verified? Describe testing methods and evidence.',
    'Partially Supports': 'Which content meets this criterion? What does not, and why?',
    'Does Not Support':   'What barriers exist? Which content or features are affected?',
    'Not Applicable':     'Why does this criterion not apply to this product?',
  }[conformance] || 'Add testing notes and evidence...');

  // ── Render the Conformance & Remarks cell ────────────────────────────────
  const renderConformanceCell = (r) => {
    const hasVerdict = !!r.inlineConformance;

    const btns = CONF_LEVELS.map(({ value, label, cls }) => {
      const isActive = r.conformanceLevel === value && hasVerdict;
      return `<button class="vpat-v-btn ${cls}${isActive ? ' vpat-v-active' : ''}"
                data-action="vpat-verdict" data-sc="${r.sc}" data-verdict="${value}"
                aria-pressed="${isActive}">${escapeHtml(label)}</button>`;
    }).join('');

    // Show auto-calculated hint when no manual verdict is recorded
    const autoHint = !hasVerdict && r.autoConformance !== 'Not Evaluated'
      ? `<div class="vpat-auto-hint">Auto: ${escapeHtml(r.autoConformance)}</div>`
      : '';

    // Remark textarea appears only once a conformance level is set
    const remarkArea = hasVerdict ? `
      <div class="vpat-remark-area">
        <label class="vpat-remark-label" for="vpat-remark-${r.sc}">Remarks <span class="vpat-remark-req" title="Required for formal VPAT">*</span></label>
        <textarea id="vpat-remark-${r.sc}" class="vpat-remark-input"
          data-action="vpat-remark" data-sc="${r.sc}"
          placeholder="${remarkPlaceholder(r.conformanceLevel)}"
          rows="2">${escapeHtml(r.remark)}</textarea>
      </div>` : '';

    return `<div class="vpat-verdict-btns">${btns}</div>${autoHint}${remarkArea}`;
  };

  // ── Row background class ──────────────────────────────────────────────────
  const rowClass = (r) => {
    if (r.inlineConformance === 'Supports')           return 'vpat-row-supports';
    if (r.inlineConformance === 'Partially Supports') return 'vpat-row-partial';
    if (r.inlineConformance === 'Does Not Support')   return 'vpat-row-fail';
    if (r.inlineConformance === 'Not Applicable')     return 'vpat-row-na';
    // Fall back to automated-evidence row coloring
    if (r.readiness === 'Evidence Available')         return 'vpat-row-evidence-available';
    if (r.readiness === 'High Confidence Candidate')  return 'vpat-row-high-confidence-candidate';
    if (r.readiness === 'Needs Manual Verification')  return 'vpat-row-needs-manual-verification';
    return 'vpat-row-not-evaluated';
  };

  panel.innerHTML = `
    <div class="vpat-legend">
      <span class="vpat-key vpat-key-supports">✓ Supports (${cCounts['Supports']})</span>
      <span class="vpat-key vpat-key-partial">◑ Partially Supports (${cCounts['Partially Supports']})</span>
      <span class="vpat-key vpat-key-fail">✗ Does Not Support (${cCounts['Does Not Support']})</span>
      <span class="vpat-key vpat-key-na">— Not Applicable (${cCounts['Not Applicable']})</span>
      <span class="vpat-key manual">⚑ Needs Manual (${cCounts['Needs Review']})</span>
      <span class="vpat-key noevals">○ Not Evaluated (${cCounts['Not Evaluated']})</span>
    </div>
    <div style="overflow-x:auto;max-height:380px;overflow-y:auto">
      <table class="vpat-table">
        <thead><tr>
          <th>SC</th><th>Criterion</th><th>Lvl</th><th>Evidence</th><th>Conformance Level &amp; Remarks</th>
        </tr></thead>
        <tbody>
          ${matrix.map(r => `
            <tr class="${rowClass(r)}">
              <td><strong>${r.sc}</strong></td>
              <td>
                ${escapeHtml(r.name)}
                <details class="vpat-howto">
                  <summary>How to test</summary>
                  <p>${escapeHtml(r.testMethod || 'No specific test method recorded yet — use judgment based on the criterion description.')}</p>
                  ${r.tool ? `<button type="button" class="vpat-test-btn" data-action="vpat-activate-tool" data-tool="${r.tool}">Test this in Audit Tools →</button>` : ''}
                </details>
              </td>
              <td>${r.level}</td>
              <td>${r.automatedEvidence}</td>
              <td class="vpat-readiness-cell">${renderConformanceCell(r)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <p class="vpat-disclaimer">Select a conformance level on any row to record your assessment and add required remarks. Remarks are required for every criterion included in a formal VPAT.</p>
  `;

  // ── Event listeners — attached once to avoid stacking on re-renders ──────
  if (!_vpatListenerAttached) {
    _vpatListenerAttached = true;

    // Verdict button clicks
    panel.addEventListener('click', e => {
      const toolBtn = e.target.closest('[data-action="vpat-activate-tool"]');
      if (toolBtn) { activateTool(toolBtn.dataset.tool); return; }

      const btn = e.target.closest('[data-action="vpat-verdict"]');
      if (!btn) return;
      const sc = btn.dataset.sc;
      const newConformance = btn.dataset.verdict;
      const existing = vpatVerdicts[sc] || {};
      vpatVerdicts[sc] = { conformance: newConformance, remark: existing.remark || '' };
      renderVpatMatrix();
      // Focus the remarks textarea after re-render
      setTimeout(() => {
        const ta = panel.querySelector(`#vpat-remark-${CSS.escape(sc)}`);
        if (ta) { ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); ta.focus(); }
      }, 60);
    });

    // Remark textarea input — save without re-rendering so cursor stays put
    panel.addEventListener('input', e => {
      const ta = e.target.closest('[data-action="vpat-remark"]');
      if (!ta) return;
      const sc = ta.dataset.sc;
      if (vpatVerdicts[sc]) vpatVerdicts[sc].remark = ta.value;
    });
  }
}

function exportVpatCSV() {
  const matrix = buildVpatMatrix();
  // Column names mirror the VPAT 2.x ACR template format
  const headers = ['SC', 'Criterion', 'Level', 'Automated Evidence', 'Conformance Level', 'Remarks and Explanations'];
  const rows = [headers, ...matrix.map(r => [
    r.sc, r.name, r.level, r.automatedEvidence, r.conformanceLevel, r.remark || ''
  ])];
  const csv = rows.map(row => row.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  download(csv, `vpat-readiness-matrix-${dateStamp()}.csv`, 'text/csv');
}

// ---------------------------------------------------------------------------
// ACR (Accessibility Conformance Report) HTML export
// Follows VPAT® 2.5 structure from ITI
// ---------------------------------------------------------------------------

function exportAcrHtml() {
  if (!currentResults) { alert('Run a test first, then record conformance levels in the VPAT Matrix tab.'); return; }

  const matrix  = buildVpatMatrix();
  const levelA  = matrix.filter(r => r.level === 'A');
  const levelAA = matrix.filter(r => r.level === 'AA');

  const date  = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const url   = currentResults.url  || 'Unknown';
  const level = currentResults.level || 'AA';

  const pi = vpatProductInfo;
  const productName = pi.productName  || '[PRODUCT NAME — edit before sharing]';
  const version     = pi.version      || '[VERSION]';
  const org         = pi.organization || '[ORGANIZATION NAME]';
  const contact     = pi.contact      || '[Contact Name, Title, Email]';
  const notes       = pi.notes        || '';

  const evalMethods =
    `Automated accessibility testing was conducted using axe-core 4.8.4 (Deque Systems) ` +
    `via the Accessiblü WCAG 2.2 Tester Chrome extension (v1.4.0). ` +
    `Testing was performed on: ${url} on ${date}. ` +
    `Manual testing and expert review were conducted for success criteria requiring human judgment, ` +
    `including keyboard operability, screen reader compatibility, focus management, ` +
    `motion sensitivity, cognitive accessibility, and dynamic content behavior.`;

  // Count completeness for the cover-page notice
  const withVerdict = matrix.filter(r => r.inlineConformance).length;
  const withRemark  = matrix.filter(r => r.remark && r.remark.trim()).length;
  const notEval     = matrix.filter(r => r.conformanceLevel === 'Not Evaluated').length;

  const rowClass = (r) => ({
    'Supports':           'acr-row-supports',
    'Partially Supports': 'acr-row-partial',
    'Does Not Support':   'acr-row-fail',
    'Not Applicable':     'acr-row-na',
    'Not Evaluated':      'acr-row-none',
  }[r.conformanceLevel] || 'acr-row-none');

  const criteriaLink = (sc) =>
    `https://www.w3.org/TR/WCAG22/#${sc.replace(/\./g,'')}`;

  const renderCriteriaRows = (criteria) => criteria.map(r => `
    <tr class="${rowClass(r)}">
      <td>
        <a href="${criteriaLink(r.sc)}" target="_blank" rel="noopener noreferrer"
           style="color:inherit;font-weight:600;text-decoration:none;">${r.sc}</a>
        ${escapeHtml(r.name)} (Level ${r.level})
      </td>
      <td class="acr-conf-cell">${escapeHtml(r.conformanceLevel)}</td>
      <td class="acr-remark-cell">${r.remark ? escapeHtml(r.remark) : (r.conformanceLevel === 'Not Evaluated' ? '<em style="color:#9ca3af">Not yet evaluated</em>' : '')}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Accessibility Conformance Report — ${escapeHtml(productName)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, Helvetica, sans-serif; font-size: 14px;
         color: #111; background: #fff; line-height: 1.6; }
  .page { max-width: 960px; margin: 0 auto; padding: 0 32px 64px; }

  /* ── Header ── */
  .acr-header { background: #000B5E; color: white; padding: 36px 32px 28px;
                margin: 0 -32px 40px; }
  .acr-header-top { display: flex; justify-content: space-between; align-items: flex-start;
                    flex-wrap: wrap; gap: 16px; }
  .acr-org-name { font-size: 13px; font-weight: 600; opacity: 0.7; text-transform: uppercase;
                  letter-spacing: 0.08em; margin-bottom: 6px; }
  .acr-title  { font-size: 26px; font-weight: 700; letter-spacing: -0.5px; }
  .acr-sub    { font-size: 13px; opacity: 0.65; margin-top: 6px; }
  /* Tool attribution — small, right-aligned, clearly "the tool used" not the author */
  .acr-tool-credit { display: flex; flex-direction: column; align-items: flex-end;
                     gap: 4px; opacity: 0.75; flex-shrink: 0; }
  .acr-tool-credit-label { font-size: 10px; text-transform: uppercase;
                            letter-spacing: 0.08em; opacity: 0.8; }
  .acr-tool-credit-name  { font-size: 13px; font-weight: 700; }
  .acr-tool-credit-name span { color: #93c5fd; }
  .acr-tool-credit-sub   { font-size: 11px; opacity: 0.7; }

  /* ── Self-generated notice (prominent, near top) ── */
  .acr-self-notice { background: #eff6ff; border: 1px solid #93c5fd;
                     border-left: 4px solid #2563eb; border-radius: 6px;
                     padding: 16px 18px; font-size: 13px; color: #1e3a5f; margin-bottom: 28px; }
  .acr-self-notice strong { display: block; font-size: 14px; margin-bottom: 8px; color: #1d4ed8; }
  .acr-self-notice p { margin-bottom: 8px; }
  .acr-self-notice p:last-child { margin-bottom: 0; }
  .acr-self-notice a { color: #1d4ed8; }

  /* ── Completeness notice ── */
  .acr-notice { background: #fffbeb; border: 1px solid #fbbf24; border-radius: 6px;
                padding: 12px 16px; font-size: 13px; color: #78350f; margin-bottom: 24px; }
  .acr-notice strong { display: block; margin-bottom: 4px; }

  /* ── Section headings ── */
  h2 { font-size: 18px; color: #000B5E; border-bottom: 2px solid #000B5E;
       padding-bottom: 6px; margin: 36px 0 16px; }
  h3 { font-size: 15px; color: #0A1C78; margin: 28px 0 10px; }
  p  { margin-bottom: 10px; }
  ul { padding-left: 24px; margin-bottom: 12px; }
  li { margin-bottom: 4px; }
  a  { color: #000B5E; }

  /* ── Info table (cover page) ── */
  .info-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px; }
  .info-table th { background: #f3f4f6; font-weight: 600; padding: 8px 12px;
                   border: 1px solid #e5e7eb; width: 220px; text-align: left;
                   vertical-align: top; }
  .info-table td { padding: 8px 12px; border: 1px solid #e5e7eb; vertical-align: top; }

  /* ── Standards table ── */
  .std-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px; }
  .std-table th { background: #000B5E; color: white; padding: 8px 12px; text-align: left; }
  .std-table td { padding: 8px 12px; border: 1px solid #e5e7eb; }

  /* ── Terms ── */
  .terms-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px; }
  .terms-table th { background: #f3f4f6; font-weight: 600; padding: 8px 12px;
                    border: 1px solid #e5e7eb; text-align: left; width: 160px; }
  .terms-table td { padding: 8px 12px; border: 1px solid #e5e7eb; }

  /* ── WCAG criteria table ── */
  .acr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .acr-table th { background: #000B5E; color: white; padding: 9px 10px; text-align: left; }
  .acr-table th:nth-child(1) { width: 38%; }
  .acr-table th:nth-child(2) { width: 18%; }
  .acr-table th:nth-child(3) { width: 44%; }
  .acr-table td { padding: 8px 10px; border: 1px solid #e5e7eb; vertical-align: top; }
  .acr-conf-cell   { font-weight: 600; }
  .acr-remark-cell { font-size: 12px; color: #374151; }

  /* Row colors */
  .acr-row-supports { background: #f0fdf4; }
  .acr-row-partial  { background: #fefce8; }
  .acr-row-fail     { background: #fef2f2; }
  .acr-row-na       { background: #f9fafb; color: #6b7280; }
  .acr-row-none     { background: #fff; color: #9ca3af; }

  /* Conformance level colors */
  .acr-row-supports .acr-conf-cell { color: #15803d; }
  .acr-row-partial  .acr-conf-cell { color: #92400e; }
  .acr-row-fail     .acr-conf-cell { color: #dc2626; }

  /* ── Disclaimer / Footer ── */
  .acr-disclaimer { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px;
                    padding: 16px; font-size: 12px; color: #4b5563; margin-top: 40px; }
  .acr-footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb;
                text-align: center; font-size: 11px; color: #9ca3af; }

  /* ── Print ── */
  @media print {
    .acr-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .acr-table th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    h2 { break-before: auto; }
    .acr-table tr { break-inside: avoid; }
  }
  @page { margin: 1in; }
</style>
</head>
<body>
<div class="page">

  <!-- ── Header ── -->
  <header class="acr-header">
    <div class="acr-header-top">
      <div>
        <div class="acr-org-name">${escapeHtml(org)}</div>
        <div class="acr-title">Accessibility Conformance Report</div>
        <div class="acr-sub">WCAG Edition &nbsp;·&nbsp; Based on VPAT<sup>®</sup> Version 2.5</div>
      </div>
      <div class="acr-tool-credit">
        <div class="acr-tool-credit-label">Generated with</div>
        <div class="acr-tool-credit-name">Accessi<span>blü</span> WCAG Check&nbsp;Ü</div>
        <div class="acr-tool-credit-sub">Self-service testing tool</div>
      </div>
    </div>
  </header>

  <!-- ── Self-generated notice ── -->
  <div class="acr-self-notice">
    <strong>Self-Generated Accessibility Conformance Report</strong>
    <p>
      This document was independently prepared by <strong>${escapeHtml(org)}</strong> using the
      <strong>Accessiblü WCAG Check Ü</strong> browser extension — a self-service accessibility
      testing tool. It was not prepared by, reviewed by, or issued by Accessiblü as part of a
      professional accessibility consulting engagement.
    </p>
    <p>
      <strong>${escapeHtml(org)}</strong> is solely responsible for all conformance assessments,
      remarks, and claims contained in this report. Accessiblü makes no representations,
      warranties, or guarantees — express or implied — regarding the accuracy, completeness,
      or reliability of any conformance determination herein.
    </p>
    <p>
      This report is distinct from an Accessibility Conformance Report prepared by Accessiblü
      as part of a professional audit engagement. For a professionally conducted accessibility
      audit and ACR, contact Accessiblü at
      <a href="https://www.accessiblu.com/contact/" target="_blank" rel="noopener noreferrer">accessiblu.com/contact</a>.
    </p>
  </div>

  ${notEval > 0 || withVerdict < matrix.length ? `
  <div class="acr-notice">
    <strong>Completeness Notice</strong>
    ${withVerdict} of ${matrix.length} criteria have recorded conformance levels &nbsp;·&nbsp;
    ${withRemark} of ${matrix.length} have remarks &nbsp;·&nbsp;
    ${notEval} criteria are still marked "Not Evaluated."
    Review the VPAT Matrix tab in the extension to complete all entries before distributing this report.
  </div>` : ''}

  <!-- ── Product Information ── -->
  <h2>Product Information</h2>
  <table class="info-table">
    <tr><th>Name of Product / Version</th><td>${escapeHtml(productName)} &nbsp; <em>${escapeHtml(version)}</em></td></tr>
    <tr><th>Report Date</th><td>${escapeHtml(date)}</td></tr>
    <tr><th>Vendor / Organization</th><td>${escapeHtml(org)}</td></tr>
    <tr><th>Contact Information</th><td>${escapeHtml(contact)}</td></tr>
    ${notes ? `<tr><th>Notes</th><td>${escapeHtml(notes)}</td></tr>` : ''}
    <tr><th>Evaluation Methods Used</th><td>${escapeHtml(evalMethods)}</td></tr>
  </table>

  <!-- ── Applicable Standards ── -->
  <h2>Applicable Standards / Guidelines</h2>
  <p>This report covers the degree of conformance for the following accessibility standard:</p>
  <table class="std-table">
    <thead><tr><th>Standard / Guideline</th><th>Included In Report</th></tr></thead>
    <tbody>
      <tr>
        <td><a href="https://www.w3.org/TR/WCAG22/" target="_blank" rel="noopener noreferrer">
          Web Content Accessibility Guidelines 2.2 (WCAG 2.2)</a></td>
        <td>Level A &amp; Level AA</td>
      </tr>
    </tbody>
  </table>

  <!-- ── Terms ── -->
  <h2>Terms</h2>
  <p>The terms used in the Conformance Level information are defined as follows:</p>
  <table class="terms-table">
    <thead><tr><th>Term</th><th>Definition</th></tr></thead>
    <tbody>
      <tr><td><strong>Supports</strong></td>
          <td>The functionality of the product has at least one method that meets the criterion without known defects or meets with equivalent facilitation.</td></tr>
      <tr><td><strong>Partially Supports</strong></td>
          <td>Some functionality of the product does not meet the criterion.</td></tr>
      <tr><td><strong>Does Not Support</strong></td>
          <td>The majority of product functionality does not meet the criterion.</td></tr>
      <tr><td><strong>Not Applicable</strong></td>
          <td>The criterion is not relevant to the product.</td></tr>
      <tr><td><strong>Not Evaluated</strong></td>
          <td>The product has not been evaluated against the criterion.</td></tr>
    </tbody>
  </table>

  <!-- ── WCAG 2.2 Report ── -->
  <h2>WCAG 2.2 Report</h2>
  <p>Note: When reporting on conformance with the WCAG 2.2 Success Criteria, they are scoped
  for full pages, complete processes, and accessibility-supported ways of using technology as
  documented in the
  <a href="https://www.w3.org/TR/WCAG22/#conformance-reqs" target="_blank" rel="noopener noreferrer">
  WCAG 2.2 Conformance Requirements</a>.</p>

  <h3>Table 1: Success Criteria, Level A</h3>
  <div style="overflow-x:auto">
    <table class="acr-table">
      <thead><tr>
        <th>Criteria</th>
        <th>Conformance Level</th>
        <th>Remarks and Explanations</th>
      </tr></thead>
      <tbody>${renderCriteriaRows(levelA)}</tbody>
    </table>
  </div>

  <h3>Table 2: Success Criteria, Level AA</h3>
  <div style="overflow-x:auto">
    <table class="acr-table">
      <thead><tr>
        <th>Criteria</th>
        <th>Conformance Level</th>
        <th>Remarks and Explanations</th>
      </tr></thead>
      <tbody>${renderCriteriaRows(levelAA)}</tbody>
    </table>
  </div>

  <!-- ── Legal Disclaimer ── -->
  <div class="acr-disclaimer">
    <strong>Legal Disclaimer</strong>
    <p style="margin-top:8px">
      This Accessibility Conformance Report (ACR) was self-generated by
      <strong>${escapeHtml(org)}</strong> using the Accessiblü WCAG Check Ü browser extension
      and is provided for informational purposes only. It is not a professional accessibility
      audit, and it was not prepared, reviewed, or endorsed by Accessiblü or any of its
      affiliates as a consulting deliverable.
    </p>
    <p>
      All conformance assessments, remarks, and claims in this report reflect the independent
      judgment of <strong>${escapeHtml(org)}</strong> based on testing conducted with the
      methods described herein. <strong>${escapeHtml(org)}</strong> is solely responsible for
      the accuracy and completeness of this document. Accessiblü expressly disclaims all
      liability for the content of this ACR and any reliance placed upon it.
    </p>
    <p>
      This ACR does not constitute a legal guarantee of accessibility. Automated testing
      identifies approximately 30–40% of potential WCAG barriers; additional manual evaluation
      is required for comprehensive conformance assessment. User experiences may vary.
    </p>
    <p>
      VPAT® is a registered trademark of the Information Technology Industry Council (ITI).
      This document was produced using the Accessiblü WCAG Check Ü self-service tool and is
      not affiliated with, endorsed by, or reviewed by ITI.
    </p>
  </div>

  <div class="acr-footer">
    Self-generated by <strong>${escapeHtml(org)}</strong> using
    <a href="https://www.accessiblu.com" target="_blank" rel="noopener noreferrer">Accessiblü WCAG Check Ü</a>
    &nbsp;·&nbsp; axe-core 4.8.4 &nbsp;·&nbsp; ${escapeHtml(date)}
    &nbsp;·&nbsp; This ACR was not prepared by Accessiblü as a professional audit service.
  </div>

</div>
</body>
</html>`;

  download(html, `accessibility-conformance-report-${dateStamp()}.html`, 'text/html');
}

// ---------------------------------------------------------------------------
// Branded HTML Report export
// ---------------------------------------------------------------------------

async function getIconDataUrl() {
  const res  = await fetch(chrome.runtime.getURL('icons/icon128.png'));
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function exportHTMLReport() {
  if (!currentResults) { alert('Run a test first.'); return; }

  const iconDataUrl = await getIconDataUrl();
  const matrix    = buildVpatMatrix();
  const date      = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const url       = currentResults.url || 'Unknown URL';
  const level     = currentResults.level || 'AA';
  const violations = currentResults.violations || [];
  const overlays  = violations.filter(v => v.isOverlay);
  const axeViol   = violations.filter(v => !v.isOverlay);

  const critical = violations.filter(v => v.impact === 'critical' || v.isOverlay).length;
  const serious  = violations.filter(v => v.impact === 'serious').length;
  const moderate = violations.filter(v => v.impact === 'moderate').length;
  const minor    = violations.filter(v => v.impact === 'minor').length;
  const risk     = critical > 0 ? 'HIGH' : serious > 3 ? 'MEDIUM-HIGH' : serious > 0 || moderate > 2 ? 'MEDIUM' : 'LOW';
  const riskColor = critical > 0 ? '#dc2626' : risk === 'MEDIUM-HIGH' ? '#ea580c' : risk === 'MEDIUM' ? '#d97706' : '#16a34a';

  // Reviewed items
  const reviewedItems = currentResults.incomplete.map((item, idx) => ({
    ...item, review: manualReviews[idx] || null
  })).filter(item => item.review);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Accessiblü Automated Accessibility Assessment Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 14px; color: #1a1a1a; background: #fff; }
  .page { max-width: 900px; margin: 0 auto; padding: 0 32px 48px; }
  /* Header */
  .report-header { background: #000B5E; color: white; padding: 32px; margin: 0 -32px 40px; display: flex; align-items: center; gap: 20px; }
  .logo-mark { width: 56px; height: 56px; border-radius: 12px; overflow: hidden; flex-shrink: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.25); }
  .logo-mark img { width: 100%; height: 100%; display: block; }
  .logo-text { display: flex; flex-direction: column; }
  .logo-brand { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .logo-brand span { color: #93c5fd; }
  .logo-sub { font-size: 12px; opacity: 0.8; margin-top: 2px; }
  .report-meta { margin-left: auto; text-align: right; font-size: 13px; opacity: 0.9; }
  .report-meta strong { display: block; font-size: 15px; margin-bottom: 4px; }
  /* Sections */
  h2 { font-size: 18px; color: #000B5E; border-bottom: 2px solid #000B5E; padding-bottom: 8px; margin: 32px 0 16px; }
  h3 { font-size: 15px; color: #0A1C78; margin: 20px 0 10px; }
  p, li { line-height: 1.6; margin-bottom: 8px; }
  ul { padding-left: 24px; }
  .disclaimer { background: #fffbeb; border: 1px solid #fbbf24; border-radius: 8px; padding: 16px; font-size: 13px; color: #78350f; margin-bottom: 24px; }
  .disclaimer strong { display: block; margin-bottom: 4px; }
  /* Summary grid */
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 16px 0 24px; }
  .summary-card { text-align: center; padding: 16px; border-radius: 8px; }
  .summary-card .count { font-size: 36px; font-weight: 700; display: block; }
  .summary-card .label { font-size: 12px; font-weight: 500; }
  .card-critical { background: #fee2e2; } .card-critical .count, .card-critical .label { color: #7f1d1d; }
  .card-serious  { background: #fff7ed; } .card-serious  .count, .card-serious  .label { color: #7c2d12; }
  .card-moderate { background: #fffbeb; } .card-moderate .count, .card-moderate .label { color: #78350f; }
  .card-minor    { background: #f7fee7; } .card-minor    .count, .card-minor    .label { color: #14532d; }
  /* Risk badge */
  .risk-badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-weight: 700; font-size: 13px; color: white; background: ${riskColor}; }
  /* Overlay alert */
  .overlay-alert { background: #ede9fe; border: 2px solid #7c3aed; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .overlay-alert h3 { color: #4c1d95; margin-top: 0; }
  .overlay-alert p { color: #3b0764; }
  /* Finding cards */
  .finding { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 16px; border-left: 5px solid #ddd; }
  .finding.critical { border-left-color: #dc2626; background: #fef2f2; }
  .finding.serious  { border-left-color: #ea580c; background: #fff7ed; }
  .finding.moderate { border-left-color: #d97706; background: #fffbeb; }
  .finding.minor    { border-left-color: #65a30d; background: #f7fee7; }
  .finding-title    { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .finding-meta     { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; align-items: center; }
  .impact-tag       { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: white; }
  .tag-critical { background: #dc2626; } .tag-serious { background: #ea580c; }
  .tag-moderate { background: #d97706; } .tag-minor   { background: #65a30d; }
  .wcag-tag { background: #e5e7eb; color: #374151; padding: 2px 6px; border-radius: 3px; font-size: 11px; }
  .code-snippet { background: #f3f4f6; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 12px; overflow-x: auto; margin: 8px 0; word-break: break-all; }
  .learn-more { color: #000B5E; font-size: 13px; }
  /* Review results */
  .review-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .review-table th { background: #f3f4f6; text-align: left; padding: 8px; border: 1px solid #e5e7eb; }
  .review-table td { padding: 8px; border: 1px solid #e5e7eb; vertical-align: top; }
  .verdict-pass { color: #15803d; font-weight: 600; }
  .verdict-fail { color: #dc2626; font-weight: 600; }
  .verdict-na   { color: #6b7280; font-weight: 600; }
  /* VPAT matrix */
  .vpat-matrix { width: 100%; border-collapse: collapse; font-size: 12px; }
  .vpat-matrix th { background: #000B5E; color: white; padding: 8px; text-align: left; position: sticky; top: 0; }
  .vpat-matrix td { padding: 7px 8px; border: 1px solid #e5e7eb; vertical-align: top; }
  .vpat-matrix tr:nth-child(even) { background: #f9fafb; }
  .vpat-matrix td:last-child { font-style: italic; color: #374151; font-size: 11px; }
  .status-supports    { background: #dcfce7 !important; }
  .status-partial     { background: #fef9c3 !important; }
  .status-fail        { background: #fef2f2 !important; }
  .status-na          { background: #f3f4f6 !important; }
  .status-manual      { background: #fffbeb !important; }
  .status-noevals     { background: #f9fafb !important; color: #9ca3af; }
  /* Print */
  @media print {
    .report-header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .finding, .summary-card { break-inside: avoid; }
    h2 { break-before: auto; }
  }
  .page-break { page-break-before: always; }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <header class="report-header">
    <div class="logo-mark"><img src="${iconDataUrl}" alt=""></div>
    <div class="logo-text">
      <div class="logo-brand">Accessi<span>blü</span></div>
      <div class="logo-sub">Automated Accessibility Assessment Report</div>
    </div>
    <div class="report-meta">
      <strong>WCAG 2.2 Level ${escapeHtml(level)}</strong>
      ${escapeHtml(date)}<br>
      axe-core 4.8.4
    </div>
  </header>

  <!-- Disclaimer -->
  <div class="disclaimer">
    <strong>Disclaimer</strong>
    This report reflects the results of automated accessibility testing conducted on the evaluated page.
    Automated testing cannot identify all accessibility barriers and does not constitute a complete WCAG
    conformance assessment. Additional manual testing is required to determine overall accessibility
    conformance and user experience for individuals with disabilities.
  </div>

  <!-- Executive Summary -->
  <h2>Executive Summary</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px">
    <tr><td style="padding:6px;border:1px solid #e5e7eb;font-weight:600;width:180px">Page Tested</td><td style="padding:6px;border:1px solid #e5e7eb;word-break:break-all">${escapeHtml(url)}</td></tr>
    <tr><td style="padding:6px;border:1px solid #e5e7eb;font-weight:600">Test Date</td><td style="padding:6px;border:1px solid #e5e7eb">${escapeHtml(date)}</td></tr>
    <tr><td style="padding:6px;border:1px solid #e5e7eb;font-weight:600">WCAG Version / Level</td><td style="padding:6px;border:1px solid #e5e7eb">WCAG 2.2 Level ${escapeHtml(level)}</td></tr>
    <tr><td style="padding:6px;border:1px solid #e5e7eb;font-weight:600">Tool</td><td style="padding:6px;border:1px solid #e5e7eb">Accessiblü WCAG 2.2 Tester · axe-core 4.8.4</td></tr>
    <tr><td style="padding:6px;border:1px solid #e5e7eb;font-weight:600">Overall Risk</td><td style="padding:6px;border:1px solid #e5e7eb"><span class="risk-badge">${risk}</span></td></tr>
  </table>

  <!-- Testing Methodology -->
  <h2>Testing Methodology</h2>
  <p>Automated accessibility testing was conducted using <strong>axe-core 4.8.4</strong> by Deque Systems, the industry-standard open-source accessibility testing engine. Tests were executed via the Accessiblü WCAG 2.2 Tester Chrome extension in a desktop browser environment.</p>
  <p><strong>WCAG version:</strong> WCAG 2.2 · Conformance Level ${escapeHtml(level)}<br>
  <strong>Scope:</strong> Single page — ${escapeHtml(url)}</p>
  <p><strong>Limitations:</strong> Automated testing identifies approximately 30–40% of potential WCAG violations. Criteria requiring human judgment — including keyboard operability, screen reader compatibility, cognitive accessibility, and dynamic content behavior — require additional manual evaluation.</p>

  <!-- Findings Summary -->
  <h2>Findings Summary</h2>
  <div class="summary-grid">
    <div class="summary-card card-critical"><span class="count">${critical}</span><span class="label">Critical</span></div>
    <div class="summary-card card-serious"><span class="count">${serious}</span><span class="label">Serious</span></div>
    <div class="summary-card card-moderate"><span class="count">${moderate}</span><span class="label">Moderate</span></div>
    <div class="summary-card card-minor"><span class="count">${minor}</span><span class="label">Minor</span></div>
  </div>

  ${overlays.length ? `
  <!-- Overlay Warning -->
  <div class="overlay-alert">
    <h3>⚠ Accessibility Overlay Detected</h3>
    ${overlays.map(o => `<p><strong>${escapeHtml(o.overlayName)}</strong> — ${escapeHtml(o.description)}</p>`).join('')}
  </div>
  ` : ''}

  <!-- Detailed Findings -->
  <h2 class="page-break">Detailed Findings</h2>
  ${violations.length === 0 ? '<p>No violations were detected by automated testing.</p>' : ''}
  ${violations.map((v, i) => `
    <div class="finding ${v.isOverlay ? 'critical' : (v.impact || 'moderate')}">
      <div class="finding-title">${i + 1}. ${escapeHtml(v.help || v.description)}</div>
      <div class="finding-meta">
        ${v.isOverlay
          ? '<span class="impact-tag tag-critical">OVERLAY — CRITICAL</span>'
          : `<span class="impact-tag tag-${v.impact || 'moderate'}">${(v.impact || 'moderate').toUpperCase()}</span>`}
        ${(v.wcagTags || []).map(t => `<span class="wcag-tag">${escapeHtml(t)}</span>`).join('')}
        <span style="font-size:12px;color:#6b7280">${v.nodes.length} element${v.nodes.length !== 1 ? 's' : ''}</span>
      </div>
      <p>${escapeHtml(v.description)}</p>
      ${v.nodes[0] ? `<div class="code-snippet">${escapeHtml(v.nodes[0].html || '').substring(0, 300)}</div>` : ''}
      ${v.helpUrl ? `<a href="${escapeHtml(v.helpUrl)}" class="learn-more" target="_blank" rel="noopener noreferrer">WCAG guidance: ${escapeHtml(v.help || v.id)} ↗</a>` : ''}
    </div>
  `).join('')}

  <!-- Needs Review Results -->
  ${reviewedItems.length > 0 ? `
  <h2 class="page-break">Manual Review Results</h2>
  <table class="review-table">
    <thead><tr><th>Criterion</th><th>Description</th><th>Verdict</th><th>Notes</th></tr></thead>
    <tbody>
      ${reviewedItems.map(item => `
        <tr>
          <td>${(item.wcagTags || []).join(', ') || item.id}</td>
          <td>${escapeHtml(item.help || item.description)}</td>
          <td class="verdict-${item.review.verdict}">${item.review.verdict.toUpperCase()}</td>
          <td>${escapeHtml(item.review.notes || '')}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
  ` : ''}

  <!-- Manual Review Recommendations -->
  <h2>Manual Review Recommendations</h2>
  <p>The following areas require additional evaluation beyond what automated testing can provide:</p>
  <ul>
    <li><strong>Keyboard accessibility</strong> — Verify all interactive elements are reachable and operable by keyboard alone</li>
    <li><strong>Screen reader compatibility</strong> — Test with NVDA, JAWS (Windows) and VoiceOver (macOS/iOS)</li>
    <li><strong>Focus management</strong> — Confirm focus is managed appropriately during dynamic updates, modals, and SPAs</li>
    <li><strong>Error handling</strong> — Verify error messages are clear, associated with the relevant field, and announced to screen readers</li>
    <li><strong>Cognitive accessibility</strong> — Evaluate reading level, plain language, consistent navigation, and help availability</li>
    <li><strong>Dynamic content behavior</strong> — Test live regions, carousels, infinite scroll, and AJAX-loaded content</li>
    <li><strong>Touch and pointer interaction</strong> — Verify target sizes, gesture alternatives, and drag operations</li>
    <li><strong>Color and use of color</strong> — Confirm information is not conveyed by color alone</li>
  </ul>

  <!-- VPAT Readiness Matrix -->
  <h2 class="page-break">VPAT Readiness Matrix</h2>
  <p>The following matrix maps WCAG 2.2 Level A and AA Success Criteria to available automated evidence, recorded conformance levels, and auditor remarks.</p>
  <div style="overflow-x:auto">
    <table class="vpat-matrix">
      <thead><tr><th>SC</th><th>Criterion</th><th>Level</th><th>Auto Evidence</th><th>Conformance Level</th><th>Remarks and Explanations</th></tr></thead>
      <tbody>
        ${matrix.map(r => {
          const cls = r.conformanceLevel === 'Supports'           ? 'status-supports'
                    : r.conformanceLevel === 'Partially Supports' ? 'status-partial'
                    : r.conformanceLevel === 'Does Not Support'   ? 'status-fail'
                    : r.conformanceLevel === 'Not Applicable'     ? 'status-na'
                    : r.readiness === 'Needs Manual Verification' ? 'status-manual'
                    : 'status-noevals';
          return `<tr class="${cls}">
            <td><strong>${r.sc}</strong></td>
            <td>${escapeHtml(r.name)}</td>
            <td>${r.level}</td>
            <td>${r.automatedEvidence}</td>
            <td><strong>${escapeHtml(r.conformanceLevel)}</strong></td>
            <td>${escapeHtml(r.remark || '')}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
  <p style="font-size:12px;color:#6b7280;margin-top:12px"><em>The VPAT Readiness Matrix is not an Accessibility Conformance Report and does not make accessibility conformance claims. It identifies available evidence and testing gaps prior to formal VPAT development.</em></p>

  <footer style="margin-top:48px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;font-size:12px;color:#9ca3af">
    Generated by Accessiblü WCAG 2.2 Tester &mdash; ${escapeHtml(date)} &mdash; This report is confidential and intended for internal use only.
  </footer>

</div>
</body>
</html>`;

  download(html, `accessiblu-report-${dateStamp()}.html`, 'text/html');
}

