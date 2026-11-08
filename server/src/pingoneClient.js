// The Real pull: READ-ONLY calls to PingOne's own API, owner-run (a button, never automatic).
//   POST  https://auth.pingone.<region>/<env>/as/token          client_credentials: this is authentication, not a change to PingOne
//   GET   https://api.pingone.<region>/v1/environments/<env>/subscriptions
//   GET   https://api.pingone.<region>/v1/environments/<env>/activities?limit=..&filter=recordedat ge "<iso>"
// There is no other method and no other path. Each request: manual redirects (a 3xx is an error), a timeout, a response size cap.
// The client secret stays inside this closure; errors are scrubbed of it before they leave.
import { scrubber } from './sinks/elasticsearch.js';

export const MAX_ACTIVITIES = 500; // measured 2026-11-07: the API refuses a larger limit (see FACTS)
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

async function readCapped(res, max) {
  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader(); const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); n += value.length;
      if (n > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('response too large'); }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const t = String(await res.text());
  if (t.length > max) throw new Error('response too large');
  return t;
}

export class PingOneError extends Error {
  constructor(code, detail, status = 502) { super(detail); this.code = code; this.detail = detail; this.status = status; }
}

export function createPingOneClient({ cfg, fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now, extraSecrets = [] }) {
  const scrub = scrubber([cfg.secret, cfg.clientId, ...extraSecrets]);
  let token = null; let tokenUntil = 0;
  const traces = []; // [{ method, host, path, status, bytes }]: shown in the hops panel, never a header or a token

  async function call(host, method, p, { headers = {}, body } = {}) {
    let res;
    try {
      res = await fetchImpl(`https://${host}${p}`, { method, redirect: 'manual', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) { throw new PingOneError('unreachable', scrub(`could not reach ${host}: ${e?.cause?.code || e?.code || e?.name || 'error'}`)); }
    let text = '';
    try { text = await readCapped(res, MAX_BYTES); } catch (e) { throw new PingOneError('bad_response', scrub(String(e?.message || 'unreadable response'))); }
    traces.push({ method, host, path: p.split('?')[0], status: res.status, bytes: text.length });
    if (res.status >= 300 && res.status < 400) throw new PingOneError('redirect_refused', 'PingOne answered with a redirect, which is refused', 502);
    if (res.status === 401 || res.status === 403) throw new PingOneError('pingone_refused', `PingOne refused the request (${res.status}). Check that the worker app has read access to subscriptions and activities.`, 502);
    if (res.status < 200 || res.status >= 300) throw new PingOneError('pingone_error', scrub(`PingOne answered ${res.status}: ${text}`), 502);
    try { return JSON.parse(text); } catch { throw new PingOneError('bad_response', 'PingOne answered with something that is not JSON'); }
  }

  async function bearer() {
    if (token && now() < tokenUntil) return token;
    const form = 'grant_type=client_credentials';
    const basic = Buffer.from(`${cfg.clientId}:${cfg.secret}`).toString('base64');
    const j = await call(cfg.authHost, 'POST', `/${cfg.envId}/as/token`, { headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, body: form });
    if (typeof j.access_token !== 'string') throw new PingOneError('pingone_error', 'PingOne answered the token request without an access token');
    token = j.access_token; tokenUntil = now() + Math.max(30, Math.min(Number(j.expires_in) || 300, 3600) - 30) * 1000;
    return token;
  }
  const get = async (p) => call(cfg.apiHost, 'GET', p, { headers: { authorization: `Bearer ${await bearer()}` } });

  return {
    traces,
    // The fields the Delivery panel shows. Nothing else from the subscription (headers, auth settings) is read out.
    async subscriptions() {
      const j = await get(`/v1/environments/${cfg.envId}/subscriptions`);
      return (j?._embedded?.subscriptions ?? []).slice(0, 50).map((s) => {
        let dest = null; try { const u = new URL(s?.httpEndpoint?.url); dest = `${u.protocol}//${u.host}${u.pathname}`; } catch { /* no URL */ }
        const cs = s?.connectionStatus || {};
        return {
          id: String(s?.id ?? '').slice(0, 60), name: scrub(s?.name, 80), enabled: s?.enabled === true, format: scrub(s?.format, 40),
          destination: dest ? scrub(dest, 200) : null, filterCount: Array.isArray(s?.filterOptions?.includedActionTypes) ? s.filterOptions.includedActionTypes.length : null,
          connectionStatus: { status: scrub(cs.status, 30) || null, lastAttemptedAt: cs.lastAttemptedAt ?? null, lastSuccessfulAt: cs.lastSuccessfulAt ?? null, lastResponseCode: scrub(cs.lastResponseCode, 12) || null, lastResponseDetails: scrub(cs.lastResponseDetails, 100) || null },
        };
      });
    },
    // Raw activity objects since `sinceMs` ago (newest first as PingOne returns them). The caller parses them.
    async activities({ sinceMs = 36 * 3600e3, limit = MAX_ACTIVITIES } = {}) {
      const since = new Date(now() - sinceMs).toISOString();
      const q = `limit=${Math.max(1, Math.min(limit, MAX_ACTIVITIES))}&filter=${encodeURIComponent(`recordedat ge "${since}"`)}`;
      const j = await get(`/v1/environments/${cfg.envId}/activities?${q}`);
      return Array.isArray(j?._embedded?.activities) ? j._embedded.activities : [];
    },
  };
}

// Counts failed deliveries per subscription from a batch of raw activities (EVENT_DELIVERY.FAILED, resource type SUBSCRIPTION).
export function failedDeliveries(activities) {
  const by = new Map(); let total = 0;
  for (const a of activities) {
    if (a?.action?.type !== 'EVENT_DELIVERY.FAILED') continue;
    total += 1;
    const sub = (a.resources || []).find((r) => r?.type === 'SUBSCRIPTION');
    const key = String(sub?.name || sub?.id || 'unknown').slice(0, 80);
    const row = by.get(key) || { subscription: key, count: 0, lastReason: null, lastAt: null };
    row.count += 1;
    if (!row.lastAt || String(a.recordedAt) > row.lastAt) { row.lastAt = a.recordedAt ?? null; row.lastReason = String(a.result?.description || a.result?.reason || '').slice(0, 120) || null; }
    by.set(key, row);
  }
  return { total, bySubscription: [...by.values()] };
}
