import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEventStore, PERSIST_DELAY_MS } from '../src/eventStore.js';
import { MAX_RAW_BYTES, parseActivity, parseDelivery } from '../src/eventParser.js';
import { ingest } from '../src/receiver.js';
import { CSP } from '../src/app.js';
import { hostedFrom, hostedProblems, sinkFrom, trustProxyHops, uiAuthFrom, webhookAuthFrom } from '../src/config.js';
import { isBlockedTargetHost } from '../src/safety.js';
import { runChecks } from '../src/doctor.js';
import { activity, basic, ENV_ID, CLIENT_ID, fakeFetch, jsonRes, post, rawHttp, tmpDir, waitFor, withServer } from './helpers.js';

const HW = 'webhook-credential-1234'; const HU = 'page-credential-5678';
const HOSTED = { PEV_HOSTED: '1', WEBHOOK_BASIC_USER: 'pingone', WEBHOOK_BASIC_PASSWORD: HW, UI_BASIC_USER: 'viewer', UI_BASIC_PASSWORD: HU, WEBHOOK_ALLOWED_HOSTS: 'hook.example', MODE: 'real' };
const WH = basic('pingone', HW); const UI = basic('viewer', HU);
const hook = (url, body, headers = {}, p = '/webhook/pingone-events') => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const FAST = { sleep: async () => {}, flushDelayMs: 0 };
const REAL = { PINGONE_ENVIRONMENT_ID: ENV_ID, PINGONE_CLIENT_ID: CLIENT_ID, PINGONE_CLIENT_SECRET: 'a-test-secret-value', PINGONE_REGION: 'eu' };
const ES = { ELASTICSEARCH_URL: 'https://cluster.example:9200', ELASTICSEARCH_API_KEY: 'test-api-key-value' };

// ---- 3: PEV_HOSTED fails closed -------------------------------------------------------------------------------------------------------
test('3. hosted means anything that is not explicitly falsy: "true", "yes", " 1 ", "TRUE" and typos all require credentials', () => {
  for (const v of ['1', 'true', 'yes', ' 1 ', 'TRUE', 'on', 'enabled', 'hosted', 'x', '2']) { assert.equal(hostedFrom({ PEV_HOSTED: v }), true, JSON.stringify(v)); assert.equal(hostedProblems({ PEV_HOSTED: v }).length, 2, `${JSON.stringify(v)} without credentials is refused`); }
  for (const v of [undefined, '', '0', 'false', 'FALSE', ' no ', 'No', 'off', '  ']) { assert.equal(hostedFrom({ PEV_HOSTED: v }), false, JSON.stringify(v)); assert.deepEqual(hostedProblems({ PEV_HOSTED: v }), []); }
});
test('3. the app is not created for "true" without credentials, and the doctor says why', async () => {
  const { createApp } = await import('../src/app.js'); const { createHealth } = await import('../src/health.js');
  for (const v of ['true', 'yes', ' 1 ', 'TRUE']) assert.throws(() => createApp({ health: createHealth({ intervalMs: 3_600_000 }), env: { PEV_HOSTED: v } }), /hosted deployment cannot start/, v);
  assert.equal((await runChecks({ env: { PEV_HOSTED: 'true' } })).find((c) => c.id === 'hosted').level, 'fail');
});

