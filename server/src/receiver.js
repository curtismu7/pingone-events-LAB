// The one function every delivery goes through, whatever its source (PingOne's POST, the pull, or Mock's test button):
// parse -> store (idempotent) -> answer (including how durable the store is). Forwarding to the sink is handed to `forward` AFTER the result is decided and is never awaited,
// so a slow or down cluster cannot change what PingOne is told. Never throws.
import { parseDelivery } from './eventParser.js';

export function ingest({ body, store, via, now = Date.now, forward = null }) {
  const parsed = parseDelivery(body, { receivedAt: new Date(now()).toISOString(), via });
  if (parsed.error) {
    return { status: parsed.error === 'too_many_events' ? 413 : 400, body: { error: parsed.error, ...(parsed.limit ? { limit: parsed.limit } : {}) }, fresh: [] };
  }
  const fresh = [];
  for (const e of parsed.events) if (store.add(e)) fresh.push(e);
  if (forward && fresh.length) { try { forward(fresh); } catch { /* the sink is best-effort */ } }
  return {
    status: 200,
    body: { received: true, eventId: parsed.events[0].eventId, eventIds: parsed.events.map((e) => e.eventId), count: parsed.events.length, stored: fresh.length, duplicates: parsed.events.length - fresh.length, ...(parsed.rejected.length ? { rejected: parsed.rejected.length } : {}),
      // Honest about disk: 'memory' (no file), 'pending' (a write is scheduled), 'ok' (on disk), 'failing' (the last write failed: these events are in memory only).
      durability: typeof store.durability === 'function' ? store.durability() : 'memory' },
    fresh,
  };
}
