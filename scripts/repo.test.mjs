import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('the files the standalone rules ask for are present', () => {
  for (const f of ['README.md', 'CLAUDE.md', 'LICENSE', 'Dockerfile', 'docker-compose.yml', '.github/workflows/ci.yml', 'docs/talk-track.md', 'docs/safety.md', 'docs/shelf-entry.json', 'docs/FOLLOW-UPS.md', 'docs/elasticsearch-index-template.json', 'customer.config.example.json', 'content-pack.json', 'scripts/doctor.mjs', 'scripts/reset.mjs', 'k8s/deploy.sh', 'k8s/secret.example.yaml']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test('the shelf entry is valid and portable: relative composeFile, loopback url, health path', () => {
  const e = JSON.parse(read('docs/shelf-entry.json')).demos[0];
  assert.equal(e.id, 'pingone-events-lab'); assert.equal(e.kind, 'Demo'); assert.equal(e.healthPath, '/api/health');
  assert.match(e.url, /^http:\/\/localhost:7802$/);
  assert.ok(!path.isAbsolute(e.composeFile), 'composeFile must be relative or a placeholder');
  assert.ok(!/\/Users\//.test(JSON.stringify(e)), 'no absolute home path');
  assert.deepEqual(e.pingProducts, []);
});

test('README and CLAUDE.md say Demo tier, name the SE exception and its date, and say Real forwarding is UNVERIFIED', () => {
  for (const f of ['README.md', 'CLAUDE.md']) {
    const t = read(f);
    assert.match(t, /tier[^\n]*Demo|Demo[- ]tier/i, `${f} states the tier`);
    assert.match(t, /2026-11-07/, `${f} dates the exception`);
    assert.match(t, /exception/i, `${f} names the exception`);
    assert.match(t, /UNVERIFIED/, `${f} says what is unverified`);
  }
  assert.match(read('README.md'), /fork of|derived from|scaffold/i, 'honest attribution');
  assert.ok(!/ngrok|tunnel/i.test(read('README.md') + read('CLAUDE.md') + read('docs/safety.md')), 'no tunnel anywhere in the docs');
});

test('customer.config.json is git-ignored, and its example only sets the four cast values', () => {
  assert.match(read('.gitignore'), /^customer\.config\.json$/m); assert.match(read('.gitignore'), /^\.data\/$/m);
  assert.deepEqual(Object.keys(JSON.parse(read('customer.config.example.json')).cast).sort(), ['agentId', 'brand', 'clientId', 'host']);
});

test('CI: Node 26 only, GitHub-hosted, the UI-standard check, gitleaks, forbidden strings, and the no-attribution check', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /node: \[26\]/); assert.match(ci, /runs-on: ubuntu-latest/); assert.ok(!/self-hosted/.test(ci));
  assert.match(ci, /actions\/checkout@v5/); assert.match(ci, /actions\/setup-node@v5/);
  assert.match(ci, /check-ui-standard\.sh/); assert.match(ci, /gitleaks/); assert.match(ci, /FORBIDDEN_STRINGS/); assert.match(ci, /check-no-ai-attribution\.sh/); assert.match(ci, /PORT=7802 npm run doctor/);
});

test('no shipped text names a real customer, company, tenant, public host or cluster (only the family\'s local alias local.ping-devops.com may appear)', () => {
  const skip = new Set(['node_modules', 'dist', '.git', 'package-lock.json', '.data']);
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (!['repo.test.mjs', 'story.test.js', 'content-pack.test.mjs', 'k8s.test.mjs', 'App.test.jsx', 'ping-logo.png'].some((n) => p.endsWith(n))) {
        const t = fs.readFileSync(p, 'utf8').toLowerCase();
        for (const w of ['united airlines', 'mileageplus', 'datapower', 'optum', 'unitedhealth', 'uhg', 'member benefit', 'ngrok', 'cmuir', 'nebula-decaf']) if (t.includes(w)) hits.push(`${path.relative(root, p)}: ${w}`);
        if (/(?<!local\.)ping-devops\.com/.test(t)) hits.push(`${path.relative(root, p)}: a public ping-devops.com host`);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
