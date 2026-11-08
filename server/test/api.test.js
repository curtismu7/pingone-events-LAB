import test from 'node:test';
import assert from 'node:assert/strict';
import { installNetguard } from '../src/netguard.js';
import { SPA_STUB } from '../src/app.js';
import { activity, ENV_ID, CLIENT_ID, fakeFetch, jsonRes, post, rawHttp, waitFor, withServer } from './helpers.js';

const FAST = { sleep: async () => {}, flushDelayMs: 0 };
const REAL = { PINGONE_ENVIRONMENT_ID: ENV_ID, PINGONE_CLIENT_ID: CLIENT_ID, PINGONE_CLIENT_SECRET: 'a-test-secret-value', PINGONE_REGION: 'eu' };
const ES = { ELASTICSEARCH_URL: 'https://cluster.example:9200', ELASTICSEARCH_API_KEY: 'test-api-key-value' };
const hook = (url, body, headers = {}, p = '/webhook/pingone-events') => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const json = async (url, p) => (await fetch(`${url}${p}`)).json();

test('health is the demo-health/1 contract and info says what mode and what is configured', async () => {
  await withServer(async (url) => {
    const h = await json(url, '/api/health');
    assert.deepEqual([h.schema, h.state, h.demo.id, h.runtime], ['demo-health/1', 'ready', 'pingone-events-lab', 'offline']);
    const i = await json(url, '/api/info');
    assert.deepEqual([i.mode, i.source, i.simulated, i.hosted, i.realAvailable], ['mock', 'mock', true, false, false]);
    assert.ok(i.realHint); assert.deepEqual(i.webhook.paths, ['/webhook/pingone-events', '/webhook/pingone']);
    assert.equal(i.sink.configured, false);
    assert.equal((await fetch(`${url}/api/health`, { method: 'POST', headers: { origin: url } })).status, 405);
  });
});

test('rule 19: the toggle switches both ways at runtime, answers 409 when Real is not configured, and the data reloads from the other source', async () => {
  await withServer(async (url) => {
    assert.equal((await post(url, '/api/mode', { source: 'real' })).status, 409);
    assert.equal((await json(url, '/api/info')).mode, 'mock');
    for (const bad of [{}, { source: 'hosted' }, { source: 'real', x: 1 }, [], { source: 5 }]) assert.equal((await post(url, '/api/mode', bad)).status, 400, JSON.stringify(bad));
  });
  await withServer(async (url) => {
    assert.equal((await json(url, '/api/info')).mode, 'real', 'default: Real when configured');
    await post(url, '/api/mode', { source: 'mock' });
    await post(url, '/api/mock/play', { name: 'signin-success' });
    const mock = await json(url, '/api/events');
    assert.deepEqual([mock.source, mock.count], ['mock', 4]);
    const r = await post(url, '/api/mode', { source: 'real' });
    assert.deepEqual([r.status, (await r.json()).source], [200, 'real']);
    const real = await json(url, '/api/events');
    assert.deepEqual([real.source, real.count], ['real', 0], 'the Real store is separate from the Mock one');
    await post(url, '/api/mode', { source: 'mock' });
    assert.equal((await json(url, '/api/events')).count, 4);
  }, { env: REAL });
});

test('Mock scenarios go through the receiver code path and store real-shaped events; unknown names and Real are refused', async () => {
  await withServer(async (url) => {
    assert.equal((await post(url, '/api/mock/play', { name: 'follow-a-signin' })).status, 400, 'story ids are not generator names');
    assert.equal((await post(url, '/api/mock/play', { name: 'nope' })).status, 400);
    const ok = await (await post(url, '/api/mock/play', { name: 'failed-password' })).json();
    assert.deepEqual([ok.played, ok.status, ok.sent, ok.stored, ok.duplicates], ['failed-password', 200, 4, 4, 0]);
    const ev = await json(url, '/api/events?limit=10');
    assert.deepEqual(ev.types.map((t) => t.type).sort(), ['FLOW.CREATED', 'PASSWORD.CHECK_FAILED', 'USER.ACCESS_DENIED']);
    assert.ok(ev.events.every((e) => e.environmentId && e.correlationId && e.raw.action.type === e.eventType && e.via === 'mock'));
    assert.equal(new Set(ev.events.map((e) => e.correlationId)).size, 1);
    const f = await json(url, '/api/events?status=failed');
    assert.ok(f.events.length >= 2 && f.events.every((e) => e.status === 'FAILED'));
    assert.equal((await fetch(`${url}/api/events?limit=abc`)).status, 400);
    assert.equal((await fetch(`${url}/api/events?eventType=${'x'.repeat(100)}`)).status, 400);
    assert.equal((await fetch(`${url}/api/events`, { headers: { 'x-workspace': 'Bad Id' } })).status, 400);
  });
  await withServer(async (url) => {
    assert.equal((await post(url, '/api/mock/play', { name: 'signin-success' })).status, 409);
    assert.equal((await post(url, '/api/mock/delivery', { scenario: 'healthy' })).status, 409);
  }, { env: REAL });
});

