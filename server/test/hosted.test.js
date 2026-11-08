import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { basicCredentials, matchesBasic, safeEqual, webhookAuthorized } from '../src/auth.js';
import { runChecks, allPassed } from '../src/doctor.js';
import { activity, basic, ENV_ID, post, rawHttp, withServer } from './helpers.js';

const HW = 'webhook-credential-1234'; const HU = 'page-credential-5678';
const HOSTED = { PEV_HOSTED: '1', WEBHOOK_BASIC_USER: 'pingone', WEBHOOK_BASIC_PASSWORD: HW, UI_BASIC_USER: 'viewer', UI_BASIC_PASSWORD: HU, WEBHOOK_ALLOWED_HOSTS: 'hook.example', LAB_ALLOWED_HOSTS: 'ui.example', MODE: 'real' };
const hook = (url, body, headers = {}, p = '/webhook/pingone-events') => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const WH = basic('pingone', HW); const UI = basic('viewer', HU);

test('hosted: forwarding starts OFF, and starts ON only when the owner set FORWARD_ON_START=1 with the cluster configured; local never starts it', async () => {
  const ES = { ELASTICSEARCH_URL: 'https://cluster.example:9200', ELASTICSEARCH_API_KEY: 'test-api-key-value' };
  const forwarding = async (url) => (await (await fetch(`${url}/api/sink`, { headers: UI })).json()).forwarding;
  await withServer(async (url) => assert.equal(await forwarding(url), false, 'default: off'), { env: { ...HOSTED, ...ES } });
  await withServer(async (url) => assert.equal(await forwarding(url), true, 'owner opted in'), { env: { ...HOSTED, ...ES, FORWARD_ON_START: '1' } });
  await withServer(async (url) => assert.equal(await forwarding(url), false, 'opted in but no cluster configured: stays off'), { env: { ...HOSTED, FORWARD_ON_START: '1' } });
  await withServer(async (url) => assert.equal((await (await fetch(`${url}/api/sink`)).json()).forwarding, false, 'local ignores it'), { env: { ...ES, FORWARD_ON_START: '1', MODE: 'real', PINGONE_ENVIRONMENT_ID: ENV_ID, PINGONE_CLIENT_ID: ENV_ID, PINGONE_CLIENT_SECRET: 'a-test-secret-value', PINGONE_REGION: 'eu' } });
});

test('hosted FAILS CLOSED: without the webhook credential or the page credential the app is not created, and the message names the setting, not a value', () => {
  for (const [env, re] of [[{ PEV_HOSTED: '1' }, /WEBHOOK_BASIC_USER[\s\S]*UI_BASIC_USER/], [{ PEV_HOSTED: '1', UI_BASIC_USER: 'v', UI_BASIC_PASSWORD: HU }, /webhook receiver needs a credential/], [{ PEV_HOSTED: '1', WEBHOOK_BASIC_USER: 'p', WEBHOOK_BASIC_PASSWORD: HW }, /page and the read APIs need their own credential/], [{ PEV_HOSTED: '1', WEBHOOK_BASIC_USER: 'p', WEBHOOK_BASIC_PASSWORD: 'short', UI_BASIC_USER: 'v', UI_BASIC_PASSWORD: HU }, /webhook receiver needs a credential/]]) {
    assert.throws(() => createApp({ health: createHealth({ intervalMs: 3_600_000 }), env }), (e) => { assert.match(e.message, re); assert.ok(!e.message.includes(HW) && !e.message.includes(HU)); return true; });
  }
  assert.doesNotThrow(() => { const h = createHealth({ intervalMs: 3_600_000 }); createApp({ health: h, env: HOSTED }); h.stop(); });
});

test('hosted: the doctor (and so the process start) fails with the reason when a credential is missing', async () => {
  const bad = await runChecks({ env: { PEV_HOSTED: '1' } });
  assert.equal(allPassed(bad), false);
  assert.match(bad.find((c) => c.id === 'hosted').detail, /hosted deployment cannot start.*WEBHOOK_BASIC_USER/);
  assert.equal(allPassed(await runChecks({ env: HOSTED })), true);
  assert.equal(allPassed(await runChecks({ env: {} })), true, 'not hosted: nothing required');
});

