// Deployment configuration. Mock is the only fully offline mode and the default when Real is not configured (rule 19).
// Real needs at least one of:
//   - a public host for PingOne's webhook (WEBHOOK_ALLOWED_HOSTS: the host name PingOne posts to, for the two webhook paths only), or
//   - read-only PingOne API access for the pull (PINGONE_ENVIRONMENT_ID, PINGONE_REGION, PINGONE_CLIENT_ID, PINGONE_CLIENT_SECRET).
// Forwarding to Elasticsearch / OpenSearch is a third, separate switch (ELASTICSEARCH_*): it never makes Real available by itself.
// Settings come from the shared settings file (~/Development/.env; STANDALONE_ENV overrides it). A secret is read here and only ever
// used inside the client that needs it: nothing in this file, or any API built on it, returns or logs one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBlockedTargetHost, isLoopbackHost, webhookHosts } from './safety.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PINGONE_REGIONS = ['com', 'eu', 'asia', 'ca', 'com.au', 'sg'];
const INDEX = /^[a-z0-9][a-z0-9._-]{0,100}$/;
export const DEFAULT_INDEX = 'pingone-events';

// PingOne pull settings, or null. The returned object holds the secret: keep it inside the client, never serialise it.
export function pingoneFrom(env = process.env) {
  const envId = env.PINGONE_ENVIRONMENT_ID;
  const clientId = env.PINGONE_CLIENT_ID;
  const secret = env.PINGONE_CLIENT_SECRET;
  const tld = env.PINGONE_REGION || 'com';
  if (!UUID.test(envId || '') || !UUID.test(clientId || '') || typeof secret !== 'string' || !secret || secret.length > 300 || !PINGONE_REGIONS.includes(tld)) return null;
  return { envId, clientId, secret, tld, authHost: `auth.pingone.${tld}`, apiHost: `api.pingone.${tld}` };
}
export function pullProblemFrom(env = process.env) {
  if (pingoneFrom(env)) return null;
  if (!env.PINGONE_ENVIRONMENT_ID || !env.PINGONE_CLIENT_ID || !env.PINGONE_CLIENT_SECRET) return 'The PingOne pull needs PINGONE_ENVIRONMENT_ID, PINGONE_CLIENT_ID and PINGONE_CLIENT_SECRET (a worker app with read access) in the settings file. Mock keeps working.';
  return `PINGONE_ENVIRONMENT_ID and PINGONE_CLIENT_ID must be UUIDs and PINGONE_REGION one of ${PINGONE_REGIONS.join(', ')}. Mock keeps working.`;
}

// Hosts that may reach the two webhook paths from outside this machine, or null when none is set.
export function webhookFrom(env = process.env) {
  try { const h = [...webhookHosts(env)]; return h.length ? { hosts: h } : null; } catch { return null; }
}

