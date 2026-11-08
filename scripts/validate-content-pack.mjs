#!/usr/bin/env node
// Validates content-pack.json against docs/content-pack.schema.json with ajv, and checks the cross-references the schema
// cannot: every card's terms are glossary ids and every card's story is in stories[].
//   node scripts/validate-content-pack.mjs [path/to/content-pack.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validatePack(pack, schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/content-pack.schema.json'), 'utf8'))) {
  const validate = new Ajv({ allErrors: true, strict: true, validateFormats: false }).compile(schema);
  const errors = validate(pack) ? [] : validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);
  const terms = new Set((pack.glossary || []).map((g) => g.id));
  const stories = new Set((pack.stories || []).map((s) => s.id));
  for (const c of pack.cards || []) {
    for (const t of c.terms || []) if (!terms.has(t)) errors.push(`card ${c.id}: unknown term ${t}`);
    if (c.story && !stories.has(c.story)) errors.push(`card ${c.id}: unknown story ${c.story}`);
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] || path.join(ROOT, 'content-pack.json');
  const errors = validatePack(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log(`${file}: valid`);
}
