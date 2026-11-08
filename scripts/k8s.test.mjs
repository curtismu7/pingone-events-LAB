import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { scanHosts } from '../server/src/safety.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const K = path.join(root, 'k8s');
const FILES = ['pvc', 'networkpolicy', 'deployment', 'service', 'certificate', 'ingress-webhook', 'ingress-ui'];
const read = (f) => fs.readFileSync(path.join(K, f), 'utf8');
const docs = Object.fromEntries([...FILES, 'secret.example'].map((n) => [n, YAML.parseAllDocuments(read(`${n}.yaml`)).map((d) => { assert.deepEqual(d.errors, [], `${n}.yaml parses`); return d.toJS(); })]));
const one = (n) => { assert.equal(docs[n].length, 1, n); return docs[n][0]; };
const ENV = { NAMESPACE: 'test-ns', IMAGE: 'ghcr.io/example/pingone-events-lab:sha-abc123', SE_HOST: 'hook.example', UI_HOST: 'ui.example', CLUSTER_ISSUER: 'test-issuer' };
const sh = (args, env = {}, cwd = K, bin = null) => spawnSync('bash', args, { cwd, encoding: 'utf8', env: { PATH: `${bin ? `${bin}:` : ''}${process.env.PATH}`, HOME: os.tmpdir(), ...env } });

test('every manifest parses; none carries a namespace; the only tokens are the four the deploy script fills', () => {
  for (const n of [...FILES, 'secret.example']) for (const d of docs[n]) { assert.ok(d.apiVersion && d.kind && d.metadata?.name, n); assert.equal(d.metadata.namespace, undefined, `${n}: no namespace in manifests (deploy.sh takes NAMESPACE)`); }
  const tokens = new Set(); for (const n of FILES) for (const t of read(`${n}.yaml`).match(/__[A-Z_]+__/g) || []) tokens.add(t);
  assert.deepEqual([...tokens].sort(), ['__CLUSTER_ISSUER__', '__IMAGE__', '__SE_HOST__', '__UI_HOST__']);
  assert.equal(new Set(FILES.map((n) => `${one(n).kind}/${one(n).metadata.name}`)).size, FILES.length);
});

test('no real host, registry path, tenant id or secret is in a committed manifest', () => {
  const all = [...FILES, 'secret.example'].map((n) => read(`${n}.yaml`)).join('\n');
  assert.deepEqual(scanHosts(all).filter((h) => h !== '0.0.0.0'), [], 'only the wildcard bind address (PEV_BIND) is an address here');
  assert.ok(!/ping-devops|ghcr\.io\/[a-z]|cmuir|curtismu7|ngrok|tunnel/i.test(all), 'no host, registry path, account or tunnel');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(all), 'no real-looking identifier');
});

test('the Deployment is locked down: one pod, Recreate, non-root, read-only filesystem, no capabilities, requests and limits, Host-header probes on the open endpoint', () => {
  const d = one('deployment'); const spec = d.spec; const pod = spec.template.spec; const c = pod.containers[0];
  assert.deepEqual([spec.replicas, spec.strategy.type], [1, 'Recreate']);
  assert.deepEqual([pod.securityContext.runAsNonRoot, pod.securityContext.runAsUser, pod.securityContext.fsGroup, pod.securityContext.seccompProfile.type], [true, 1000, 1000, 'RuntimeDefault']);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual([c.securityContext.allowPrivilegeEscalation, c.securityContext.readOnlyRootFilesystem, c.securityContext.capabilities.drop], [false, true, ['ALL']]);
  assert.ok(c.resources.requests.cpu && c.resources.requests.memory && c.resources.limits.cpu && c.resources.limits.memory);
  assert.equal(c.name, 'app'); assert.equal(c.image, '__IMAGE__'); assert.equal(pod.imagePullSecrets[0].name, 'ghcr-pull-secret');
  for (const probe of [c.readinessProbe, c.livenessProbe]) { assert.equal(probe.httpGet.path, '/api/health'); assert.deepEqual(probe.httpGet.httpHeaders, [{ name: 'Host', value: '127.0.0.1:7802' }]); }
  assert.equal(c.ports[0].containerPort, 7802);
  const mounts = Object.fromEntries(c.volumeMounts.map((m) => [m.name, m.mountPath])); assert.deepEqual(mounts, { data: '/data', tmp: '/tmp' });
  assert.equal(pod.volumes.find((v) => v.name === 'data').persistentVolumeClaim.claimName, one('pvc').metadata.name);
  assert.equal(pod.volumes.find((v) => v.name === 'tmp').emptyDir.sizeLimit, '16Mi');
  assert.deepEqual(one('pvc').spec.accessModes, ['ReadWriteOnce']);
});

