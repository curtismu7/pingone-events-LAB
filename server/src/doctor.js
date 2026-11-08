// Preflight checks shared by `npm run doctor` and GET /api/health. Never prints a secret, needs no network.
// Each check: { id, level: 'pass' | 'info' | 'fail', detail }.
import { assertBindAllowed, bindHost, portProblem, scanHosts, scanKeys, webhookHosts, DEFAULT_PORT, PORT_MIN } from './safety.js';
import { netguardSelfTest } from './netguard.js';
import { DEFAULT_CAST, VERTICALS, unfilled } from './cast.js';
import { buildStory, rawStory } from './story.js';
import { forwardOnStart, hostedFrom, hostedProblems, modeFrom, pingoneFrom, pullProblemFrom, realAvailableFrom, sinkFrom, sinkProblemFrom, webhookFrom } from './config.js';
import { DIAGRAM_NAMES, buildDiagram, rawDiagram } from './diagramData.js';
import { MOCK_SCENARIO_IDS, handWritten, scenarioActivities } from './mockEvents.js';
import { parseDelivery } from './eventParser.js';
import { SINK_SCENARIOS } from './mockSink.js';
import { DELIVERY_SCENARIOS } from './eventsData.js';
import { buildBulkBody } from './sinks/elasticsearch.js';

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

// The Node version this app is built and tested on. Pure, so the threshold itself is testable.
export const MIN_NODE = 26;
export const nodeCheck = (version = process.versions.node) => {
  const major = Number(String(version).split('.')[0]);
  return { level: Number.isInteger(major) && major >= MIN_NODE ? 'pass' : 'fail', detail: `v${version} (need >= ${MIN_NODE}: the version this app is built and tested on)` };
};

// Runs one scenario and reports whether it teaches what it says it does. Events scenarios go through the REAL parser.
export function checkScenario(sc, cast = DEFAULT_CAST) {
  const problems = [];
  if (sc.kind === 'events') {
    const raw = scenarioActivities(sc.play, cast, { seq: 1, now: NOW });
    if (!raw) return [`unknown mock scenario ${sc.play}`];
    const parsed = parseDelivery(raw, { receivedAt: new Date(NOW).toISOString() });
    if (parsed.error || parsed.rejected.length) problems.push(`its own events do not parse (${parsed.error || `${parsed.rejected.length} rejected`})`);
    const got = new Set(parsed.events.map((e) => e.eventType));
    for (const t of sc.expect?.types || []) if (!got.has(t)) problems.push(`no ${t} event`);
    if (new Set(parsed.events.map((e) => e.correlationId)).size !== 1) problems.push('the events do not share one correlation id');
    if (parsed.events.some((e) => !e.environmentId)) problems.push('an event has no environment id (it is read off the actor)');
  } else if (sc.kind === 'delivery') {
    if (!Object.hasOwn(DELIVERY_SCENARIOS, sc.delivery)) problems.push(`unknown delivery scenario ${sc.delivery}`);
  } else if (sc.kind === 'sink') {
    if (!SINK_SCENARIOS.includes(sc.sink)) problems.push(`unknown sink scenario ${sc.sink}`);
  } else problems.push(`unknown scenario kind ${sc.kind}`);
  return problems;
}

