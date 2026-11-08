import test from 'node:test';
import assert from 'node:assert/strict';
import { createPingOneClient, failedDeliveries, MAX_ACTIVITIES, PingOneError } from '../src/pingoneClient.js';
import { pingoneFrom } from '../src/config.js';
import { activity, CLIENT_ID, ENV_ID, fakeFetch, jsonRes, post, withServer } from './helpers.js';

const SECRET = 'a-test-secret-value';
const ENV = { PINGONE_ENVIRONMENT_ID: ENV_ID, PINGONE_CLIENT_ID: CLIENT_ID, PINGONE_CLIENT_SECRET: SECRET, PINGONE_REGION: 'eu' };
const failedAct = (n) => ({ ...activity(n, 'EVENT_DELIVERY.FAILED'), resources: [{ type: 'SUBSCRIPTION', id: 'sub-1', name: 'EXAMPLE-SUB' }], result: { status: 'FAILED', description: 'Connection attempt failed with error: 503' }, recordedAt: `2026-11-07T1${n}:00:00.000Z` });
const SUBS = { _embedded: { subscriptions: [{ id: 'sub-1', name: 'EXAMPLE-SUB', enabled: true, format: 'ACTIVITY', httpEndpoint: { url: 'https://hook.example/webhook/pingone-events?token=SHOULD-NOT-SHOW', headers: { Authorization: 'Basic SHOULD-NOT-SHOW' } }, filterOptions: { includedActionTypes: ['A.B', 'C.D'] }, connectionStatus: { status: 'FAILED', lastAttemptedAt: '2026-11-07T12:00:00Z', lastSuccessfulAt: '2026-10-30T11:00:00Z', lastResponseCode: '503', lastResponseDetails: 'Delivery failed' } }] } };
function pingone({ acts = [activity(1), failedAct(2), failedAct(3)], tokenStatus = 200 } = {}) {
  return fakeFetch((url) => {
    if (url.includes('/as/token')) return tokenStatus === 200 ? jsonRes(200, { access_token: 'tok-SHOULD-NOT-SHOW', expires_in: 3600 }) : jsonRes(tokenStatus, { error: `denied for ${SECRET}` });
    if (url.includes('/subscriptions')) return jsonRes(200, SUBS);
    if (url.includes('/activities')) return jsonRes(200, { _embedded: { activities: acts } });
    return jsonRes(404, {});
  });
}

test('the pull makes exactly three calls: a token request, then two GETs; never a write; redirects refused; credentials only where they belong', async () => {
  const f = pingone();
  await withServer(async (url) => {
    const r = await (await post(url, '/api/pull', {})).json();
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls.map((c) => [c.method, new URL(c.url).host, new URL(c.url).pathname]), [
      ['POST', 'auth.pingone.eu', `/${ENV_ID}/as/token`], ['GET', 'api.pingone.eu', `/v1/environments/${ENV_ID}/subscriptions`], ['GET', 'api.pingone.eu', `/v1/environments/${ENV_ID}/activities`]]);
    assert.ok(f.calls.every((c) => c.redirect === 'manual'));
    assert.match(f.calls[0].headers.authorization, /^Basic /); assert.equal(f.calls[0].body, 'grant_type=client_credentials');
    assert.deepEqual(f.calls.slice(1).map((c) => c.headers.authorization), ['Bearer tok-SHOULD-NOT-SHOW', 'Bearer tok-SHOULD-NOT-SHOW']);
    assert.ok(!f.calls.some((c) => ['PUT', 'PATCH', 'DELETE'].includes(c.method)));
    const q = new URL(f.calls[2].url).searchParams;
    assert.equal(q.get('limit'), String(MAX_ACTIVITIES)); assert.match(q.get('filter'), /^recordedat ge "\d{4}-\d\d-\d\dT/);
    assert.deepEqual([r.pulled, r.stored, r.duplicates], [3, 3, 0]);
    assert.equal(r.hops.length, 3); assert.match(r.hops[0].request, /POST https:\/\/auth\.pingone\.eu\/.*\/as\/token/);
    // Nothing secret anywhere in the answer: not the client secret, the token, the subscription's headers or its URL query.
    const dump = JSON.stringify(r);
    for (const s of [SECRET, 'tok-SHOULD-NOT-SHOW', 'SHOULD-NOT-SHOW', 'Basic ']) assert.ok(!dump.includes(s), s);
  }, { env: ENV, fetchImpl: f });
});

test('subscriptions show only status fields and the destination without its query; failed deliveries are counted per subscription', async () => {
  await withServer(async (url) => {
    const r = await (await post(url, '/api/pull', {})).json();
    assert.equal(r.subscriptions[0].destination, 'https://hook.example/webhook/pingone-events');
    assert.deepEqual(r.subscriptions[0].connectionStatus, { status: 'FAILED', lastAttemptedAt: '2026-11-07T12:00:00Z', lastSuccessfulAt: '2026-10-30T11:00:00Z', lastResponseCode: '503', lastResponseDetails: 'Delivery failed' });
    assert.equal(r.subscriptions[0].filterCount, 2);
    assert.deepEqual(Object.keys(r.subscriptions[0]).sort(), ['connectionStatus', 'destination', 'enabled', 'filterCount', 'format', 'id', 'name']);
    assert.deepEqual(r.failedDeliveries, { total: 2, bySubscription: [{ subscription: 'EXAMPLE-SUB', count: 2, lastReason: 'Connection attempt failed with error: 503', lastAt: '2026-11-07T13:00:00.000Z' }] });
    assert.deepEqual((await (await fetch(`${url}/api/delivery`)).json()).pull.last.failedDeliveries.total, 2, 'the Delivery panel reads the last pull');
  }, { env: ENV, fetchImpl: pingone() });
});

