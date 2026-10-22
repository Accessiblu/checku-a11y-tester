/**
 * Conformance suggestion rule for Ü Check and Ü Monitor, following the ITI VPAT definitions.
 * The output is a SUGGESTION. A tester confirms every verdict.
 *
 * Counts are per criterion, in "criterion instances": one element, page, or flow evaluated against one
 * criterion. N/A instances are excluded.
 *
 *   Supports           no known failures (after tester confirmation)
 *   Partially Supports some instances fail, but not the majority
 *   Does Not Support   failures are the majority (more than 50% of instances)
 *
 * Override: blockedFlow means a primary task (checkout, login, sign-up) cannot be completed, for example
 * with a screen reader. Suggest Does Not Support, because the ITI measures functionality, not instance counts.
 *
 * Tested by docs/conformance-rule.test.mjs. portal/lib/conformance.ts must give the same answers.
 */
(function (root) {
  'use strict';
  function suggestConformance(o) {
    var pass = (o && o.pass) || 0, fail = (o && o.fail) || 0, unresolved = (o && o.unresolved) || 0, blockedFlow = !!(o && o.blockedFlow);
    var applicable = pass + fail;
    if (unresolved > 0) return { suggestion: 'Testing Pending', reason: unresolved + ' instance(s) still unanswered.' };
    if (applicable === 0) return { suggestion: null, reason: 'No applicable instances recorded. Mark Not Applicable only if a tester confirms.' };
    var counts = pass + ' of ' + applicable + ' instances pass (' + fail + ' fail).';
    if (blockedFlow) return { suggestion: 'Does Not Support', reason: 'A primary task cannot be completed. ' + counts };
    if (fail === 0) return { suggestion: 'Supports', reason: counts };
    if (fail * 2 > applicable) return { suggestion: 'Does Not Support', reason: 'Failures are the majority. ' + counts };
    return { suggestion: 'Partially Supports', reason: counts };
  }
  var api = { suggestConformance: suggestConformance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UCheckConformance = api;
})(typeof window !== 'undefined' ? window : globalThis);