test('workspaces keep one visitor\'s Mock events apart from another\'s; Reset clears only that workspace', async () => {
  await withServer(async (url) => {
    await post(url, '/api/mock/play', { name: 'signin-success' }, { 'x-workspace': 'a' });
    assert.equal((await (await fetch(`${url}/api/events`, { headers: { 'x-workspace': 'a' } })).json()).count, 4);
    assert.equal((await (await fetch(`${url}/api/events`, { headers: { 'x-workspace': 'b' } })).json()).count, 0);
    assert.equal((await post(url, '/api/reset', {}, { 'x-workspace': 'a' })).status, 200);
    assert.equal((await (await fetch(`${url}/api/events`, { headers: { 'x-workspace': 'a' } })).json()).count, 0);
  });
});

test('the receiver answers on BOTH webhook paths: HEAD 200, POST stores, same handler and limits', async () => {
  await withServer(async (url) => {
    for (const p of ['/webhook/pingone-events', '/webhook/pingone']) {
      assert.equal((await fetch(`${url}${p}`, { method: 'HEAD' })).status, 200, `HEAD ${p}`);
    }
    const a = await (await hook(url, [activity(1)], {}, '/webhook/pingone-events')).json();
    const b = await (await hook(url, [activity(2)], {}, '/webhook/pingone')).json();
    assert.deepEqual([a.received, a.stored, b.received, b.stored], [true, 1, true, 1]);
    assert.equal((await json(url, '/api/events')).count, 2, 'both paths feed the same store');
    // Same limits on the alias: an oversized body is refused on both.
    for (const p of ['/webhook/pingone-events', '/webhook/pingone']) assert.equal((await hook(url, [{ blob: 'x'.repeat(300_000) }], {}, p)).status, 413, p);
  });
});