// ---- 4: credentials -------------------------------------------------------------------------------------------------------------------
test('4. a whitespace-only secret is not a secret; surrounding whitespace does not count towards the length', () => {
  const spaces = ' '.repeat(20);
  assert.equal(webhookAuthFrom({ WEBHOOK_BASIC_USER: 'u', WEBHOOK_BASIC_PASSWORD: spaces }), null);
  assert.equal(webhookAuthFrom({ WEBHOOK_HEADER_NAME: 'x-k', WEBHOOK_HEADER_VALUE: '\t'.repeat(20) }), null);
  assert.equal(uiAuthFrom({ UI_BASIC_USER: 'v', UI_BASIC_PASSWORD: spaces }), null);
  assert.equal(uiAuthFrom({ UI_BASIC_USER: 'v', UI_BASIC_PASSWORD: `   short   ` }), null, 'padding does not make a short secret long enough');
  assert.ok(uiAuthFrom({ UI_BASIC_USER: 'v', UI_BASIC_PASSWORD: 'a-real-secret-12' }));
  assert.equal(hostedProblems({ ...HOSTED, WEBHOOK_BASIC_PASSWORD: spaces }).length, 1);
});
test('4. hosted refuses to start when the webhook and page credentials are the same secret', () => {
  const same = 'one-shared-secret-value';
  assert.match(hostedProblems({ ...HOSTED, WEBHOOK_BASIC_PASSWORD: same, UI_BASIC_PASSWORD: same }).join(), /must be different/);
  assert.match(hostedProblems({ PEV_HOSTED: '1', WEBHOOK_HEADER_NAME: 'x-k', WEBHOOK_HEADER_VALUE: same, UI_BASIC_USER: 'v', UI_BASIC_PASSWORD: same }).join(), /must be different/, 'a header value equal to the page password counts too');
  assert.deepEqual(hostedProblems({ ...HOSTED }), []);
  assert.ok(!hostedProblems({ ...HOSTED, WEBHOOK_BASIC_PASSWORD: same, UI_BASIC_PASSWORD: same }).join().includes(same), 'the problem never repeats the value');
});
test('4. hosted refuses a placeholder in ANY key, and half-set or invalid PingOne / Elasticsearch groups (the Secret template claim is true)', () => {
  const p = (extra) => hostedProblems({ ...HOSTED, ...extra }).join(' | ');
  assert.match(p({ ELASTICSEARCH_API_KEY: 'REPLACE-ME-api-key', ELASTICSEARCH_URL: 'https://cluster.example' }), /ELASTICSEARCH_API_KEY.*REPLACE-ME/);
  assert.match(p({ PINGONE_CLIENT_ID: 'REPLACE-ME-client-uuid' }), /PINGONE_CLIENT_ID.*REPLACE-ME/);
  assert.match(p({ PINGONE_ENVIRONMENT_ID: ENV_ID }), /PINGONE|Set all four/);
  assert.match(p({ ELASTICSEARCH_URL: 'http://remote.example' }), /ELASTICSEARCH_URL/);
  assert.deepEqual(hostedProblems({ ...HOSTED, ...REAL, ...ES }), [], 'a complete, valid set is accepted');
  assert.ok(!p({ PINGONE_CLIENT_SECRET: 'REPLACE-ME-secret' }).includes('REPLACE-ME-secret'), 'names the key, never the value');
  assert.deepEqual(hostedProblems({ PINGONE_CLIENT_ID: 'REPLACE-ME' }), [], 'not hosted: a local settings file with odd values is left alone');
});

// ---- 5: SSRF --------------------------------------------------------------------------------------------------------------------------
test('5. the metadata block cannot be bypassed: IPv4-mapped and hex IPv6, zones, trailing dots, decimal/octal/hex IPv4, NAT64, compat', () => {
  for (const h of ['169.254.169.254', '::ffff:169.254.169.254', '[::ffff:169.254.169.254]', '::ffff:a9fe:a9fe', '[::ffff:a9fe:a9fe]', '0:0:0:0:0:ffff:a9fe:a9fe', '::FFFF:A9FE:A9FE', '::ffff:a9fe:a9fe%eth0', '[::ffff:a9fe:a9fe%25eth0]',
    'metadata.google.internal.', 'metadata.google.internal', 'foo.internal.', 'foo.internal..', 'metadata', 'instance-data', 'INSTANCE-DATA.',
    '2852039166', '0xa9fea9fe', '0xA9.0xFE.0xA9.0xFE', '0251.0376.0251.0376', '169.254.43518', '169.16689662', '64:ff9b::a9fe:a9fe', '::a9fe:a9fe', 'fe80::1', '[fe80::1%eth0]', 'FE80::1', 'febf::1', 'fd00:ec2::254', 'fd00:ec2::2',
    '::', '[::]', '0.0.0.0', '0', '100.100.100.200', '192.0.0.192', '168.63.129.16', 'ff02::1', '224.0.0.1', '::ffff:0.0.0.0', '::ffff:7f00:1'.replace('7f00:1', '0:0')]) assert.ok(isBlockedTargetHost(h), `${h} must be blocked`);
  for (const h of ['cluster.example', 'es.internal.example', '10.1.2.3', '192.168.1.5', '172.16.0.9', 'localhost', '127.0.0.1', '::1', '[::1]', '::ffff:10.1.2.3', '::ffff:7f00:1', '2001:db8::1', 'metadata.example', 'my-metadata-host.example']) assert.ok(!isBlockedTargetHost(h), `${h} must be allowed`);
});
test('5. through the configuration: every bypass form is refused as a forwarding target', () => {
  for (const u of ['https://[::ffff:169.254.169.254]', 'https://[::ffff:a9fe:a9fe]', 'https://[0:0:0:0:0:ffff:a9fe:a9fe]', 'https://metadata.google.internal.', 'https://foo.internal.', 'https://2852039166', 'https://0xa9fea9fe', 'https://0251.0376.0251.0376', 'https://169.254.43518', 'https://[64:ff9b::a9fe:a9fe]', 'https://[fe80::1%25eth0]', 'https://[fd00:ec2::254]', 'https://instance-data.'])
    assert.equal(sinkFrom({ ELASTICSEARCH_URL: u, ELASTICSEARCH_API_KEY: 'test-api-key-value' }), null, u);
  assert.ok(sinkFrom({ ELASTICSEARCH_URL: 'https://cluster.example:9200', ELASTICSEARCH_API_KEY: 'test-api-key-value' }));
  assert.ok(sinkFrom({ ELASTICSEARCH_URL: 'http://[::1]:9200' }));
});

