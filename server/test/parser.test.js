import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BATCH, MAX_RAW_BYTES, parseActivity, parseDelivery } from '../src/eventParser.js';
import { ingest } from '../src/receiver.js';
import { createEventStore } from '../src/eventStore.js';
import { activity, ENV_ID, CLIENT_ID } from './helpers.js';

const OPT = { receivedAt: '2026-11-07T13:00:00.000Z' };

test('a real Ping Activity delivery parses to the shared event shape, environment read off the actor', () => {
  const r = parseActivity(activity(1, 'FLOW.CREATED', { result: { status: 'SIGN_ON_REQUIRED' } }), OPT);
  assert.deepEqual({ ...r.event, raw: undefined }, {
    eventId: '00000000-0000-4000-8000-000000000001', eventType: 'FLOW.CREATED', actorId: CLIENT_ID, actorType: 'CLIENT', status: 'SIGN_ON_REQUIRED',
    resource: '00000000-0000-4000-8000-0000000000aa', environmentId: ENV_ID, correlationId: '00000000-0000-4000-8000-0000000000ff',
    timestamp: '2026-11-07T12:00:01.000Z', receivedAt: OPT.receivedAt, via: 'webhook', schema: 'activity', raw: undefined,
  });
  assert.deepEqual(r.event.raw._embedded, {}, '_embedded is empty on real deliveries and is not where the environment comes from');
});

test('the user is the actor when present, else the client; the environment can come from either', () => {
  const u = parseActivity(activity(2, 'PASSWORD.CHECK_SUCCEEDED', { actors: { user: { id: 'user-1', environment: { id: ENV_ID } }, client: { id: CLIENT_ID } } }), OPT).event;
  assert.deepEqual([u.actorType, u.actorId, u.environmentId], ['USER', 'user-1', ENV_ID]);
  const c = parseActivity(activity(3, 'X.Y', { actors: { client: { id: CLIENT_ID } }, resources: [{ id: 'r1', environment: { id: ENV_ID } }] }), OPT).event;
  assert.deepEqual([c.actorType, c.environmentId], ['CLIENT', ENV_ID], 'falls back to a resource environment');
  const none = parseActivity(activity(4, 'X.Y', { actors: {}, resources: [] }), OPT).event;
  assert.deepEqual([none.actorType, none.actorId, none.environmentId, none.resource], ['', '', '', '']);
});

test('trap: a top-level `type` is accepted ONLY when there is no `action`; a real event is never matched by the wrong field', () => {
  const hand = parseActivity({ type: 'AUTHENTICATION', result: { status: 'SUCCESS' } }, OPT).event;
  assert.equal(hand.eventType, 'AUTHENTICATION'); assert.equal(hand.schema, 'legacy-type');
  // An `action` object without a usable type is rejected even though a top-level type is sitting right there.
  assert.deepEqual(parseActivity({ type: 'AUTHENTICATION', action: { description: 'no type' } }, OPT), { reject: 'bad_action_type' });
  // And action.type wins when both exist.
  assert.equal(parseActivity({ type: 'OTHER', action: { type: 'FLOW.CREATED' } }, OPT).event.eventType, 'FLOW.CREATED');
});

test('bad shapes are rejected, never thrown on', () => {
  for (const bad of [null, 5, 'x', [], undefined, true]) assert.deepEqual(parseActivity(bad, OPT), { reject: 'not_an_object' });
  for (const t of ['', 'has space', 'a'.repeat(81), '<script>', 'A;B', 5, null]) assert.ok(parseActivity({ action: { type: t } }, OPT).reject, String(t));
});

