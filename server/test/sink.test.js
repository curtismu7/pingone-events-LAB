import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, buildBulkBody, createElasticsearchSink, scrubber, toDocument } from '../src/sinks/elasticsearch.js';
import { createMockFetch, MOCK_SINK_TARGET } from '../src/mockSink.js';
import { parseActivity } from '../src/eventParser.js';
import { activity, fakeFetch, jsonRes } from './helpers.js';

const TARGET = { origin: 'https://cluster.example:9200', index: 'pingone-events', authorization: 'ApiKey test-api-key-value', secrets: ['test-api-key-value', 'ApiKey test-api-key-value'] };
const evt = (n, type = 'FLOW.CREATED') => parseActivity(activity(n, type), { receivedAt: '2026-11-07T13:00:00Z' }).event;
const okBulk = (init) => { const lines = String(init.body).trim().split('\n'); const items = []; for (let i = 0; i < lines.length; i += 2) items.push({ index: { _id: JSON.parse(lines[i]).index._id, status: 201 } }); return jsonRes(200, { errors: false, items }); };
const make = (handler, opt = {}) => { const delays = []; const f = fakeFetch(handler); const sink = createElasticsearchSink({ target: TARGET, fetchImpl: f, sleep: async (ms) => { delays.push(ms); }, ...opt }); return { sink, f, delays }; };

test('the bulk body is ndjson: one action line with the event id as _id, then one flat document with the raw activity under raw', () => {
  const e = evt(1);
  const body = buildBulkBody([e, evt(2)], 'pingone-events');
  assert.ok(body.endsWith('\n')); const lines = body.trim().split('\n'); assert.equal(lines.length, 4);
  assert.deepEqual(JSON.parse(lines[0]), { index: { _index: 'pingone-events', _id: e.eventId } });
  const doc = JSON.parse(lines[1]);
  assert.deepEqual(Object.keys(doc), ['@timestamp', 'eventType', 'actorId', 'actorType', 'status', 'resource', 'environmentId', 'correlationId', 'eventId', 'via', 'raw']);
  assert.equal(doc['@timestamp'], e.timestamp); assert.equal(doc.raw.action.type, 'FLOW.CREATED');
  assert.deepEqual(toDocument({ ...e, actorId: '' }).actorId, null, 'empty values are null so the index stays clean');
});

test('idempotent _id: the same event queued twice sends the same document id both times', async () => {
  const { sink, f } = make((_u, init) => okBulk(init));
  const e = evt(3);
  sink.enqueue(e); await sink.drain(); sink.enqueue(e); await sink.drain();
  const ids = f.calls.map((c) => JSON.parse(c.body.split('\n')[0]).index._id);
  assert.deepEqual(ids, [e.eventId, e.eventId]);
  assert.equal(sink.status().sent, 2);
});

test('requests go to the one configured origin, with manual redirects, the credential only in the header, ndjson', async () => {
  const { sink, f } = make((_u, init) => okBulk(init));
  sink.enqueue(evt(4)); await sink.drain();
  const c = f.calls[0];
  assert.equal(c.url, 'https://cluster.example:9200/_bulk'); assert.equal(c.method, 'POST'); assert.equal(c.redirect, 'manual');
  assert.equal(c.headers['content-type'], 'application/x-ndjson'); assert.equal(c.headers.authorization, TARGET.authorization);
  assert.ok(!c.body.includes('test-api-key-value'), 'the credential is never in the body');
});

test('the queue is bounded: the oldest is dropped when full and counted; batches are capped', async () => {
  const { sink, f } = make((_u, init) => okBulk(init), { maxQueue: 5, batchSize: 2 });
  for (let i = 1; i <= 8; i++) sink.enqueue(evt(i));
  assert.deepEqual([sink.status().queued, sink.status().dropped], [5, 3]);
  await sink.drain();
  assert.equal(sink.status().sent, 5);
  assert.deepEqual(f.calls.map((c) => c.body.trim().split('\n').length / 2), [2, 2, 1], 'batches of at most 2');
  const sent = f.calls.flatMap((c) => c.body.trim().split('\n').filter((_, i) => i % 2 === 0).map((l) => JSON.parse(l).index._id.slice(-3)));
  assert.deepEqual(sent, ['004', '005', '006', '007', '008'], 'the three oldest were the ones dropped');
});

