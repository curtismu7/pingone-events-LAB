// One Express app.
//   /webhook/pingone-events and /webhook/pingone  the receiver (same handler): HEAD answers 200, POST takes a delivery.
//                     Hosted (SE): both need PingOne's credential (Basic and/or a static header) and the receiver refuses to exist without one.
//   /api  health, info, the Mock/Real toggle, events, delivery health, the read-only pull, the Elasticsearch sink, setup, diagram,
//         scenarios and reset.
// Mock state is per workspace id (X-Workspace); Real has ONE store (the app's own). Loopback Host check and same-origin writes on
// everything; the one exception is that a configured public host may reach the two webhook paths and nothing else.
// Hosted (the SE deployment; owner-approved exception 2026-11-07): the page and every /api route except /api/health sit behind HTTP Basic
// (a credential separate from the webhook's), and the app will not be created without both credentials (fail closed). Hosted differs from
// local in three more ways: the receiver ALWAYS has Real semantics for a caller that holds PingOne's credential (the Mock/Real toggle there is
// per workspace and only changes what that viewer sees), the netguard allow-list does not follow the toggle, and the client address comes from
// the one trusted proxy hop. Serves web/dist when it exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WEBHOOK_PATHS, allowedExtraHosts, hasDoubledSlash, hostCheckFor, hostOf, isLoopbackHost, isWebhookPath, sameOriginWritesFor } from './safety.js';
import { matchesBasic, requireBasic, webhookAuthorized } from './auth.js';
import { createHealth } from './health.js';
import { loadCast, verticalFrom, VERTICALS } from './cast.js';
import { allSecretsFrom, dataDirFrom, hostedFrom, hostedProblems, modeFrom, pingoneFrom, pullProblemFrom, realAvailableFrom, realHosts, realProblemFrom, sinkFrom, sinkProblemFrom, sinkPublic, trustProxyHops, uiAuthFrom, webhookAuthFrom, webhookFrom } from './config.js';
import { buildStory } from './story.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { DELIVERY_SCENARIOS } from './eventsData.js';
import { MOCK_SCENARIO_IDS, scenarioActivities } from './mockEvents.js';
import { createEventStore } from './eventStore.js';
import { ingest } from './receiver.js';
import { MAX_BATCH } from './eventParser.js';
import { MOCK_SINK_TARGET, SINK_SCENARIOS, createMockFetch } from './mockSink.js';
import { buildBulkBody, createElasticsearchSink } from './sinks/elasticsearch.js';
import { PingOneError, createPingOneClient, failedDeliveries } from './pingoneClient.js';
import { buildPullHops, buildReceiveHops, newTrace } from './trace.js';
import { getNetguard } from './netguard.js';
import { createWorkspaces, workspaceFrom } from './workspaces.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');
const TEMPLATE_FILE = path.resolve(HERE, '../../docs/elasticsearch-index-template.json');
// What a destination that serves the single-page app returns instead of the receiver (the silent-discard trap).
export const SPA_STUB = '<!doctype html><html><head><title>Single-page app</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';
const WEBHOOK_BODY_LIMIT = '256kb';
const PREVIEW_EVENTS = 3;
const MAX_WS_MODES = 500;
// Browser hardening. style-src needs 'unsafe-inline' because React Flow sets inline style attributes; scripts stay 'self' only. The two Google
// hosts are the font files the page already loads (Montserrat, IBM Plex Mono).
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

// A fixed-window counter per key with a cap on distinct keys. `hit` says whether the caller is over its allowance and how many seconds remain.
function makeLimiter({ perKey, total, maxKeys, now, windowMs = 60_000 }) {
  const counts = new Map(); let start = 0; let all = 0;
  return {
    hit(key) {
      const t = now();
      if (t - start >= windowMs) { counts.clear(); start = t; all = 0; }
      all += 1;
      const retryAfter = Math.max(1, Math.ceil((start + windowMs - t) / 1000));
      if (!counts.has(key) && counts.size >= maxKeys) return { limited: true, retryAfter }; // too many distinct addresses this window
      const n = (counts.get(key) || 0) + 1; counts.set(key, n);
      return { limited: n > perKey || all > total, retryAfter };
    },
    size: () => counts.size,
  };
}
const safeDecode = (p) => { try { return decodeURIComponent(p); } catch { return String(p); } };