test('the Deployment is hosted, takes its credentials from the Secret (which must exist), and the host allow-lists come from placeholders', () => {
  const c = one('deployment').spec.template.spec.containers[0];
  const env = Object.fromEntries(c.env.map((e) => [e.name, e.value]));
  assert.equal(env.PEV_HOSTED, '1'); assert.equal(env.PEV_BIND, '0.0.0.0'); assert.equal(env.PEV_DATA_DIR, '/data'); assert.equal(env.PORT, '7802');
  assert.equal(env.LAB_ALLOWED_HOSTS, '__UI_HOST__'); assert.equal(env.WEBHOOK_ALLOWED_HOSTS, '__SE_HOST__');
  assert.equal(env.MODE, undefined, 'no MODE: Real by default because the public webhook host is configured, the toggle stays available');
  assert.equal(c.envFrom[0].secretRef.name, one('secret.example').metadata.name);
  assert.notEqual(c.envFrom[0].secretRef.optional, true, 'a missing Secret must stop the pod, not let it start unconfigured');
  assert.ok(!c.env.some((e) => /PASSWORD|SECRET|KEY|TOKEN/.test(e.name)), 'no credential is set inline');
});

test('the webhook Ingress is a NEW object: one Exact path on the shared host, nginx-public, small body, rate limited, no tls block, nothing else routed', () => {
  const i = one('ingress-webhook');
  assert.equal(i.spec.ingressClassName, 'nginx-public');
  assert.equal(i.spec.rules.length, 1); assert.equal(i.spec.rules[0].host, '__SE_HOST__');
  assert.deepEqual(i.spec.rules[0].http.paths.map((p) => [p.path, p.pathType]), [['/webhook/pingone-events', 'Exact']], 'the older /webhook/pingone path belongs to another app on that host and is not claimed');
  assert.equal(i.spec.tls, undefined, 'the host\'s certificate is already served by its existing ingress');
  const a = i.metadata.annotations;
  assert.equal(a['nginx.ingress.kubernetes.io/ssl-redirect'], 'true'); assert.equal(a['nginx.ingress.kubernetes.io/proxy-body-size'], '256k');
  assert.ok(Number(a['nginx.ingress.kubernetes.io/limit-rps']) > 0 && a['nginx.ingress.kubernetes.io/limit-connections']);
  assert.equal(a['nginx.ingress.kubernetes.io/upstream-vhost'], '127.0.0.1:7802');
  assert.equal(i.spec.rules[0].http.paths[0].backend.service.name, one('service').metadata.name);
});

test('the UI Ingress is a second object on its OWN host with its own certificate and a rate limit', () => {
  const i = one('ingress-ui'); const cert = one('certificate');
  assert.equal(i.spec.ingressClassName, 'nginx-public'); assert.equal(i.spec.rules[0].host, '__UI_HOST__'); assert.notEqual(i.spec.rules[0].host, one('ingress-webhook').spec.rules[0].host);
  assert.deepEqual(i.spec.tls, [{ hosts: ['__UI_HOST__'], secretName: 'pingone-events-lab-tls' }]);
  assert.equal(cert.spec.secretName, 'pingone-events-lab-tls'); assert.deepEqual(cert.spec.dnsNames, ['__UI_HOST__']); assert.equal(cert.spec.issuerRef.name, '__CLUSTER_ISSUER__');
  assert.ok(i.metadata.annotations['nginx.ingress.kubernetes.io/limit-rps']);
  assert.equal(i.spec.rules[0].http.paths[0].backend.service.port.name, 'http');
  assert.deepEqual(one('service').spec.selector, { app: 'pingone-events-lab' }); assert.equal(one('service').spec.ports[0].name, 'http');
});

test('the NetworkPolicy allows the app port in and only DNS plus HTTPS / the Elasticsearch port out', () => {
  const n = one('networkpolicy');
  assert.deepEqual(n.spec.podSelector.matchLabels, { app: 'pingone-events-lab' }); assert.deepEqual(n.spec.policyTypes.sort(), ['Egress', 'Ingress']);
  assert.deepEqual(n.spec.ingress[0].ports, [{ protocol: 'TCP', port: 7802 }]);
  const out = n.spec.egress.flatMap((e) => e.ports.map((p) => `${p.protocol}/${p.port}`)).sort();
  assert.deepEqual(out, ['TCP/443', 'TCP/53', 'TCP/9200', 'UDP/53']);
});