test('retries are capped with exponential backoff; then the batch counts as failed (429, 503 and unreachable alike)', async () => {
  for (const [label, handler, status] of [
    ['429', () => jsonRes(429, { error: { type: 'es_rejected_execution_exception' } }), 429],
    ['503', () => jsonRes(503, { error: 'unavailable' }), 503],
    ['unreachable', () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, null],
  ]) {
    const { sink, f, delays } = make(handler);
    sink.enqueue(evt(5)); sink.enqueue(evt(6)); await sink.drain();
    const s = sink.status();
    assert.equal(f.calls.length, DEFAULTS.maxRetries + 1, `${label}: one try plus ${DEFAULTS.maxRetries} retries`);
    assert.deepEqual(delays, [500, 1000, 2000], `${label}: backoff doubles`);
    assert.deepEqual([s.sent, s.failed, s.queued, s.retried], [0, 2, 0, 6], label);
    assert.equal(s.lastStatus, status, label); assert.ok(s.lastError && s.lastErrorAt, label);
  }
});

test('backoff is capped at maxDelayMs', async () => {
  const { sink, delays } = make(() => jsonRes(503, {}), { maxRetries: 6, baseDelayMs: 1000, maxDelayMs: 3000 });
  sink.enqueue(evt(7)); await sink.drain();
  assert.deepEqual(delays, [1000, 2000, 3000, 3000, 3000, 3000]);
});

test('recovery: a cluster that comes back after a failure indexes the batch and records the success time', async () => {
  let n = 0;
  const { sink } = make((_u, init) => (++n < 3 ? jsonRes(503, {}) : okBulk(init)), { now: () => Date.UTC(2026, 10, 7, 14, 0, 0) });
  sink.enqueue(evt(8)); await sink.drain();
  const s = sink.status();
  assert.deepEqual([s.sent, s.failed, s.retried], [1, 0, 2]);
  assert.equal(s.lastSuccessAt, '2026-11-07T14:00:00.000Z');
});

test('per-document results: throttled documents are retried alone, a mapping error is final, accepted ones are counted once', async () => {
  let call = 0;
  const { sink, f } = make((_u, init) => {
    call += 1;
    const ids = String(init.body).trim().split('\n').filter((_, i) => i % 2 === 0).map((l) => JSON.parse(l).index._id);
    if (call === 1) return jsonRes(200, { errors: true, items: [{ index: { _id: ids[0], status: 201 } }, { index: { _id: ids[1], status: 429 } }, { index: { _id: ids[2], status: 400, error: { type: 'mapper_parsing_exception', reason: 'bad field' } } }] });
    return okBulk(init);
  });
  for (const n of [9, 10, 11]) sink.enqueue(evt(n));
  await sink.drain();
  const s = sink.status();
  assert.deepEqual([s.sent, s.failed, f.calls.length], [2, 1, 2]);
  assert.equal(f.calls[1].body.trim().split('\n').length, 2, 'only the throttled document was sent again');
  assert.match(s.lastError, /rejected \(400\).*mapper_parsing_exception/);
});

test('other failures are final and not retried: 401/403 (credentials), 400, a redirect', async () => {
  for (const [status, headers, re] of [[401, {}, /refused the credentials/], [403, {}, /refused the credentials/], [400, {}, /answered 400/], [302, { location: 'https://elsewhere.example/' }, /redirect.*refused/]]) {
    const { sink, f } = make(() => new Response('x', { status, headers }));
    sink.enqueue(evt(12)); await sink.drain();
    assert.equal(f.calls.length, 1, `${status} is not retried`);
    assert.deepEqual([sink.status().failed, sink.status().sent], [1, 0]);
    assert.match(sink.status().lastError, re);
  }
});

