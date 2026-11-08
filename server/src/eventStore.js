// A bounded ring buffer of events, newest first on read, idempotent on eventId. The Real store persists to one JSON file under the
// data directory (workspace `default`), written atomically; the Mock store is in memory per workspace and is gone on Reset.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX = 1000;
export const HARD_MAX = 5000;
const SHAPE = ['eventId', 'eventType', 'timestamp'];
const ok = (e) => e && typeof e === 'object' && SHAPE.every((k) => typeof e[k] === 'string' && e[k].length > 0);

export function createEventStore({ max = DEFAULT_MAX, file = null, persistDelayMs = 200, schedule = setTimeout } = {}) {
  const cap = Math.max(1, Math.min(Number(max) || DEFAULT_MAX, HARD_MAX));
  let events = []; // insertion order, oldest first
  const ids = new Set();
  let timer = null;
  let loadError = null;
  let dups = 0;

  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) for (const e of parsed.slice(-cap)) if (ok(e) && !ids.has(e.eventId)) { events.push(e); ids.add(e.eventId); }
    } catch (e) { if (e?.code !== 'ENOENT') loadError = 'the saved events file could not be read; starting empty'; }
  }

  const persistNow = () => {
    timer = null;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(events));
      fs.renameSync(tmp, file);
    } catch { /* a read-only data directory must not break the receiver: events stay in memory */ }
  };
  const persistSoon = () => {
    if (!file || timer) return;
    timer = schedule(persistNow, persistDelayMs);
    timer?.unref?.();
  };

  return {
    // true when the event is new, false for a duplicate (same eventId). Evicts the oldest beyond the cap.
    add(event) {
      if (!ok(event)) return false;
      if (ids.has(event.eventId)) { dups += 1; return false; }
      events.push(event); ids.add(event.eventId);
      while (events.length > cap) ids.delete(events.shift().eventId);
      persistSoon();
      return true;
    },
    query({ limit = 50, eventType, actorId, status } = {}) {
      const has = (v, needle) => String(v ?? '').toLowerCase().includes(String(needle).toLowerCase());
      const rows = events.map((e, i) => [e, i]).filter(([e]) => (!eventType || has(e.eventType, eventType)) && (!actorId || has(e.actorId, actorId)) && (!status || String(e.status ?? '').toLowerCase() === String(status).toLowerCase()));
      rows.sort((a, b) => (a[0].timestamp === b[0].timestamp ? b[1] - a[1] : a[0].timestamp < b[0].timestamp ? 1 : -1));
      return rows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))).map(([e]) => e);
    },
    types() { const t = new Map(); for (const e of events) t.set(e.eventType, (t.get(e.eventType) || 0) + 1); return [...t.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })); },
    count: () => events.length,
    duplicates: () => dups,
    capacity: () => cap,
    loadError: () => loadError,
    clear() { events = []; ids.clear(); dups = 0; if (timer) { clearTimeout(timer); timer = null; } persistNow(); },
    flush() { if (timer) { clearTimeout(timer); } persistNow(); },
  };
}
