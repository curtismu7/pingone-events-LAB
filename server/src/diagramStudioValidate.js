// Copied from the diagram-studio repo (core/src/validate.js, format diagram-studio/1) so this app checks its diagram data with the same gate.
// Never import across repos: re-copy to update. Unchanged below this line.
// Diagram document format "diagram-studio/1". A diagram is plain data; this module is the only gate for it.
// Text is never interpreted (the web app renders it as React text), but sizes and shapes are bounded here.
export const SCHEMA = 'diagram-studio/1';
export const LIMITS = { nodes: 60, edges: 120, steps: 60, groups: 8, text: 300, sub: 6, id: 48 };
export const COLORS = ['red', 'dark', 'grey', 'blue', 'green', 'amber'];
const ID = /^[a-z0-9][a-z0-9_-]*$/;
const STORY_ID = /^S\d{2}$/;
const HOP = /^[A-Za-z0-9._:/-]{1,64}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = LIMITS.text) => typeof v === 'string' && v.length > 0 && v.length <= max;
const num = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 20000;

/** Returns an array of human-readable problems; empty means valid. Never throws. */
export function validateDiagram(d) {
  const p = [];
  if (!isObj(d)) return ['diagram must be an object'];
  if (d.schema !== SCHEMA) p.push(`schema must be "${SCHEMA}"`);
  if (typeof d.id !== 'string' || !ID.test(d.id) || d.id.length > LIMITS.id) p.push('id must be lowercase letters, digits, - or _ (max 48)');
  if (!str(d.title, 120)) p.push('title is required (max 120 characters)');
  if (d.lede !== undefined && typeof d.lede !== 'string') p.push('lede must be text');
  if (typeof d.lede === 'string' && d.lede.length > 600) p.push('lede is too long (max 600)');

  const groups = isObj(d.groups) ? d.groups : null;
  if (!groups || !Object.keys(groups).length) p.push('groups must be an object with at least one group');
  else {
    if (Object.keys(groups).length > LIMITS.groups) p.push(`at most ${LIMITS.groups} groups`);
    for (const [k, g] of Object.entries(groups)) {
      if (!ID.test(k)) p.push(`group key "${k}" is not a valid id`);
      if (!isObj(g) || !str(g.label, 80)) p.push(`group "${k}" needs a label`);
      else if (!COLORS.includes(g.color)) p.push(`group "${k}" color must be one of ${COLORS.join(', ')}`);
    }
  }

  const ids = new Set();
  if (!Array.isArray(d.nodes) || !d.nodes.length) p.push('nodes must be a non-empty array');
  else {
    if (d.nodes.length > LIMITS.nodes) p.push(`at most ${LIMITS.nodes} nodes`);
    d.nodes.forEach((n, i) => {
      const at = `node ${i + 1}`;
      if (!isObj(n)) return p.push(`${at} must be an object`);
      if (typeof n.id !== 'string' || !ID.test(n.id)) p.push(`${at}: bad id`);
      else if (ids.has(n.id)) p.push(`${at}: duplicate id "${n.id}"`);
      else ids.add(n.id);
      if (!str(n.label, 80)) p.push(`${at}: label is required (max 80)`);
      if (groups && !Object.hasOwn(groups, n.group)) p.push(`${at}: unknown group "${n.group}"`);
      if (n.sub !== undefined && (!Array.isArray(n.sub) || n.sub.length > LIMITS.sub || !n.sub.every((s) => typeof s === 'string' && s.length <= 120))) p.push(`${at}: sub must be up to ${LIMITS.sub} short text lines`);
      if (!num(n.x) || !num(n.y)) p.push(`${at}: x and y must be numbers`);
    });
  }

  if (!Array.isArray(d.edges)) p.push('edges must be an array');
  else {
    if (d.edges.length > LIMITS.edges) p.push(`at most ${LIMITS.edges} edges`);
    d.edges.forEach((e, i) => {
      const at = `edge ${i + 1}`;
      if (!isObj(e)) return p.push(`${at} must be an object`);
      if (!ids.has(e.source)) p.push(`${at}: unknown source "${e.source}"`);
      if (!ids.has(e.target)) p.push(`${at}: unknown target "${e.target}"`);
      if (e.label !== undefined && (typeof e.label !== 'string' || e.label.length > 160)) p.push(`${at}: label max 160 characters`);
      if (e.dashed !== undefined && typeof e.dashed !== 'boolean') p.push(`${at}: dashed must be true or false`);
    });
  }

  if (d.steps !== undefined) {
    if (!Array.isArray(d.steps) || d.steps.length > LIMITS.steps) p.push(`steps must be an array of at most ${LIMITS.steps}`);
    else d.steps.forEach((s, i) => {
      const at = `step ${i + 1}`;
      if (!isObj(s) || !str(s.title, 120)) return p.push(`${at}: title is required`);
      if (typeof s.what !== 'string' || s.what.length > 600) p.push(`${at}: what must be text (max 600)`);
      if (s.why !== undefined && (typeof s.why !== 'string' || s.why.length > 600)) p.push(`${at}: why must be text (max 600)`);
      if (s.story !== undefined && !(isObj(s.story) && STORY_ID.test(s.story.id) && Number.isInteger(s.story.step) && s.story.step >= 1 && s.story.step <= 99)) p.push(`${at}: story must be { id: "S01", step: 1 }: the id is S and two digits, the step a whole number from 1 to 99`);
      if (s.hop !== undefined && !(typeof s.hop === 'string' && HOP.test(s.hop))) p.push(`${at}: hop must be a short id (letters, digits . _ : / -)`);
      const n = Array.isArray(d.edges) ? d.edges.length : 0;
      if (!Array.isArray(s.edges) || !s.edges.every((x) => Number.isInteger(x) && x >= 0 && x < n)) p.push(`${at}: edges must list valid edge numbers`);
    });
  }
  return p;
}

export const isValid = (d) => validateDiagram(d).length === 0;

/** Parse JSON text and validate. Returns { diagram } or { problems }. */
export function parseDiagram(text) {
  if (typeof text !== 'string' || text.length > 500_000) return { problems: ['diagram text missing or over 500 KB'] };
  let d;
  try { d = JSON.parse(text); } catch { return { problems: ['not valid JSON'] }; }
  const problems = validateDiagram(d);
  return problems.length ? { problems } : { diagram: d };
}