test('the Secret template holds only placeholders, only keys the app reads, and the two required credential pairs are separate', () => {
  const s = one('secret.example'); const data = s.stringData;
  assert.equal(s.kind, 'Secret');
  for (const [k, v] of Object.entries(data)) assert.match(v, /^REPLACE-ME/, `${k} is a placeholder`);
  const known = ['WEBHOOK_BASIC_USER', 'WEBHOOK_BASIC_PASSWORD', 'UI_BASIC_USER', 'UI_BASIC_PASSWORD', 'WEBHOOK_HEADER_NAME', 'WEBHOOK_HEADER_VALUE', 'PINGONE_ENVIRONMENT_ID', 'PINGONE_REGION', 'PINGONE_CLIENT_ID', 'PINGONE_CLIENT_SECRET', 'ELASTICSEARCH_URL', 'ELASTICSEARCH_API_KEY', 'ELASTICSEARCH_INDEX'];
  const src = fs.readFileSync(path.join(root, 'server/src/config.js'), 'utf8');
  for (const k of [...Object.keys(data), ...(read('secret.example.yaml').match(/^  # ([A-Z]+_[A-Z_]+):/gm) || []).map((l) => l.replace(/^  # /, '').replace(':', ''))]) { assert.ok(known.includes(k), `${k} is a known setting`); assert.ok(src.includes(k), `${k} is read by config.js`); }
  assert.deepEqual(Object.keys(data).filter((k) => /^WEBHOOK/.test(k)), ['WEBHOOK_BASIC_USER', 'WEBHOOK_BASIC_PASSWORD']);
  assert.notEqual(data.WEBHOOK_BASIC_PASSWORD, data.UI_BASIC_PASSWORD);
});

test('deploy.sh --dry-run renders every manifest with no token left, calls no kubectl, and omits the Secret', () => {
  const r = sh(['deploy.sh', '--dry-run'], ENV);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/__[A-Z_]+__/.test(r.stdout), 'no token survives');
  for (const needle of ['image: ghcr.io/example/pingone-events-lab:sha-abc123', 'host: hook.example', 'host: ui.example', 'name: test-issuer', 'value: ui.example', 'value: hook.example', '/webhook/pingone-events']) assert.ok(r.stdout.includes(needle), needle);
  assert.ok(!/kind: Secret/.test(r.stdout), 'the Secret is never rendered or applied');
  assert.match(r.stdout, /DRY RUN: would apply to namespace 'test-ns'/);
  const kinds = [...r.stdout.matchAll(/^kind: (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(kinds, ['PersistentVolumeClaim', 'NetworkPolicy', 'Deployment', 'Service', 'Certificate', 'Ingress', 'Ingress']);
});

test('deploy.sh --dry-run FAILS on an unreplaced __TOKEN__ (a manifest that grew a token the script does not know)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k8s-'));
  for (const f of fs.readdirSync(K)) fs.copyFileSync(path.join(K, f), path.join(tmp, f));
  fs.appendFileSync(path.join(tmp, 'service.yaml'), '# __NEW_TOKEN__\n');
  const r = sh([path.join(tmp, 'deploy.sh'), '--dry-run'], ENV, tmp);
  assert.equal(r.status, 2); assert.match(r.stderr, /unreplaced __TOKEN__ in service\.yaml: __NEW_TOKEN__/);
});

test('deploy.sh refuses bad input before doing anything', () => {
  const bad = (over, re) => { const r = sh(['deploy.sh', '--dry-run'], { ...ENV, ...over }); assert.equal(r.status, 2, JSON.stringify(over)); assert.match(r.stderr, re); };
  for (const v of Object.keys(ENV)) bad({ [v]: '' }, new RegExp(`set ${v}`));
  bad({ IMAGE: 'ghcr.io/example/x:latest' }, /immutable tag/); bad({ IMAGE: 'ghcr.io/example/x:HEAD' }, /immutable tag/); bad({ IMAGE: 'ghcr.io/example/x' }, /no tag or digest/); bad({ IMAGE: 'x:1;rm -rf' }, /characters/);
  bad({ NAMESPACE: 'Bad_NS' }, /plain name/); bad({ SE_HOST: 'host with space' }, /plain host/); bad({ UI_HOST: 'a.example', SE_HOST: 'a.example' }, /must be different/); bad({ CLUSTER_ISSUER: 'x y' }, /plain name/);
  assert.equal(sh(['deploy.sh', '--dry-run'], { ...ENV, IMAGE: 'ghcr.io/example/x@sha256:abc' }).status, 0, 'a digest is an immutable reference');
});

// A fake kubectl and docker: record what the script asks for, answer like a healthy cluster. No real cluster is ever contacted.
function fakeBin(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-')); const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'kubectl'), `#!/usr/bin/env bash
echo "$*" >> "${log}"; n=$((RANDOM*32768+RANDOM))
case "$*" in
  *"get secret"*) [ "\${FAKE_NO_SECRET:-}" = 1 ] && exit 1; exit 0;;
  *" -f -"*) cat > "${dir}/apply-$n.yaml"; echo applied;;
  *"rollout status"*) echo rolled;;
  *" exec "*) m="\${@: -2:1}"; p="\${@: -1}"
     if [ "$m $p" = "GET /api/health" ]; then echo '{"status":200,"body":"{\\"schema\\":\\"demo-health/1\\",\\"state\\":\\"ready\\",\\"demo\\":{\\"id\\":\\"pingone-events-lab\\"}}"}'
     else echo "\${FAKE_PROBE:-{\\"status\\":401,\\"body\\":\\"{}\\"}}"; fi;;
  *"get pod"*) echo "\${FAKE_IMAGE_ID:-ghcr.io/example/pingone-events-lab@sha256:abc}";;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'docker'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  void extra; return { dir, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []), applied: () => fs.readdirSync(dir).filter((f) => f.startsWith('apply-')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n---\n') };
}