// ---- 2: rate limiting, authentication first, trusted hops ----------------------------------------------------------------------------
const xff = (...ips) => ({ 'x-forwarded-for': ips.join(', ') });
test('2. an unauthenticated flood cannot starve PingOne: failures have their own small per-address bucket, valid requests their own', async () => {
  await withServer(async (url) => {
    const flood = []; for (let i = 0; i < 6; i++) flood.push(await hook(url, [activity(i + 1)], xff('198.51.100.1')));
    assert.deepEqual(flood.map((r) => r.status), [401, 401, 429, 429, 429, 429]);
    const limited = flood[2]; assert.match(limited.headers.get('retry-after'), /^[1-9]\d*$/); assert.ok(Number(limited.headers.get('retry-after')) <= 60);
    assert.equal((await limited.json()).error, 'rate_limited');
    // PingOne from the SAME address as the flooder, and from another: untouched.
    for (let i = 0; i < 3; i++) assert.equal((await hook(url, [activity(100 + i)], { ...WH, ...xff('198.51.100.1') })).status, 200, `valid request ${i} from the flooding address`);
    assert.equal((await hook(url, [activity(200)], { ...WH, ...xff('203.0.113.9') })).status, 200);
    // The valid bucket is finite too, and says when to come back.
    const over = await hook(url, [activity(300)], { ...WH, ...xff('198.51.100.1') });
    assert.equal(over.status, 429); assert.match(over.headers.get('retry-after'), /^[1-9]\d*$/);
    assert.equal((await fetch(`${url}/webhook/pingone-events`, { method: 'HEAD', headers: { ...WH, ...xff('198.51.100.1') } })).status, 429, 'HEAD is counted the same way');
  }, { env: { ...HOSTED, PEV_WEBHOOK_RPM: '3', PEV_WEBHOOK_UNAUTH_RPM: '2' } });
});
test('2. the unauthenticated bucket is bounded in distinct addresses and cannot touch the valid bucket (a flood from many addresses)', async () => {
  await withServer(async (url) => {
    const codes = []; for (let i = 1; i <= 4; i++) codes.push((await hook(url, [activity(i)], xff(`198.51.100.${i}`))).status);
    assert.deepEqual(codes, [401, 401, 429, 429], 'the third NEW address in the window is refused outright: the table cannot grow without bound');
    assert.equal((await hook(url, [activity(10)], { ...WH, ...xff('203.0.113.50') })).status, 200, 'valid traffic has its own table');
  }, { env: { ...HOSTED, PEV_RATE_MAX_IPS: '2' } });
});
test('2. only the configured number of proxy hops is trusted: a client-written X-Forwarded-For prefix cannot choose its own bucket', async () => {
  await withServer(async (url) => {
    // Same right-most address (what the ingress appended), different forged left parts: ONE bucket.
    const codes = []; for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']) codes.push((await hook(url, [activity(1)], xff(forged, '203.0.113.7'))).status);
    assert.deepEqual(codes, [401, 401, 429, 429]);
    // A different right-most address is a different caller.
    assert.equal((await hook(url, [activity(2)], xff('1.1.1.1', '203.0.113.8'))).status, 401);
  }, { env: { ...HOSTED, PEV_WEBHOOK_UNAUTH_RPM: '2' } });
  await withServer(async (url) => {
    // Zero hops (no proxy): X-Forwarded-For is ignored entirely, so spoofing it changes nothing.
    const codes = []; for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) codes.push((await hook(url, [activity(1)], xff(forged))).status);
    assert.deepEqual(codes, [401, 401, 429]);
  }, { env: { ...HOSTED, PEV_TRUST_PROXY_HOPS: '0', PEV_WEBHOOK_UNAUTH_RPM: '2' } });
  assert.deepEqual([trustProxyHops({}), trustProxyHops(HOSTED), trustProxyHops({ ...HOSTED, PEV_TRUST_PROXY_HOPS: '2' }), trustProxyHops({ ...HOSTED, PEV_TRUST_PROXY_HOPS: '9' }), trustProxyHops({ PEV_TRUST_PROXY_HOPS: '1' })], [0, 1, 2, 1, 1]);
});
test('2. authentication is checked before the body is read, so an unauthenticated 300 KB body is a 401 and costs no parse', async () => {
  await withServer(async (url) => { assert.equal((await hook(url, [{ blob: 'x'.repeat(300_000) }])).status, 401); }, { env: HOSTED });
});