test('pulled activities go through the SAME parser into the Real store (via=pull); a second pull is all duplicates; a token is reused', async () => {
  const f = pingone();
  await withServer(async (url) => {
    await post(url, '/api/pull', {});
    const again = await (await post(url, '/api/pull', {})).json();
    assert.deepEqual([again.stored, again.duplicates], [0, 3]);
    assert.equal(f.calls.filter((c) => c.url.includes('/as/token')).length, 1, 'the token is cached between pulls');
    const ev = await (await fetch(`${url}/api/events?limit=10`)).json();
    assert.deepEqual([ev.source, ev.count], ['real', 3]);
    assert.ok(ev.events.every((e) => e.via === 'pull' && e.environmentId === ENV_ID));
  }, { env: ENV, fetchImpl: f });
});

test('more than one batch of activities is chunked, not rejected (250 stored)', async () => {
  const acts = Array.from({ length: 250 }, (_, i) => activity(i + 1, 'SESSION.UPDATED'));
  await withServer(async (url) => {
    const r = await (await post(url, '/api/pull', {})).json();
    assert.deepEqual([r.pulled, r.stored, r.rejected], [250, 250, 0]);
  }, { env: ENV, fetchImpl: pingone({ acts }) });
});

test('pulled events are forwarded too, exactly once, only when forwarding is on', async () => {
  const es = fakeFetch((_u, init) => { const ids = String(init.body).trim().split('\n').filter((_, i) => i % 2 === 0).map((l) => JSON.parse(l).index._id); return jsonRes(200, { errors: false, items: ids.map((id) => ({ index: { _id: id, status: 201 } })) }); });
  const both = (u, init) => (u.includes('pingone') ? pingone().calls && pingoneHandler(u, init) : es(u, init));
  const pf = pingone(); const pingoneHandler = (u, init) => pf(u, init);
  const combined = Object.assign(both, { calls: pf.calls });
  await withServer(async (url) => {
    await post(url, '/api/pull', {});
    assert.equal(es.calls.length, 0, 'forwarding off: nothing sent');
    await post(url, '/api/sink', { enabled: true, confirm: true });
    await post(url, '/api/pull', {});
    assert.equal(es.calls.length, 0, 'the events were already stored, so a re-pull forwards nothing new');
  }, { env: { ...ENV, ELASTICSEARCH_URL: 'https://cluster.example', ELASTICSEARCH_API_KEY: 'test-api-key-value' }, fetchImpl: combined, sinkOptions: { sleep: async () => {}, flushDelayMs: 0 } });
});

test('errors are short, scrubbed and never contain a secret: refused credentials, an error body that echoes the secret, a redirect, an unreachable host', async () => {
  const cases = [
    [pingone({ tokenStatus: 401 }), /pingone_refused|pingone_error/, 502],
    [fakeFetch(() => new Response('', { status: 302, headers: { location: 'https://elsewhere.example/' } })), /redirect_refused/, 502],
    [fakeFetch(() => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); }), /unreachable/, 502],
    [fakeFetch(() => new Response('not json', { status: 200 })), /bad_response/, 502],
  ];
  for (const [f, re, status] of cases) {
    await withServer(async (url) => {
      const r = await post(url, '/api/pull', {}); const text = await r.text();
      assert.equal(r.status, status); assert.match(text, re); assert.ok(!text.includes(SECRET), text);
      assert.equal((await (await fetch(`${url}/api/events`)).json()).count, 0);
    }, { env: ENV, fetchImpl: f });
  }
});

test('not configured and wrong-mode pulls are 409', async () => {
  await withServer(async (url) => {
    const r = await post(url, '/api/pull', {});
    assert.deepEqual([r.status, (await r.json()).error], [409, 'pull_not_configured']);
  }, { env: { MODE: 'real', WEBHOOK_ALLOWED_HOSTS: 'hook.example' } });
  await withServer(async (url) => {
    await post(url, '/api/mode', { source: 'mock' });
    assert.deepEqual([(await post(url, '/api/pull', {})).status], [409]);
  }, { env: ENV, fetchImpl: pingone() });
});

test('the client in isolation: errors are PingOneError with a code; failedDeliveries tolerates junk', async () => {
  const cfg = pingoneFrom(ENV);
  const c = createPingOneClient({ cfg, fetchImpl: pingone({ tokenStatus: 500 }) });
  await assert.rejects(c.subscriptions(), (e) => e instanceof PingOneError && e.code === 'pingone_error' && !e.detail.includes(SECRET));
  assert.deepEqual(failedDeliveries([null, {}, { action: { type: 'OTHER' } }, failedAct(1)]).total, 1);
  assert.deepEqual(failedDeliveries([]), { total: 0, bySubscription: [] });
});
