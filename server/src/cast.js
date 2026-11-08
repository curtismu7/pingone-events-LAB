// {{token}} templating for the story data. customer.config.json (optional, git-ignored) overrides the default cast.
// Tokens are {{castBrand}}, {{castAgentId}}, {{castClientId}}, {{castHost}}. A test fails on any token the cast does not define.
import fs from 'node:fs';
import { scanHosts } from './safety.js';

const TOKEN = /\{\{(\w+)\}\}/g;
const MAX_CAST = 40;
const ID = /^[a-z0-9-]{1,40}$/;

export const VERTICALS = {
  retail: { castBrand: 'Northwind Retail', castAgentId: 'orders-agent', castClientId: 'orders-agent', castHost: 'northwind' },
  health: { castBrand: 'Contoso Health', castAgentId: 'claims-agent', castClientId: 'claims-agent', castHost: 'contoso' },
  finance: { castBrand: 'Fabrikam Bank', castAgentId: 'payments-agent', castClientId: 'payments-agent', castHost: 'fabrikam' },
};
export const DEFAULT_VERTICAL = 'retail';
export const DEFAULT_CAST = VERTICALS[DEFAULT_VERTICAL];

export const unfilled = (text, cast) => [...String(text).matchAll(TOKEN)].map((m) => m[1]).filter((k) => !Object.hasOwn(cast, k));
export const fill = (text, cast) => String(text).replace(TOKEN, (m, k) => (Object.hasOwn(cast, k) ? cast[k] : m));
export function fillDeep(value, cast) {
  if (typeof value === 'string') return fill(value, cast);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, cast));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, cast)]));
  return value;
}

export const verticalFrom = (id) => (Object.hasOwn(VERTICALS, id) ? id : DEFAULT_VERTICAL);

// Only brand, agentId, clientId and host, as short plain strings; anything else in the file is ignored.
export function loadCast(file, vertical = DEFAULT_VERTICAL) {
  const cast = { ...VERTICALS[verticalFrom(vertical)] };
  if (!file) return cast;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [short, key] of [['brand', 'castBrand'], ['agentId', 'castAgentId'], ['clientId', 'castClientId'], ['host', 'castHost']]) {
      const v = cfg?.cast?.[short];
      if (typeof v !== 'string' || !v.trim()) continue;
      const clean = v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim().slice(0, MAX_CAST);
      if (/:\/\/|@/.test(clean) || scanHosts(clean).length) continue;
      if (short !== 'brand' && !ID.test(clean.toLowerCase())) continue;
      cast[key] = short === 'brand' ? clean : clean.toLowerCase();
    }
  } catch { /* no file or not JSON: the defaults */ }
  return cast;
}
