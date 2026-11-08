// Copied unchanged from the diagram-studio repo (curtismu7/diagram-studio-LAB, core/src/wire.js), main as fetched 2026-11-07. Required by diagramStudioValidate.js. Re-copy to update.
// "On the wire": optional per-step example traffic (step.wire). Data only, always shown as an Example. A token is stored as its decoded
// header and payload; the header.payload.signature string is built from them (signature is always the fake "sig-not-real"), so the two
// can never disagree and no long token-like string is ever stored.
export const WIRE_LIMITS = { headers: 16, body: 1500, tokens: 3, claims: 16, text: 600, url: 300 };
const KEY = /^[A-Za-z0-9_.:-]{1,40}$/;
const HEADER = /^[A-Za-z0-9-]{1,40}: .{1,260}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const txt = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const json = (v, depth = 0) => v === null || ['string', 'number', 'boolean'].includes(typeof v) && (typeof v !== 'number' || Number.isFinite(v))
  || (depth < 3 && (Array.isArray(v) ? v.every((x) => json(x, depth + 1)) : isObj(v) && Object.entries(v).every(([k, x]) => KEY.test(k) && json(x, depth + 1))));

function checkMessage(m, at, kind, p) {
  if (!isObj(m)) return p.push(`${at}: ${kind} must be an object`);
  if (kind === 'request') {
    if (typeof m.method !== 'string' || !/^[A-Z]{3,10}$/.test(m.method)) p.push(`${at}: request method must be capital letters such as GET or POST`);
    if (!txt(m.url, WIRE_LIMITS.url)) p.push(`${at}: request url is required (max ${WIRE_LIMITS.url})`);
  } else if (typeof m.status !== 'string' || !/^\d{3}( [A-Za-z' -]{1,40})?$/.test(m.status)) p.push(`${at}: response status must look like "200 OK"`);
  if (m.headers !== undefined && !(Array.isArray(m.headers) && m.headers.length <= WIRE_LIMITS.headers && m.headers.every((h) => typeof h === 'string' && HEADER.test(h)))) p.push(`${at}: ${kind} headers must be up to ${WIRE_LIMITS.headers} lines like "Name: value"`);
  if (m.body !== undefined && (typeof m.body !== 'string' || m.body.length > WIRE_LIMITS.body)) p.push(`${at}: ${kind} body must be text (max ${WIRE_LIMITS.body})`);
  if (m.notice !== undefined && !txt(m.notice, WIRE_LIMITS.text)) p.push(`${at}: ${kind} notice must be text (max ${WIRE_LIMITS.text})`);
}

/** Problems with one step.wire; [] when valid or absent. */
export function validateWire(w, at) {
  const p = [];
  if (!isObj(w)) return [`${at}: wire must be an object`];
  for (const k of Object.keys(w)) if (!['request', 'response', 'tokens', 'notice', 'none'].includes(k)) p.push(`${at}: wire has an unknown field "${k}"`);
  if (w.notice !== undefined && !txt(w.notice, WIRE_LIMITS.text)) p.push(`${at}: wire notice must be text (max ${WIRE_LIMITS.text})`);
  if (w.none !== undefined) {
    if (!txt(w.none, WIRE_LIMITS.text)) p.push(`${at}: wire none must say why there is no network call (max ${WIRE_LIMITS.text})`);
    if (w.request || w.response || w.tokens) p.push(`${at}: wire cannot have both none and traffic`);
    return p;
  }
  if (!w.request && !w.response && !w.tokens) p.push(`${at}: wire needs a request, a response, tokens or none`);
  if (w.request !== undefined) checkMessage(w.request, at, 'request', p);
  if (w.response !== undefined) checkMessage(w.response, at, 'response', p);
  if (w.tokens !== undefined) {
    if (!Array.isArray(w.tokens) || w.tokens.length > WIRE_LIMITS.tokens) p.push(`${at}: tokens must be a list of at most ${WIRE_LIMITS.tokens}`);
    else w.tokens.forEach((t, i) => {
      const tat = `${at} token ${i + 1}`;
      if (!isObj(t) || !txt(t.label, 120)) return p.push(`${tat}: label is required`);
      for (const part of ['header', 'payload']) {
        if (!isObj(t[part]) || !Object.keys(t[part]).length || Object.keys(t[part]).length > WIRE_LIMITS.claims || !json(t[part]) || JSON.stringify(t[part]).length > 1000) p.push(`${tat}: ${part} must be an object of up to ${WIRE_LIMITS.claims} plain values`);
      }
      if (t.notes !== undefined && !(isObj(t.notes) && Object.entries(t.notes).every(([k, v]) => KEY.test(k) && txt(v, 300)))) p.push(`${tat}: notes must map a claim name to text (max 300)`);
      if (t.focus !== undefined && !(Array.isArray(t.focus) && t.focus.length <= WIRE_LIMITS.claims && t.focus.every((k) => typeof k === 'string' && KEY.test(k)))) p.push(`${tat}: focus must list claim names`);
    });
  }
  return p;
}

// Plain-language meaning of the common token fields, used when a token has no note of its own for a field.
export const CLAIMS = {
  alg: 'How the signature was made. The receiver checks it with the issuer\'s public key.',
  kid: 'Which of the issuer\'s keys to check the signature with.',
  typ: 'The kind of token this is.',
  iss: 'Issuer: who created this token. Receivers only trust issuers they know.',
  sub: 'Subject: who the token is about, usually the person.',
  aud: 'Audience: the one service this token is FOR. Any other service should refuse it.',
  scope: 'What the token allows, as a list of permissions.',
  exp: 'Expires: when the token stops working (seconds since 1 Jan 1970).',
  iat: 'Issued at: when the token was created (seconds since 1 Jan 1970).',
  nbf: 'Not before: the token is not valid until this time.',
  jti: 'A unique id for this one token, so it can be logged or revoked.',
  act: 'Actor: who is acting on the subject\'s behalf (for example an agent). A nested act is a chain of hand-offs.',
  cnf: 'Confirmation: ties the token to a key only its rightful holder has, so a stolen copy is useless.',
  client_id: 'The app that asked for this token.',
  azp: 'Authorized party: the app this token was issued to.',
  resource: 'The exact API the token is meant for.',
};
const TERMS = [
  [/Bearer/, 'Bearer token', 'A pass that works for whoever holds it, so it must travel only over HTTPS and be short-lived.'],
  [/x-www-form-urlencoded/, 'Form body', 'The request content written as name=value pairs joined by &.'],
  [/jsonrpc/, 'JSON-RPC', 'The message format MCP uses: a method name and its arguments, answered by a result or an error.'],
  [/code_challenge|code_verifier/, 'PKCE', 'The app invents a secret (verifier), sends only its fingerprint (challenge) first, and reveals the secret when redeeming the code.'],
  [/grant_type=authorization_code/, 'Authorization code', 'A one-time ticket handed back after sign-in, swapped for a token at the token endpoint.'],
  [/token-exchange/, 'Token exchange', 'Swapping the token you hold for a different one: another audience, narrower scope, or naming who is acting.'],
  [/client_credentials/, 'Client credentials', 'An app proves its own identity with its own secret, with no person involved.'],
  [/\bact\b/, 'Actor', 'The party doing the work on behalf of the person. Both are named so the trail stays honest.'],
];
export const STATUS_TERM = ['Status code', 'The three-digit answer: 2xx worked, 3xx go elsewhere, 4xx the request was refused or wrong.'];

const b64u = (o) => {
  let s = '';
  for (const b of new TextEncoder().encode(JSON.stringify(o))) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const show = (name, v) => {
  if (['exp', 'iat', 'nbf'].includes(name) && Number.isFinite(v)) { const d = new Date(v * 1000); return Number.isNaN(d.getTime()) ? String(v) : `${v} (${d.toISOString().slice(0, 16).replace('T', ' ')} UTC)`; }
  return typeof v === 'string' ? v : JSON.stringify(v);
};
const lines = (first, m) => [first, ...(m.headers || []), ...(m.body ? ['', m.body] : [])].join('\n');

/** Everything a view needs, as plain text: shared by the web app and the HTML export. Assumes a valid wire. */
export function wireView(w) {
  const all = JSON.stringify(w);
  const terms = TERMS.filter(([re]) => re.test(all)).map(([, a, b]) => [a, b]);
  if (w.response) terms.push(STATUS_TERM);
  return {
    none: w.none, notice: w.notice, terms,
    request: w.request && { text: lines(`${w.request.method} ${w.request.url} HTTP/1.1`, w.request), notice: w.request.notice },
    response: w.response && { text: lines(`HTTP/1.1 ${w.response.status}`, w.response), notice: w.response.notice },
    tokens: (w.tokens || []).map((t) => ({
      label: t.label,
      parts: [b64u(t.header), b64u(t.payload), 'sig-not-real'],
      rows: [['header', t.header], ['payload', t.payload]].flatMap(([part, o]) => Object.entries(o).map(([name, v]) => ({
        part, name, value: show(name, v), meaning: t.notes?.[name] || CLAIMS[name] || 'A custom field of this example.', focus: !!t.focus?.includes(name),
      }))),
    })),
  };
}
