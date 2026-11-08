// Forward events to ONE Elasticsearch / OpenSearch cluster through its bulk API. This is the only sink and the only external write
// this app can make; there is no plug-in layer. Interface: createElasticsearchSink(...) -> { enqueue, drain, status, testConnection, stop }.
//
//   - The receiver stores an event FIRST and answers PingOne, then calls enqueue(): it never waits for this module.
//   - Documents use the eventId as `_id` (op "index"), so a redelivery or a retry overwrites the same document: idempotent.
//   - Bounded in memory: the queue holds maxQueue events and drops the OLDEST when full (counted in `dropped`); a batch is
//     retried at most maxRetries times with capped exponential backoff, then counted in `failed`.
//   - A down cluster (429, 5xx, unreachable) only changes the counters. Nothing here throws into the caller.
//   - Contacts exactly the one configured origin: manual redirects (a 3xx is a failure), a timeout, a response size cap. Credentials
//     live inside this closure; every message that leaves it is scrubbed of them.
import { createHash } from 'node:crypto';

export const DEFAULTS = { maxQueue: 1000, batchSize: 50, maxRetries: 3, baseDelayMs: 500, maxDelayMs: 5000, timeoutMs: 5000, flushDelayMs: 250, maxResponseBytes: 65536 };
const RETRY_STATUS = (s) => s === 429 || s >= 500;

// The flat, query-friendly document. The raw activity is kept under `raw` (the index template stores it but does not index it).
export function toDocument(event) {
  return {
    '@timestamp': event.timestamp,
    eventType: event.eventType,
    actorId: event.actorId || null,
    actorType: event.actorType || null,
    status: event.status || null,
    resource: event.resource || null,
    environmentId: event.environmentId || null,
    correlationId: event.correlationId || null,
    eventId: event.eventId,
    via: event.via || null,
    raw: event.raw,
  };
}

// The exact ndjson a _bulk call carries. Used for the real request and for the "what would be sent" preview.
export function buildBulkBody(events, index) {
  return `${events.map((e) => `${JSON.stringify({ index: { _index: index, _id: e.eventId } })}\n${JSON.stringify(toDocument(e))}`).join('\n')}\n`;
}

// Removes every credential-looking value from text that may leave this module, then bounds it.
export function scrubber(secrets = []) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
  return (value, max = 200) => {
    let t = String(value ?? '');
    for (const s of list) t = t.split(s).join('[redacted]');
    t = t.replace(/\/\/[^/\s@]*:[^/\s@]*@/g, '//[redacted]@').replace(/\b(ApiKey|Basic|Bearer)\s+[A-Za-z0-9+/=_-]{6,}/gi, '$1 [redacted]');
    return t.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  };
}

async function readCapped(res, max) {
  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader(); const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); n += value.length;
      if (n > max) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    }
    return Buffer.concat(chunks).subarray(0, max).toString('utf8');
  }
  return String(await res.text()).slice(0, max);
}

