// Safety rules. Pure functions plus two tiny middlewares. No I/O.
//  1. Loopback bind only unless PEV_BIND is set on purpose.
//  2. Host header must be a loopback name (DNS-rebinding defence).
//  3. A write must be same-origin: a cross-origin Origin, or a cross-site Sec-Fetch-Site, is refused.
//  4. Every host in any shipped text is reserved (.invalid / .example / apex of example.com|net|org).
//  5. The one port is 7802 (allocated 2026-11-07) and never one of the forbidden ones.
//  6. Every key-looking string is an obviously fake sk-MOCK- value.

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(h);
}

export function bindHost(env = process.env) { return env.PEV_BIND || '127.0.0.1'; }

export function assertBindAllowed(host, env = process.env) {
  if (isLoopbackHost(host) || env.PEV_BIND) return host;
  throw new Error(`refusing to bind ${host}: loopback only. Set PEV_BIND to opt in.`);
}

export const PORT_MIN = 7802;
export const PORT_MAX = 7802;
export const DEFAULT_PORT = 7802;
const FORBIDDEN_PORTS = new Set([8080, 5173, 3900, 4000, 4400, 4510, 4600, 4601, 4840, 18080, 19080, 19090]);
export function portProblem(port) {
  if (!Number.isInteger(port)) return 'PORT is not an integer';
  if (FORBIDDEN_PORTS.has(port)) return `port ${port} is reserved for something else`;
  if (port < PORT_MIN || port > PORT_MAX) return `port ${port} is not this app's allocated port ${PORT_MIN}`;
  return null;
}
export function resolvePort(env = process.env) {
  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  const problem = portProblem(port);
  if (problem) throw new Error(problem);
  return port;
}

export function isReservedHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return /(^|\.)(invalid|example)$/.test(h);
}

const NETWORK_URL = /\b(?:https?|wss?|ftp|sftp|ssh|smtp|tcp|udp):\/\/([^\s/?#"'<>\\()]+)/gi; // ( and ) never belong to an authority: a URL in parentheses must not swallow the ")"
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const stripAuthority = (a) => a.replace(/^[^@]*@/, '').replace(/:\d+$/, '');

// Every hostname or IP in text that is not reserved. Loopback names in URLs are allowed. Empty = clean.
export function scanHosts(text) {
  const found = new Set();
  const s = String(text);
  for (const m of s.matchAll(NETWORK_URL)) found.add(stripAuthority(m[1]).toLowerCase());
  for (const m of s.matchAll(EMAIL)) found.add(m[1].toLowerCase());
  for (const m of s.matchAll(IPV4)) found.add(m[0]);
  return [...found].filter((h) => !isReservedHost(h) && !isLoopbackHost(h)).sort();
}

// Any "sk-" secret that is not an obviously fake sk-MOCK- value. Empty = clean.
export function scanKeys(text) {
  return [...String(text).matchAll(/\bsk-(?!MOCK-)[A-Za-z0-9_-]{8,}/g)].map((m) => `${m[0].slice(0, 8)}...`);
}

// Free text from a caller (custodian, description): control characters stripped, length capped. Rendered as text, never as markup.
export function cleanText(value, max = 80) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim().slice(0, max);
}

// Extra Host names this lab answers to (family standard): LAB_ALLOWED_HOSTS, comma separated
// validated host names that point at this Mac, such as local.ping-devops.com. Loopback always works.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export function allowedExtraHosts(env = process.env) {
  const extra = String(env.LAB_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of extra) if (!HOSTNAME.test(h)) throw new Error(`LAB_ALLOWED_HOSTS: not a host name: ${h}`);
  return new Set(extra);
}

// The only paths an outside host may reach: PingOne's delivery (POST) and its HEAD check. Both names reach the same handler.
// /webhook/pingone-events is the name this app's subscription uses; /webhook/pingone is kept for subscriptions made for the older page.
// Everything else stays loopback.
export const WEBHOOK_PATHS = ['/webhook/pingone-events', '/webhook/pingone'];
export const WEBHOOK_PATH = WEBHOOK_PATHS[0];
export function webhookHosts(env = process.env) {
  const hosts = String(env.WEBHOOK_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of hosts) if (!HOSTNAME.test(h)) throw new Error(`WEBHOOK_ALLOWED_HOSTS: not a host name: ${h}`);
  return new Set(hosts);
}
export const hostOf = (raw) => { const r = String(raw || ''); return (r.startsWith('[') ? r.slice(0, r.indexOf(']') + 1) : r.replace(/:\d+$/, '')).toLowerCase(); };

// Host check bound to a settings object (the app passes its own env; the default is process.env).
export const hostCheckFor = (env = process.env) => function hostCheckWithEnv(req, res, next) {
  const host = hostOf(req.headers.host);
  if (isLoopbackHost(host) || allowedExtraHosts(env).has(host)) return next();
  // A public host is accepted for the webhook paths only (and only for the methods PingOne uses).
  if (WEBHOOK_PATHS.includes(req.path) && ['POST', 'HEAD', 'OPTIONS'].includes(req.method) && webhookHosts(env).has(host)) return next();
  return res.status(403).json({ error: 'bad_host', message: 'Host must be loopback or on LAB_ALLOWED_HOSTS' });
};
export const hostCheck = (req, res, next) => hostCheckFor(process.env)(req, res, next);

// SSRF guard for the one outbound target the owner configures: link-local, metadata and unspecified addresses are never allowed.
export function isBlockedTargetHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === '0.0.0.0' || h === '::' || h === 'metadata.google.internal' || h === 'metadata' || h.endsWith('.internal')) return true;
  if (/^169\.254\./.test(h) || /^100\.100\.100\.200$/.test(h)) return true; // link-local + a cloud metadata address
  if (/^fe[89ab][0-9a-f]:/.test(h) || h === 'fd00:ec2::254' || /^::ffff:169\.254\./.test(h)) return true;
  return false;
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function sameOriginWrites(req, res, next) {
  if (!WRITE.has(req.method)) return next();
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
  const origin = req.headers.origin;
  if (origin) {
    // Behind the shared lab-proxy the browser origin is local.ping-devops.com:8443 while Host is the lab's
    // own name: trust X-Forwarded-Host, which only the proxy sets, when it is there.
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    let ok = false;
    try { ok = new URL(origin).host.toLowerCase() === host; } catch { /* malformed */ }
    if (!ok) return res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
  }
  next();
}
