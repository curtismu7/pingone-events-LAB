import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost, assertBindAllowed, bindHost, portProblem, resolvePort, isReservedHost, scanHosts, scanKeys, cleanText, hostCheck, sameOriginWrites, sameOriginWritesFor, isBlockedTargetHost, webhookHosts, WEBHOOK_PATHS } from '../src/safety.js';

test('loopback names', () => {
  for (const h of ['localhost', '127.0.0.1', '127.9.9.9', '::1', '[::1]']) assert.ok(isLoopbackHost(h), h);
  for (const h of ['0.0.0.0', '192.168.1.5', 'example.com', 'localhost.evil.invalid']) assert.ok(!isLoopbackHost(h), h);
});

test('bind: loopback only unless PEV_BIND is set', () => {
  assert.equal(bindHost({}), '127.0.0.1');
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /loopback only/);
  assert.equal(assertBindAllowed('127.0.0.1', {}), '127.0.0.1');
  assert.equal(assertBindAllowed('0.0.0.0', { PEV_BIND: '0.0.0.0' }), '0.0.0.0');
});

test('ports: 7802 only, never a reserved or another app\'s one', () => {
  assert.equal(portProblem(7802), null);
  for (const p of [5000, 7720, 7800, 7801, 7803, 7710, 7700, 5200, 8080, 5173, 3900, 4000, 4400, 4510, 4600, 4601, 4840, 18080, 19080, 19090, 4771, 4700]) assert.ok(portProblem(p), String(p));
  assert.ok(portProblem(NaN));
  assert.equal(resolvePort({}), 7802);
  assert.equal(resolvePort({ PORT: '7802' }), 7802);
  assert.throws(() => resolvePort({ PORT: '7800' })); // observability-lab owns 7800
  assert.throws(() => resolvePort({ PORT: '7801' })); // privilege-logging-LAB owns 7801
});

test('reserved hosts and the host scan', () => {
  assert.ok(isReservedHost('a.b.invalid')); assert.ok(isReservedHost('mcp.northwind.example')); assert.ok(!isReservedHost('example.com'), 'the rulebook allows only .example and .invalid'); assert.ok(!isReservedHost('example.org')); assert.ok(!isReservedHost('sub.example.com'));
  assert.deepEqual(scanHosts('https://as.example.invalid/x and mail a@agent.example and http://localhost:7800/'), []);
  assert.deepEqual(scanHosts('authz warm (http://authz.example:9001)'), [], 'a URL in parentheses keeps its host clean');
  assert.deepEqual(scanHosts('authz warm (http://real-host.test:9001)'), ['real-host.test'], 'and a real host in parentheses is still caught');
  assert.deepEqual(scanHosts('https://example.com/mcp'), ['example.com']);
  assert.deepEqual(scanHosts('see https://real.com/x and 10.1.2.3'), ['10.1.2.3', 'real.com']);
});

test('key scan: only sk-MOCK- values are allowed in shipped text', () => {
  assert.deepEqual(scanKeys('sk-MOCK-ABCDEF and sk-MOCK-REAL-UPSTREAM-PLACEHOLDER'), []);
  assert.equal(scanKeys('key sk-proj-abcdefghijklmnop1234').length, 1);
  assert.equal(scanKeys('sk-ant-api03-abcdefghijkl').length, 1);
});

test('cleanText strips control and bidi characters and caps the length', () => {
  assert.equal(cleanText('a\u0000b\nc‮d', 80), 'a b c d');
  assert.equal(cleanText('x'.repeat(100), 10).length, 10);
  assert.equal(cleanText(undefined), '');
});

const run = (mw, req) => { const out = {}; const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } }; mw(req, res, () => { out.next = true; }); return out; };

test('hostCheck refuses a non-loopback Host (DNS rebinding)', () => {
  assert.ok(run(hostCheck, { headers: { host: 'localhost:7800' } }).next);
  assert.ok(run(hostCheck, { headers: { host: '[::1]:7800' } }).next);
  assert.equal(run(hostCheck, { headers: { host: 'evil.example.invalid:7800' } }).status, 403);
  assert.equal(run(hostCheck, { headers: {} }).status, 403);
});

test('sameOriginWrites: GET passes, cross-origin and cross-site writes refused', () => {
  const h = { host: 'localhost:7800' };
  assert.ok(run(sameOriginWrites, { method: 'GET', headers: { ...h, origin: 'http://evil.example.invalid' } }).next);
  assert.ok(run(sameOriginWrites, { method: 'POST', headers: h }).next, 'no Origin (curl) is allowed');
  assert.ok(run(sameOriginWrites, { method: 'POST', headers: { ...h, origin: 'http://localhost:7800' } }).next);
  assert.equal(run(sameOriginWrites, { method: 'POST', headers: { ...h, origin: 'http://localhost:9999' } }).status, 403);
  assert.equal(run(sameOriginWrites, { method: 'POST', headers: { ...h, origin: 'null' } }).status, 403);
  assert.equal(run(sameOriginWrites, { method: 'DELETE', headers: { ...h, 'sec-fetch-site': 'cross-site' } }).status, 403);
  assert.equal(run(sameOriginWrites, { method: 'PUT', headers: { ...h, 'sec-fetch-site': 'same-site' } }).status, 403);
  assert.ok(run(sameOriginWrites, { method: 'POST', headers: { ...h, 'sec-fetch-site': 'same-origin' } }).next);
});

