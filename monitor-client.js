/**
 * Ü Check client for the Ü Monitor API (see docs/monitor/openapi.yaml).
 * Pure functions plus a small fetch wrapper. No DOM and no chrome.*, so Node can test them.
 */
(function (root) {
  'use strict';

  const VERDICTS = {
    'Supports': 'supports',
    'Partially Supports': 'partially_supports',
    'Does Not Support': 'does_not_support',
    'Not Applicable': 'not_applicable',
  };
  const IMPACTS = ['minor', 'moderate', 'serious', 'critical'];
  const MAX_NODES = 200;
  const MAX_HTML = 2000;

  const uuid = () => (root.crypto || globalThis.crypto).randomUUID();

  // axe-style results from content.js (violations only) -> POST /audits/{id}/scans
  function buildScanPayload(results, { pageId, engineVersion, clientScanId, ranAt } = {}) {
    return {
      clientScanId: clientScanId || uuid(),
      pageId,
      url: results.url,
      engine: 'axe-core',
      engineVersion,
      ranAt: ranAt || results.timestamp || new Date().toISOString(),
      summary: results.summary && {
        violations: results.summary.violations, passes: results.summary.passes,
        incomplete: results.summary.incomplete, inapplicable: results.summary.inapplicable,
      },
      // how many elements each criterion checked, passed, failed and left undecided (criterion-counts.js)
      ...(results.criteriaCounts ? { criteria: results.criteriaCounts } : {}),
      violations: (results.violations || []).map(v => ({
        ruleId: v.id,
        ...(IMPACTS.includes(v.impact) ? { impact: v.impact } : {}),
        nodes: (v.nodes || []).slice(0, MAX_NODES).map(n => ({
          selector: Array.isArray(n.target) ? n.target.join(' ') : String(n.target || ''),
          html: (n.html || '').slice(0, MAX_HTML),
          failureSummary: n.failureSummary || '',
        })),
      })),
    };
  }

  // merged inventory (inventory-report.js) -> PUT /audits/{id}/pages/{pageId}/inventory
  function buildInventoryPayload(merged) {
    const groups = [];
    const uncounted = [];
    merged.types.forEach(t => {
      t.groups.forEach(g => {
        if (!g.count) return;
        const where = g.frameUrl ? ` (inside frame ${g.frameUrl})` : '';
        groups.push({
          elementType: t.id,
          signature: g.signature + (g.frameUrl ? '|' + g.frameUrl : ''),
          description: (g.description || g.signature) + where,
          instances: g.count,
          identicalCopiesElsewhere: 0,
        });
      });
      if (t.hidden) uncounted.push({ reason: 'hidden-until-opened', detail: `${t.hidden} hidden ${t.name.toLowerCase()} not counted` });
    });
    (merged.approximate || []).forEach(a => uncounted.push({ reason: 'other', detail: `Approximate only: ${a.label} (${a.count})` }));
    (merged.limits || []).forEach(l => uncounted.push({ reason: 'other', detail: l }));
    return { scannedAt: merged.timestamp || new Date().toISOString(), groups, uncounted };
  }

  // popup.js vpatVerdicts { '1.1.1': {conformance, remark} } -> POST /audits/{id}/verdicts:batch
  function buildVerdictBatch(vpatVerdicts, standard) {
    return {
      standard: standard || 'wcag22',
      verdicts: Object.entries(vpatVerdicts || {})
        .filter(([, v]) => v && VERDICTS[v.conformance])
        .map(([criterionId, v]) => ({ criterionId, verdict: VERDICTS[v.conformance], remark: v.remark || '' })),
    };
  }

  class MonitorError extends Error {
    constructor(message, status, body) { super(message); this.name = 'MonitorError'; this.status = status; this.body = body; }
  }

  const trimSlash = u => String(u || '').replace(/\/+$/, '');
  async function readBody(res) {
    const text = await res.text();
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }

  // Sign in with email and password. The API tells the extension where Supabase Auth lives (GET /config).
  // The password is sent only to Supabase Auth and is never stored. Returns a session to keep.
  async function signIn({ baseUrl, email, password, fetchImpl }) {
    const f = fetchImpl || ((...a) => root.fetch(...a));
    const cfgRes = await f(trimSlash(baseUrl) + '/config');
    const cfg = await readBody(cfgRes);
    if (!cfgRes.ok || !cfg || !cfg.supabaseUrl) throw new MonitorError('Could not reach Ü Monitor at that address.', cfgRes.status);
    const res = await f(trimSlash(cfg.supabaseUrl) + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.publishableKey },
      body: JSON.stringify({ email, password }),
    });
    const data = await readBody(res);
    if (!res.ok || !data || !data.access_token) {
      throw new MonitorError(res.status === 400 ? 'The email or password is not correct.' : 'Sign in failed. Try again.', res.status);
    }
    return toSession(data, cfg);
  }

  function toSession(data, cfg) {
    return {
      accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      supabaseUrl: cfg.supabaseUrl, publishableKey: cfg.publishableKey,
      user: data.user ? { id: data.user.id, email: data.user.email } : undefined,
    };
  }

  // session: from signIn(). onSession is called whenever the tokens are renewed, so the caller can keep them.
  function createClient({ baseUrl, session, onSession, fetchImpl }) {
    const f = fetchImpl || ((...a) => root.fetch(...a));
    const base = trimSlash(baseUrl);
    let current = session || null;

    async function refresh() {
      if (!current || !current.refreshToken) throw new MonitorError('Signed out. Connect to Ü Monitor again.', 401);
      const res = await f(trimSlash(current.supabaseUrl) + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: current.publishableKey },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      });
      const data = await readBody(res);
      if (!res.ok || !data || !data.access_token) throw new MonitorError('Signed out. Connect to Ü Monitor again.', 401);
      current = { ...toSession(data, current), user: current.user };
      if (onSession) onSession(current);
    }

    async function call(method, path, body, retried) {
      if (current && current.expiresAt - Date.now() < 60000) await refresh();
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (current) headers.Authorization = 'Bearer ' + current.accessToken;
      const res = await f(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await readBody(res);
      if (res.status === 401 && !retried && current) { await refresh(); return call(method, path, body, true); }
      if (res.status === 401) throw new MonitorError('Signed out. Connect to Ü Monitor again.', 401, data);
      if (!res.ok) throw new MonitorError((data && (data.message || data.error)) || `Request failed (${res.status}).`, res.status, data);
      return { status: res.status, data };
    }
    return {
      context: url => call('GET', '/context?url=' + encodeURIComponent(url)).then(r => r.data),
      catalog: auditId => call('GET', `/audits/${auditId}/catalog`).then(r => r.data),
      addPage: (auditId, page) => call('POST', `/audits/${auditId}/pages`, page).then(r => r.data),
      putInventory: (auditId, pageId, payload) => call('PUT', `/audits/${auditId}/pages/${pageId}/inventory`, payload).then(r => r.data),
      postScan: (auditId, payload) => call('POST', `/audits/${auditId}/scans`, payload).then(r => r.data),
      postVerdicts: (auditId, payload) => call('POST', `/audits/${auditId}/verdicts:batch`, payload).then(r => r.data),
      checklist: (auditId, pageId) => call('GET', `/audits/${auditId}/pages/${pageId}/checklist`).then(r => r.data),
      // AI draft test plan for one page (needs the client's AI switch on; the server checks).
      planPage: (auditId, pageId) => call('POST', `/audits/${auditId}/test-plan`, { pageId }).then(r => r.data),
      uploadEvidence: (auditId, payload) => call('POST', `/audits/${auditId}/evidence`, payload).then(r => r.data),
      updateEvidence: (id, caption) => call('PATCH', `/evidence/${id}`, { caption }).then(r => r.data),
      deleteEvidence: id => call('DELETE', `/evidence/${id}`).then(r => r.data),
      decidePlan: (runId, decision) => call('PATCH', `/ai-runs/${runId}`, { decision }).then(r => r.data),
      postResults: (auditId, payload) => call('POST', `/audits/${auditId}/results:batch`, payload).then(r => r.data),
    };
  }

  const api = { VERDICTS, buildScanPayload, buildInventoryPayload, buildVerdictBatch, signIn, createClient, MonitorError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UMonitorClient = api;
})(typeof window !== 'undefined' ? window : globalThis);