// The Elasticsearch / OpenSearch forwarding target, or null. { origin, host, index, authorization } : authorization is a secret.
export function sinkFrom(env = process.env) {
  const raw = env.ELASTICSEARCH_URL;
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  const loop = isLoopbackHost(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (isBlockedTargetHost(u.hostname)) return null;
  const index = env.ELASTICSEARCH_INDEX || DEFAULT_INDEX;
  if (!INDEX.test(index)) return null;
  let authorization = null;
  if (env.ELASTICSEARCH_API_KEY) authorization = `ApiKey ${env.ELASTICSEARCH_API_KEY}`;
  else if (env.ELASTICSEARCH_USERNAME && env.ELASTICSEARCH_PASSWORD) authorization = `Basic ${Buffer.from(`${env.ELASTICSEARCH_USERNAME}:${env.ELASTICSEARCH_PASSWORD}`).toString('base64')}`;
  if (!authorization && !loop) return null; // a remote cluster without credentials is refused: nothing here sends unauthenticated writes off the machine
  const secrets = [env.ELASTICSEARCH_API_KEY, env.ELASTICSEARCH_USERNAME, env.ELASTICSEARCH_PASSWORD, authorization].filter((x) => typeof x === 'string' && x.length >= 4);
  return { origin: u.origin, host: u.hostname.toLowerCase(), index, authorization, secrets };
}
export function sinkProblemFrom(env = process.env) {
  if (sinkFrom(env)) return null;
  if (!env.ELASTICSEARCH_URL) return 'Forwarding needs ELASTICSEARCH_URL (the cluster address) plus ELASTICSEARCH_API_KEY, or ELASTICSEARCH_USERNAME and ELASTICSEARCH_PASSWORD, in the settings file. ELASTICSEARCH_INDEX is optional (default pingone-events). Mock still shows what would be sent.';
  return 'ELASTICSEARCH_URL must be an https address (http only for localhost) with no credentials, query or path; the host cannot be a link-local or metadata address; ELASTICSEARCH_INDEX must be a lower-case index name; a remote cluster needs credentials.';
}
// What the API may say about the target: never a credential.
export const sinkPublic = (cfg) => (cfg ? { host: cfg.host, origin: cfg.origin, index: cfg.index } : null);

export const realAvailableFrom = (env = process.env) => pingoneFrom(env) !== null || webhookFrom(env) !== null;
export function realProblemFrom(env = process.env) {
  if (realAvailableFrom(env)) return null;
  return 'Real needs the PingOne pull settings (PINGONE_ENVIRONMENT_ID, PINGONE_REGION, PINGONE_CLIENT_ID, PINGONE_CLIENT_SECRET) or WEBHOOK_ALLOWED_HOSTS (the public host name PingOne posts to) in the settings file. Mock keeps working.';
}

// The launch mode. Default: Real if configured, else Mock. The runtime mode (POST /api/mode) starts from this.
export function modeFrom(env = process.env) {
  if (env.MODE === undefined || env.MODE === '') return realAvailableFrom(env) ? 'real' : 'mock';
  const m = env.MODE;
  if (m !== 'mock' && m !== 'real') throw new Error(`MODE=${String(m).slice(0, 20)} is not available: this app has mock and real modes`);
  if (m === 'real' && !realAvailableFrom(env)) throw new Error('MODE=real requested but neither the PingOne pull settings nor WEBHOOK_ALLOWED_HOSTS are set');
  return m;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const dataDirFrom = (env = process.env) => path.resolve(env.PEV_DATA_DIR || path.join(HERE, '../../.data'));

// The hosts the netguard may let through in Real mode: the PingOne API hosts when the pull is configured, the cluster host when
// forwarding is configured. Mock never gets any.
export function realHosts(env = process.env) {
  const hosts = [];
  const p = pingoneFrom(env); if (p) hosts.push(p.authHost, p.apiHost);
  const s = sinkFrom(env); if (s) hosts.push(s.host);
  return hosts;
}

// ---- hosted deployment (SE cluster) -------------------------------------------------------------------------------------------------
// Owner-approved exception, 2026-11-07: this one app also runs on the SE cluster so PingOne's cloud can reach the webhook. The SAME image
// runs there with PEV_HOSTED=1. Hosted mode fails CLOSED: it will not start without a webhook credential and a separate UI credential,
// because real PingOne events carry user ids, IP addresses and user agents. Locally (loopback, not hosted) nothing here is required.
// Hosted unless the value is explicitly falsy. ANY other value ("1", "true", "yes", " 1 ", "TRUE", ...) means hosted: a typo must fail
// CLOSED (credentials required), never open.
const FALSY = new Set(['', '0', 'false', 'no', 'off']);
export const hostedFrom = (env = process.env) => !FALSY.has(String(env.PEV_HOSTED ?? '').trim().toLowerCase());
const MIN_SECRET = 12;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{1,63}$/;
// A value that still says REPLACE-ME is the template's placeholder, not a credential: refusing it makes an unedited Secret fail closed.
const placeholder = (v) => /REPLACE-ME/i.test(v);
const user = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v) && !placeholder(v);
// At least 12 characters AFTER trimming (a whitespace-only value is not a secret), no line breaks or NULs, no placeholder.
const secret = (v) => typeof v === 'string' && v.trim().length >= MIN_SECRET && v.length <= 300 && !/[\r\n\u0000]/.test(v) && !placeholder(v);

// What PingOne must send with a delivery: HTTP Basic, a static custom header, or either. { basic, header } or null when neither is set.
export function webhookAuthFrom(env = process.env) {
  const basic = user(env.WEBHOOK_BASIC_USER) && secret(env.WEBHOOK_BASIC_PASSWORD) ? { user: env.WEBHOOK_BASIC_USER, password: env.WEBHOOK_BASIC_PASSWORD } : null;
  const hn = env.WEBHOOK_HEADER_NAME;
  const header = HEADER_NAME.test(hn || '') && !/^(authorization|host|content-type|content-length|cookie|x-lab-hops|traceparent)$/i.test(hn) && secret(env.WEBHOOK_HEADER_VALUE) ? { name: hn.toLowerCase(), value: env.WEBHOOK_HEADER_VALUE } : null;
  return basic || header ? { basic, header } : null;
}
// The browser-facing credential for the UI and the read APIs on a hosted deployment. Separate from the webhook one.
export function uiAuthFrom(env = process.env) {
  return user(env.UI_BASIC_USER) && secret(env.UI_BASIC_PASSWORD) ? { user: env.UI_BASIC_USER, password: env.UI_BASIC_PASSWORD } : null;
}
// The settings a hosted deployment reads. A placeholder in any of them, or a half-set or invalid PingOne / Elasticsearch group, stops it.
const HOSTED_KEYS = ['WEBHOOK_BASIC_USER', 'WEBHOOK_BASIC_PASSWORD', 'WEBHOOK_HEADER_NAME', 'WEBHOOK_HEADER_VALUE', 'UI_BASIC_USER', 'UI_BASIC_PASSWORD', 'PINGONE_ENVIRONMENT_ID', 'PINGONE_REGION', 'PINGONE_CLIENT_ID', 'PINGONE_CLIENT_SECRET', 'ELASTICSEARCH_URL', 'ELASTICSEARCH_API_KEY', 'ELASTICSEARCH_USERNAME', 'ELASTICSEARCH_PASSWORD', 'ELASTICSEARCH_INDEX', 'WEBHOOK_ALLOWED_HOSTS', 'LAB_ALLOWED_HOSTS'];

// Why a hosted deployment must not start, or [] when it can. Names the setting, never a value.
export function hostedProblems(env = process.env) {
  if (!hostedFrom(env)) return [];
  const p = [];
  const wh = webhookAuthFrom(env); const ui = uiAuthFrom(env);
  if (!wh) p.push(`the webhook receiver needs a credential from PingOne: set WEBHOOK_BASIC_USER and WEBHOOK_BASIC_PASSWORD (at least ${MIN_SECRET} characters), or WEBHOOK_HEADER_NAME and WEBHOOK_HEADER_VALUE`);
  if (!ui) p.push(`the page and the read APIs need their own credential: set UI_BASIC_USER and UI_BASIC_PASSWORD (at least ${MIN_SECRET} characters)`);
  if (wh && ui) {
    const whSecrets = [wh.basic?.password, wh.header?.value].filter(Boolean);
    if (whSecrets.some((v) => v === ui.password) || (wh.basic && wh.basic.user === ui.user && wh.basic.password === ui.password)) p.push('the webhook credential and the page credential must be different (the same secret is set for both)');
  }
  const placeholders = HOSTED_KEYS.filter((k) => typeof env[k] === 'string' && placeholder(env[k]));
  if (placeholders.length) p.push(`${placeholders.join(', ')} still hold${placeholders.length === 1 ? 's' : ''} the template placeholder REPLACE-ME: set a real value or delete the key`);
  const anyPull = ['PINGONE_ENVIRONMENT_ID', 'PINGONE_CLIENT_ID', 'PINGONE_CLIENT_SECRET'].some((k) => env[k]);
  if (anyPull && !pingoneFrom(env)) p.push(pullProblemFrom(env).replace(' Mock keeps working.', '') + ' Set all four or delete them');
  if (env.ELASTICSEARCH_URL && !sinkFrom(env)) p.push('ELASTICSEARCH_URL / ELASTICSEARCH_INDEX / credentials are set but not valid (see sink-config); fix or delete them');
  return p;
}

// How many proxy hops to trust for the client address (X-Forwarded-For). Hosted default 1: the ingress appends the address it saw as the
// RIGHT-MOST entry, and that is the only entry trusted; anything a client put to the left of it is ignored. Locally 0 (no proxy).
export function trustProxyHops(env = process.env) {
  const raw = env.PEV_TRUST_PROXY_HOPS;
  if (raw === undefined || raw === '') return hostedFrom(env) ? 1 : 0;
  return /^[0-3]$/.test(raw) ? Number(raw) : (hostedFrom(env) ? 1 : 0);
}

// Every secret value in the settings, for scrubbing error text that might echo one (a cluster, a proxy or PingOne repeating a header back).
export function allSecretsFrom(env = process.env) {
  return [env.PINGONE_CLIENT_SECRET, env.WEBHOOK_BASIC_PASSWORD, env.WEBHOOK_HEADER_VALUE, env.UI_BASIC_PASSWORD, env.ELASTICSEARCH_API_KEY, env.ELASTICSEARCH_PASSWORD]
    .filter((x) => typeof x === 'string' && x.length >= 4);
}
