import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { installNetguard, netguardSelfTest } from '../src/netguard.js';

test('self-test: every route out is refused and recorded, none reaches the network', async () => {
  const r = await netguardSelfTest();
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.blocked, 6);
  assert.match(r.detail, /fetch: blocked.*socket: blocked.*socket-ip: blocked.*dns: blocked.*dns-resolve: blocked.*udp: blocked/);
  installNetguard().restore();
});

test('a real outbound attempt is blocked and appears in attempts', async () => {
  const g = installNetguard();
  // The timeout makes a loosened fetch guard fail fast (TimeoutError) instead of hanging on a real lookup.
  await assert.rejects(fetch('https://example.invalid/', { signal: AbortSignal.timeout(1500) }), /network blocked/);
  await assert.rejects(new Promise((res, rej) => { const q = http.get('http://other.invalid/', res); q.on('error', rej); }), /network blocked|ENOTFOUND|blocked/);
  assert.ok(g.attempts.some((a) => a === 'fetch:example.invalid'));
  assert.ok(g.attempts.some((a) => a.includes('other.invalid')));
  g.restore();
});

test('loopback still works under the guard', async () => {
  const g = installNetguard();
  const server = http.createServer((_q, s) => s.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: AbortSignal.timeout(3000) });
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(g.attempts, []);
  } finally { await new Promise((r) => server.close(r)); g.restore(); } // always close: a failed assertion must not leave a listener that hangs the run
});

test('restore puts the real functions back', async () => {
  const before = net.Socket.prototype.connect;
  const g = installNetguard();
  assert.notEqual(net.Socket.prototype.connect, before);
  g.restore();
  assert.equal(net.Socket.prototype.connect, before);
});

test('raw IP-literal sockets are refused and recorded as socket:<ip>', async () => {
  const g = installNetguard();
  assert.throws(() => net.connect({ host: '192.0.2.1', port: 80 }), /network blocked: 192\.0\.2\.1/);
  assert.throws(() => net.connect(80, '192.0.2.2'), /network blocked: 192\.0\.2\.2/);
  assert.throws(() => http.get({ host: '192.0.2.3', port: 80 }), /network blocked: 192\.0\.2\.3/);
  assert.deepEqual(g.attempts.filter((a) => a.startsWith('socket:')), ['socket:192.0.2.1', 'socket:192.0.2.2', 'socket:192.0.2.3']);
  g.restore();
});

test('a wildcard bind (container OBS_BIND=0.0.0.0) can listen, but connecting to it is still refused', async () => {
  const g = installNetguard();
  const srv = net.createServer((c) => c.end());
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '0.0.0.0', res); });
  try {
    const { port } = srv.address();
    assert.deepEqual(g.attempts, [], 'listening is not an outbound attempt');
    await assert.rejects(new Promise((res, rej) => { try { const s = net.connect({ host: '0.0.0.0', port }); s.on('error', rej); s.on('connect', () => { s.destroy(); res(); }); } catch (e) { rej(e); } }), /network blocked/);
    assert.ok(g.attempts.includes('socket:0.0.0.0'));
  } finally { await new Promise((r) => srv.close(r)); g.restore(); }
});

test('dns.resolve*, dns.promises.* and Resolver are refused and recorded; loopback names pass the check', async () => {
  const g = installNetguard();
  await assert.rejects(dns.promises.resolve4('probe.invalid'), /network blocked/);
  await assert.rejects(dns.promises.lookup('probe2.invalid'), /network blocked/);
  await assert.rejects(new dns.promises.Resolver().resolve4('probe3.invalid'), /network blocked/);
  await new Promise((res) => dns.resolve4('probe4.invalid', (e) => { assert.match(e.message, /network blocked/); res(); }));
  for (const h of ['probe', 'probe2', 'probe3', 'probe4']) assert.ok(g.attempts.includes(`dns:${h === 'probe' ? 'probe' : h}.invalid`), h);
  g.restore();
});

test('udp: the address is found by position, so a message body cannot masquerade as it', () => {
  const g = installNetguard();
  const s = dgram.createSocket('udp4');
  try {
    assert.throws(() => s.send('127.0.0.1', 9, 'evil.invalid'), /network blocked: evil\.invalid/);
    assert.throws(() => s.send(Buffer.from('x'), 0, 1, 9, 'evil2.invalid'), /network blocked: evil2\.invalid/);
    assert.throws(() => s.send('x', 9, 'evil3.invalid', () => {}), /network blocked: evil3\.invalid/);
    assert.deepEqual(g.attempts.filter((a) => a.startsWith('udp:')), ['udp:evil.invalid', 'udp:evil2.invalid', 'udp:evil3.invalid']);
    s.send('plain message', 9, '127.0.0.1', () => {}); // a string body is fine for loopback
  } finally { s.close(); g.restore(); }
});

test('the allow-list lets exactly the named hosts through, is replaceable, and everything else is still refused and recorded', async () => {
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (u) => { calls.push(String(u)); return new Response('ok'); }; // what the guard calls through to: no network
  const g = installNetguard();
  try {
    g.setAllowed(['cluster.example', 'API.pingone.example']);
    assert.deepEqual(g.allowedHosts().sort(), ['api.pingone.example', 'cluster.example']);
    assert.equal(await (await fetch('https://cluster.example/_bulk')).text(), 'ok');
    assert.equal(await (await fetch('https://api.pingone.example/x')).text(), 'ok');
    await assert.rejects(fetch('https://other.example/', { signal: AbortSignal.timeout(1500) }), /network blocked: other\.example/);
    assert.deepEqual(calls, ['https://cluster.example/_bulk', 'https://api.pingone.example/x']);
    assert.deepEqual(g.attempts, ['fetch:other.example']);
    g.setAllowed([]); // Mock mode: nothing is allowed, including what was allowed a moment ago
    await assert.rejects(fetch('https://cluster.example/_bulk', { signal: AbortSignal.timeout(1500) }), /network blocked: cluster\.example/);
    assert.throws(() => net.connect({ host: 'cluster.example', port: 443 }), /network blocked: cluster\.example/);
    const s = dgram.createSocket('udp4');
    try { g.setAllowed(['cluster.example']); assert.throws(() => s.send('x', 9, 'cluster.example'), /network blocked/, 'udp is never allowed out, even for an allowed host'); } finally { s.close(); }
  } finally { g.restore(); globalThis.fetch = real; }
});
