// Credential checks for a hosted deployment. Everything compares in constant time: both sides are hashed first so the comparison runs on
// equal-length values and its duration does not depend on how many leading characters match. No credential is ever logged or returned.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (v) => createHash('sha256').update(String(v)).digest();
export const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

// { user, password } from an Authorization: Basic header, or null.
export function basicCredentials(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || h.length > 600) return null;
  const m = /^basic ([A-Za-z0-9+/=]+)$/i.exec(h.trim()); // the scheme name is case-insensitive (RFC 7235)
  if (!m) return null;
  const text = Buffer.from(m[1], 'base64').toString('utf8');
  const i = text.indexOf(':');
  return i < 0 ? null : { user: text.slice(0, i), password: text.slice(i + 1) };
}

// True when the request carries the credential. Both parts are always compared (no short-circuit on the user name).
export function matchesBasic(req, cred) {
  if (!cred) return false;
  const got = basicCredentials(req);
  if (!got) return false;
  const u = safeEqual(got.user, cred.user);
  const p = safeEqual(got.password, cred.password);
  return u && p;
}

// PingOne's webhook credential: Basic and/or a static header. Either configured method is enough.
export function webhookAuthorized(req, auth) {
  if (!auth) return false;
  let ok = matchesBasic(req, auth.basic);
  if (auth.header) {
    const v = req.headers[auth.header.name];
    if (typeof v === 'string' && v.length <= 600 && safeEqual(v, auth.header.value)) ok = true;
  }
  return ok;
}

// Middleware: HTTP Basic for the page and the read APIs (hosted only). `except` lists the paths that stay open (health) or carry their own credential.
export function requireBasic(cred, { except = () => false, realm = 'PingOne Events Lab' } = {}) {
  return (req, res, next) => {
    if (except(req)) return next();
    if (matchesBasic(req, cred)) return next();
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`).set('Cache-Control', 'no-store');
    return res.status(401).json({ error: 'unauthorized' });
  };
}
