// Turns what PingOne delivers into the one event shape the page, the store and the Elasticsearch sink share:
//   { eventId, eventType, actorId, actorType, status, resource, environmentId, correlationId, timestamp, via, raw }
// A real delivery uses the "Ping Activity" schema: action.type, actors.user / actors.client (each with its environment), result.status,
// resources[], recordedAt, correlationId, id. Two traps are pinned by tests:
//   - `_embedded` is {} on real deliveries, so the environment id is read off the actor, never off `_embedded`;
//   - a top-level `type` is what hand-written curls use. It is accepted ONLY when there is no `action` object, and the event says so
//     (`raw` keeps the original), so a real event can never be matched by the wrong field.
// All text is bounded and stripped of control characters. Nothing here is ever executed or rendered as markup.
import { createHash } from 'node:crypto';
import { cleanText } from './safety.js';

export const MAX_BATCH = 100;
export const MAX_RAW_BYTES = 16 * 1024;
const TYPE = /^[A-Za-z0-9_.:-]{1,80}$/;
// An event id becomes a document _id and a map key: letters, digits . _ : - only, starting alphanumeric, no slashes and no '..'.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 120) => (typeof v === 'string' ? cleanText(v, max) : '');

function boundedRaw(raw) {
  let text;
  try { text = JSON.stringify(raw); } catch { return { unserialisable: true }; }
  const bytes = Buffer.byteLength(text, 'utf8'); // bytes, not characters: multi-byte text cannot slip under the cap
  return bytes <= MAX_RAW_BYTES ? raw : { truncated: true, bytes, note: `the original was larger than ${MAX_RAW_BYTES} bytes and is not kept` };
}
// recordedAt is the SENDER's claim. It is shown, but it is never trusted for ordering: it must be a real date between 2000 and one day after
// it arrived, else the arrival time stands in. Compared as epoch numbers, never as strings.
export const MIN_EPOCH = Date.UTC(2000, 0, 1);
const MAX_SKEW_MS = 24 * 3600_000;
const saneEpoch = (n, receivedMs) => Number.isFinite(n) && n >= MIN_EPOCH && n <= receivedMs + MAX_SKEW_MS;

// One activity -> one event, or { reject: reason }.
export function parseActivity(raw, { receivedAt, via = 'webhook' } = {}) {
  if (!isObj(raw)) return { reject: 'not_an_object' };
  const hasAction = isObj(raw.action);
  const typeRaw = hasAction ? raw.action.type : raw.type;
  if (typeof typeRaw !== 'string' || !TYPE.test(typeRaw)) return { reject: hasAction ? 'bad_action_type' : 'no_event_type' };
  const user = isObj(raw.actors?.user) ? raw.actors.user : null;
  const client = isObj(raw.actors?.client) ? raw.actors.client : null;
  const actor = (user && str(user.id)) ? { type: 'USER', obj: user } : (client && str(client.id)) ? { type: 'CLIENT', obj: client } : null;
  const envCandidates = [user?.environment?.id, client?.environment?.id, ...(Array.isArray(raw.resources) ? raw.resources.map((r) => r?.environment?.id) : [])];
  const environmentId = envCandidates.find((e) => typeof e === 'string' && UUID.test(e)) || '';
  const res0 = Array.isArray(raw.resources) && isObj(raw.resources[0]) ? raw.resources[0] : null;
  const receivedMs = Number.isFinite(Date.parse(receivedAt)) ? Date.parse(receivedAt) : Date.now();
  const stamp = [raw.recordedAt, raw.createdAt].map((t) => (typeof t === 'string' ? Date.parse(t) : NaN)).find((n) => saneEpoch(n, receivedMs));
  const timestamp = new Date(stamp ?? receivedMs).toISOString();
  const base = {
    eventType: typeRaw,
    actorId: actor ? str(actor.obj.id) : '',
    actorType: actor ? actor.type : '',
    status: str(raw.result?.status, 60),
    resource: res0 ? str(res0.id) : '',
    environmentId,
    correlationId: str(raw.correlationId),
    timestamp,
  };
  const receivedAtIso = new Date(receivedMs).toISOString();
  // The id PingOne gives the activity makes a redelivery the same event. Without one, a hash of the identifying fields does.
  const given = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : null;
  const eventId = given || `h-${createHash('sha256').update([base.eventType, base.correlationId, base.timestamp, base.actorId, base.resource, base.status].join('|')).digest('hex').slice(0, 24)}`;
  return { event: { eventId, ...base, receivedAt: receivedAtIso, via, schema: hasAction ? 'activity' : 'legacy-type', raw: boundedRaw(raw) } };
}

// A delivery body: one activity or an array of them (payload limit 1 sends one; a larger limit batches). Never throws.
export function parseDelivery(body, opts = {}) {
  if (Array.isArray(body)) {
    if (body.length === 0) return { events: [], rejected: [], error: 'invalid_event' };
    if (body.length > MAX_BATCH) return { events: [], rejected: [], error: 'too_many_events', limit: MAX_BATCH };
  } else if (!isObj(body)) return { events: [], rejected: [], error: 'invalid_event' };
  const items = Array.isArray(body) ? body : [body];
  const events = []; const rejected = [];
  items.forEach((item, index) => {
    const r = parseActivity(item, opts);
    if (r.event) events.push(r.event); else rejected.push({ index, reason: r.reject });
  });
  return { events, rejected, error: events.length ? null : 'invalid_event' };
}