test('hosted: the page and every read API need the page credential; only health stays open', async () => {
  await withServer(async (url) => {
    for (const p of ['/api/info', '/api/events', '/api/sink', '/api/delivery', '/api/setup', '/api/scenarios', '/api/diagram', '/api/runs', '/api/nope', '/', '/index.html']) {
      const r = await fetch(`${url}${p}`);
      assert.equal(r.status, 401, p); assert.match(r.headers.get('www-authenticate'), /^Basic realm="PingOne Events Lab"/); assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal((await fetch(`${url}${p}`, { headers: basic('viewer', 'wrong-password-123') })).status, 401, `${p} wrong password`);
      assert.equal((await fetch(`${url}${p}`, { headers: basic('other', HU) })).status, 401, `${p} wrong user`);
    }
    assert.equal((await fetch(`${url}/api/info`, { headers: UI })).status, 200);
    assert.equal((await fetch(`${url}/api/events`, { headers: UI })).status, 200);
    const h = await fetch(`${url}/api/health`); assert.equal(h.status, 200); assert.equal((await h.json()).schema, 'demo-health/1');
    assert.equal((await fetch(`${url}/api/health/`)).status, 200);
    assert.equal((await post(url, '/api/mode', { source: 'mock' })).status, 401, 'writes need it too');
    assert.equal((await post(url, '/api/mode', { source: 'mock' }, UI)).status, 200);
    assert.equal((await fetch(`${url}/api/info`, { headers: { authorization: 'Bearer abc' } })).status, 401);
    assert.equal((await fetch(`${url}/api/info`, { headers: { authorization: `Basic ${'A'.repeat(700)}` } })).status, 401);
  }, { env: HOSTED });
});

test('hosted: the webhook needs PingOne\'s credential BEFORE the body is read; the page credential does not unlock it and vice versa', async () => {
  await withServer(async (url) => {
    const none = await hook(url, [activity(1)]);
    assert.equal(none.status, 401); assert.match(none.headers.get('www-authenticate'), /^Basic realm="PingOne webhook"/);
    assert.equal((await hook(url, [{ blob: 'x'.repeat(300_000) }])).status, 401, 'an unauthenticated 300 KB body is a 401, not a 413: it was never parsed');
    assert.equal((await hook(url, [activity(1)], basic('pingone', 'wrong-credential-1234'))).status, 401);
    assert.equal((await hook(url, [activity(1)], basic('wrong', HW))).status, 401);
    assert.equal((await hook(url, [activity(1)], UI)).status, 401, 'the page credential is not the webhook credential');
    assert.equal((await fetch(`${url}/api/events`, { headers: WH })).status, 401, 'the webhook credential is not the page credential');
    const ok = await hook(url, [activity(1)], WH);
    assert.deepEqual([ok.status, (await ok.json()).stored], [200, 1]);
    assert.equal((await hook(url, [activity(2)], WH, '/webhook/pingone')).status, 200, 'the alias path needs it too');
    assert.equal((await (await fetch(`${url}/api/events`, { headers: UI })).json()).count, 2);
  }, { env: HOSTED });
});

test('hosted: HEAD (the connection test) is 401 without the credential and 200 with it, on both paths', async () => {
  await withServer(async (url) => {
    for (const p of ['/webhook/pingone-events', '/webhook/pingone']) {
      assert.equal((await fetch(`${url}${p}`, { method: 'HEAD' })).status, 401, `HEAD ${p} anonymous`);
      assert.equal((await fetch(`${url}${p}`, { method: 'HEAD', headers: WH })).status, 200, `HEAD ${p} with the credential`);
      assert.equal((await fetch(`${url}${p}`, { method: 'HEAD', headers: UI })).status, 401);
    }
  }, { env: HOSTED });
});

test('hosted: a static header credential works, alone or beside Basic; a wrong or short value does not', async () => {
  const KEY = 'static-header-value-123';
  await withServer(async (url) => {
    assert.equal((await hook(url, [activity(1)], { 'x-webhook-key': KEY })).status, 200);
    assert.equal((await hook(url, [activity(2)], { 'x-webhook-key': `${KEY}x` })).status, 401);
    assert.equal((await hook(url, [activity(3)], { 'x-webhook-key': KEY.slice(0, -1) })).status, 401);
    assert.equal((await hook(url, [activity(4)], WH)).status, 200, 'Basic still works');
    assert.equal((await fetch(`${url}/webhook/pingone-events`, { method: 'HEAD', headers: { 'x-webhook-key': KEY } })).status, 200);
    assert.equal((await hook(url, [activity(5)], {})).status, 401);
  }, { env: { ...HOSTED, WEBHOOK_HEADER_NAME: 'X-Webhook-Key', WEBHOOK_HEADER_VALUE: KEY } });
});

