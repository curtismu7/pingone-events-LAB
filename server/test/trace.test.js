import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPullHops, buildReceiveHops, formatTraceparent, newTrace, parseTraceparent } from '../src/trace.js';
import { withServer } from './helpers.js';

const GOOD = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

test('parseTraceparent accepts the W3C shape and refuses everything else', () => {
  assert.deepEqual(parseTraceparent(GOOD), { traceId: '0af7651916cd43dd8448eb211c80319c', parentId: 'b7ad6b7169203331', flags: '01' });
  for (const bad of [undefined, '', 'x', GOOD.toUpperCase(), `00-${'0'.repeat(32)}-b7ad6b7169203331-01`, `00-0af7651916cd43dd8448eb211c80319c-${'0'.repeat(16)}-01`, `${GOOD}-extra`, 5, `00-${'a'.repeat(32)}-${'b'.repeat(16)}-ff`]) assert.equal(parseTraceparent(bad), null);
});

test('receive hops: one trace id, a distinct valid span per hop, the sink hop only when forwarding queued something', () => {
  const trace = newTrace(GOOD);
  assert.equal(trace.traceId, '0af7651916cd43dd8448eb211c80319c');
  const plain = buildReceiveHops({ trace, path: '/webhook/pingone-events', bodyText: '[{"action":{"type":"A.B"}}]', status: 200, responseText: '{"received":true}', stored: 1, duplicates: 0 });
  assert.equal(plain.length, 2);
  const fwd = buildReceiveHops({ trace, path: '/webhook/pingone-events', bodyText: '[]', status: 200, responseText: '{}', stored: 1, duplicates: 0, sink: { queued: 1, note: '1 queued' } });
  assert.equal(fwd.length, 3);
  assert.match(fwd[2].label, /never waited for/);
  for (const set of [plain, fwd]) {
    assert.equal(new Set(set.map((h) => h.traceparent)).size, set.length);
    for (const h of set) { assert.ok(parseTraceparent(h.traceparent)); assert.ok(h.traceparent.includes(trace.traceId)); assert.ok(h.request.includes(h.traceparent)); }
  }
  assert.equal(formatTraceparent('a'.repeat(32), 'b'.repeat(16)), `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
});

test('pull hops show paths and statuses only: never a header, token or secret', () => {
  const hops = buildPullHops({ trace: newTrace(), calls: [{ method: 'POST', host: 'auth.pingone.example', path: '/ENV/as/token', status: 200, bytes: 120 }, { method: 'GET', host: 'api.pingone.example', path: '/v1/environments/ENV/subscriptions', status: 200, bytes: 900 }] });
  assert.equal(hops.length, 2);
  assert.match(hops[0].request, /POST https:\/\/auth\.pingone\.example\/ENV\/as\/token/);
  assert.match(hops[1].response, /HTTP 200, 900 bytes/);
  assert.ok(!/authorization|bearer|secret/i.test(JSON.stringify(hops)));
});

test('POST /webhook/pingone-events?hops continues a valid incoming trace only (Mock test button)', async () => {
  await withServer(async (url) => {
    const send = (headers = {}) => fetch(`${url}/webhook/pingone-events`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-lab-hops': '1', ...headers }, body: JSON.stringify([{ id: `e${Math.random()}`.replace('.', ''), action: { type: 'A.B' } }]) });
    let j = await (await send()).json();
    assert.equal(j.hops.length, 2);
    assert.match(j.traceId, /^[0-9a-f]{32}$/);
    j = await (await send({ traceparent: GOOD })).json();
    assert.equal(j.traceId, '0af7651916cd43dd8448eb211c80319c');
    j = await (await send({ traceparent: 'garbage' })).json();
    assert.notEqual(j.traceId, '0af7651916cd43dd8448eb211c80319c');
  });
});
