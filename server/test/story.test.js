import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CAST, VERTICALS, fill, fillDeep, loadCast, unfilled, verticalFrom } from '../src/cast.js';
import { buildStory, rawStory, renderTalkTrackMarkdown } from '../src/story.js';
import { scanHosts, scanKeys } from '../src/safety.js';
import { DIAGRAM_NAMES, buildDiagram, rawDiagram } from '../src/diagramData.js';
import { validateDiagram } from '../src/diagramStudioValidate.js';
import { checkScenario, runChecks, allPassed } from '../src/doctor.js';
import { MOCK_SCENARIO_IDS, scenarioActivities } from '../src/mockEvents.js';
import { buildBulkBody } from '../src/sinks/elasticsearch.js';
import { parseDelivery } from '../src/eventParser.js';
import { withServer } from './helpers.js';

const text = JSON.stringify(rawStory());

test('every {{cast}} token in the story is defined in every vertical pack (and an undefined token FAILS)', () => {
  assert.deepEqual(unfilled(text, DEFAULT_CAST), []);
  for (const [name, cast] of Object.entries(VERTICALS)) assert.deepEqual(unfilled(text, cast), [], name);
  assert.equal(Object.keys(VERTICALS).length, 3);
  assert.deepEqual(unfilled('hello {{castNope}} and {{castBrand}}', DEFAULT_CAST), ['castNope'], 'the check that guards the story catches an undefined token');
  assert.equal(fill('{{castBrand}} {{castNope}}', DEFAULT_CAST), `${DEFAULT_CAST.castBrand} {{castNope}}`);
  assert.deepEqual(fillDeep({ a: ['{{castHost}}'] }, DEFAULT_CAST), { a: [DEFAULT_CAST.castHost] });
  assert.equal(verticalFrom('finance'), 'finance'); assert.equal(verticalFrom('nope'), 'retail');
});

test('rule 10 covers the diagram files too: every {{token}} in server/diagrams/*.json is defined in every vertical, and the guard fires on an undefined one', async () => {
  const fs2 = await import('node:fs'); const dir = new URL('../diagrams/', import.meta.url);
  const files = fs2.readdirSync(dir).filter((f) => f.endsWith('.json')); assert.ok(files.length >= 1);
  for (const f of files) for (const [name, cast] of Object.entries(VERTICALS)) assert.deepEqual(unfilled(fs2.readFileSync(new URL(f, dir), 'utf8'), cast), [], `${f} / ${name}`);
  const bad = { ...rawDiagram('event-pipeline'), lede: 'Hello {{castNope}}' };
  assert.deepEqual(unfilled(JSON.stringify(bad), DEFAULT_CAST), ['castNope']);
  // The doctor reads the same data: injecting a bad token into the story's text makes its token check name it.
  const { runChecks: rc } = await import('../src/doctor.js'); const checks = await rc();
  assert.equal(checks.find((c) => c.id === 'story-tokens').level, 'pass'); assert.equal(checks.find((c) => c.id === 'verticals').level, 'pass');
});

