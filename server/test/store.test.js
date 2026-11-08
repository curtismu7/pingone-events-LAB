import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEventStore, HARD_MAX } from '../src/eventStore.js';
import { tmpDir } from './helpers.js';

const ev = (n, over = {}) => ({ eventId: `e${n}`, eventType: 'FLOW.CREATED', actorId: `actor-${n % 2}`, status: n % 3 ? 'SUCCESS' : 'FAILED', timestamp: new Date(Date.UTC(2026, 10, 7, 12, 0, n)).toISOString(), ...over });

test('add is idempotent on eventId and counts duplicates', () => {
  const s = createEventStore({ max: 10 });
  assert.equal(s.add(ev(1)), true); assert.equal(s.add(ev(1)), false);
  assert.deepEqual([s.count(), s.duplicates()], [1, 1]);
  for (const bad of [null, {}, { eventId: 'x' }, { eventId: '', eventType: 'A', timestamp: 't' }]) assert.equal(s.add(bad), false);
});

test('the ring buffer is bounded: the oldest is evicted, and an evicted id can come back as new', () => {
  const s = createEventStore({ max: 3 });
  for (let i = 1; i <= 5; i++) s.add(ev(i));
  assert.equal(s.count(), 3);
  assert.deepEqual(s.query({ limit: 10 }).map((e) => e.eventId), ['e5', 'e4', 'e3']);
  assert.equal(s.add(ev(1)), true);
  assert.equal(createEventStore({ max: 10_000_000 }).capacity(), HARD_MAX);
});

test('query: newest first, ties by insertion, filters are case-insensitive contains (status exact), limit is clamped', () => {
  const s = createEventStore({ max: 50 });
  s.add(ev(1, { timestamp: '2026-11-07T12:00:00.000Z' })); s.add(ev(2, { timestamp: '2026-11-07T12:00:00.000Z' })); s.add(ev(3, { eventType: 'SESSION.UPDATED', timestamp: '2026-11-07T11:00:00.000Z' }));
  assert.deepEqual(s.query({}).map((e) => e.eventId), ['e2', 'e1', 'e3']);
  assert.deepEqual(s.query({ eventType: 'session' }).map((e) => e.eventId), ['e3']);
  assert.deepEqual(s.query({ actorId: 'ACTOR-1' }).map((e) => e.eventId), ['e1', 'e3']);
  assert.deepEqual(s.query({ status: 'failed' }).map((e) => e.eventId), ['e3']);
  assert.equal(s.query({ limit: 1 }).length, 1);
  assert.equal(s.query({ limit: 0 }).length, 3, 'a bad limit falls back to the default rather than returning nothing');
  assert.deepEqual(s.types(), [{ type: 'FLOW.CREATED', count: 2 }, { type: 'SESSION.UPDATED', count: 1 }]);
});

test('persistence: written atomically under the data dir, reloaded on start, capped to the buffer; a corrupt file starts empty with a notice', () => {
  const dir = tmpDir(); const file = path.join(dir, 'default', 'events.json');
  const s = createEventStore({ max: 3, file });
  for (let i = 1; i <= 5; i++) s.add(ev(i));
  s.flush();
  assert.ok(fs.existsSync(file)); assert.ok(!fs.existsSync(`${file}.tmp`), 'no temp file left behind');
  const again = createEventStore({ max: 3, file });
  assert.deepEqual(again.query({ limit: 10 }).map((e) => e.eventId), ['e5', 'e4', 'e3']);
  assert.equal(createEventStore({ max: 2, file }).count(), 2, 'a smaller buffer keeps the newest');
  fs.writeFileSync(file, '{not json');
  const bad = createEventStore({ max: 3, file });
  assert.equal(bad.count(), 0); assert.match(bad.loadError(), /could not be read/);
  fs.writeFileSync(file, JSON.stringify([ev(1), { junk: true }, ev(1), 5]));
  assert.equal(createEventStore({ max: 3, file }).count(), 1, 'junk rows and duplicates in a saved file are dropped');
});

test('an unwritable data dir never breaks the store', () => {
  const s = createEventStore({ max: 3, file: '/proc/definitely/not/writable/events.json' });
  assert.equal(s.add(ev(1)), true);
  assert.doesNotThrow(() => s.flush());
  assert.equal(s.count(), 1);
});

test('clear empties the store', () => {
  const s = createEventStore({ max: 3 }); s.add(ev(1)); s.clear();
  assert.deepEqual([s.count(), s.duplicates()], [0, 0]);
});
