/**
 * Ü Check guided audit: a checklist for the current page, answered by the tester and synced to Ü Monitor.
 * Follows the team's audit method (docs/sheet-structure.md): each CHECK is answered once per ELEMENT GROUP as
 * yes / no / N/A / unsure, with how many instances were reviewed and how many failed.
 * The logic is plain functions (tested in Node). renderGuided() builds the markup; popup.js wires the events.
 */
(function (root) {
  'use strict';

  var RESULTS = [['yes', 'Yes, passes'], ['no', 'No, fails'], ['na', 'N/A'], ['unsure', 'Unsure']];
  var METHOD_NAMES = { auto: 'Automated scan', sr: 'Screen reader', keyboard: 'Keyboard', visual: 'Look', content: 'Judgment', pointer: 'Pointer', zoom: 'Zoom' };
  var STEP_SETS = [['keyboard', 'Keyboard'], ['jaws', 'JAWS'], ['nvda', 'NVDA'], ['voiceover', 'VoiceOver'], ['visual', 'Look and judge']];
  var PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  // Colors for "highlight all": each group gets one, and the legend also names the group, so color is never the only cue.
  var PALETTE = ['#d6008f', '#0057d9', '#008a4e', '#c25700', '#7b2cbf', '#b00020', '#007c91', '#5c6b00'];
  var isPageLevel = function (g) { return g.elementType === 'page' || g.elementType === 'text'; };

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var keyOf = function (groupCode, checkId) { return groupCode + '|' + checkId; };
  var uuid = function () { return (root.crypto || globalThis.crypto).randomUUID(); };
  var toInt = function (v) { var n = parseInt(v, 10); return isFinite(n) ? n : null; };

  function emptyDraft() { return { result: null, reviewedAll: true, instancesReviewed: '', instancesFailing: '', observation: '', evidence: [], clientResultId: uuid(), dirty: false, savedAt: null, error: '' }; }

  // Start from what the server already has for this round, then lay local unsaved work over it.
  function initialDrafts(checklist, localDrafts) {
    var drafts = {};
    (checklist.results || []).forEach(function (r) {
      drafts[keyOf(r.groupCode, r.checkId)] = {
        result: r.result, reviewedAll: r.reviewedAll !== false, instancesReviewed: r.instancesReviewed == null ? '' : String(r.instancesReviewed),
        instancesFailing: r.instancesFailing == null ? '' : String(r.instancesFailing), observation: r.observation || '',
        evidence: (r.evidence || []).map(function (e) { return { id: e.id, caption: e.caption || '', url: e.url || null }; }),
        clientResultId: r.clientResultId || uuid(), dirty: false, savedAt: r.testedAt || null, error: '',
      };
    });
    Object.keys(localDrafts || {}).forEach(function (k) { if (localDrafts[k] && localDrafts[k].dirty) drafts[k] = localDrafts[k]; });
    return drafts;
  }

  // The same rules the server applies, so a tester finds out now and not after syncing.
  function validateDraft(group, d) {
    if (!d || !d.result) return 'Choose a result.';
    var total = group.instances || 0, failing = toInt(d.instancesFailing), reviewed = toInt(d.instancesReviewed);
    if (d.result === 'no' && !(failing >= 1)) return 'Enter how many instances fail (at least 1).';
    if (d.result === 'no' && failing > (d.reviewedAll ? total : (reviewed == null ? total : reviewed))) return 'More instances fail than were reviewed.';
    if (!d.reviewedAll && d.result !== 'na') {
      if (reviewed == null || reviewed < 0) return 'Enter how many instances you reviewed.';
      if (reviewed > total) return 'You cannot review more than the ' + total + ' on the page.';
    }
    return null;
  }

  function toResultItem(group, check, d, pageId, testedAt) {
    var allReviewed = d.result === 'na' ? true : d.reviewedAll;
    var item = {
      clientResultId: d.clientResultId, pageId: pageId, groupCode: group.code, checkId: check.id, result: d.result,
      reviewedAll: allReviewed, testedAt: testedAt || new Date().toISOString(),
    };
    if (!allReviewed) item.instancesReviewed = toInt(d.instancesReviewed);
    if (d.result === 'no') item.instancesFailing = toInt(d.instancesFailing);
    if (d.observation && d.observation.trim()) item.observation = d.observation.trim();
    // screenshots attached to this answer; an empty list clears any that were removed
    if (d.evidence) item.evidenceIds = d.evidence.map(function (e) { return e.id; });
    return item;
  }

  // What to send: unsaved answers that pass validation. Invalid ones are reported back, not sent.
  function pendingItems(checklist, drafts, pageId) {
    var groups = {}, checks = {};
    checklist.groups.forEach(function (g) { groups[g.code] = g; });
    checklist.checks.forEach(function (c) { checks[c.id] = c; });
    var items = [], invalid = [];
    Object.keys(drafts).forEach(function (k) {
      var d = drafts[k]; if (!d.dirty) return;
      var parts = k.split('|'), g = groups[parts[0]], c = checks[parts[1]];
      if (!g || !c) return;
      var err = validateDraft(g, d);
      if (err) invalid.push({ key: k, error: err }); else items.push(toResultItem(g, c, d, pageId));
    });
    return { items: items, invalid: invalid };
  }

  function checksFor(group, checklist) { return checklist.checks.filter(function (c) { return c.elementType === group.elementType; }); }
  function hintFor(checklist, group, check) {
    var h = checklist.planHints || {};
    return h[keyOf(group.code, check.id)] || h['|' + check.id] || null;
  }

  // Other groups of the same kind of element (not the whole-page groups), for "apply this answer to the rest".
  function sameTypeGroups(checklist, group) {
    if (group.elementType === 'page' || group.elementType === 'text') return [];
    return checklist.groups.filter(function (g) { return g.elementType === group.elementType && g.code !== group.code; });
  }
  var BULK_RESULTS = { yes: 1, na: 1, unsure: 1 };   // a failure count belongs to one group, so No is never copied

  // Copy one answer to the other groups of the same type that have no answer yet. Answers already given are left alone.
  function applyToOthers(checklist, drafts, groupCode, checkId) {
    var from = drafts[keyOf(groupCode, checkId)];
    var group = checklist.groups.filter(function (g) { return g.code === groupCode; })[0];
    var out = { applied: [], skipped: [], error: null };
    if (!group || !from || !from.result || !BULK_RESULTS[from.result]) { out.error = 'Only Yes, N/A and Unsure can be applied to other groups.'; return out; }
    sameTypeGroups(checklist, group).forEach(function (g) {
      var k = keyOf(g.code, checkId), existing = drafts[k];
      if (existing && existing.result) { out.skipped.push(g.code); return; }
      var d = emptyDraft(); d.result = from.result; d.reviewedAll = true; d.dirty = true;
      drafts[k] = d; out.applied.push(g.code);
    });
    return out;
  }

  function progress(checklist, drafts) {
    var total = 0, answered = 0, unsaved = 0, byGroup = {};
    checklist.groups.forEach(function (g) {
      var t = 0, a = 0;
      checksFor(g, checklist).forEach(function (c) {
        t++; var d = drafts[keyOf(g.code, c.id)];
        if (d && d.result) a++;
        if (d && d.dirty) unsaved++;
      });
      byGroup[g.code] = { total: t, answered: a }; total += t; answered += a;
    });
    return { total: total, answered: answered, unsaved: unsaved, byGroup: byGroup };
  }

  // Highest-priority work first (from the AI plan, when there is one), then the biggest groups; whole-page last.
  function orderGroups(checklist) {
    var rank = function (g) {
      var best = 3;
      checksFor(g, checklist).forEach(function (c) { var h = hintFor(checklist, g, c); if (h && PRIORITY_RANK[h.priority] < best) best = PRIORITY_RANK[h.priority]; });
      return best;
    };
    var pageLevel = function (g) { return g.elementType === 'page' || g.elementType === 'text' ? 1 : 0; };
    return checklist.groups.slice().sort(function (x, y) {
      return pageLevel(x) - pageLevel(y) || rank(x) - rank(y) || (y.instances || 0) - (x.instances || 0) || String(x.code).localeCompare(String(y.code));
    });
  }

  function isVisible(filter, checklist, group, check, drafts) {
    var d = drafts[keyOf(group.code, check.id)];
    if (filter === 'open') return !(d && d.result);
    if (filter === 'priority') { var h = hintFor(checklist, group, check); return !!h && h.priority === 'high'; }
    return true;
  }

  var MAX_SHOTS = 5;
  var MAX_FILE_BYTES = 5.5 * 1024 * 1024;   // under the server's 6 MB limit
  // Can this file be attached as a screenshot? Plain words, or null when it is fine. The server checks again.
  function checkImageFile(f) {
    if (!f) return 'Choose an image file.';
    if (f.type !== 'image/png' && f.type !== 'image/jpeg') return 'Choose a PNG or JPEG image.';
    if (!f.size) return 'That file is empty.';
    if (f.size > MAX_FILE_BYTES) return 'That file is larger than 5 MB. Save it smaller and try again.';
    return null;
  }
  function renderShots(d, k, check, group) {
    var shots = d.evidence || [];
    return '<div class="g-shots">' +
      '<button type="button" class="secondary-btn g-shot-btn" data-action="shot" data-key="' + esc(k) + '"' + (shots.length >= MAX_SHOTS ? ' disabled' : '') + '>Take a screenshot of the page' + (shots.length ? ' (' + shots.length + ' attached)' : '') + '</button>' +
      (shots.length >= MAX_SHOTS ? '<span class="g-hint">Five screenshots is the most for one check.</span>' : '<label class="g-field g-file">Or attach an image file from this computer <input type="file" accept="image/png,image/jpeg" data-action="shot-file" data-key="' + esc(k) + '"></label>') +
      shots.map(function (s, i) {
        return '<figure class="g-shot" data-shot="' + esc(s.id) + '">' +
          (s.url ? '<img src="' + esc(s.url) + '" alt="' + esc(s.caption || ('Screenshot ' + (i + 1) + ' for ' + check.id + ' on ' + group.code)) + '">' : '<p class="g-hint">Screenshot saved. A preview is not available right now.</p>') +
          '<figcaption><label class="g-field">Describe what this screenshot shows <input type="text" data-shot-caption="' + esc(s.id) + '" value="' + esc(s.caption) + '"></label>' +
          '<button type="button" class="secondary-btn" data-action="shot-remove" data-key="' + esc(k) + '" data-id="' + esc(s.id) + '">Remove screenshot ' + (i + 1) + '</button></figcaption></figure>';
      }).join('') + '</div>';
  }

  function renderCheck(checklist, group, check, drafts) {
    var k = keyOf(group.code, check.id), d = drafts[k] || emptyDraft(), id = 'ga-' + k.replace(/[^a-z0-9]/gi, '-');
    var h = hintFor(checklist, group, check);
    var total = group.instances || 0;
    var steps = h ? STEP_SETS.filter(function (s) { return (h.steps[s[0]] || []).length; }).map(function (s) {
      return '<p class="g-method">' + s[1] + '</p><ol>' + h.steps[s[0]].map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol>';
    }).join('') : '';
    var needsCounts = d.result && d.result !== 'na';
    var status = d.error ? '<span class="g-error">' + esc(d.error) + '</span>' : d.dirty ? 'Not saved yet' : d.result ? 'Saved' : '';
    return '<fieldset class="g-check" data-key="' + esc(k) + '">' +
      '<legend>' + esc(check.ask) + (h ? ' <span class="g-pri g-pri-' + esc(h.priority) + '">' + esc(h.priority) + ' priority</span>' : '') + '</legend>' +
      '<p class="g-look">' + esc(check.look) + '</p>' +
      '<p class="g-meta">Method: ' + esc(check.modes.map(function (m) { return METHOD_NAMES[m] || m; }).join(', ')) + '. Criteria: ' + esc(check.criteria.join(', ')) + '.</p>' +
      (h ? '<details><summary>Why it matters here and how to test it (AI draft)</summary><p>' + esc(h.whyHere) + '</p>' + steps + '</details>' : '') +
      '<div class="g-results" role="radiogroup" aria-label="Result for ' + esc(check.id) + ' on ' + esc(group.code) + '">' +
        RESULTS.map(function (r) {
          return '<label class="g-radio"><input type="radio" name="' + id + '" value="' + r[0] + '" data-field="result"' + (d.result === r[0] ? ' checked' : '') + '> ' + r[1] + '</label>';
        }).join('') + '</div>' +
      (d.result === 'no' ? '<label class="g-field">How many of the ' + total + ' fail? <input type="number" min="1" max="' + total + '" inputmode="numeric" data-field="instancesFailing" value="' + esc(d.instancesFailing) + '"></label>' : '') +
      (needsCounts ? '<label class="g-check-box"><input type="checkbox" data-field="reviewedAll"' + (d.reviewedAll ? ' checked' : '') + '> I reviewed all ' + total + ' instance' + (total === 1 ? '' : 's') + '</label>' : '') +
      (needsCounts && !d.reviewedAll ? '<label class="g-field">How many did you review? <input type="number" min="0" max="' + total + '" inputmode="numeric" data-field="instancesReviewed" value="' + esc(d.instancesReviewed) + '"></label>' : '') +
      (d.result ? '<label class="g-field">What you saw (optional) <textarea rows="2" data-field="observation">' + esc(d.observation) + '</textarea></label>' : '') +
      (group.elementType !== 'page' && group.elementType !== 'text' ? '<button type="button" class="secondary-btn g-show" data-action="hl-show" data-key="' + esc(k) + '">Show these ' + total + ' on the page</button>' : '<p class="g-hint">This check is about the whole page, so there is nothing to highlight.</p>') +
      (d.result && BULK_RESULTS[d.result] && sameTypeGroups(checklist, group).length ? '<button type="button" class="secondary-btn g-apply" data-action="apply" data-key="' + esc(k) + '">Apply this answer to the other ' + sameTypeGroups(checklist, group).length + ' group' + (sameTypeGroups(checklist, group).length === 1 ? '' : 's') + ' of the same kind (' + esc(group.elementType) + ')</button><span class="g-hint">Use this only if you checked every instance in them. Groups that already have an answer are left alone.</span>' : '') +
      renderShots(d, k, check, group) +
      '<p class="g-status" aria-live="polite">' + status + '</p>' +
    '</fieldset>';
  }

  function renderGuided(container, state) {
    var checklist = state.checklist, drafts = state.drafts, p = progress(checklist, drafts);
    var groups = orderGroups(checklist);
    var onlyPageLevel = checklist.groups.every(function (g) { return g.elementType === 'page' || g.elementType === 'text'; });
    var html =
      '<h3 id="guidedHeading">Guided audit: ' + esc(checklist.page.code) + ' ' + esc(checklist.page.name) + '</h3>' +
      (onlyPageLevel ? '<p class="monitor-hint">Only whole-page checks are listed. Run the Element Inventory and send it from the Ü Monitor tab to add links, buttons, forms and the rest, then reload.</p>' : '') +
      '<p id="guidedProgress" class="tool-status" role="status">' + p.answered + ' of ' + p.total + ' checks answered' + (p.unsaved ? ', ' + p.unsaved + ' not saved yet' : '') + '.</p>' +
      '<div class="g-hlall"><div class="monitor-plan-actions"><button type="button" class="secondary-btn" data-action="hl-all">Highlight all groups on the page</button>' +
        (state.hlAll ? '<button type="button" class="secondary-btn" data-action="hl-clear-all">Clear highlights</button>' : '') + '</div>' +
        (state.hlAll ? '<p id="guidedHlAllStatus" class="g-hl-status">' + esc(state.hlAll.message) + '</p><ul class="g-legend">' + state.hlAll.legend.map(function (l) {
          return '<li><span class="g-swatch" style="background:' + esc(l.color) + '" aria-hidden="true"></span> ' + esc(l.code) + ', ' + esc(l.type) + ': ' + l.found + ' found' + (l.found === l.expected ? '' : ' of ' + l.expected + ' counted') + '</li>';
        }).join('') + '</ul>' : '') + '</div>' +
      '<div class="control"><label for="guidedFilter">Show</label><select id="guidedFilter" data-action="filter">' +
        [['all', 'All checks'], ['open', 'Not answered yet'], ['priority', 'High priority from the AI plan']].map(function (o) { return '<option value="' + o[0] + '"' + (state.filter === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="monitor-plan-actions"><button type="button" class="primary-btn" data-action="save">Save answers to Ü Monitor</button><button type="button" class="secondary-btn" data-action="reload">Reload checklist</button></div>' +
      '<p id="guidedSaveStatus" class="tool-status" role="status"></p>' +
      groups.map(function (g) {
        var checks = checksFor(g, checklist).filter(function (c) { return isVisible(state.filter, checklist, g, c, drafts); });
        var gp = p.byGroup[g.code] || { total: 0, answered: 0 };
        var label = g.elementType === 'page' ? 'Whole page' : g.elementType === 'text' ? 'Text on the page' : g.code + ', ' + g.elementType + ', ' + g.instances + ' on the page' + (g.description ? ' (' + g.description + ')' : '');
        var hl = state.hl && state.hl.groupCode === g.code ? state.hl : null;
        var hlBar = hl ? '<div class="g-hl" role="group" aria-label="Elements shown on the page"><p id="guidedHlStatus" class="g-hl-status">' + esc(hl.message || '') + '</p>' +
          (hl.items && hl.items.length ? '<div class="g-hl-buttons"><button type="button" class="secondary-btn" data-action="hl-prev">Previous element</button><button type="button" class="secondary-btn" data-action="hl-next">Next element</button><button type="button" class="secondary-btn" data-action="hl-focus">Move keyboard focus to it on the page</button>' : '<div class="g-hl-buttons">') +
          '<button type="button" class="secondary-btn" data-action="hl-clear">Clear highlights</button></div>' +
          (hl.items && hl.items.length ? '<p class="g-hint">Moving keyboard focus to the page can close this popup. Your answers are kept. Pop the window out first if you want it to stay open.</p>' : '') + '</div>' : '';
        return '<details class="g-group"' + ((state.open && state.open[g.code]) || hl ? ' open' : '') + ' data-group="' + esc(g.code) + '"><summary>' + esc(label) + ': ' + gp.answered + ' of ' + gp.total + ' answered</summary>' + hlBar +
          (checks.length ? checks.map(function (c) { return renderCheck(checklist, g, c, drafts); }).join('') : '<p class="monitor-hint">No checks to show here with this filter.</p>') + '</details>';
      }).join('');
    container.innerHTML = html;
  }

  var api = { checkImageFile: checkImageFile, MAX_FILE_BYTES: MAX_FILE_BYTES, MAX_SHOTS: MAX_SHOTS, PALETTE: PALETTE, isPageLevel: isPageLevel, sameTypeGroups: sameTypeGroups, applyToOthers: applyToOthers, RESULTS: RESULTS, keyOf: keyOf, emptyDraft: emptyDraft, initialDrafts: initialDrafts, validateDraft: validateDraft, toResultItem: toResultItem, pendingItems: pendingItems, checksFor: checksFor, progress: progress, orderGroups: orderGroups, isVisible: isVisible, renderGuided: renderGuided };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UCheckGuided = api;
})(typeof window !== 'undefined' ? window : globalThis);