const intParam = (raw, def, min, max) => {
  if (raw === undefined) return def;
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
};
const textParam = (raw, max) => (raw === undefined ? undefined : typeof raw === 'string' && raw.length <= max ? raw : null);

export function createApp({
  health = createHealth(), configFile = CONFIG, env = process.env, now = Date.now,
  workspaces = createWorkspaces({ now }), realStore = null, fetchImpl = null, guard = getNetguard(), sinkOptions = {}, pullClient = null,
  webDir = DEFAULT_WEB_DIST,
} = {}) {
  const hosted = hostedFrom(env);
  const problems = hostedProblems(env);
  if (problems.length) throw new Error(`hosted deployment cannot start: ${problems.join('; ')}`);
  const webhookAuth = webhookAuthFrom(env);
  const uiAuth = uiAuthFrom(env);
  const app = express();
  app.disable('x-powered-by');
  // Trust exactly the configured number of proxy hops. With 1, Express takes the client address from the RIGHT-MOST X-Forwarded-For entry (the one
  // the ingress appended); anything a client wrote to the left of it is ignored. The SE ingress must set or append X-Forwarded-For (nginx-ingress
  // does by default); if it ever stops, every caller appears as the ingress address and shares one bucket (it fails safe, not open).
  const hops = trustProxyHops(env);
  if (hops > 0) app.set('trust proxy', hops);
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  // A doubled slash is never a legitimate path here, and Express would not match it to the webhook routes (so it would reach the web page and
  // answer 200). Refuse it before anything else looks at the path.
  app.use((req, res, next) => (hasDoubledSlash(req.path) ? res.status(404).json({ error: 'not_found' }) : next()));
  app.use(hostCheckFor(env));
  app.use(sameOriginWritesFor(env));
  // Hosted: everything needs the UI credential except the probe endpoint and the webhook paths (which carry PingOne's credential).
  if (hosted) app.use(requireBasic(uiAuth, { except: (req) => /^\/api\/health\/?$/i.test(req.path) || isWebhookPath(req.path) }));

  // ---- mode (rule 19) -----------------------------------------------------------------------------------------------------------------
  // Local: one process-wide mode, as for every lab. Hosted: the mode is per workspace, so one viewer flipping to Mock changes only their own
  // view; it can never change how the receiver treats PingOne.
  const launchMode = modeFrom(env);
  let globalMode = launchMode;
  const wsModes = new Map();
  const modeFor = (ws) => (hosted ? (wsModes.get(ws) ?? launchMode) : globalMode);
  const iso = () => new Date(now()).toISOString();
  const store = realStore || createEventStore({ max: Number(env.PEV_MAX_EVENTS) || undefined, file: path.join(dataDirFrom(env), 'default', 'events.json'), now });
  if (typeof health.setDegraded === 'function') health.setDegraded(() => store.durability() === 'failing');
  // Mock gets no outbound at all; Real gets exactly the hosts its configuration names. Hosted always allows them: its receiver is always Real.
  const applyGuard = () => guard?.setAllowed(hosted || globalMode === 'real' ? realHosts(env) : []);
  applyGuard();

  // ---- the sinks -------------------------------------------------------------------------------------------------------------------
  let realSink = null; let realForwarding = false;
  const realFetch = (...a) => (fetchImpl || globalThis.fetch)(...a);
  const getRealSink = () => {
    const cfg = sinkFrom(env);
    if (!cfg) return null;
    realSink ||= createElasticsearchSink({ target: { ...cfg, secrets: [...cfg.secrets, ...allSecretsFrom(env)] }, fetchImpl: realFetch, now, ...sinkOptions });
    return realSink;
  };
  // Switching a local app to Mock means zero outbound: stop the Real sink (its queue, its pending retries), and make the owner turn forwarding on
  // again (with the confirm) if they come back to Real.
  const stopRealSink = () => { if (realSink) { realSink.stop(); realSink = null; } realForwarding = false; };
  const getMockSink = (ws) => {
    const v = workspaces.state(ws);
    v.sink ||= createElasticsearchSink({ target: MOCK_SINK_TARGET, fetchImpl: createMockFetch(() => v.sinkScenario), now, ...sinkOptions });
    return v.sink;
  };
  // Called AFTER the receiver has decided its answer. Never awaited, never throws.
  const forwardFor = (ws, source) => (events) => {
    const sink = source === 'real' ? (realForwarding ? getRealSink() : null) : (workspaces.state(ws).forward ? getMockSink(ws) : null);
    if (sink) for (const e of events) sink.enqueue(e);
  };

  // ---- the receiver ----------------------------------------------------------------------------------------------------------------
  // Authenticate FIRST (a cheap constant-time check, before any body is read). A request that fails goes into a small per-address bucket of its
  // own; a request that holds a valid credential has a separate, larger one. An unauthenticated flood can therefore never use up PingOne's allowance.
  const RPM = Number(env.PEV_WEBHOOK_RPM) || 120;
  const UNAUTH_RPM = Number(env.PEV_WEBHOOK_UNAUTH_RPM) || 30;
  const MAX_IPS = Number(env.PEV_RATE_MAX_IPS) || 1000;
  const validLimiter = makeLimiter({ perKey: RPM, total: RPM * 5, maxKeys: MAX_IPS, now });
  const failLimiter = makeLimiter({ perKey: UNAUTH_RPM, total: UNAUTH_RPM * 10, maxKeys: MAX_IPS, now });
  const tooMany = (res, r) => res.set('Retry-After', String(r.retryAfter)).status(429);

  const MOCK_PATH_NOTE = 'This app is in Mock mode. Switch to Real to receive PingOne deliveries.';
  // Who is calling the webhook path. 'credential' = PingOne (or anything holding its credential); 'page' = this app's own Mock test button in a
  // hosted deployment (same-origin, with the UI credential, and only while THAT workspace is in Mock: it never touches the Real store);
  // 'local' = this machine, not hosted; null = refused. Hosted never trusts the Host header to decide: an ingress may rewrite it.
  const accessFor = (req, ws) => {
    if (webhookAuthorized(req, webhookAuth)) return 'credential';
    if (ws && modeFor(ws) === 'mock' && req.headers.origin && uiAuth && matchesBasic(req, uiAuth)) return 'page';
    // Not hosted: this machine. That includes a name the owner listed in LAB_ALLOWED_HOSTS (the family lab-proxy reaches the app as
    // local.ping-devops.com): the host check already admits it for the page, so the page's own test webhook must work through it too.
    if (!hosted && (isLoopbackHost(hostOf(req.headers.host)) || allowedExtraHosts(env).has(hostOf(req.headers.host)))) return 'local';
    return null;
  };
  const refuse = (res) => { if (webhookAuth?.basic) res.set('WWW-Authenticate', 'Basic realm="PingOne webhook", charset="UTF-8"'); return res.status(401).set('Cache-Control', 'no-store'); };
  // True when this delivery belongs in the Real store. Hosted: always, for a credential holder. Local: whenever the app is in Real.
  const wantsReal = (who, ws) => (who === 'page' ? false : hosted ? who === 'credential' : modeFor(ws) === 'real');

  // One delivery into the Mock store, honouring the workspace's delivery scenario (what the door does) and keeping the counters
  // the Delivery panel compares: what the sender was told vs what was stored.
  function deliverToMock(ws, body) {
    const v = workspaces.state(ws);
    const d = v.delivery;
    d.attempts += 1; d.lastAt = iso();
    const n = Array.isArray(body) ? body.length : 1;
    const scenario = v.deliveryScenario;
    if (scenario === 'receiver_503') { d.refused += n; d.lastCode = 503; return { status: 503, kind: 'json', body: { error: 'service_unavailable' }, fresh: [] }; }
    if (scenario === 'spa_html') { d.acked += n; d.lost += n; d.lastCode = 200; d.lastSuccessAt = iso(); return { status: 200, kind: 'html', body: SPA_STUB, fresh: [] }; }
    const r = ingest({ body, store: v.store, via: 'mock', now, forward: forwardFor(ws, 'mock') });
    d.lastCode = r.status;
    if (r.status === 200) { d.acked += r.body.count; d.stored += r.body.stored; d.duplicates += r.body.duplicates; d.lastSuccessAt = iso(); } else d.refused += n;
    return { ...r, kind: 'json' };
  }

  const webhookBody = express.json({ limit: WEBHOOK_BODY_LIMIT, type: () => true });
  // eslint-disable-next-line no-unused-vars
  const webhookBodyError = (err, _req, res, _next) => res.status(Number(err?.status) === 413 ? 413 : 400).json({ error: Number(err?.status) === 413 ? 'payload_too_large' : 'invalid_json' });
  // The one gate for both HEAD and POST. Returns who may proceed, or answers and returns null.
  const gate = (req, res) => {
    res.set('Cache-Control', 'no-store');
    const ip = req.ip || 'unknown';
    const ws = workspaceFrom(req);
    const who = accessFor(req, ws);
    if (!who) {
      const r = failLimiter.hit(ip);
      if (r.limited) { tooMany(res, r); return null; }
      refuse(res); return null;
    }
    const r = validLimiter.hit(ip);
    if (r.limited) { tooMany(res, r); return null; }
    return { who, ws };
  };

  app.head(WEBHOOK_PATHS, (req, res) => {
    const g = gate(req, res);
    if (!g) return res.end();
    // Local only: a Mock-mode app is not a receiver for anyone holding PingOne's credential. Hosted never answers this way.
    if (!hosted && g.who === 'credential' && modeFor(g.ws || 'default') === 'mock') return res.status(409).end();
    return res.status(200).end();
  });
  app.post(WEBHOOK_PATHS, (req, res, next) => {
    // Refuse before reading the body: an unauthenticated caller costs one header check, not a 256 KB parse.
    const g = gate(req, res);
    if (!g) return res.json({ error: res.statusCode === 429 ? 'rate_limited' : 'unauthorized' });
    req.webhookWho = g.who; req.webhookWs = g.ws;
    return next();
  }, webhookBody, webhookBodyError, (req, res) => {
    const who = req.webhookWho;
    if (!req.webhookWs) return res.status(400).json({ error: 'bad_workspace' });
    const ws = req.webhookWs;
    if (!hosted && who === 'credential' && modeFor(ws) === 'mock') return res.status(409).json({ error: 'mock_mode', detail: MOCK_PATH_NOTE });
    const wantHops = req.headers['x-lab-hops'] === '1' && who !== 'credential';
    let r; let sinkNote = null; let sinkQueued = 0;
    if (wantsReal(who, ws)) {
      const before = realSink?.status().queued ?? 0;
      r = { ...ingest({ body: req.body, store, via: 'webhook', now, forward: forwardFor('default', 'real') }), kind: 'json' };
      if (realForwarding && realSink) { sinkQueued = r.fresh.length; sinkNote = `${r.fresh.length} queued (queue was ${before})`; }
    } else {
      r = deliverToMock(ws, req.body);
      const v = workspaces.state(ws);
      if (v.forward && r.fresh?.length) { sinkQueued = r.fresh.length; sinkNote = `${r.fresh.length} queued for the mock cluster (scenario: ${v.sinkScenario})`; }
    }
    if (r.kind === 'html') return res.status(r.status).type('html').send(r.body);
    if (wantHops && r.status === 200) {
      const trace = newTrace(req.headers.traceparent);
      const hopsList = buildReceiveHops({ trace, path: req.path, bodyText: JSON.stringify(req.body).slice(0, 800), status: r.status, responseText: JSON.stringify(r.body), stored: r.body.stored, duplicates: r.body.duplicates, sink: sinkQueued ? { queued: sinkQueued, note: sinkNote } : null });
      return res.status(r.status).json({ ...r.body, traceId: trace.traceId, hops: hopsList });
    }
    return res.status(r.status).json(r.body);
  });
  // Any other method on the webhook paths is refused outright. Falling through to the web page would answer 200 OK with HTML, which
  // is exactly the silent-discard trap this lab teaches.
  app.all(WEBHOOK_PATHS, (_req, res) => res.set('Allow', 'POST, HEAD').status(405).json({ error: 'method_not_allowed' }));

  // ---- the API ---------------------------------------------------------------------------------------------------------------------
  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  api.use('/health', health.router);
  const castFor = (req) => loadCast(configFile, verticalFrom(req.query.vertical));
  const withWorkspace = (handler) => (req, res) => {
    const ws = workspaceFrom(req);
    if (!ws) return res.status(400).json({ error: 'bad_workspace' });
    res.set('Cache-Control', 'no-store');
    return handler(ws, req, res);
  };
  const mockOnly = (res) => res.status(409).json({ error: 'mock_only', detail: 'This control drives the Mock stream. Switch to Mock to use it.' });
  const realOnly = (res) => res.status(409).json({ error: 'real_only', detail: 'This control reads from your real PingOne settings. Switch to Real to use it.' });
  const storeFor = (ws) => (modeFor(ws) === 'real' ? store : workspaces.state(ws).store);
  const persistenceNotice = () => { const p = store.persistence(); return p.durability === 'failing' ? p.lastError : p.notice; };

  api.get('/scenarios', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ...buildStory(castFor(req)), verticals: Object.keys(VERTICALS) }); });
  api.get('/diagram', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(buildDiagram(castFor(req), DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0])); });
  api.get('/info', withWorkspace((ws, _req, res) => {
    const mode = modeFor(ws);
    const sinkCfg = sinkFrom(env);
    res.json({
      mode, source: mode, simulated: mode === 'mock', hosted, realAvailable: realAvailableFrom(env), realHint: realAvailableFrom(env) ? null : realProblemFrom(env),
      pull: { available: Boolean(pingoneFrom(env)), hint: pullProblemFrom(env) },
      webhook: { paths: WEBHOOK_PATHS, publicHostConfigured: Boolean(webhookFrom(env)), credentialConfigured: Boolean(webhookAuth) },
      sink: { configured: Boolean(sinkCfg), hint: sinkCfg ? null : sinkProblemFrom(env), target: sinkPublic(sinkCfg) },
      persistence: store.persistence(),
    });
  }));
  // Rule 19: exactly { source: "mock"|"real" }; 409 when Real is not configured. Hosted: this workspace's view only.
  api.post('/mode', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !['mock', 'real'].includes(body.source)) {
      return res.status(400).json({ error: 'bad_source', detail: 'body must be exactly { source: "mock" | "real" }' });
    }
    if (body.source === 'real' && !realAvailableFrom(env)) return res.status(409).json({ error: 'real_not_configured', detail: realProblemFrom(env) });
    if (hosted) {
      wsModes.set(ws, body.source);
      while (wsModes.size > MAX_WS_MODES) wsModes.delete(wsModes.keys().next().value);
    } else {
      const was = globalMode;
      globalMode = body.source;
      if (was === 'real' && globalMode === 'mock') stopRealSink();
      applyGuard();
    }
    return res.json({ source: modeFor(ws) });
  }));

  api.get('/events', withWorkspace((ws, req, res) => {
    const limit = intParam(req.query.limit, 50, 1, 200);
    const eventType = textParam(req.query.eventType, 80); const actorId = textParam(req.query.actorId, 120); const status = textParam(req.query.status, 60);
    if (limit === null || eventType === null || actorId === null || status === null) return res.status(400).json({ error: 'bad_param', detail: 'limit must be 1-200; eventType, actorId and status must be short text' });
    const mode = modeFor(ws);
    const s = storeFor(ws);
    return res.json({ source: mode, count: s.count(), capacity: s.capacity(), duplicates: s.duplicates(), types: s.types(), events: s.query({ limit, eventType, actorId, status }), workspace: ws, ...(mode === 'real' && persistenceNotice() ? { notice: persistenceNotice() } : {}) });
  }));

  // Mock: PingOne "sends" a scenario's events. They go to the receiver code path (deliverToMock -> ingest), not around it.
  api.post('/mock/play', withWorkspace((ws, req, res) => {
    if (modeFor(ws) === 'real') return mockOnly(res);
    const name = req.body?.name;
    if (typeof name !== 'string' || !MOCK_SCENARIO_IDS.includes(name)) return res.status(400).json({ error: 'bad_scenario', detail: `name must be one of ${MOCK_SCENARIO_IDS.join(', ')}` });
    const v = workspaces.state(ws);
    v.seq += 1;
    const raw = scenarioActivities(name, castFor(req), { seq: v.seq, now: now() });
    const r = deliverToMock(ws, raw);
    workspaces.record(ws, { action: 'play', name });
    return res.json({ played: name, status: r.status, sent: raw.length, ...(r.status === 200 && r.kind === 'json' ? { stored: r.body.stored, duplicates: r.body.duplicates } : {}), workspace: ws });
  }));
  api.post('/mock/delivery', withWorkspace((ws, req, res) => {
    if (modeFor(ws) === 'real') return mockOnly(res);
    const s = req.body?.scenario;
    if (typeof s !== 'string' || !Object.hasOwn(DELIVERY_SCENARIOS, s)) return res.status(400).json({ error: 'bad_scenario', detail: `scenario must be one of ${Object.keys(DELIVERY_SCENARIOS).join(', ')}` });
    workspaces.state(ws).deliveryScenario = s;
    workspaces.record(ws, { action: 'delivery', scenario: s });
    return res.json({ scenario: s, workspace: ws });
  }));

  let lastPull = null; let piClient = null; // one client, so its token is reused between pulls
  api.get('/delivery', withWorkspace((ws, _req, res) => {
    if (modeFor(ws) === 'real') {
      return res.json({ source: 'real', receiver: { paths: WEBHOOK_PATHS, publicHostConfigured: Boolean(webhookFrom(env)), credentialConfigured: Boolean(webhookAuth), stored: store.count(), capacity: store.capacity(), duplicates: store.duplicates(), persistence: store.persistence() }, pull: { available: Boolean(pingoneFrom(env)), hint: pullProblemFrom(env), last: lastPull }, workspace: ws });
    }
    const v = workspaces.state(ws); const d = v.delivery;
    const code = d.lastCode;
    return res.json({
      source: 'mock', scenario: v.deliveryScenario, scenarios: DELIVERY_SCENARIOS,
      subscription: { name: 'EXAMPLE-SUBSCRIPTION', enabled: true, destination: 'https://<se-host>/webhook/pingone-events', connectionStatus: { status: code === null ? 'UNKNOWN' : code >= 200 && code < 300 ? 'SUCCESS' : 'FAILED', lastAttemptedAt: d.lastAt, lastSuccessfulAt: d.lastSuccessAt ?? null, lastResponseCode: code === null ? null : (code >= 200 && code < 300 ? '2xx' : String(code)), lastResponseDetails: code === null ? null : (code >= 200 && code < 300 ? 'Connection attempt successful' : 'Connection attempt failed with error: 503') } },
      counters: { attempts: d.attempts, acked: d.acked, refused: d.refused, stored: d.stored, duplicates: d.duplicates, lost: d.lost },
      workspace: ws,
    });
  }));

  // Real, owner-run, read-only: the delivery health of your subscriptions plus recent activities, parsed by the same parser.
  api.post('/pull', withWorkspace((ws, req, res) => {
    if (modeFor(ws) !== 'real') return realOnly(res);
    const cfg = pingoneFrom(env);
    if (!cfg) return res.status(409).json({ error: 'pull_not_configured', detail: pullProblemFrom(env) });
    const client = pullClient || (piClient ||= createPingOneClient({ cfg, fetchImpl: realFetch, now, extraSecrets: allSecretsFrom(env) }));
    const trace = newTrace(req.headers.traceparent);
    const run = async () => {
      const subscriptions = await client.subscriptions();
      const activities = await client.activities();
      let stored = 0; let duplicates = 0; let rejected = 0;
      for (let i = 0; i < activities.length; i += MAX_BATCH) {
        const r = ingest({ body: activities.slice(i, i + MAX_BATCH), store, via: 'pull', now, forward: forwardFor('default', 'real') });
        if (r.status === 200) { stored += r.body.stored; duplicates += r.body.duplicates; rejected += r.body.rejected || 0; } else rejected += Math.min(MAX_BATCH, activities.length - i);
      }
      const calls = client.traces ? client.traces.splice(0) : [];
      lastPull = { at: iso(), pulled: activities.length, stored, duplicates, rejected, subscriptions, failedDeliveries: failedDeliveries(activities) };
      return res.json({ ...lastPull, traceId: trace.traceId, hops: buildPullHops({ trace, calls }) });
    };
    return run().catch((e) => {
      if (client.traces) client.traces.length = 0;
      if (e instanceof PingOneError) return res.status(e.status).json({ error: e.code, detail: e.detail });
      return res.status(500).json({ error: 'internal_error' });
    });
  }));

  // ---- the Elasticsearch / OpenSearch sink ----------------------------------------------------------------------------------------
  function sinkView(ws) {
    const mode = modeFor(ws);
    const real = mode === 'real';
    const cfg = sinkFrom(env);
    const events = storeFor(ws).query({ limit: PREVIEW_EVENTS });
    const index = real && cfg ? cfg.index : MOCK_SINK_TARGET.index;
    const target = real && cfg ? `${cfg.origin}/_bulk` : 'https://your-cluster.example/_bulk';
    const sink = real ? realSink : workspaces.state(ws).sink;
    const empty = { host: real && cfg ? cfg.host : 'your-cluster.example', index, queued: 0, sent: 0, failed: 0, dropped: 0, retried: 0, batches: 0, lastError: null, lastErrorAt: null, lastSuccessAt: null, lastAttemptAt: null, lastStatus: null, maxQueue: 1000, batchSize: 50, maxRetries: 3 };
    return {
      source: mode,
      configured: real ? Boolean(cfg) : true, hint: real && !cfg ? sinkProblemFrom(env) : null,
      forwarding: real ? realForwarding : workspaces.state(ws).forward,
      confirmRequired: real,
      target: real ? sinkPublic(cfg) : { host: 'your-cluster.example', origin: 'https://your-cluster.example', index },
      scenario: real ? null : workspaces.state(ws).sinkScenario, scenarios: real ? null : SINK_SCENARIOS,
      status: sink ? sink.status() : empty,
      preview: { method: 'POST', url: target, contentType: 'application/x-ndjson', index, events: events.length, body: events.length ? buildBulkBody(events, index).slice(0, 6000) : '', note: real ? 'The last events in the store, in the exact shape a bulk request carries.' : 'MOCK: this is what would be sent. Nothing leaves this machine.' },
      template: 'docs/elasticsearch-index-template.json',
      workspace: ws,
    };
  }
  api.get('/sink', withWorkspace((ws, _req, res) => res.json(sinkView(ws))));
  // The switch. Forwarding is a WRITE to a system you own: Real needs the target configured AND an explicit confirm; it starts OFF.
  api.post('/sink', withWorkspace((ws, req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'bad_request', detail: 'body.enabled must be true or false' });
    if (modeFor(ws) === 'real') {
      if (!sinkFrom(env)) return res.status(409).json({ error: 'sink_not_configured', detail: sinkProblemFrom(env) });
      if (enabled && req.body?.confirm !== true) return res.status(400).json({ error: 'confirm_required', detail: 'Forwarding writes to your cluster. Send { enabled: true, confirm: true } to turn it on.' });
      realForwarding = enabled;
      if (enabled) getRealSink(); else realSink?.clearQueue();
    } else {
      const v = workspaces.state(ws);
      v.forward = enabled;
      if (!enabled) v.sink?.clearQueue();
    }
    return res.json(sinkView(ws));
  }));
  api.post('/sink/scenario', withWorkspace((ws, req, res) => {
    if (modeFor(ws) === 'real') return mockOnly(res);
    const s = req.body?.scenario;
    if (typeof s !== 'string' || !SINK_SCENARIOS.includes(s)) return res.status(400).json({ error: 'bad_scenario', detail: `scenario must be one of ${SINK_SCENARIOS.join(', ')}` });
    workspaces.state(ws).sinkScenario = s;
    return res.json(sinkView(ws));
  }));
  // Owner-run and read-only: GET the cluster root. Never automatic.
  api.post('/sink/test', withWorkspace(async (ws, _req, res) => {
    if (modeFor(ws) === 'real') {
      const sink = getRealSink();
      if (!sink) return res.status(409).json({ error: 'sink_not_configured', detail: sinkProblemFrom(env) });
      return res.json({ source: 'real', ...(await sink.testConnection()) });
    }
    return res.json({ source: 'mock', ...(await getMockSink(ws).testConnection()) });
  }));

  api.get('/setup', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    let template = null; try { template = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8')); } catch { /* not shipped in this image */ }
    res.json({ receiverPaths: WEBHOOK_PATHS, publicHostConfigured: Boolean(webhookFrom(env)), hosted, indexTemplate: template });
  });

  // Reset clears this workspace's Mock state (events, delivery counters, scenarios, mock sink). Real events are the app's own and are NEVER
  // cleared by it; the answer says so and how many there are.
  api.post('/reset', withWorkspace((ws, _req, res) => {
    workspaces.resetWorkspace(ws);
    res.json({ reset: 'ok', workspace: ws, realEventsKept: true, realEvents: store.count() });
  }));
  api.get('/runs', withWorkspace((ws, _req, res) => res.json(workspaces.runs(ws))));
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);
  // Errors become short JSON. Express's default handler would send an HTML stack trace with absolute file paths.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode);
    if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
    return res.status(500).json({ error: 'internal_error' });
  });

  // The web page. `webDir` is where the built UI lives (npm run build puts it in web/dist). The server works without it: with NO build present the API
  // and the webhook are unaffected and every other path answers 404 with a short JSON explanation, never a crash or a stack trace.
  const built = fs.existsSync(path.join(webDir, 'index.html'));
  if (built) app.use(express.static(webDir));
  // "Not the webhook" is decided on the DECODED, slash-collapsed, lower-cased path, so //webhook/x, /Webhook/x and /webhook%2Fx can never be
  // answered with a 200 page.
  app.get(/^\/.*/, (req, res) => {
    const decoded = safeDecode(req.path).replace(/\/{2,}/g, '/').toLowerCase();
    if (/^\/(api|webhook)(\/|$)/.test(decoded)) return res.status(404).json({ error: 'not_found' });
    if (!built) return res.status(404).json({ error: 'web_not_built', detail: 'The web UI has not been built. Run `npm run build` (the API, the webhook and /api/health work without it).' });
    return res.sendFile(path.join(webDir, 'index.html'));
  });
  app.flushStore = () => store.flush();
  app.stopSinks = () => { stopRealSink(); };
  return app;
}

export function startHttpServer({ port, host, app = createApp() } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
    server.once('error', reject);
  });
}