export function createElasticsearchSink({ target, fetchImpl, now = Date.now, sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }), schedule = setTimeout, ...opt } = {}) {
  const o = { ...DEFAULTS, ...opt };
  const scrub = scrubber(target.secrets || []);
  const queue = [];
  const c = { sent: 0, failed: 0, dropped: 0, discarded: 0, retried: 0, batches: 0, lastError: null, lastErrorAt: null, lastSuccessAt: null, lastAttemptAt: null, lastStatus: null };
  let timer = null; let running = null; let stopped = false;

  const headers = () => ({ 'content-type': 'application/x-ndjson', ...(target.authorization ? { authorization: target.authorization } : {}) });
  const iso = () => new Date(now()).toISOString();

  const fail = (msg) => { c.lastError = msg; c.lastErrorAt = iso(); };

  // One request. Returns { kind: 'ok' | 'retry' | 'final' | 'partial', ... } and never throws.
  async function sendOnce(batch) {
    c.lastAttemptAt = iso();
    let res;
    try {
      res = await fetchImpl(`${target.origin}/_bulk`, { method: 'POST', redirect: 'manual', headers: headers(), body: buildBulkBody(batch, target.index), signal: AbortSignal.timeout(o.timeoutMs) });
    } catch (e) {
      c.lastStatus = null;
      fail(scrub(`could not reach the cluster: ${e?.cause?.code || e?.code || e?.name || 'error'}`));
      return { kind: 'retry' };
    }
    c.lastStatus = res.status;
    if (res.status >= 300 && res.status < 400) { fail('the cluster answered with a redirect, which is refused (only the configured address is contacted)'); return { kind: 'final' }; }
    let text = '';
    try { text = await readCapped(res, o.maxResponseBytes); } catch { /* body unreadable: the status still decides */ }
    if (RETRY_STATUS(res.status)) { fail(scrub(`the cluster answered ${res.status}${text ? `: ${text}` : ''}`)); return { kind: 'retry' }; }
    if (res.status === 401 || res.status === 403) { fail(`the cluster refused the credentials (${res.status}); check ELASTICSEARCH_API_KEY or the user and password`); return { kind: 'final' }; }
    if (res.status < 200 || res.status >= 300) { fail(scrub(`the cluster answered ${res.status}${text ? `: ${text}` : ''}`)); return { kind: 'final' }; }
    let body = null; try { body = JSON.parse(text); } catch { /* a 2xx without JSON counts as accepted */ }
    if (!body || body.errors !== true || !Array.isArray(body.items)) return { kind: 'ok' };
    // Per-document results: retry only the throttled or server-side failures; a mapping or other 4xx is final.
    const retryIds = new Set(); let okCount = 0; let finalCount = 0;
    body.items.forEach((it, i) => {
      const r = it?.index || it?.create || it?.update || {};
      const id = batch[i]?.eventId; if (!id) return;
      if (r.status >= 200 && r.status < 300) okCount += 1;
      else if (RETRY_STATUS(r.status)) retryIds.add(id);
      else { finalCount += 1; fail(scrub(`a document was rejected (${r.status}): ${r.error?.type || ''} ${r.error?.reason || ''}`)); }
    });
    if (!retryIds.size && !finalCount) return { kind: 'ok' };
    return { kind: 'partial', okCount, finalCount, retryIds };
  }

  async function sendBatch(batch) {
    c.batches += 1;
    let pending = batch;
    for (let attempt = 0; !stopped; attempt += 1) {
      const r = await sendOnce(pending);
      if (r.kind === 'ok') { c.sent += pending.length; c.lastSuccessAt = iso(); return; }
      if (r.kind === 'final') { c.failed += pending.length; return; }
      if (r.kind === 'partial') {
        c.sent += r.okCount; c.failed += r.finalCount; if (r.okCount) c.lastSuccessAt = iso();
        pending = pending.filter((e) => r.retryIds.has(e.eventId));
        if (!pending.length) return;
      }
      if (attempt >= o.maxRetries) { c.failed += pending.length; return; }
      c.retried += pending.length;
      await sleep(Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** attempt));
    }
  }

  async function run() {
    timer = null;
    while (queue.length && !stopped) await sendBatch(queue.splice(0, o.batchSize));
  }
  function kick() {
    if (timer || running || stopped) return;
    timer = schedule(() => { running = run().finally(() => { running = null; if (queue.length) kick(); }); }, o.flushDelayMs);
    timer?.unref?.();
  }

  return {
    // Never throws, never waits. A full queue drops the oldest event and counts it.
    enqueue(event) {
      try {
        if (stopped) return false;
        queue.push(event);
        while (queue.length > o.maxQueue) { queue.shift(); c.dropped += 1; }
        kick();
        return true;
      } catch { return false; }
    },
    // Sends everything queued now and resolves when the queue is empty (tests and Reset use it; the receiver never does).
    async drain() {
      if (timer) { clearTimeout(timer); timer = null; }
      while ((queue.length || running) && !stopped) {
        if (running) await running; else { running = run().finally(() => { running = null; }); await running; }
      }
    },
    // Forwarding was switched off: empty the queue (counted in `discarded`); a batch already in flight finishes.
    clearQueue() { const n = queue.length; queue.length = 0; c.discarded += n; return n; },
    status() {
      return { host: new URL(target.origin).hostname, index: target.index, queued: queue.length, ...c, maxQueue: o.maxQueue, batchSize: o.batchSize, maxRetries: o.maxRetries };
    },
    // Owner-run, read-only: GET the cluster root. Returns only a few bounded fields, never headers or credentials.
    async testConnection() {
      try {
        const res = await fetchImpl(`${target.origin}/`, { method: 'GET', redirect: 'manual', headers: target.authorization ? { authorization: target.authorization } : {}, signal: AbortSignal.timeout(o.timeoutMs) });
        const text = await readCapped(res, o.maxResponseBytes);
        let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
        if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, detail: 'redirect refused' };
        return { ok: res.status >= 200 && res.status < 300, status: res.status, cluster: scrub(j?.cluster_name || j?.name || '', 60) || null, version: scrub(j?.version?.number || '', 30) || null, flavor: scrub(j?.version?.distribution || j?.tagline || '', 60) || null, detail: res.status === 401 || res.status === 403 ? 'the cluster refused the credentials' : null };
      } catch (e) { return { ok: false, status: null, detail: scrub(`could not reach the cluster: ${e?.cause?.code || e?.code || e?.name || 'error'}`) }; }
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; queue.length = 0; },
    // Stable fingerprint of what a given event would send (tests).
    fingerprint: (event) => createHash('sha256').update(buildBulkBody([event], target.index)).digest('hex').slice(0, 16),
  };
}
