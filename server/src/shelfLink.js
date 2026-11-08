// shelf-link service: server side. Every -LAB app mounts GET /api/shelf, which returns
// the shelf (launcher) URL saved by scripts/bootstrap.sh in the one shared settings file
// (~/Development/.env, or STANDALONE_ENV, key SHELF_URL). No hardcoded host here (hygiene:
// repo text carries only .invalid/.example names): unconfigured means shelfUrl null and
// the web component renders nothing.
import fs from 'node:fs';

function readShelfUrl(env = process.env) {
  if (env.SHELF_URL) return String(env.SHELF_URL).trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
  const candidates = [];
  if (env.STANDALONE_ENV) candidates.push(env.STANDALONE_ENV);
  candidates.push(`${env.HOME || ''}/Development/.env`);
  for (const f of candidates) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const m = text.split('\n').map((l) => l.match(/^SHELF_URL=(.*)$/)).find(Boolean);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
    } catch { /* next candidate */ }
  }
  return null;
}

export function shelfInfo(env = process.env) {
  return { shelfUrl: readShelfUrl(env) };
}

export function mountShelfRoute(router, { env = process.env } = {}) {
  router.get('/shelf', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(shelfInfo(env));
  });
}
