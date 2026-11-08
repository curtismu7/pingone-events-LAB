// Rule 14: W3C Trace Context on every hop. One trace id per query; a valid incoming `traceparent` header continues its trace,
// anything else starts a new one. Values are random and carry no meaning outside this app.
import { randomBytes } from 'node:crypto';

const TP = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO32 = '0'.repeat(32);
const ZERO16 = '0'.repeat(16);

export function parseTraceparent(v) {
  if (typeof v !== 'string' || v.length !== 55) return null;
  const m = TP.exec(v);
  return m && m[1] !== ZERO32 && m[2] !== ZERO16 && m[3] !== 'ff' ? { traceId: m[1], parentId: m[2], flags: m[3] } : null;
}
export const formatTraceparent = (traceId, spanId, flags = '01') => `00-${traceId}-${spanId}-${flags}`;

export function newTrace(incoming, rand = randomBytes) {
  const p = parseTraceparent(incoming);
  const span = () => rand(8).toString('hex').replace(/^0{16}$/, '0000000000000001');
  return { traceId: p ? p.traceId : rand(16).toString('hex').replace(/^0{32}$/, `${'0'.repeat(31)}1`), parentId: p ? p.parentId : null, span };
}

const clip = (t, n = 600) => String(t).slice(0, n);
const hop = (trace, n, from, to, label, request, response) => { const id = trace.span(); const tp = formatTraceparent(trace.traceId, id); return { n, from, to, label, traceparent: tp, request: `${clip(request)}\ntraceparent: ${tp}`, response: clip(response) }; };

// The hops of one delivery to the receiver, with raw request/response text. Bodies are shown clipped; no header or secret is ever included.
export function buildReceiveHops({ trace, path, bodyText, status, responseText, stored, duplicates, sink }) {
  const hops = [
    hop(trace, 1, 'sender', 'receiver', 'A delivery reaches the receiver (PingOne, or this page\'s test button)', `POST ${path}\ncontent-type: application/json\n\n${bodyText}`, `${status}: ${responseText}`),
  ];
  if (stored !== undefined) hops.push(hop(trace, 2, 'receiver', 'store', 'The receiver parses and stores the events (same parser for every source)', `parseDelivery(body); store.add(event) for each`, `${stored} new event(s), ${duplicates} duplicate(s) ignored (same eventId)`));
  if (sink) hops.push(hop(trace, 3, 'receiver', 'sink', 'Forwarding: queued for Elasticsearch AFTER the answer (never waited for)', `sink.enqueue(event) x ${sink.queued}`, sink.note));
  return hops;
}

// The hops of one Real pull: the token request, then two reads. Paths only: never a header, a token or a secret.
export function buildPullHops({ trace, calls }) {
  return calls.map((c, i) => hop(trace, i + 1, 'lab', 'pingone', `${c.method} ${c.host}`, `${c.method} https://${c.host}${c.path}`, `HTTP ${c.status}, ${c.bytes} bytes`));
}
