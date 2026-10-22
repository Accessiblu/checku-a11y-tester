/**
 * Counts, for each WCAG success criterion, how many elements the automated scan checked and how many
 * passed, failed, or could not be decided. Teams use these counts to choose a conformance level, for
 * example "17 of 20 elements pass" for Partially Supports.
 *
 * Input is the scan result from content.js (axe-core nodes, each with a `target`) and a map of
 * criterion -> axe rule ids (the curated map in popup.js). Pure functions, no DOM, tested in Node.
 *
 * How elements are counted:
 *  - An element is one distinct `target` (its selector path). One element checked by several rules for the
 *    same criterion counts once.
 *  - fail:       the element failed at least one rule for the criterion.
 *  - unresolved: the element needs review for a rule (and did not fail another). It is not counted as a pass.
 *  - pass:       the element passed every rule that checked it.
 *  - applicable: pass + fail + unresolved, the number of elements the automated rules looked at.
 * These are AUTOMATED counts only. axe covers part of what most criteria require, so manual checks can add
 * more elements. Criteria with no automated rules have no counts here.
 */
(function (root) {
  'use strict';

  var keyOf = function (node) { return JSON.stringify(node && node.target != null ? node.target : node && node.html || ''); };

  function indexByRule(list) {
    var map = {};
    (list || []).forEach(function (r) { map[r.id] = r.nodes || []; });
    return map;
  }

  function computeCriterionCounts(results, criteriaRules) {
    var fail = indexByRule(results && results.violations);
    var pass = indexByRule(results && results.passes);
    var inc  = indexByRule(results && results.incomplete);
    var out = {};

    Object.keys(criteriaRules || {}).forEach(function (sc) {
      var ruleIds = criteriaRules[sc] || [];
      if (!ruleIds.length) return;
      var failSet = {}, passSet = {}, incSet = {}, rules = [], noElements = [];

      ruleIds.forEach(function (id) {
        var f = fail[id] || [], p = pass[id] || [], i = inc[id] || [];
        f.forEach(function (n) { failSet[keyOf(n)] = 1; });
        p.forEach(function (n) { passSet[keyOf(n)] = 1; });
        i.forEach(function (n) { incSet[keyOf(n)] = 1; });
        if (f.length + p.length + i.length) rules.push({ id: id, pass: p.length, fail: f.length, unresolved: i.length });
        else noElements.push(id);
      });

      var failN = Object.keys(failSet).length;
      var unresolvedKeys = Object.keys(incSet).filter(function (k) { return !failSet[k]; });
      var passKeys = Object.keys(passSet).filter(function (k) { return !failSet[k] && !incSet[k]; });
      var applicable = failN + unresolvedKeys.length + passKeys.length;
      // a criterion with automated rules but nothing to check on this page is still worth reporting
      out[sc] = { pass: passKeys.length, fail: failN, unresolved: unresolvedKeys.length, applicable: applicable, rules: rules, rulesWithNoElements: noElements };
    });
    return out;
  }

  // "17 of 20 elements pass (3 fail)" style sentence for a criterion's counts.
  function describeCounts(c) {
    if (!c) return 'No automated checks for this criterion.';
    if (!c.applicable) return 'Automated checks found no elements to test on this page.';
    var parts = [c.pass + ' of ' + c.applicable + ' element' + (c.applicable === 1 ? '' : 's') + ' pass'];
    var extra = [];
    if (c.fail) extra.push(c.fail + ' fail');
    if (c.unresolved) extra.push(c.unresolved + ' need review');
    return parts[0] + (extra.length ? ' (' + extra.join(', ') + ')' : '');
  }

  var api = { computeCriterionCounts: computeCriterionCounts, describeCounts: describeCounts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UCheckCriterionCounts = api;
})(typeof window !== 'undefined' ? window : globalThis);