test('the story uses its cast: each vertical changes the names in the lessons, and no token survives', () => {
  const retail = JSON.stringify(buildStory(VERTICALS.retail)); const health = JSON.stringify(buildStory(VERTICALS.health));
  assert.notEqual(retail, health); assert.ok(retail.includes('Northwind Retail')); assert.ok(health.includes('Contoso Health'));
  for (const s of [retail, health, JSON.stringify(buildStory(VERTICALS.finance))]) assert.ok(!/\{\{/.test(s));
});

test('the story names no real host, tenant, tunnel, key or customer: only placeholders, .example and .invalid', () => {
  const filled = JSON.stringify(buildStory(DEFAULT_CAST));
  assert.deepEqual(scanHosts(filled), []); assert.deepEqual(scanKeys(filled), []);
  assert.ok(!/ngrok|tunnel/i.test(filled), 'no tunnel anywhere in the story or Setup panel');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(filled.replace(/0{8}-0000-4000-8000-0{9}[0-9a-f]{3}/g, '')), 'no real-looking identifier');
});

test('every fact is labelled, and the UNVERIFIED ones include everything about a live cluster', () => {
  const facts = rawStory().facts;
  assert.ok(facts.every((f) => ['measured', 'inferred', 'UNVERIFIED'].includes(f.status) && f.source && f.text));
  for (const id of ['es-bulk', 'es-429', 'kibana']) assert.equal(facts.find((f) => f.id === id).status, 'UNVERIFIED', id);
  assert.ok(facts.filter((f) => f.status === 'measured').every((f) => /tenant|query/i.test(f.source)), 'a measured fact names where it was measured');
});

test('15. the silent-discard claim is labelled with the evidence it really has (inferred, not measured), in the facts, the scenario, the delivery panel data and the talk track', async () => {
  const story = rawStory();
  const f = story.facts.find((x) => x.id === 'silent-discard');
  assert.equal(f.status, 'inferred'); assert.match(f.text, /NOT been re-tested|not been re-tested/i); assert.ok(f.source.length > 40);
  assert.match(story.scenarios.find((x) => x.id === 'silent-discard').lesson, /Inferred, not re-tested/);
  assert.equal(story.deliveryScenarios.spa_html.fact, 'silent-discard'); assert.match(story.deliveryScenarios.spa_html.explain, /INFERRED, not re-tested/);
  assert.match(story.talkTrack.find((t) => t.id === 'silent').say, /inferred/i);
  assert.match(fs.readFileSync(new URL('../../docs/talk-track.md', import.meta.url), 'utf8'), /inferred from PingOne/i);
});

test('every scenario teaches what it says: events parse and share a correlation id; delivery and sink scenarios exist', () => {
  const sc = rawStory().scenarios;
  assert.equal(sc.length, 11); assert.deepEqual([...new Set(sc.map((s) => s.kind))].sort(), ['delivery', 'events', 'sink']);
  for (const s of sc) assert.deepEqual(checkScenario(s, DEFAULT_CAST), [], s.id);
  assert.match(checkScenario({ kind: 'events', play: 'nope', expect: {} }).join(), /unknown mock scenario/);
  assert.match(checkScenario({ kind: 'events', play: 'signin-success', expect: { types: ['NOT.THERE'] } }).join(), /no NOT\.THERE event/);
  assert.match(checkScenario({ kind: 'delivery', delivery: 'nope' }).join(), /unknown delivery scenario/);
  assert.match(checkScenario({ kind: 'sink', sink: 'nope' }).join(), /unknown sink scenario/);
});

test('every mock generator builds the real delivery shape: ids are unique per run, timestamps run forward, env on the actor', () => {
  for (const id of MOCK_SCENARIO_IDS) {
    const a = scenarioActivities(id, DEFAULT_CAST, { seq: 1, now: Date.UTC(2026, 10, 7, 12) }); const b = scenarioActivities(id, DEFAULT_CAST, { seq: 2, now: Date.UTC(2026, 10, 7, 12) });
    assert.equal(new Set([...a, ...b].map((x) => x.id)).size, a.length + b.length, id);
    assert.ok(a.every((x, i) => i === 0 || x.recordedAt >= a[i - 1].recordedAt), id);
    assert.ok(a.every((x) => x.actors.client.environment.id && x.action.type && x.result.status), id);
    assert.equal(parseDelivery(a, {}).events.length, a.length, id);
  }
  assert.equal(scenarioActivities('nope', DEFAULT_CAST), null);
});

test('the talk track and docs/talk-track.md come from the same data (no drift)', () => {
  const doc = fs.readFileSync(new URL('../../docs/talk-track.md', import.meta.url), 'utf8');
  assert.equal(doc, renderTalkTrackMarkdown(DEFAULT_CAST));
  assert.ok(rawStory().talkTrack.every((t) => t.title && t.say.length > 40));
});

test('the diagram is diagram-studio/1 data loaded by name, validates, and includes the forward-to-Elasticsearch/Kibana hop', () => {
  assert.deepEqual(DIAGRAM_NAMES, ['event-pipeline']);
  assert.deepEqual(validateDiagram(rawDiagram('event-pipeline')), []);
  const d = buildDiagram(DEFAULT_CAST);
  assert.ok(d.nodes.length >= 10 && d.steps.length >= 9);
  const labels = d.nodes.map((n) => n.label).join('|');
  assert.match(labels, /Elasticsearch/); assert.match(labels, /Kibana/); assert.match(labels, /Ingress on the SE cluster/);
  assert.ok(!/tunnel|ngrok/i.test(JSON.stringify(d)));
  assert.ok(d.steps.some((s) => /Kibana/.test(s.label)) && d.steps.some((s) => /queued, not awaited/.test(s.label)));
  assert.ok(validateDiagram({ ...rawDiagram('event-pipeline'), edges: [{ source: 'nope', target: 'p1' }] }).length > 0, 'the validator is live');
  assert.equal(buildDiagram(DEFAULT_CAST, 'unknown-name').title, d.title, 'an unknown name falls back to the default diagram');
});

test('the Elasticsearch index template matches the document the sink sends: every flat field is mapped, raw is stored but not indexed', () => {
  const tpl = JSON.parse(fs.readFileSync(new URL('../../docs/elasticsearch-index-template.json', import.meta.url), 'utf8'));
  const props = tpl.template.mappings.properties;
  assert.deepEqual(tpl.index_patterns, ['pingone-events*']);
  assert.equal(props['@timestamp'].type, 'date'); assert.deepEqual(props.raw, { type: 'object', enabled: false });
  for (const k of ['eventType', 'actorId', 'actorType', 'status', 'resource', 'environmentId', 'correlationId', 'eventId', 'via']) assert.equal(props[k].type, 'keyword', k);
  const ev = parseDelivery([scenarioActivities('signin-success', DEFAULT_CAST)[0]], {}).events[0];
  const doc = JSON.parse(buildBulkBody([ev], 'pingone-events').trim().split('\n')[1]);
  assert.deepEqual(Object.keys(doc).sort(), Object.keys(props).sort(), 'the template maps exactly the fields the document carries');
  assert.equal(tpl.template.mappings.dynamic, false);
});

test('customer.config overrides only the four cast values and is sanitised', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pev-cfg-')), 'c.json');
  fs.writeFileSync(f, JSON.stringify({ cast: { brand: 'Acme‮Evil', agentId: 'My-Agent', clientId: 'bad id', host: 'https://real.com', extra: 'x' }, secret: 'nope' }));
  const c = loadCast(f, 'health');
  assert.ok(!/‮/.test(c.castBrand)); assert.equal(c.castAgentId, 'my-agent'); assert.equal(c.castClientId, VERTICALS.health.castClientId); assert.equal(c.castHost, VERTICALS.health.castHost);
  assert.deepEqual(loadCast('/nonexistent.json'), DEFAULT_CAST);
});

