// A bounded ring buffer of events, newest first on read, idempotent on eventId. The Real store persists to one JSON file under the
// data directory (workspace `default`), written atomically; the Mock store is in memory per workspace and is gone on Reset.
//
// Ordering: by ARRIVAL time (`receivedAt`, set here by the receiver), never by the sender's recordedAt, so a forged far-future or far-past
// timestamp cannot pin an event to the top or bottom. Compared as epoch numbers.
//
// Durability is reported, never assumed: every failed write is counted and its (scrubbed) reason kept, `durability()` says memory / pending /
// ok / failing, and the receiver includes it in its answer. A corrupt file is MOVED ASIDE (events.json.corrupt-<time>, never overwritten),
// the store starts empty with a notice, and the notice clears after the first successful write.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX = 1000;
export const HARD_MAX = 5000;
// Short on purpose: a SIGKILL within this window loses the newest events (SIGTERM flushes first). A write per event would cost far more.
export const PERSIST_DELAY_MS = 50;
const SHAPE = ['eventId', 'eventType', 'timestamp'];
const ok = (e) => e && typeof e === 'object' && SHAPE.every((k) => typeof e[k] === 'string' && e[k].length > 0);
const epoch = (e) => { const n = Date.parse(e.receivedAt || e.timestamp); return Number.isFinite(n) ? n : 0; };

export function createEventStore({ max = DEFAULT_MAX, file = null, persistDelayMs = PERSIST_DELAY_MS, schedule = setTimeout, now = Date.now } = {}) {
  const cap = Math.max(1, Math.min(Number(max) || DEFAULT_MAX, HARD_MAX));
  let events = []; // insertion order, oldest first
  const ids = new Set();
  let timer = null;
  let loadError = null; let corruptMovedTo = null;
  let dups = 0;
  let dirty = false;
  const w = { failures: 0, lastError: null, lastErrorAt: null, lastOkAt: null, failing: false };

  const stamp = () => new Date(now()).toISOString().replace(/[:.]/g, '-');
  if (file) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') { loadError = 'the saved events file could not be read; starting empty'; } }
    if (text !== null) {
      let parsed = null; let bad = false;
      try { parsed = JSON.parse(text); } catch { bad = true; }
      if (!bad && !Array.isArray(parsed)) bad = true;
      if (bad) {
        // Never overwrite the evidence: move the unreadable file aside under a name that cannot collide.
        let to = `${file}.corrupt-${stamp()}`; let n = 0;
        while (fs.existsSync(to)) to = `${file}.corrupt-${stamp()}-${++n}`;
        try { fs.renameSync(file, to); corruptMovedTo = path.basename(to); } catch { /* cannot move it: the next write would replace it, so say so */ }
        loadError = `the saved events file could not be read; starting empty${corruptMovedTo ? ` (the old file was kept as ${corruptMovedTo})` : ' (and it could not be moved aside)'}`;
      } else for (const e of parsed.slice(-cap)) if (ok(e) && !ids.has(e.eventId)) { events.push(e); ids.add(e.eventId); }
    }
  }

  const persistNow = () => {
    timer = null;
    if (!file || !dirty) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(events));
      fs.renameSync(tmp, file);
      dirty = false; w.failing = false; w.lastOkAt = new Date(now()).toISOString();
      loadError = null; // the notice about a bad file at start-up is stale once a good one has been written
    } catch (e) {
      w.failures += 1; w.failing = true; w.lastErrorAt = new Date(now()).toISOString();
      w.lastError = `could not write the events file (${String(e?.code || e?.name || 'error').slice(0, 20)}): events are kept in memory only and would be lost on a restart`;
    }
  };
  const persistSoon = () => {
    if (!file) return;
    dirty = true;
    if (timer) return;
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
      const rows = events.map((e, i) => [e, i, epoch(e)]).filter(([e]) => (!eventType || has(e.eventType, eventType)) && (!actorId || has(e.actorId, actorId)) && (!status || String(e.status ?? '').toLowerCase() === String(status).toLowerCase()));
      rows.sort((a, b) => (b[2] - a[2]) || (b[1] - a[1]));
      return rows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))).map(([e]) => e);
    },
    types() { const t = new Map(); for (const e of events) t.set(e.eventType, (t.get(e.eventType) || 0) + 1); return [...t.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })); },
    count: () => events.length,
    duplicates: () => dups,
    capacity: () => cap,
    loadError: () => loadError,
    // 'memory' (no file), 'pending' (a write is scheduled), 'ok' (everything is on disk), 'failing' (the last write failed).
    durability: () => (!file ? 'memory' : w.failing ? 'failing' : dirty ? 'pending' : 'ok'),
    // Bounded facts for the authenticated panels; never a path or a stack.
    persistence: () => ({ durability: !file ? 'memory' : w.failing ? 'failing' : dirty ? 'pending' : 'ok', writeFailures: w.failures, lastError: w.lastError, lastErrorAt: w.lastErrorAt, lastOkAt: w.lastOkAt, notice: loadError }),
    clear() { events = []; ids.clear(); dups = 0; dirty = true; if (timer) { clearTimeout(timer); timer = null; } persistNow(); },
    flush() { if (timer) { clearTimeout(timer); } persistNow(); },
  };
}