test('hosted never trusts the Host header to decide who is calling (an ingress may rewrite it to loopback)', async () => {
  await withServer(async (url) => {
    const u = new URL(url);
    const send = (host, headers = {}) => rawHttp(`${url}/webhook/pingone-events`, { method: 'POST', headers: { host, 'content-type': 'application/json', 'content-length': 2, ...headers }, body: '[]' });
    assert.equal((await send(`127.0.0.1:${u.port}`)).status, 401, 'a loopback Host with no credential: still refused');
    assert.equal((await send('localhost')).status, 401);
    assert.equal((await send(`127.0.0.1:${u.port}`, WH)).status, 400, 'with the credential it reaches the receiver (an empty batch is a 400)');
    const api = await rawHttp(`${url}/api/info`, { headers: { host: `127.0.0.1:${u.port}` } });
    assert.equal(api.status, 401, 'the API is behind the page credential whatever the Host says');
    assert.equal((await rawHttp(`${url}/api/health`, { headers: { host: `127.0.0.1:${u.port}` } })).status, 200);
    assert.equal((await rawHttp(`${url}/api/health`, { headers: { host: 'evil.example' } })).status, 403, 'a Host that is on no list is still refused');
    assert.equal((await rawHttp(`${url}/api/info`, { headers: { host: 'ui.example', ...UI } })).status, 200, 'the UI host is allowed');
  }, { env: HOSTED });
});

test('hosted: the toggle is per workspace and can NEVER change how the receiver treats PingOne; the page\'s own test button works only in a workspace that chose Mock', async () => {
  await withServer(async (url) => {
    const A = { ...UI, 'x-workspace': 'viewer-a' }; const B = { ...UI, 'x-workspace': 'viewer-b' };
    const modeOf = async (h) => (await (await fetch(`${url}/api/info`, { headers: h })).json()).mode;
    assert.equal((await post(url, '/api/mode', { source: 'mock' }, A)).status, 200);
    assert.deepEqual([await modeOf(A), await modeOf(B)], ['mock', 'real'], 'one viewer\'s choice is theirs alone');
    // PingOne, after the flip: still answered as a Real receiver, still stored in the Real store.
    const pingone = await hook(url, [activity(1)], WH);
    assert.deepEqual([pingone.status, (await pingone.json()).stored], [200, 1]);
    assert.equal((await fetch(`${url}/webhook/pingone-events`, { method: 'HEAD', headers: WH })).status, 200, 'the connection test still passes');
    assert.equal((await hook(url, [activity(2)], WH, '/webhook/pingone')).status, 200);
    assert.equal((await (await fetch(`${url}/api/events`, { headers: B })).json()).count, 2, 'viewer B sees the real events');
    assert.equal((await (await fetch(`${url}/api/events`, { headers: A })).json()).count, 0, 'viewer A, in Mock, sees only the Mock store');
    // The page\'s own test button: same-origin + page credential + THIS workspace in Mock.
    const page = await hook(url, [activity(3)], { ...A, origin: url, 'x-lab-hops': '1' });
    const j = await page.json();
    assert.deepEqual([page.status, j.stored, j.hops.length >= 2], [200, 1, true]);
    assert.equal((await (await fetch(`${url}/api/events`, { headers: A })).json()).count, 1);
    assert.equal((await (await fetch(`${url}/api/events`, { headers: B })).json()).count, 2, 'the Real store is untouched by the test button');
    assert.equal((await hook(url, [activity(4)], { ...A, origin: url }, '/webhook/pingone-events')).status, 200);
    assert.equal((await hook(url, [activity(5)], A)).status, 401, 'the page credential without a same-origin Origin (a script, not the page) is refused');
    assert.equal((await hook(url, [activity(6)], { ...B, origin: url })).status, 401, 'in a Real workspace the page credential does not unlock the webhook');
    assert.equal((await post(url, '/api/mode', { source: 'real' }, A)).status, 200);
    assert.equal((await hook(url, [activity(7)], { ...A, origin: url })).status, 401, 'back in Real the test button is closed again');
    assert.equal((await post(url, '/api/mode', { source: 'mock' }, A)).status, 200);
    // And even if EVERY viewer is in Mock, PingOne is unaffected.
    await post(url, '/api/mode', { source: 'mock' }, B);
    assert.deepEqual([(await hook(url, [activity(8)], WH)).status, (await fetch(`${url}/webhook/pingone-events`, { method: 'HEAD', headers: WH })).status], [200, 200]);
  }, { env: HOSTED });
});