test('GET /api/scenarios, /api/diagram and /api/setup serve the story, the diagram and the Setup data (placeholders only)', async () => {
  await withServer(async (url) => {
    const s = await (await fetch(`${url}/api/scenarios?vertical=finance`)).json();
    assert.equal(s.cast.castBrand, 'Fabrikam Bank'); assert.deepEqual(s.verticals, ['retail', 'health', 'finance']);
    assert.equal(s.setup.webhook.destination, 'https://<se-host>/webhook/pingone-events');
    assert.ok(s.setup.webhook.fields.some(([k]) => k === 'Event Schema') && s.setup.webhook.fields.some(([k, v]) => k === 'Payload Limit' && /Events, 1/.test(v)) && s.setup.webhook.fields.some(([k, v]) => k === 'JSON Format' && /array/.test(v)));
    assert.match(JSON.stringify(s.setup.webhook.managementApi), /PINGONE-EVENTS-LAB/);
    assert.match(s.setup.webhook.managementApi.note, /UNVERIFIED/);
    const d = await (await fetch(`${url}/api/diagram?name=event-pipeline`)).json(); assert.equal(d.steps.length, 9);
    const setup = await (await fetch(`${url}/api/setup`)).json();
    assert.deepEqual(setup.receiverPaths, ['/webhook/pingone-events', '/webhook/pingone']); assert.equal(setup.indexTemplate.index_patterns[0], 'pingone-events*');
    assert.equal((await fetch(`${url}/api/nope`)).status, 404);
  });
});

test('the doctor passes on a clean checkout and fails when a scenario or the netguard is broken', async () => {
  const checks = await runChecks();
  assert.equal(allPassed(checks), true, checks.filter((c) => c.level === 'fail').map((c) => c.detail).join('; '));
  assert.deepEqual(['parser', 'scenarios', 'sink-shape', 'netguard', 'hosted', 'diagrams'].filter((id) => !checks.some((c) => c.id === id)), []);
  const bad = await runChecks({ env: { MODE: 'real' } });
  assert.equal(bad.find((c) => c.id === 'mode').level, 'fail');
  assert.equal((await runChecks({ env: { PORT: '7800' } })).find((c) => c.id === 'port-range').level, 'fail');
  assert.equal((await runChecks({ env: { ELASTICSEARCH_URL: 'http://remote.example' } })).find((c) => c.id === 'sink-config').level, 'fail');
});
