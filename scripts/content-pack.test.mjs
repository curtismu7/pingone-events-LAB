import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPack } from './build-content-pack.mjs';
import { validatePack } from './validate-content-pack.mjs';

const root = new URL('..', import.meta.url);
const committed = JSON.parse(fs.readFileSync(new URL('content-pack.json', root), 'utf8'));

test('the pack validates against the schema and its cross-references hold', () => {
  assert.deepEqual(validatePack(buildPack()), []);
});

test('the committed content-pack.json is exactly what the builder makes (no drift)', () => {
  assert.deepEqual(committed, buildPack());
});

test('every scenario has a story and a try-it card that opens it', () => {
  const pack = buildPack();
  assert.equal(pack.stories.length, 11);
  for (const s of pack.stories) {
    const card = pack.cards.find((c) => c.story === s.id);
    assert.ok(card, s.id);
    assert.equal(card.action.href, `/#scenario-${pack.cards.find((c) => c.story === s.id).id.replace('try-', '')}`);
  }
});

test('a broken pack is caught: unknown term and unknown story', () => {
  const pack = buildPack();
  pack.cards[0].terms = ['nope'];
  pack.cards[1].story = 'ghost';
  const errors = validatePack(pack).join('\n');
  assert.match(errors, /unknown term nope/);
  assert.match(errors, /unknown story ghost/);
});

test('the pack names no real company or tenant and shows no real credential', () => {
  const t = JSON.stringify(buildPack()).toLowerCase();
  for (const w of ['united', 'mileageplus', 'datapower', 'optum', 'uhg', 'benefit', 'ngrok', 'tunnel']) assert.ok(!t.includes(w), w);
  assert.ok(!/https?:\/\/(?!(www\.w3\.org|localhost))/.test(t), 'only w3.org links and localhost');
});