test('secrets never leave the module: an error body that echoes the key, URL credentials and Authorization values are scrubbed', async () => {
  const { sink } = make(() => jsonRes(503, { error: `bad key test-api-key-value at https://user:hunter2@cluster.example with ApiKey test-api-key-value and Bearer abcdef123456` }));
  sink.enqueue(evt(13)); await sink.drain();
  const dump = JSON.stringify(sink.status());
  for (const secret of ['test-api-key-value', 'hunter2', 'abcdef123456']) assert.ok(!dump.includes(secret), secret);
  assert.match(sink.status().lastError, /\[redacted\]/);
  assert.ok(sink.status().lastError.length <= 200);
  const scrub = scrubber(['topsecret99']);
  assert.equal(scrub('a topsecret99 b'), 'a [redacted] b'); assert.equal(scrub('x'.repeat(500), 50).length, 50); assert.equal(scrub('a\u0000b\n\nc'), 'a b c');
  const status = JSON.stringify(sink.status());
  assert.ok(!/authorization|apikey|basic /i.test(status), 'the status never carries a credential header');
});

test('a hanging cluster does not block enqueue, and enqueue never throws', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { sink } = make(async (_u, init) => { await gate; return okBulk(init); });
  const t0 = Date.now();
  for (let i = 1; i <= 20; i++) assert.equal(sink.enqueue(evt(i)), true);
  assert.ok(Date.now() - t0 < 100, 'enqueue returned without waiting');
  const d = sink.drain(); release(); await d;
  assert.equal(sink.status().sent, 20);
  sink.stop();
  assert.equal(sink.enqueue(evt(99)), false, 'a stopped sink refuses quietly');
  assert.doesNotThrow(() => sink.enqueue(null));
});

test('clearQueue empties what is waiting and counts it as discarded (forwarding switched off)', () => {
  const { sink } = make(() => jsonRes(200, {}), { flushDelayMs: 1e9 });
  for (let i = 1; i <= 4; i++) sink.enqueue(evt(i));
  assert.equal(sink.clearQueue(), 4);
  assert.deepEqual([sink.status().queued, sink.status().discarded], [0, 4]);
  sink.stop();
});

test('test connection is a GET of the root; it returns a few bounded fields and never headers or credentials', async () => {
  const { sink, f } = make(() => jsonRes(200, { name: 'node-1', cluster_name: 'c1', version: { number: '8.15.0' }, tagline: 'You Know, for Search', secretish: 'test-api-key-value' }));
  const r = await sink.testConnection();
  assert.equal(f.calls[0].method, 'GET'); assert.equal(f.calls[0].url, 'https://cluster.example:9200/');
  assert.deepEqual(r, { ok: true, status: 200, cluster: 'c1', version: '8.15.0', flavor: 'You Know, for Search', detail: null });
  assert.ok(!JSON.stringify(r).includes('test-api-key-value'));
  const down = await make(() => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); }).sink.testConnection();
  assert.deepEqual([down.ok, down.status], [false, null]); assert.match(down.detail, /ECONNREFUSED/);
  assert.equal((await make(() => new Response('', { status: 401 })).sink.testConnection()).detail, 'the cluster refused the credentials');
});

test('the mock cluster stand-in drives the SAME code: healthy indexes, 429/503/unreachable fail visibly', async () => {
  for (const [scenario, sent, failed] of [['healthy', 2, 0], ['throttled', 0, 2], ['unavailable', 0, 2], ['unreachable', 0, 2]]) {
    const delays = [];
    const sink = createElasticsearchSink({ target: MOCK_SINK_TARGET, fetchImpl: createMockFetch(() => scenario), sleep: async (ms) => { delays.push(ms); } });
    sink.enqueue(evt(1)); sink.enqueue(evt(2)); await sink.drain();
    assert.deepEqual([sink.status().sent, sink.status().failed], [sent, failed], scenario);
    assert.equal(delays.length, scenario === 'healthy' ? 0 : 3, scenario);
  }
});