// ---- 6: Mock means zero outbound ------------------------------------------------------------------------------------------------------
test('6. flipping a local app to Mock stops the Real sink: pending retries and the queue end, nothing more is sent, and forwarding is OFF on return', async () => {
  const gates = []; const f = fakeFetch(() => jsonRes(503, { error: 'down' }));
  await withServer(async (url, app) => {
    await post(url, '/api/sink', { enabled: true, confirm: true });
    for (let i = 1; i <= 5; i++) await hook(url, [activity(i)]);
    assert.ok(await waitFor(() => f.calls.length >= 1 && gates.length >= 1), 'a batch failed once and is waiting to retry');
    const before = f.calls.length;
    await post(url, '/api/mode', { source: 'mock' });
    gates.splice(0).forEach((g) => g()); // let every pending backoff finish
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.calls.length, before, 'not one more request to the cluster after the flip');
    for (let i = 10; i <= 12; i++) await hook(url, [activity(i)]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.calls.length, before, 'new events in Mock are never forwarded to the real cluster');
    await post(url, '/api/mode', { source: 'real' });
    const s = await (await fetch(`${url}/api/sink`)).json();
    assert.deepEqual([s.forwarding, s.status.queued], [false, 0], 'back in Real, forwarding is OFF again and the old queue is gone');
    assert.equal((await post(url, '/api/sink', { enabled: true })).status, 400, 'and turning it on needs the confirm again');
    void app;
  }, { env: { ...REAL, ...ES }, fetchImpl: f, sinkOptions: { sleep: () => new Promise((r) => { gates.push(r); }), flushDelayMs: 0 } });
});

