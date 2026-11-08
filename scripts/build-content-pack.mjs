// Builds content-pack.json for the Learning Hub from the story data, so the pack cannot drift from the lab.
//   node scripts/build-content-pack.mjs        (writes content-pack.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CAST } from '../server/src/cast.js';
import { buildStory } from '../server/src/story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export function buildPack() {
  const story = buildStory(DEFAULT_CAST);
  const sid = (n) => `S${String(n).padStart(2, '0')}`;
  const terms = {
    'follow-a-signin': ['correlation-id'], 'failed-password': ['correlation-id'], 'step-up': ['correlation-id'], 'flow-lifecycle': ['activity-schema'], 'session-noise': ['activity-schema'], 'risk-event': ['activity-schema'],
    'receiver-down': ['delivery-health'], 'silent-discard': ['silent-discard', 'delivery-health'],
    'cluster-throttled': ['bulk-idempotent'], 'cluster-unavailable': ['bulk-idempotent'], 'cluster-unreachable': ['bulk-idempotent'],
  };
  return {
    schema: 'demo-content-pack/1',
    id: 'pingone-events-lab',
    title: 'PingOne Events Lab',
    version,
    demo: { id: 'pingone-events-lab', name: 'PingOne Events Lab', catalog: 'D124', baseUrl: 'http://localhost:7803', doctor: '/api/health', tags: ['pingone', 'webhook', 'events', 'elasticsearch', 'kibana', 'delivery-health', 'simulated'] },
    glossary: [
      { id: 'activity-schema', term: 'Ping Activity event', definition: 'The shape PingOne delivers: an id, when it was recorded, a correlation id, an action type, who did it (a user and/or a client application, each with its environment), what it touched and a result status.', aliases: ['activity', 'webhook event'] },
      { id: 'correlation-id', term: 'Correlation id', definition: 'One id shared by the events of a single sign-in or flow. It, not the clock, is how you join them into a story.', aliases: ['trace join'] },
      { id: 'delivery-health', term: 'Delivery health', definition: 'What PingOne records about a webhook subscription: when it last tried, when it last succeeded, and what the destination answered. A 503 means the door was shut.', aliases: ['connection status'] },
      { id: 'silent-discard', term: 'Silent discard', definition: 'A destination that serves a web page answers 200 OK to PingOne, which records success while every event is thrown away. The only tell is that the count PingOne says it delivered and the count stored do not match.', aliases: ['200 with HTML'] },
      { id: 'bulk-idempotent', term: 'Idempotent bulk indexing', definition: 'Each event is sent to Elasticsearch or OpenSearch with its event id as the document id, so a retry or a redelivery overwrites the same document instead of adding a copy.', aliases: ['bulk API', '_id'] },
    ],
    sources: [
      { id: 'trace-context', title: 'W3C Trace Context', url: 'https://www.w3.org/TR/trace-context/', kind: 'standard', use: 'The traceparent header shown on every hop.', status: 'not-read', checked: '2026-11-07' },
    ],
    cards: [
      ...story.scenarios.map((sc, i) => ({ id: `try-${sc.id}`, label: `Scenario ${i + 1}: ${sc.title}`, description: sc.lesson, group: 'try-it', action: { type: 'route', href: `/#scenario-${sc.id}` }, terms: terms[sc.id], story: sid(i + 1) })),
      { id: 'concept-delivery', label: 'Delivery health', description: 'Compare what PingOne says it delivered with what was stored, and see the silent discard.', group: 'concept', action: { type: 'route', href: '/#delivery' }, terms: ['delivery-health', 'silent-discard'] },
      { id: 'concept-forward', label: 'Forward to Elasticsearch', description: 'Send each stored event to your cluster, with a bounded queue, retries and visible counters. Unverified against a live cluster.', group: 'concept', action: { type: 'route', href: '/#forward' }, terms: ['bulk-idempotent'] },
      { id: 'setup-webhook', label: 'Set up the webhook', description: 'The destination, the credential, Ping Activity, payload limit 1; and the same thing through the Management API.', group: 'setup', action: { type: 'route', href: '/#setup' } },
      { id: 'ref-doctor', label: 'Doctor and health', description: 'Preflight checks and the demo-health/1 endpoint.', group: 'setup', action: { type: 'route', href: '/api/health' } },
    ],
    stories: story.scenarios.map((sc, i) => ({ id: sid(i + 1), title: sc.title, say: sc.lesson })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'content-pack.json'), `${JSON.stringify(buildPack(), null, 2)}\n`);
}
