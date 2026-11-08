import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { runChecks } from '../src/doctor.js';
import { createEventStore } from '../src/eventStore.js';

// A tiny web build for the tests: they must not depend on `npm run build` having been run (a fresh clone has no web/dist).
export const WEB_FIXTURE = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pev-web-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>fixture</title></head><body><div id="root"></div></body></html>');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("fixture");');
  return dir;
})();

export const ENV_ID = '00000000-0000-4000-8000-0000000000e1';
export const CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';

// env: the settings the app sees (never process.env, so a developer's real settings cannot leak into a test).
// extra: createApp options (fetchImpl, sinkOptions, pullClient, guard, realStore ...). The real store is in memory unless given.
export async function withServer(fn, { configFile = '/nonexistent/customer.config.json', env = {}, now, ...extra } = {}) {
  // The health checks read the SAME settings the app was given, never the developer's own environment.
  const health = createHealth({ intervalMs: 3_600_000, runChecks: () => runChecks({ env }) });
  await health.ready;
  const app = createApp({ health, configFile, env, realStore: extra.realStore || createEventStore({ max: 100 }), webDir: WEB_FIXTURE, ...(now ? { now } : {}), ...extra });
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app });
  try { await fn(url.replace(/\/$/, ''), app); } finally { health.stop(); await new Promise((r) => server.close(r)); }
}

export const post = (url, p, body, headers = {}) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify(body) });
export const basic = (user, pw) => ({ authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}` });

// A real-shaped PingOne delivery of one activity.
export const activity = (n = 1, type = 'FLOW.CREATED', extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  recordedAt: new Date(Date.UTC(2026, 10, 7, 12, 0, n)).toISOString(),
  correlationId: '00000000-0000-4000-8000-0000000000ff',
  _embedded: {},
  action: { type, description: type.toLowerCase() },
  actors: { client: { id: CLIENT_ID, name: 'orders-agent', environment: { id: ENV_ID } } },
  resources: [{ id: '00000000-0000-4000-8000-0000000000aa', type: type.split('.')[0], name: 'x' }],
  result: { status: 'SUCCESS' },
  ...extra,
});

// A stand-in for fetch that records every call and answers with `handler(url, init)` (a Response or a throw). No socket is opened.
export function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body, redirect: init.redirect }); return handler(String(url), init, calls.length); };
  f.calls = calls;
  return f;
}
export const jsonRes = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pev-'));
export const waitFor = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

// fetch cannot set Host; node:http can.
export function rawHttp(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
