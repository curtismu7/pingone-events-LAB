#!/usr/bin/env node
// Reset a running lab: clears the default workspace's Mock events and scenarios (Real events are kept).
//   node scripts/reset.mjs [base-url]      (default http://localhost:${PORT:-7802})
// Loopback only: refuses any other host. Needs the server already running; sends the same-origin header the server requires.
import { isLoopbackHost } from '../server/src/safety.js';

export async function reset(base = `http://localhost:${process.env.PORT || 7802}`) {
  const u = new URL(base);
  if (!isLoopbackHost(u.hostname)) throw new Error(`refusing ${u.hostname}: loopback only`);
  const r = await fetch(new URL('/api/reset', u), { method: 'POST', headers: { 'content-type': 'application/json', origin: u.origin }, body: '{}' });
  if (!r.ok) throw new Error(`reset failed: HTTP ${r.status}`);
  return r.json();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reset(process.argv[2]).then((j) => console.log(`reset: ${j.reset}`), (e) => { console.error(e.message); process.exit(1); });
}