// ---- 7: persistence honesty -----------------------------------------------------------------------------------------------------------
const ev = (n, over = {}) => ({ eventId: `e${n}`, eventType: 'A.B', timestamp: new Date(Date.UTC(2026, 10, 7, 12, 0, n)).toISOString(), receivedAt: new Date(Date.UTC(2026, 10, 7, 12, 0, n)).toISOString(), ...over });
test('7. a failed write is counted, explained without a path, shown in the durability state, and recovers', () => {
  const dir = tmpDir(); const blocker = path.join(dir, 'blocker'); fs.writeFileSync(blocker, 'a file where a directory is needed');
  const file = path.join(blocker, 'default', 'events.json');
  const s = createEventStore({ max: 10, file, persistDelayMs: 1e9 });
  assert.equal(s.durability(), 'ok'.replace('ok', 'ok'), 'nothing to write yet');
  assert.equal(s.add(ev(1)), true); assert.equal(s.durability(), 'pending');
  s.flush();
  const p = s.persistence();
  assert.deepEqual([s.durability(), p.writeFailures], ['failing', 1]);
  assert.match(p.lastError, /could not write the events file.*kept in memory only/); assert.ok(!p.lastError.includes(dir) && !p.lastError.includes('blocker'), 'no path in the message');
  assert.ok(p.lastErrorAt); assert.equal(s.count(), 1, 'the event is still in memory');
  s.add(ev(2)); s.flush(); assert.equal(s.persistence().writeFailures, 2, 'every failure is counted');
  fs.rmSync(blocker); // the disk is fixed
  s.add(ev(3)); s.flush();
  assert.deepEqual([s.durability(), s.persistence().lastOkAt !== null], ['ok', true]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => e.eventId), ['e1', 'e2', 'e3'], 'everything held in memory is written once the disk works');
  assert.equal(createEventStore({ max: 3 }).durability(), 'memory');
});
test('7. the receiver answers with the durability it can honestly claim, and /api/health says broken while writes fail', async () => {
  const dir = tmpDir(); const blocker = path.join(dir, 'blocker'); fs.writeFileSync(blocker, 'x');
  const store = createEventStore({ max: 10, file: path.join(blocker, 'default', 'events.json'), persistDelayMs: 5 });
  await withServer(async (url) => {
    const first = await (await hook(url, [activity(1)], WH)).json();
    assert.equal(first.stored, 1); assert.ok(['pending', 'failing'].includes(first.durability), first.durability);
    assert.ok(await waitFor(async () => (await (await fetch(`${url}/api/health`)).json()).state === 'broken'), 'health reports broken, not ready');
    const second = await (await hook(url, [activity(2)], WH)).json();
    assert.equal(second.durability, 'failing', 'a 200 is not allowed to imply the events are on disk');
    const info = await (await fetch(`${url}/api/info`, { headers: UI })).json();
    assert.equal(info.persistence.durability, 'failing'); assert.ok(info.persistence.writeFailures >= 1); assert.match(info.persistence.lastError, /kept in memory only/);
    const del = await (await fetch(`${url}/api/delivery`, { headers: UI })).json();
    assert.equal(del.receiver.persistence.durability, 'failing');
    assert.match((await (await fetch(`${url}/api/events`, { headers: UI })).json()).notice, /kept in memory only/);
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.deepEqual(Object.keys(health).sort(), ['at', 'demo', 'runtime', 'schema', 'state'], 'the health contract gets no extra fields');
    fs.rmSync(blocker);
    await hook(url, [activity(3)], WH);
    assert.ok(await waitFor(async () => (await (await fetch(`${url}/api/health`)).json()).state === 'ready'), 'ready again once a write succeeds');
  }, { env: HOSTED, realStore: store });
});
test('7. a corrupt events file is moved aside (never overwritten); the notice clears after the first good write; flush writes pending events', () => {
  const dir = tmpDir(); const file = path.join(dir, 'default', 'events.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  const fixed = () => Date.UTC(2026, 10, 7, 12, 0, 0);
  const s = createEventStore({ max: 10, file, now: fixed });
  assert.equal(s.count(), 0); assert.match(s.loadError(), /could not be read.*kept as events\.json\.corrupt-/);
  const kept = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('events.json.corrupt-'));
  assert.equal(kept.length, 1); assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), '{ this is not json', 'the evidence is intact');
  assert.ok(!fs.existsSync(file), 'nothing was overwritten or left in the way');
  s.add(ev(1)); assert.ok(s.loadError(), 'the notice stays until something is written');
  s.flush();
  assert.equal(s.loadError(), null, 'cleared after the first successful write'); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1);
  // A second corrupt file at the same moment gets a different name: still never overwritten.
  fs.writeFileSync(file, '[[[bad'); createEventStore({ max: 10, file, now: fixed });
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('events.json.corrupt-')).length, 2);
  // A valid-JSON file that is not an array is corrupt too.
  fs.writeFileSync(file, '{"events":[]}'); assert.match(createEventStore({ max: 10, file, now: fixed }).loadError(), /kept as events\.json\.corrupt-/);
  // SIGTERM path: flush() writes what is pending right now.
  const f2 = path.join(tmpDir(), 'e.json'); const s2 = createEventStore({ max: 10, file: f2, persistDelayMs: 1e9 });
  s2.add(ev(1)); assert.ok(!fs.existsSync(f2)); s2.flush(); assert.equal(JSON.parse(fs.readFileSync(f2, 'utf8')).length, 1);
  assert.ok(PERSIST_DELAY_MS <= 100, `the window in which a SIGKILL can lose the newest events is ${PERSIST_DELAY_MS} ms`);
});