test('a real apply needs OWNER_APPROVED and does not touch kubectl without it', () => {
  const f = fakeBin();
  const r = sh(['deploy.sh'], ENV, K, f.dir);
  assert.equal(r.status, 2); assert.match(r.stderr, /owner-approved/); assert.deepEqual(f.calls(), []);
});

test('a real apply needs the Secret to exist first, and applies nothing when it does not', () => {
  const f = fakeBin();
  const r = sh(['deploy.sh'], { ...ENV, OWNER_APPROVED: '1', FAKE_NO_SECRET: '1' }, K, f.dir);
  assert.equal(r.status, 2); assert.match(r.stderr, /Secret 'pingone-events-lab' does not exist/);
  assert.ok(!f.calls().some((c) => /apply/.test(c)), 'nothing applied');
});

test('a full run applies the seven manifests (never the Secret), then verifies by content: health, fail-closed 401s, and the image', () => {
  const f = fakeBin();
  const r = sh(['deploy.sh'], { ...ENV, OWNER_APPROVED: '1' }, K, f.dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const applied = f.applied();
  assert.ok(!/kind: Secret/.test(applied)); assert.ok(!/__[A-Z_]+__/.test(applied));
  assert.equal((applied.match(/^kind: /gm) || []).length, 7);
  const calls = f.calls().join('\n');
  assert.match(calls, /-n test-ns apply -n test-ns -f -|apply -n test-ns -f -/);
  assert.ok(f.calls().filter((c) => / apply /.test(` ${c} `)).length === 7);
  assert.match(calls, /rollout status deployment\/pingone-events-lab/);
  assert.match(r.stdout, /verify ok: \/api\/health says demo-health\/1, ready, pingone-events-lab/);
  assert.match(r.stdout, /verify ok: HEAD \/webhook\/pingone-events answers 401 without a credential/);
  assert.match(r.stdout, /verify ok: GET \/api\/info answers 401 without a credential/);
  assert.match(r.stdout, /verify ok: pod imageID is ghcr\.io\/example\/pingone-events-lab@sha256:abc/);
  assert.ok(!/kubectl.* set image|\*=/.test(calls), 'it applies manifests; it never sets an image with a wildcard container');
});

test('the verification FAILS when the receiver would answer without a credential, or the pod runs a different image', () => {
  for (const [env, re] of [[{ FAKE_PROBE: '{"status":200,"body":"{}"}' }, /did not answer 401 without a credential/], [{ FAKE_IMAGE_ID: 'ghcr.io/example/other@sha256:abc' }, /does not match IMAGE/]]) {
    const f = fakeBin(); const r = sh(['deploy.sh'], { ...ENV, OWNER_APPROVED: '1', ...env }, K, f.dir);
    assert.equal(r.status, 1); assert.match(r.stderr, re);
  }
});

test('the deploy script never applies the Secret template and never sets an image with a wildcard', () => {
  const s = read('deploy.sh');
  assert.ok(!/^FILES=.*secret/m.test(s), 'the template is not in the apply list');
  assert.ok(!/set image/.test(s.replace(/^#.*$/gm, '')));
  assert.match(s, /set -euo pipefail/);
});