export async function runChecks({ env = process.env, cast = DEFAULT_CAST, diagrams = DIAGRAM_NAMES.map((n) => rawDiagram(n)) } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const nc = nodeCheck(); add('node', nc.level, nc.detail);

  try { add('mode', 'pass', `mode=${modeFrom(env)}${realAvailableFrom(env) ? ' (Real configured)' : ' (Mock only)'}`); }
  catch (e) { add('mode', 'fail', e.message); }

  try { add('bind', 'pass', `${assertBindAllowed(bindHost(env), env)}${env.PEV_BIND ? ' (PEV_BIND opt-in)' : ' (loopback)'}`); }
  catch (e) { add('bind', 'fail', e.message); }

  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  const problem = portProblem(port);
  add('port-range', problem ? 'fail' : 'pass', problem || `${port} is the allocated port ${PORT_MIN} and not reserved`);

  // The parser: a real-shaped delivery (environment id on the actor, `_embedded` empty) and the hand-written fallback.
  const real = scenarioActivities('signin-success', cast, { seq: 7, now: NOW }).map((a) => ({ ...a, _embedded: {} }));
  const pr = parseDelivery(real, { receivedAt: new Date(NOW).toISOString() });
  const hw = parseDelivery(handWritten(cast), { receivedAt: new Date(NOW).toISOString() });
  const parserOk = !pr.error && pr.events.length === 4 && pr.events.every((e) => e.environmentId && e.schema === 'activity') && !hw.error && hw.events[0].schema === 'legacy-type';
  add('parser', parserOk ? 'pass' : 'fail', parserOk ? 'a real-shaped delivery parses (environment read off the actor); a hand-written top-level type is accepted only as the labelled fallback' : 'the event parser does not handle a real-shaped delivery');

  const raw = rawStory();
  const wrong = [];
  for (const sc of raw.scenarios) { try { const p = checkScenario(sc, cast); if (p.length) wrong.push(`${sc.id} (${p.join('; ')})`); } catch (e) { wrong.push(`${sc.id} (${e.message})`); } }
  const generators = MOCK_SCENARIO_IDS.filter((id) => { const r = parseDelivery(scenarioActivities(id, cast, { now: NOW }), {}); return r.error || r.rejected.length; });
  add('scenarios', raw.scenarios.length >= 8 && !wrong.length && !generators.length ? 'pass' : 'fail', wrong.length || generators.length ? `scenarios that do not teach what they claim: ${[...wrong, ...generators].join(', ')}` : `${raw.scenarios.length} scenarios each behave as their lesson says (${MOCK_SCENARIO_IDS.length} event generators parse)`);
  const facts = raw.facts.filter((f) => !['measured', 'inferred', 'UNVERIFIED'].includes(f.status));
  add('facts-labelled', facts.length ? 'fail' : 'pass', facts.length ? 'a fact has no status label' : 'every fact is labelled measured, inferred or UNVERIFIED');
  const text = JSON.stringify([raw, diagrams]); // the story AND every diagram file: a {{token}} in either must be defined
  const holes = unfilled(text, DEFAULT_CAST);
  add('story-tokens', holes.length ? 'fail' : 'pass', holes.length ? `unfilled {{tokens}}: ${[...new Set(holes)].join(', ')}` : 'every {{cast}} token is filled');
  const badVert = Object.entries(VERTICALS).filter(([, v]) => unfilled(text, v).length).map(([k]) => k);
  add('verticals', badVert.length ? 'fail' : 'pass', badVert.length ? `verticals missing a token: ${badVert.join(', ')}` : `${Object.keys(VERTICALS).length} vertical packs fill every token`);

  const filled = JSON.stringify([buildStory(cast)]);
  const hosts = scanHosts(filled);
  add('story-hosts', hosts.length ? 'fail' : 'pass', hosts.length ? `non-reserved hosts: ${hosts.join(', ')}` : 'every host in the story is a placeholder, .invalid or .example');
  const keys = scanKeys(filled);
  add('story-keys', keys.length ? 'fail' : 'pass', keys.length ? 'key-looking values that are not sk-MOCK-' : 'no key-looking values in the story');
  add('diagrams', DIAGRAM_NAMES.every((n) => buildDiagram(cast, n).steps.length > 0) ? 'pass' : 'fail', `${DIAGRAM_NAMES.length} diagram-studio/1 diagram loads and validates`);

  // The sink: the bulk body must carry the event id as _id (idempotent) and the flat fields the index template maps.
  const sample = pr.events[0];
  const lines = buildBulkBody([sample], 'pingone-events').trim().split('\n');
  const meta = JSON.parse(lines[0]).index; const doc = JSON.parse(lines[1]);
  const sinkShape = meta._id === sample.eventId && doc['@timestamp'] === sample.timestamp && doc.eventType === sample.eventType && doc.raw && lines.length === 2;
  add('sink-shape', sinkShape ? 'pass' : 'fail', sinkShape ? 'a forwarded event is one bulk action (_id = eventId) plus one flat document with the raw activity under raw' : 'the bulk body is not the shape the index template expects');

  let hookHosts = null; try { hookHosts = webhookFrom(env); webhookHosts(env); } catch (e) { add('webhook-config', 'fail', e.message); }
  if (!checks.some((c) => c.id === 'webhook-config')) add('webhook-config', 'pass', hookHosts ? `${hookHosts.hosts.length} public host(s) may reach the two webhook paths (nothing else)` : 'no public host configured: only this machine can reach the receiver');
  const hp = hostedProblems(env);
  add('hosted', hp.length ? 'fail' : (hostedFrom(env) ? 'pass' : 'info'), hp.length ? `hosted deployment cannot start: ${hp.join('; ')}` : (hostedFrom(env) ? 'hosted: the webhook credential and the page credential are both set (fail-closed otherwise)' : 'not hosted: loopback only, no credentials required'));
  add('pull-config', 'info', pingoneFrom(env) ? 'the read-only PingOne pull is configured (owner-run, never automatic)' : pullProblemFrom(env));
  add('sink-config', env.ELASTICSEARCH_URL && !sinkFrom(env) ? 'fail' : 'info', sinkFrom(env) ? (forwardOnStart(env) ? 'forwarding target configured; this hosted deployment starts with forwarding ON (FORWARD_ON_START)' : 'forwarding target configured (switched OFF until the owner turns it on)') : (sinkProblemFrom(env) || ''));

  const ng = await netguardSelfTest();
  add('netguard', ng.ok ? 'pass' : 'fail', ng.ok ? `blocked fetch, socket, socket-by-IP, dns lookup, dns resolve and udp to a non-loopback host (${ng.blocked}/6)` : ng.detail);

  add('tenant', 'pass', 'Mock needs no tenant or credentials and makes no outbound network call; Real contacts only the configured PingOne API hosts (read-only) and, if switched on, the one configured cluster');
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
