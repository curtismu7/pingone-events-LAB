// The Mock stand-in for a cluster: a function with fetch's shape that answers in-process, so the REAL sink code (queue, batches, retries,
// backoff, counters) runs against it and its failures are visible. Nothing here touches a socket. Scenarios the owner can switch:
//   healthy      every document indexed (201)
//   throttled    the cluster answers 429 (too many requests): retried with backoff, then counted as failed
//   unavailable  the cluster answers 503: same handling
//   unreachable  the connection is refused (no answer at all)
export const SINK_SCENARIOS = ['healthy', 'throttled', 'unavailable', 'unreachable'];
export const MOCK_SINK_TARGET = { origin: 'https://your-cluster.example', index: 'pingone-events', authorization: 'ApiKey MOCK-key-not-a-secret', secrets: ['MOCK-key-not-a-secret'] };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createMockFetch(getScenario) {
  return async function mockFetch(url, init = {}) {
    const scenario = getScenario();
    if (scenario === 'unreachable') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (scenario === 'throttled') return json(429, { error: { type: 'es_rejected_execution_exception', reason: 'rejected execution of bulk request (mock)' }, status: 429 });
    if (scenario === 'unavailable') return json(503, { error: { type: 'cluster_block_exception', reason: 'service unavailable (mock)' }, status: 503 });
    if (init.method === 'GET') return json(200, { name: 'mock-node', cluster_name: 'mock-cluster', version: { number: '0.0.0-mock', distribution: 'mock' }, tagline: 'MOCK: not a real cluster' });
    const lines = String(init.body || '').split('\n').filter(Boolean);
    const items = [];
    for (let i = 0; i < lines.length; i += 2) { let meta = {}; try { meta = JSON.parse(lines[i]).index || {}; } catch { /* ignore */ } items.push({ index: { _index: meta._index, _id: meta._id, status: 201, result: 'created' } }); }
    return json(200, { took: 1, errors: false, items });
  };
}