// ---- 8: reset -------------------------------------------------------------------------------------------------------------------------
test('8. POST /api/reset with no workspace header resets the default workspace (what the browser and the reset script use) and reports accurately', async () => {
  await withServer(async (url) => {
    await post(url, '/api/mode', { source: 'mock' });
    await post(url, '/api/mock/play', { name: 'signin-success' });
    assert.equal((await (await fetch(`${url}/api/events`)).json()).count, 4);
    await post(url, '/api/mode', { source: 'real' }); await hook(url, [activity(1)]); await post(url, '/api/mode', { source: 'mock' });
    const r = await (await post(url, '/api/reset', {})).json();
    assert.deepEqual([r.reset, r.workspace, r.realEventsKept, r.realEvents], ['ok', 'default', true, 1], 'in Mock it still says the Real events were kept, and how many');
    assert.equal((await (await fetch(`${url}/api/events`)).json()).count, 0, 'what the unlabelled browser sees is reset');
    await post(url, '/api/mode', { source: 'real' });
    assert.equal((await (await fetch(`${url}/api/events`)).json()).count, 1, 'the Real event really was kept');
  }, { env: { ...REAL } });
  const { reset } = await import('../../scripts/reset.mjs');
  await withServer(async (url) => {
    await post(url, '/api/mock/play', { name: 'signin-success' });
    assert.equal((await reset(url)).workspace, 'default');
    assert.equal((await (await fetch(`${url}/api/events`)).json()).count, 0, 'the script reset what an unlabelled client sees');
  });
});

