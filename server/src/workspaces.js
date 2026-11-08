// Rule 13: a workspace id keeps one visitor's state apart from another's. Per workspace (Mock only): its own event store, the delivery
// scenario and counters, the sink scenario and the mock sink, the recent actions. Bounded in count, size and age. Real has ONE store,
// in the `default` workspace's data directory, owned by the app, not by a visitor.
import { createEventStore } from './eventStore.js';

export const WORKSPACE_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_WORKSPACE = 'default';
export const MAX_RUNS = 20;
export const MOCK_STORE_MAX = 500;

export function workspaceFrom(req) {
  const raw = req.headers['x-workspace'];
  if (raw === undefined) return DEFAULT_WORKSPACE;
  return typeof raw === 'string' && WORKSPACE_RE.test(raw) ? raw : null;
}

export function createWorkspaces({ max = 500, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const map = new Map(); // id -> { runs, store, delivery, deliveryScenario, sinkScenario, forward, sink, seq, at }
  const sweep = () => {
    const t = now();
    // Evict by oldest TOUCH (insertion order lies: a long-lived active workspace is touched
    // constantly), and consider every entry — no early break.
    const expired = [...map.entries()].filter(([, v]) => t - v.at > ttlMs).sort((a, b) => a[1].at - b[1].at);
    for (const [id, v] of expired) { v.sink?.stop?.(); map.delete(id); }
    const byAge = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
    while (map.size > max) { const [id, v] = byAge.shift(); v.sink?.stop?.(); map.delete(id); }
  };
  const blank = () => ({ runs: [], store: createEventStore({ max: MOCK_STORE_MAX }), delivery: { attempts: 0, acked: 0, refused: 0, stored: 0, duplicates: 0, lost: 0, lastCode: null, lastAt: null, lastSuccessAt: null }, deliveryScenario: 'healthy', sinkScenario: 'healthy', forward: false, sink: null, seq: 0, at: now() });
  return {
    state(id) {
      sweep();
      let v = map.get(id);
      if (!v) { v = blank(); map.set(id, v); }
      v.at = now();
      return v;
    },
    runs(id) { sweep(); const v = map.get(id); return { workspace: id, runs: v ? v.runs : [] }; },
    record(id, run) {
      const v = this.state(id);
      v.runs = [...v.runs, { ...run, at: now() }].slice(-MAX_RUNS);
      sweep();
      return v.runs;
    },
    resetWorkspace(id) { map.get(id)?.sink?.stop?.(); map.delete(id); },
    size() { return map.size; },
  };
}
