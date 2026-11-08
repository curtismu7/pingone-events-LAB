import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RUNS, WORKSPACE_RE, createWorkspaces, workspaceFrom } from '../src/workspaces.js';

test('workspaceFrom defaults, accepts a good id and refuses a bad one', () => {
  assert.equal(workspaceFrom({ headers: {} }), 'default');
  assert.equal(workspaceFrom({ headers: { 'x-workspace': 'abc-1' } }), 'abc-1');
  for (const bad of ['', 'A', 'a b', 'a/b', 'x'.repeat(41), ['a']]) assert.equal(workspaceFrom({ headers: { 'x-workspace': bad } }), null);
  assert.ok(WORKSPACE_RE.test('a'));
});

test('workspaces are isolated, runs are bounded, reset is per workspace', () => {
  const w = createWorkspaces();
  for (let i = 0; i < MAX_RUNS + 5; i++) w.record('a', { scenario: 's', decision: 'denied' });
  w.record('b', { scenario: 's', decision: 'forward' });
  assert.equal(w.runs('a').runs.length, MAX_RUNS);
  w.resetWorkspace('a');
  assert.equal(w.runs('a').runs.length, 0);
  assert.equal(w.runs('b').runs.length, 1);
});

test('each workspace has its own mock event store, delivery scenario and sink switch; reset gives a fresh one', () => {
  const w = createWorkspaces({});
  const a = w.state('a');
  assert.equal(a.deliveryScenario, 'healthy'); assert.equal(a.sinkScenario, 'healthy'); assert.equal(a.forward, false);
  assert.equal(a.store.count(), 0);
  a.store.add({ eventId: 'e1', eventType: 'X.Y', timestamp: '2026-11-07T00:00:00.000Z' });
  a.deliveryScenario = 'spa_html'; a.forward = true;
  assert.equal(w.state('a').store.count(), 1);
  assert.equal(w.state('b').store.count(), 0);
  assert.equal(w.state('b').deliveryScenario, 'healthy');
  assert.equal(w.state('b').forward, false);
  w.resetWorkspace('a');
  assert.equal(w.state('a').store.count(), 0);
  assert.equal(w.state('a').deliveryScenario, 'healthy');
  assert.equal(w.state('a').forward, false);
});

test('an expired or reset workspace stops its mock sink (no timers outlive it)', () => {
  let t = 0; let stopped = 0;
  const w = createWorkspaces({ ttlMs: 100, now: () => t });
  w.state('a').sink = { stop() { stopped += 1; } };
  w.resetWorkspace('a');
  w.state('b').sink = { stop() { stopped += 1; } };
  t = 500; w.state('c');
  assert.equal(stopped, 2);
});

test('the store expires old workspaces and caps their count', () => {
  let t = 0;
  const w = createWorkspaces({ max: 3, ttlMs: 100, now: () => t });
  for (const id of ['a', 'b', 'c', 'd']) w.record(id, { scenario: 's', decision: 'allow' });
  assert.equal(w.size(), 3);
  t = 500;
  assert.equal(w.runs('d').runs.length, 0);
  assert.equal(w.size(), 0);
});
