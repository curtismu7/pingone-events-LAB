// Safety rules. Pure functions plus two tiny middlewares. No I/O.
//  1. Loopback bind only unless PEV_BIND is set on purpose.
//  2. Host header must be a loopback name (DNS-rebinding defence).
//  3. A write must be same-origin: a cross-origin Origin, or a cross-site Sec-Fetch-Site, is refused.
//  4. Every host in any shipped text is reserved (.invalid / .example / apex of example.com|net|org).
//  5. The one HOST port is 7803 (allocated 2026-11-08: 7802 went to aggregate-entitlement-lab). 7802 stays only as the CONTAINER-internal port
//     (Docker and the SE deployment set it explicitly), so neither has to change. Never one of the forbidden ones.
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

export const PORT_MIN = 7802; // container-internal
export const PORT_MAX = 7803; // host
export const DEFAULT_PORT = 7803;
const FORBIDDEN_PORTS = new Set([8080, 5173, 3900, 4000, 4400, 4510, 4600, 4601, 4840, 18080, 19080, 19090]);
export function portProblem(port) {
  if (!Number.isInteger(port)) return 'PORT is not an integer';
  if (FORBIDDEN_PORTS.has(port)) return `port ${port} is reserved for something else`;
  if (port < PORT_MIN || port > PORT_MAX) return `port ${port} is not this app's host port ${PORT_MAX} or its container port ${PORT_MIN}`;
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
// A request path is a webhook path if, ignoring case and ONE trailing slash, it is one of the two names. Doubled slashes are never normalised
// into a match: they are refused outright (see appPathProblem), so //webhook/pingone can never fall through to the web page.
export const isWebhookPath = (p) => WEBHOOK_PATHS.includes(String(p).replace(/\/$/, '').toLowerCase());
export const hasDoubledSlash = (p) => /\/{2,}/.test(String(p));
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
  if (isWebhookPath(req.path) && ['POST', 'HEAD', 'OPTIONS'].includes(req.method) && webhookHosts(env).has(host)) return next();
  return res.status(403).json({ error: 'bad_host', message: 'Host must be loopback or on LAB_ALLOWED_HOSTS' });
};
export const hostCheck = (req, res, next) => hostCheckFor(process.env)(req, res, next);

// SSRF guard for the one outbound target the owner configures: link-local, cloud-metadata and unspecified addresses are never allowed,
// whatever form they are written in. Loopback and private ranges are allowed (a local or LAN cluster is legitimate).
import net from 'node:net';

// inet_aton-style IPv4 literal (1 to 4 parts; each decimal, 0x hex or 0-leading octal) -> 4 bytes, or null. new URL() already canonicalises
// these for http(s) URLs; this makes the function safe on its own for any caller.
function ipv4Bytes(h) {
  if (!/^[0-9a-fx.]+$/i.test(h)) return null;
  const parts = h.split('.');
  if (parts.length > 4 || parts.some((x) => x === '')) return null;
  const nums = parts.map((x) => (/^0x[0-9a-f]+$/i.test(x) ? parseInt(x, 16) : /^0[0-7]*$/.test(x) && x.length > 1 ? parseInt(x, 8) : /^[0-9]+$/.test(x) ? parseInt(x, 10) : NaN));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const last = nums.pop();
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  let v = last; nums.forEach((n, i) => { v += n * 256 ** (3 - i); });
  return [(v / 2 ** 24) & 255, (v / 2 ** 16) & 255, (v / 2 ** 8) & 255, v & 255];
}
const blockedV4 = ([a, b, c, d]) => a === 0 || (a === 169 && b === 254) || (a === 100 && b === 100 && c === 100 && d === 200) || (a === 192 && b === 0 && c === 0 && d === 192) || (a === 168 && b === 63 && c === 129 && d === 16) || a >= 224;
// 16 bytes of an IPv6 address, or null.
function ipv6Bytes(h) {
  if (net.isIPv6(h) === false) return null;
  let t = h; const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (m) { const q = m[2].split('.').map(Number); t = `${m[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`; }
  const [l, r = null] = t.split('::');
  const L = l ? l.split(':') : []; const R = r === null ? null : (r ? r.split(':') : []);
  const groups = R === null ? L : [...L, ...Array(8 - L.length - R.length).fill('0'), ...R];
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => { const n = parseInt(g, 16); return [(n >> 8) & 255, n & 255]; });
}
export function isBlockedTargetHost(host) {
  let h = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '').replace(/\.+$/, ''); // brackets, zone id, trailing dots
  if (!h) return true;
  const v4 = ipv4Bytes(h);
  if (v4) return blockedV4(v4);
  const v6 = ipv6Bytes(h);
  if (v6) {
    if (v6.every((x) => x === 0)) return true; // ::
    if ((v6[0] === 0xfe) && ((v6[1] & 0xc0) === 0x80)) return true; // fe80::/10 link-local
    if (v6[0] === 0xfd && v6[1] === 0x00 && v6[2] === 0x0e && v6[3] === 0xc2) return true; // fd00:ec2::/32 (AWS)
    if (v6[0] === 0xff) return true; // multicast
    const embedded = v6.slice(12);
    const mapped = v6.slice(0, 10).every((x) => x === 0) && v6[10] === 0xff && v6[11] === 0xff; // ::ffff:a.b.c.d
    const compat = v6.slice(0, 12).every((x) => x === 0) && embedded.slice(0, 3).some((x) => x !== 0); // ::a.b.c.d (but not ::1, the loopback)
    const nat64 = v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b && v6.slice(4, 12).every((x) => x === 0); // 64:ff9b::/96
    if ((mapped || compat || nat64) && blockedV4(embedded)) return true;
    return false;
  }
  return h === 'metadata' || h === 'instance-data' || h.endsWith('.internal') || h === 'internal';
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// A write must be same-origin. The Origin's host must be the request's real Host, OR a host name the admin listed in LAB_ALLOWED_HOSTS (the
// page's own public host, which an ingress that rewrites Host would otherwise hide). X-Forwarded-Host is a header any client can set: it
// is never consulted.
export const sameOriginWritesFor = (env = process.env) => function sameOriginWritesWithEnv(req, res, next) {
  if (!WRITE.has(req.method)) return next();
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
  const origin = req.headers.origin;
  if (origin) {
    const host = String(req.headers.host || '').toLowerCase();
    let ok = false;
    try { const o = new URL(origin); ok = o.host.toLowerCase() === host || (o.protocol === 'https:' || isLoopbackHost(o.hostname)) && allowedExtraHosts(env).has(o.hostname.toLowerCase()); } catch { /* malformed */ }
    if (!ok) return res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
  }
  next();
};
export const sameOriginWrites = (req, res, next) => sameOriginWritesFor(process.env)(req, res, next);