test('hosted: a viewer flipping the DEFAULT workspace (the one PingOne\'s header-less requests use) to Mock cannot turn the receiver into a 409 for PingOne', async () => {
  await withServer(async (url) => {
    assert.equal((await post(url, '/api/mode', { source: 'mock' }, UI)).status, 200, 'no X-Workspace header: the default workspace');
    assert.equal((await (await fetch(`${url}/api/info`, { headers: UI })).json()).mode, 'mock');
    const ok = await hook(url, [activity(1)], WH);
    assert.deepEqual([ok.status, (await ok.json()).stored], [200, 1], 'PingOne is still answered as a Real receiver and stored in the Real store');
    assert.equal((await fetch(`${url}/webhook/pingone-events`, { method: 'HEAD', headers: WH })).status, 200);
    assert.equal((await (await fetch(`${url}/api/events`, { headers: { ...UI, 'x-workspace': 'other-viewer' } })).json()).count, 1, 'another viewer, still in Real, sees the event');
  }, { env: HOSTED });
});

test('hosted: the rate limit is per client address as the ingress reports it (X-Forwarded-For, one hop)', async () => {
  await withServer(async (url) => {
    const code = async (ip, n) => (await hook(url, [activity(n)], { ...WH, 'x-forwarded-for': ip })).status;
    assert.deepEqual([await code('203.0.113.1', 1), await code('203.0.113.1', 2), await code('203.0.113.1', 3)], [200, 200, 429]);
    assert.equal(await code('203.0.113.2', 4), 200, 'a different client has its own allowance');
  }, { env: { ...HOSTED, PEV_WEBHOOK_RPM: '2' } });
});

test('credentials are compared in constant time: hashed to equal length, then timingSafeEqual', () => {
  assert.equal(safeEqual('same', 'same'), true); assert.equal(safeEqual('same', 'sameX'), false); assert.equal(safeEqual('', 'x'), false); assert.equal(safeEqual('a'.repeat(5000), 'a'.repeat(5000)), true);
  const src = fs.readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
  assert.match(src, /export const safeEqual = \(a, b\) => timingSafeEqual\(digest\(a\), digest\(b\)\);/, 'safeEqual IS timingSafeEqual over two digests');
  assert.match(src, /const digest = \(v\) => createHash\('sha256'\)/);
  assert.ok(!/(password|cred\.user|auth\.header\.value)\s*[!=]==/.test(src), 'no ordinary string comparison on a secret');
  const req = (h) => ({ headers: h });
  assert.deepEqual(basicCredentials(req({ authorization: basic('u', 'p:with:colons').authorization })), { user: 'u', password: 'p:with:colons' });
  for (const bad of [undefined, 'Basic', 'Basic !!!', 'Bearer x', `Basic ${Buffer.from('nocolon').toString('base64')}`]) assert.equal(basicCredentials(req({ authorization: bad })), null, String(bad));
  assert.equal(matchesBasic(req(basic('u', 'p')), { user: 'u', password: 'p' }), true);
  assert.equal(matchesBasic(req(basic('u', 'p')), null), false);
  assert.equal(webhookAuthorized(req({}), null), false);
  assert.equal(webhookAuthorized(req({ 'x-k': 'v'.repeat(20) }), { basic: null, header: { name: 'x-k', value: 'v'.repeat(20) } }), true);
});

test('locally (not hosted) the page and the API stay open on loopback, and the receiver needs no credential from this machine', async () => {
  await withServer(async (url) => {
    assert.equal((await fetch(`${url}/api/info`)).status, 200);
    assert.equal((await hook(url, [activity(1)])).status, 200);
    assert.equal((await fetch(`${url}/webhook/pingone-events`, { method: 'HEAD' })).status, 200);
  }, { env: { MODE: 'real', WEBHOOK_ALLOWED_HOSTS: 'hook.example' } });
  void ENV_ID;
});