// ---- 11: browser hardening headers ----------------------------------------------------------------------------------------------------
test('11. the UI and the API carry CSP, frame-ancestors none, X-Frame-Options DENY, Referrer-Policy no-referrer and nosniff', async () => {
  await withServer(async (url) => {
    for (const p of ['/', '/api/info', '/api/health', '/nope-page']) {
      const r = await fetch(`${url}${p}`);
      assert.equal(r.headers.get('content-security-policy'), CSP, p); assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer', p); assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    }
    const w = await fetch(`${url}/webhook/pingone-events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' });
    assert.equal(w.headers.get('x-frame-options'), 'DENY');
  });
  assert.match(CSP, /frame-ancestors 'none'/); assert.match(CSP, /script-src 'self'(;|$)/); assert.match(CSP, /default-src 'self'/); assert.match(CSP, /object-src 'none'/); assert.match(CSP, /connect-src 'self'/);
  assert.match(CSP, /font-src https:\/\/fonts\.gstatic\.com/); assert.match(CSP, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
  assert.ok(!/script-src[^;]*(unsafe-inline|unsafe-eval|\*)/.test(CSP), 'scripts: self only');
  assert.ok(!/ngrok/.test(CSP));
});

// ---- 12: paths --------------------------------------------------------------------------------------------------------------------------
test('12. doubled-slash and encoded variants of the webhook and API paths are never answered with the web page', async () => {
  await withServer(async (url) => {
    for (const p of ['//webhook/pingone', '//webhook/pingone-events', '///webhook/pingone', '/webhook//pingone', '//api/info', '/api//info', '//', '/%2Fwebhook/pingone', '/webhook%2Fpingone', '/webhook%2fpingone-events', '/Webhook/Nope', '/api%2Finfo']) {
      for (const method of ['HEAD', 'GET']) {
        const r = await fetch(`${url}${p}`, { method });
        assert.notEqual(r.status, 200, `${method} ${p} must not be a 200 page`);
        assert.ok([403, 404, 405].includes(r.status), `${method} ${p} -> ${r.status}`);
      }
    }
    assert.equal((await rawHttp(`${url}//webhook/pingone`, { method: 'HEAD' })).status, 404);
    assert.equal((await fetch(`${url}/some/client/route`)).status, 200, 'real client routes still get the page');
  });
});
test('12. trailing-slash, upper-case path and lower-case Basic scheme behave exactly like the exact URL (200 or 401, never a misleading 401/403/404)', async () => {
  await withServer(async (url) => {
    const lower = { authorization: `basic ${Buffer.from(`pingone:${HW}`).toString('base64')}` };
    for (const p of ['/webhook/pingone-events', '/webhook/pingone-events/', '/Webhook/PingOne-Events', '/WEBHOOK/PINGONE/', '/webhook/pingone']) {
      assert.equal((await fetch(`${url}${p}`, { method: 'HEAD' })).status, 401, `HEAD ${p} anonymous`);
      assert.equal((await fetch(`${url}${p}`, { method: 'HEAD', headers: WH })).status, 200, `HEAD ${p} with the credential`);
      assert.equal((await fetch(`${url}${p}`, { method: 'HEAD', headers: lower })).status, 200, `HEAD ${p} with a lower-case scheme`);
      const post1 = await hook(url, [activity(Math.floor(Math.random() * 1e6))], WH, p); assert.equal(post1.status, 200, `POST ${p}`);
    }
    assert.equal((await fetch(`${url}/webhook/pingone-events/`, { method: 'GET', headers: WH })).status, 405);
  }, { env: { ...HOSTED, PEV_WEBHOOK_RPM: '1000', PEV_WEBHOOK_UNAUTH_RPM: '1000' } });
  // The public host reaches the trailing-slash form too (the Host check uses the same path test).
  await withServer(async (url) => {
    const u = new URL(url);
    const call = (p, extra) => rawHttp(url + p, { method: 'HEAD', headers: { host: `hook.example:${u.port}`, ...extra } });
    assert.equal((await call('/webhook/pingone-events/', WH)).status, 200);
    assert.equal((await call('/Webhook/PingOne-Events', WH)).status, 200);
    assert.equal((await call('/api/info', WH)).status, 403);
  }, { env: { ...HOSTED, WEBHOOK_ALLOWED_HOSTS: 'hook.example' } });
});

// ---- 13: parser -----------------------------------------------------------------------------------------------------------------------
const OPT = { receivedAt: '2026-11-07T13:00:00.000Z' };
test('13. the hash fallback id includes the result status; path-ish ids are not trusted', () => {
  const base = { action: { type: 'A.B' }, correlationId: 'c1', recordedAt: '2026-11-07T12:00:00Z', actors: { client: { id: 'x' } } };
  const ok = parseActivity({ ...base, result: { status: 'SUCCESS' } }, OPT).event.eventId; const bad = parseActivity({ ...base, result: { status: 'FAILED' } }, OPT).event.eventId;
  assert.notEqual(ok, bad, 'a success and a failure of the same thing are different events');
  for (const id of ['../../etc/passwd', '..', 'a/b', '/abs', 'a\\b', '.hidden', '-x', 'a b', 'a'.repeat(121), 'id@host', '%2e%2e', 'a..b/c', '']) assert.match(parseActivity({ ...base, id }, OPT).event.eventId, /^h-[0-9a-f]{24}$/, JSON.stringify(id));
  for (const id of ['00000000-0000-4000-8000-000000000001', 'evt_123', 'a.b:c-d', 'A1']) assert.equal(parseActivity({ ...base, id }, OPT).event.eventId, id);
});
test('13. a forged recordedAt (far future, far past, negative year, nonsense) cannot choose where the event sorts: arrival time does', () => {
  for (const ts of ['9999-12-31T23:59:59Z', '+275760-09-13T00:00:00.000Z', '-000001-01-01T00:00:00Z', '1970-01-01T00:00:00Z', '1999-12-31T23:59:59Z', '2026-11-09T00:00:00Z', 'not a date', 5, null]) {
    const e = parseActivity({ action: { type: 'A.B' }, recordedAt: ts }, OPT).event;
    assert.equal(e.timestamp, OPT.receivedAt, `${JSON.stringify(ts)} is replaced by the arrival time`);
  }
  assert.equal(parseActivity({ action: { type: 'A.B' }, recordedAt: '2026-11-07T12:30:00Z' }, OPT).event.timestamp, '2026-11-07T12:30:00.000Z', 'a sane time is kept');
  assert.equal(parseActivity({ action: { type: 'A.B' }, recordedAt: '2026-11-08T12:00:00Z' }, OPT).event.timestamp, '2026-11-08T12:00:00.000Z', 'within a day of arrival is tolerated (clock skew)');
  const s = createEventStore({ max: 10 });
  const mk = (n, recordedAt) => parseActivity({ id: `evt${n}`, action: { type: 'A.B' }, recordedAt }, { receivedAt: new Date(Date.UTC(2026, 10, 7, 13, 0, n)).toISOString() }).event;
  s.add(mk(1, '9999-12-31T23:59:59Z')); s.add(mk(2, '2026-11-07T12:00:00Z')); s.add(mk(3, '1999-01-01T00:00:00Z'));
  assert.deepEqual(s.query({}).map((e) => e.eventId), ['evt3', 'evt2', 'evt1'], 'newest ARRIVAL first, whatever the forged timestamps say');
  assert.deepEqual(parseActivity({ id: 'evt1', action: { type: 'A.B' } }, OPT).event.receivedAt, OPT.receivedAt);
});
test('13. the raw size cap counts bytes, not characters', () => {
  const chars = Math.floor(MAX_RAW_BYTES / 3) + 200; // fewer characters than the cap, more bytes
  const e = parseActivity({ action: { type: 'A.B' }, blob: '€'.repeat(chars) }, OPT).event;
  assert.ok(JSON.stringify({ action: { type: 'A.B' }, blob: '€'.repeat(chars) }).length < MAX_RAW_BYTES);
  assert.equal(e.raw.truncated, true); assert.ok(e.raw.bytes > MAX_RAW_BYTES);
  assert.notEqual(parseActivity({ action: { type: 'A.B' }, blob: '€'.repeat(100) }, OPT).event.raw.truncated, true);
});
test('13. a partly bad delivery reports how many it rejected', () => {
  const store = createEventStore({ max: 10 });
  const r = ingest({ body: [activity(1), { nope: 1 }, 7], store, via: 'webhook' });
  assert.deepEqual([r.status, r.body.count, r.body.stored, r.body.rejected], [200, 1, 1, 2]);
  assert.equal(ingest({ body: [activity(2)], store, via: 'webhook' }).body.rejected, undefined, 'no rejected field when nothing was rejected');
  assert.equal(parseDelivery([activity(3), { nope: 1 }], OPT).rejected.length, 1);
});

// ---- same-origin guard is wired in, and X-Forwarded-Host cannot defeat it -----------------------------------------------------------
test('writes are same-origin: a cross-origin write is refused even with the page credential, and a spoofed X-Forwarded-Host does not help', async () => {
  await withServer(async (url) => {
    const mode = (origin, extra = {}) => fetch(`${url}/api/mode`, { method: 'POST', headers: { 'content-type': 'application/json', ...UI, origin, ...extra }, body: JSON.stringify({ source: 'real' }) });
    assert.equal((await mode('https://evil.example')).status, 403);
    assert.equal((await mode('https://evil.example', { 'x-forwarded-host': 'evil.example' })).status, 403);
    assert.equal((await mode('https://evil.example', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await mode(url, { 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await mode('https://ui.example')).status, 200, 'the admin-listed page host is same-origin');
    for (const p of ['/api/sink', '/api/pull', '/api/reset', '/api/mock/play']) {
      const r = await fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...UI, origin: 'https://evil.example' }, body: '{}' });
      assert.equal(r.status, 403, `${p} cross-origin`);
    }
  }, { env: { ...HOSTED, LAB_ALLOWED_HOSTS: 'ui.example' } });
});

// ---- 14: doctor says Node >= 26 --------------------------------------------------------------------------------------------------------
test('14. the doctor requires Node 26: the threshold is tested on versions either side of it', async () => {
  const { nodeCheck, MIN_NODE } = await import('../src/doctor.js');
  assert.equal(MIN_NODE, 26);
  for (const v of ['26.0.0', '26.8.2', '27.1.0', '30.0.0']) assert.equal(nodeCheck(v).level, 'pass', v);
  for (const v of ['25.9.9', '24.0.0', '22.5.0', '20.20.2', '18.0.0', '0.12.0', 'x.y']) assert.equal(nodeCheck(v).level, 'fail', v);
  assert.match(nodeCheck('20.0.0').detail, /need >= 26/);
  const node = (await runChecks()).find((c) => c.id === 'node');
  assert.equal(node.level, nodeCheck().level);
});
test('14. the doctor fails when a diagram file holds an undefined {{token}}', async () => {
  const { rawDiagram } = await import('../src/diagramData.js');
  const checks = await runChecks({ diagrams: [{ ...rawDiagram('event-pipeline'), lede: 'Hello {{castNope}}' }] });
  const t = checks.find((c) => c.id === 'story-tokens'); assert.equal(t.level, 'fail'); assert.match(t.detail, /castNope/);
  assert.equal(checks.find((c) => c.id === 'verticals').level, 'fail');
  assert.equal((await runChecks()).find((c) => c.id === 'story-tokens').level, 'pass');
});