test('event id: the activity id makes a redelivery the same event; without one, a hash of the identifying fields does', () => {
  const a = parseActivity(activity(5), OPT).event; const b = parseActivity(activity(5), OPT).event;
  assert.equal(a.eventId, b.eventId);
  const noId = { action: { type: 'A.B' }, correlationId: 'c1', recordedAt: '2026-11-07T12:00:00Z', actors: { client: { id: 'x' } } };
  const h1 = parseActivity(noId, OPT).event.eventId; const h2 = parseActivity({ ...noId }, OPT).event.eventId;
  assert.match(h1, /^h-[0-9a-f]{24}$/); assert.equal(h1, h2);
  assert.notEqual(h1, parseActivity({ ...noId, correlationId: 'c2' }, OPT).event.eventId);
  assert.match(parseActivity({ ...noId, id: '<bad id>' }, OPT).event.eventId, /^h-/, 'an id with odd characters is not trusted');
});

test('text is bounded and stripped of control characters; the timestamp falls back to when it was received', () => {
  const e = parseActivity(activity(6, 'A.B', { result: { status: `FAIL\u0000ED\n${'x'.repeat(200)}` }, recordedAt: 'not a date' }), OPT).event;
  assert.ok(!/[\u0000-\u001f]/.test(e.status)); assert.ok(e.status.length <= 60);
  assert.equal(e.timestamp, OPT.receivedAt);
});

test('an oversized original is replaced by a marker, not stored', () => {
  const e = parseActivity(activity(7, 'A.B', { blob: 'x'.repeat(MAX_RAW_BYTES + 10) }), OPT).event;
  assert.equal(e.raw.truncated, true); assert.ok(e.raw.bytes > MAX_RAW_BYTES);
});

test('a delivery is one object or an array; a batch works; empty, huge and non-objects are errors', () => {
  assert.equal(parseDelivery(activity(8), OPT).events.length, 1, 'payload limit 1 may send a bare object');
  const many = parseDelivery([activity(9), activity(10), { nope: 1 }, 7], OPT);
  assert.equal(many.events.length, 2); assert.deepEqual(many.rejected.map((r) => r.index), [2, 3]); assert.equal(many.error, null);
  assert.equal(parseDelivery([], OPT).error, 'invalid_event');
  assert.equal(parseDelivery('x', OPT).error, 'invalid_event');
  assert.equal(parseDelivery(null, OPT).error, 'invalid_event');
  assert.equal(parseDelivery([{ nope: 1 }], OPT).error, 'invalid_event', 'a batch of nothing parseable is an error');
  const big = parseDelivery(Array.from({ length: MAX_BATCH + 1 }, (_, i) => activity(i + 1)), OPT);
  assert.deepEqual([big.error, big.limit], ['too_many_events', MAX_BATCH]);
});

test('ingest: stores new events, ignores a redelivery, answers with counts, and hands ONLY new events to forward after deciding', () => {
  const store = createEventStore({ max: 10 }); const forwarded = [];
  const r1 = ingest({ body: [activity(1), activity(2)], store, via: 'webhook', forward: (e) => forwarded.push(...e) });
  assert.equal(r1.status, 200);
  assert.deepEqual([r1.body.received, r1.body.count, r1.body.stored, r1.body.duplicates], [true, 2, 2, 0]);
  assert.equal(r1.body.eventId, r1.body.eventIds[0]);
  const r2 = ingest({ body: [activity(2), activity(3)], store, via: 'webhook', forward: (e) => forwarded.push(...e) });
  assert.deepEqual([r2.body.stored, r2.body.duplicates], [1, 1]);
  assert.deepEqual(forwarded.map((e) => e.eventId.slice(-3)), ['001', '002', '003'], 'the duplicate was not forwarded again');
  assert.equal(store.count(), 3);
  assert.equal(ingest({ body: [], store, via: 'webhook' }).status, 400);
  assert.equal(ingest({ body: Array.from({ length: MAX_BATCH + 1 }, (_, i) => activity(i)), store, via: 'webhook' }).status, 413);
  assert.doesNotThrow(() => ingest({ body: activity(20), store, via: 'webhook', forward: () => { throw new Error('sink exploded'); } }), 'a failing sink cannot break the receiver');
});