test('same-origin: the Origin must match the request\'s REAL Host or a host the admin listed in LAB_ALLOWED_HOSTS; X-Forwarded-Host is never trusted', () => {
  const env = { LAB_ALLOWED_HOSTS: 'local.example,ui.example' };
  const post = (origin, extra = {}, host = '127.0.0.1:7802') => run(sameOriginWritesFor(env), { method: 'POST', headers: { host, origin, ...extra } });
  assert.equal(post('https://app.demo.example').status, 403);
  assert.equal(post('not a url').status, 403);
  assert.ok(post('http://127.0.0.1:7802').next, 'Origin equals the real Host');
  assert.equal(post('https://evil.example', { 'x-forwarded-host': 'evil.example' }).status, 403, 'a client-supplied X-Forwarded-Host cannot make a foreign origin same-origin');
  assert.equal(post('https://evil.example', { 'x-forwarded-host': '127.0.0.1:7802' }).status, 403);
  assert.ok(post('https://ui.example').next, 'the page\'s own public host (listed by the admin) is trusted even when an ingress rewrote Host');
  assert.ok(post('https://local.example:8443').next, 'with a port: the host NAME is what is listed');
  assert.equal(post('http://ui.example').status, 403, 'plain http for a non-loopback listed host is not trusted');
  assert.equal(post('https://ui.example.evil.example').status, 403);
  assert.equal(post('https://ui.example', {}, 'ui.example').status !== 403, true);
});

test('review fixes: octets above 255 are not loopback; 4840 is reserved; control and bidi characters are stripped', async () => {
  assert.equal(isLoopbackHost('127.999.999.999'), false);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.255.255.255'), true);
  assert.ok(portProblem(4840));
  const { loadCast } = await import('../src/cast.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pad-')), 'customer.config.json');
  fs.writeFileSync(f, JSON.stringify({ cast: { brand: 'Acme\u202eevil' } }));
  assert.ok(!/\u202e/.test(loadCast(f).castBrand));
});

test('the tunnel host may reach the two webhook paths with POST/HEAD and nothing else', () => {
  const env = process.env.WEBHOOK_ALLOWED_HOSTS;
  process.env.WEBHOOK_ALLOWED_HOSTS = 'tunnel.example';
  try {
    assert.deepEqual(WEBHOOK_PATHS, ['/webhook/pingone-events', '/webhook/pingone']);
    for (const path of WEBHOOK_PATHS) {
      assert.ok(run(hostCheck, { headers: { host: 'tunnel.example' }, path, method: 'POST' }).next, `POST ${path}`);
      assert.ok(run(hostCheck, { headers: { host: 'tunnel.example' }, path, method: 'HEAD' }).next, `HEAD ${path}`);
      assert.equal(run(hostCheck, { headers: { host: 'tunnel.example' }, path, method: 'GET' }).status, 403, `GET ${path} through the tunnel`);
    }
    assert.equal(run(hostCheck, { headers: { host: 'tunnel.example' }, path: '/api/events', method: 'GET' }).status, 403, 'the API is not reachable through the tunnel');
    assert.equal(run(hostCheck, { headers: { host: 'tunnel.example' }, path: '/api/mode', method: 'POST' }).status, 403);
    assert.equal(run(hostCheck, { headers: { host: 'tunnel.example' }, path: '/webhook/other', method: 'POST' }).status, 403);
    assert.equal(run(hostCheck, { headers: { host: 'other.example' }, path: '/webhook/pingone-events', method: 'POST' }).status, 403, 'only the configured host');
  } finally { if (env === undefined) delete process.env.WEBHOOK_ALLOWED_HOSTS; else process.env.WEBHOOK_ALLOWED_HOSTS = env; }
  assert.throws(() => webhookHosts({ WEBHOOK_ALLOWED_HOSTS: 'not a host' }), /not a host name/);
});

test('the SSRF guard refuses link-local, metadata and unspecified targets', () => {
  for (const h of ['169.254.169.254', '169.254.0.1', '100.100.100.200', 'metadata.google.internal', 'foo.internal', '0.0.0.0', '::', 'fe80::1', 'fd00:ec2::254', '[fe80::1]']) assert.ok(isBlockedTargetHost(h), h);
  for (const h of ['cluster.example', '10.1.2.3', '192.168.1.5', 'localhost', '127.0.0.1']) assert.ok(!isBlockedTargetHost(h), h);
});