test('the receiver never falls through to the web page: other methods get 405, bad bodies get JSON errors', async () => {
  await withServer(async (url) => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(`${url}/webhook/pingone-events`, { method, headers: { origin: url } });
      assert.equal(r.status, 405, method); assert.equal(r.headers.get('allow'), 'POST, HEAD'); assert.match(r.headers.get('content-type'), /json/);
    }
    const bad = await fetch(`${url}/webhook/pingone-events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    assert.deepEqual([bad.status, (await bad.json()).error], [400, 'invalid_json']);
    for (const body of [[], {}, [{ nope: 1 }]]) { const r = await hook(url, body); assert.deepEqual([r.status, (await r.json()).error], [400, 'invalid_event'], JSON.stringify(body)); }
    const bare = await hook(url, 'text'); assert.deepEqual([bare.status, (await bare.json()).error], [400, 'invalid_json'], 'a bare JSON string is not a delivery');
    const many = await hook(url, Array.from({ length: 101 }, (_, i) => activity(i + 1)));
    assert.deepEqual([many.status, (await many.json()).error], [413, 'too_many_events']);
    assert.equal((await hook(url, [activity(1), activity(2)])).status, 200, 'a batch of 2 works');
    const dup = await (await hook(url, [activity(1)])).json();
    assert.deepEqual([dup.stored, dup.duplicates], [0, 1], 'a redelivery is acknowledged and ignored');
  });
});

test('the receiver is rate limited per address', async () => {
  await withServer(async (url) => {
    const codes = []; for (let i = 0; i < 5; i++) codes.push((await hook(url, [activity(i + 1)])).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  }, { env: { PEV_WEBHOOK_RPM: '3' } });
});

test('Mock delivery scenarios: a 503 door stores nothing; a 200 web page stores nothing and PingOne is told success (the silent discard)', async () => {
  await withServer(async (url) => {
    const ws = { 'x-workspace': 'd1' };
    const send = (n) => hook(url, [activity(n)], { origin: url, ...ws });
    assert.equal((await send(1)).status, 200);
    assert.equal((await post(url, '/api/mock/delivery', { scenario: 'receiver_503' }, ws)).status, 200);
    const down = await send(2);
    assert.equal(down.status, 503);
    assert.equal((await post(url, '/api/mock/delivery', { scenario: 'spa_html' }, ws)).status, 200);
    const html = await send(3);
    assert.deepEqual([html.status, html.headers.get('content-type').split(';')[0], await html.text()], [200, 'text/html', SPA_STUB]);
    const d = await (await fetch(`${url}/api/delivery`, { headers: ws })).json();
    assert.deepEqual(d.counters, { attempts: 3, acked: 2, refused: 1, stored: 1, duplicates: 0, lost: 1 });
    assert.equal(d.subscription.connectionStatus.status, 'SUCCESS', 'PingOne records success for the web page');
    assert.ok(d.counters.acked > d.counters.stored, 'the tell: acknowledged but not stored');
    assert.equal((await (await fetch(`${url}/api/events`, { headers: ws })).json()).count, 1);
    await post(url, '/api/mock/delivery', { scenario: 'receiver_503' }, ws); await send(4);
    assert.equal((await (await fetch(`${url}/api/delivery`, { headers: ws })).json()).subscription.connectionStatus.lastResponseCode, '503');
    assert.equal((await post(url, '/api/mock/delivery', { scenario: 'nope' }, ws)).status, 400);
    await post(url, '/api/mock/delivery', { scenario: 'healthy' }, ws);
    assert.equal((await send(5)).status, 200);
  });
});

test('forwarding is OFF by default and nothing is sent when it is configured but off', async () => {
  const f = fakeFetch(() => jsonRes(200, { errors: false, items: [] }));
  await withServer(async (url) => {
    const s = await json(url, '/api/sink');
    assert.deepEqual([s.configured, s.forwarding], [true, false]);
    for (let i = 1; i <= 3; i++) assert.equal((await hook(url, [activity(i)])).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(f.calls.length, 0, 'configured but off: not one request');
    assert.equal((await json(url, '/api/sink')).status.queued, 0);
  }, { env: { ...REAL, ...ES }, fetchImpl: f, sinkOptions: FAST });
});

test('turning forwarding on needs the target configured and an explicit confirm; the answer to PingOne never waits for the cluster', async () => {
  await withServer(async (url) => {
    const r = await post(url, '/api/sink', { enabled: true, confirm: true });
    assert.deepEqual([r.status, (await r.json()).error], [409, 'sink_not_configured']);
    assert.equal((await post(url, '/api/sink', { enabled: 'yes' })).status, 400);
  }, { env: REAL });
  let release; const gate = new Promise((r) => { release = r; });
  const f = fakeFetch(async (_u, init) => { await gate; const ids = String(init.body).trim().split('\n').filter((_, i) => i % 2 === 0).map((l) => JSON.parse(l).index._id); return jsonRes(200, { errors: false, items: ids.map((id) => ({ index: { _id: id, status: 201 } })) }); });
  await withServer(async (url) => {
    const noConfirm = await post(url, '/api/sink', { enabled: true });
    assert.deepEqual([noConfirm.status, (await noConfirm.json()).error], [400, 'confirm_required']);
    assert.equal((await json(url, '/api/sink')).forwarding, false);
    const on = await (await post(url, '/api/sink', { enabled: true, confirm: true })).json();
    assert.deepEqual([on.forwarding, on.target.host, on.target.index], [true, 'cluster.example', 'pingone-events']);
    const t0 = Date.now();
    const ack = await hook(url, [activity(1), activity(2)]);
    assert.equal(ack.status, 200); assert.ok(Date.now() - t0 < 500, 'answered while the cluster call is still hanging');
    assert.equal((await ack.json()).stored, 2);
    assert.ok(await waitFor(() => f.calls.length === 1));
    release();
    assert.ok(await waitFor(async () => (await json(url, '/api/sink')).status.sent === 2));
    const dup = await hook(url, [activity(1)]);
    assert.equal((await dup.json()).duplicates, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(f.calls.length, 1, 'a redelivery is not forwarded again');
    assert.equal(f.calls[0].url, 'https://cluster.example:9200/_bulk');
    const off = await (await post(url, '/api/sink', { enabled: false })).json();
    assert.equal(off.forwarding, false);
    await hook(url, [activity(3)]); await new Promise((r) => setTimeout(r, 50));
    assert.equal(f.calls.length, 1, 'off means off');
  }, { env: { ...REAL, ...ES }, fetchImpl: f, sinkOptions: FAST });
});

test('a down cluster (429, 503, unreachable) never changes the answer to PingOne or the page; the failure shows only in counters', async () => {
  for (const [label, handler] of [['429', () => jsonRes(429, { error: 'slow down' })], ['503', () => jsonRes(503, {})], ['unreachable', () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }]]) {
    const f = fakeFetch(handler);
    await withServer(async (url) => {
      await post(url, '/api/sink', { enabled: true, confirm: true });
      for (let i = 1; i <= 3; i++) { const r = await hook(url, [activity(i)]); assert.equal(r.status, 200, `${label}: webhook still 2xx`); assert.equal((await r.json()).stored, 1); }
      assert.ok(await waitFor(async () => (await json(url, '/api/sink')).status.failed === 3), `${label}: failed counter`);
      const ev = await json(url, '/api/events');
      assert.equal(ev.count, 3, `${label}: the page still has every event`);
      const s = (await json(url, '/api/sink')).status;
      assert.ok(s.lastError && s.retried > 0, label);
    }, { env: { ...REAL, ...ES }, fetchImpl: f, sinkOptions: FAST });
  }
});

test('Mock forwarding: the same queue and retry code against a stand-in cluster; the preview shows the exact bulk body; nothing leaves', async () => {
  const g = installNetguard();
  try {
    await withServer(async (url) => {
      const ws = { 'x-workspace': 'm1' };
      await post(url, '/api/mock/play', { name: 'signin-success' }, ws);
      const s0 = await (await fetch(`${url}/api/sink`, { headers: ws })).json();
      assert.deepEqual([s0.source, s0.configured, s0.forwarding, s0.scenario, s0.target.host], ['mock', true, false, 'healthy', 'your-cluster.example']);
      assert.equal(s0.preview.url, 'https://your-cluster.example/_bulk'); assert.equal(s0.preview.events, 3);
      const lines = s0.preview.body.trim().split('\n'); assert.equal(lines.length, 6);
      assert.match(JSON.parse(lines[0]).index._id, /^0{8}-0000-4000-8000-/);
      await post(url, '/api/sink', { enabled: true }, ws);
      await post(url, '/api/mock/play', { name: 'session-update' }, ws);
      assert.ok(await waitFor(async () => (await (await fetch(`${url}/api/sink`, { headers: ws })).json()).status.sent === 3));
      for (const scenario of ['throttled', 'unavailable', 'unreachable']) {
        assert.equal((await post(url, '/api/sink/scenario', { scenario }, ws)).status, 200);
        const before = (await (await fetch(`${url}/api/sink`, { headers: ws })).json()).status.failed;
        await post(url, '/api/mock/play', { name: 'flow-lifecycle' }, ws);
        assert.ok(await waitFor(async () => (await (await fetch(`${url}/api/sink`, { headers: ws })).json()).status.failed === before + 3), scenario);
      }
      assert.equal((await post(url, '/api/sink/scenario', { scenario: 'nope' }, ws)).status, 400);
      const t = await (await post(url, '/api/sink/test', {}, ws)).json();
      assert.deepEqual([t.source, t.ok], ['mock', false], 'the mock cluster is unreachable in the last scenario');
      assert.deepEqual(g.attempts, [], 'not one outbound attempt, even for the failure scenarios');
      assert.deepEqual(g.allowedHosts(), [], 'Mock allows no outbound host at all');
    }, { sinkOptions: FAST, guard: g });
  } finally { g.restore(); }
});

test('Real only: the pull, the real sink scenario switch and the Mock controls refuse in the wrong mode', async () => {
  await withServer(async (url) => {
    assert.equal((await post(url, '/api/pull', {})).status, 409);
    assert.equal((await post(url, '/api/sink/test', {}, {})).status, 200, 'the mock test connection works in Mock');
  });
  await withServer(async (url) => {
    assert.equal((await post(url, '/api/sink/scenario', { scenario: 'healthy' })).status, 409);
    assert.equal((await post(url, '/api/sink/test', {})).status, 409, 'Real without a configured target: 409');
  }, { env: REAL });
});

test('the netguard allow-list follows the mode: Real gets the PingOne and cluster hosts, Mock gets none', async () => {
  const g = installNetguard();
  try {
    await withServer(async (url) => {
      assert.deepEqual(g.allowedHosts().sort(), ['api.pingone.eu', 'auth.pingone.eu', 'cluster.example']);
      await post(url, '/api/mode', { source: 'mock' });
      assert.deepEqual(g.allowedHosts(), []);
      await post(url, '/api/mode', { source: 'real' });
      assert.equal(g.allowedHosts().length, 3);
      assert.deepEqual(g.attempts, []);
    }, { env: { ...REAL, ...ES }, guard: g });
  } finally { g.restore(); }
});

test('no secret appears in any API response or any log line, even when the cluster echoes the key back', async () => {
  const secrets = ['a-test-secret-value', 'test-api-key-value', 'hook-credential-1234', 'page-credential-1234'];
  const logged = []; const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.join(' '));
  try {
    const f = fakeFetch(() => jsonRes(503, { error: 'test-api-key-value leaked? a-test-secret-value' }));
    await withServer(async (url) => {
      await post(url, '/api/sink', { enabled: true, confirm: true });
      await hook(url, [activity(1)], { authorization: `Basic ${Buffer.from('hook:hook-credential-1234').toString('base64')}` });
      await waitFor(async () => (await json(url, '/api/sink')).status.failed === 1);
      const texts = [];
      for (const p of ['/api/info', '/api/sink', '/api/delivery', '/api/events', '/api/setup', '/api/scenarios', '/api/diagram', '/api/runs', '/api/health']) texts.push(await (await fetch(`${url}${p}`)).text());
      texts.push(await (await post(url, '/api/sink/test', {})).text(), await (await post(url, '/api/pull', {})).text());
      const all = texts.join('\n');
      for (const s of secrets) assert.ok(!all.includes(s), `a response contains ${s.slice(0, 6)}...`);
      for (const v of ['ApiKey test-api-key-value', Buffer.from('hook:hook-credential-1234').toString('base64'), Buffer.from('ui:page-credential-1234').toString('base64')]) assert.ok(!all.includes(v), 'no authorization value either');
    }, { env: { ...REAL, ...ES, WEBHOOK_BASIC_USER: 'hook', WEBHOOK_BASIC_PASSWORD: 'hook-credential-1234', UI_BASIC_USER: 'ui', UI_BASIC_PASSWORD: 'page-credential-1234' }, fetchImpl: f, sinkOptions: FAST });
  } finally { Object.assign(console, orig); }
  for (const s of secrets) assert.ok(!logged.join('\n').includes(s), `a log line contains ${s.slice(0, 6)}...`);
});

test('the webhook paths refuse a non-loopback Host unless it is the configured public host, and the public host reaches nothing else', async () => {
  const pw = 'hook-credential-1234';
  await withServer(async (url) => {
    const u = new URL(url);
    const auth = { authorization: `Basic ${Buffer.from(`hook:${pw}`).toString('base64')}` };
    const call = (host, method, path, extra = {}) => rawHttp(url + path, { method, headers: { host: `${host}:${u.port}`, 'content-type': 'application/json', ...(method === 'POST' ? { 'content-length': 2 } : {}), ...extra }, body: method === 'POST' ? '[]' : undefined });
    assert.equal((await call('other.example', 'POST', '/webhook/pingone-events', auth)).status, 403, 'an unlisted host, even with the credential');
    assert.equal((await call('hook.example', 'POST', '/webhook/pingone-events')).status, 401, 'the public host without the credential: fail closed');
    assert.equal((await call('hook.example', 'POST', '/webhook/pingone-events', auth)).status, 400, 'with the credential it reaches the receiver (an empty batch is a 400)');
    assert.equal((await call('hook.example', 'HEAD', '/webhook/pingone', auth)).status, 200);
    for (const p of ['/api/events', '/api/info', '/api/mode']) assert.equal((await call('hook.example', 'GET', p, auth)).status, 403, p);
    assert.equal((await call('hook.example', 'GET', '/webhook/pingone-events', auth)).status, 403, 'GET through the public host is refused');
  }, { env: { WEBHOOK_ALLOWED_HOSTS: 'hook.example', WEBHOOK_BASIC_USER: 'hook', WEBHOOK_BASIC_PASSWORD: pw, MODE: 'real' } });
});

test('Mock mode refuses a delivery that comes in with the webhook credential (PingOne): it is not a receiver until Real', async () => {
  const pw = 'hook-credential-1234';
  await withServer(async (url) => {
    const auth = { authorization: `Basic ${Buffer.from(`hook:${pw}`).toString('base64')}` };
    const r = await hook(url, [activity(1)], auth);
    assert.deepEqual([r.status, (await r.json()).error], [409, 'mock_mode']);
    assert.equal((await fetch(`${url}/webhook/pingone-events`, { method: 'HEAD', headers: auth })).status, 409);
    await post(url, '/api/mode', { source: 'real' });
    assert.equal((await hook(url, [activity(1)], auth)).status, 200);
  }, { env: { WEBHOOK_ALLOWED_HOSTS: 'hook.example', MODE: 'mock', WEBHOOK_BASIC_USER: 'hook', WEBHOOK_BASIC_PASSWORD: pw } });
});
