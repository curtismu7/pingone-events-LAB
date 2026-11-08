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
const PW = 'proof-webhook-credential-1'; const USER = 'pingone';
const ENV = { KUBE_CONTEXT: 'test-ctx', NAMESPACE: 'test-ns', IMAGE: 'ghcr.io/example/pingone-events-lab:sha-abc1234', SE_HOST: 'se-host.example', UI_HOST: 'ui-host.example', CLUSTER_ISSUER: 'test-issuer' };
const REAL_ENV = { ...ENV, OWNER_APPROVED: '1', WEBHOOK_BASIC_USER: USER, WEBHOOK_BASIC_PASSWORD: PW, PUBLIC_CHECK_ATTEMPTS: '1', PUBLIC_CHECK_SLEEP: '0' };
const sh = (args, env = {}, cwd = K, bin = null) => spawnSync('bash', args, { cwd, encoding: 'utf8', env: { PATH: `${bin ? `${bin}:` : ''}${process.env.PATH}`, HOME: os.tmpdir(), ...env } });

// A fake kubectl, curl and docker: record what the script asks for, answer like a healthy cluster. No real cluster or host is ever contacted.
const DEFAULT_INGRESS = { items: [{ metadata: { namespace: 'other', name: 'ai-demo-ingress' }, spec: { rules: [{ host: 'se-host.example', http: { paths: [{ path: '/' }] } }] } }] };
function fakeBin(ingress = DEFAULT_INGRESS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-')); const log = path.join(dir, 'calls.log'); const curlLog = path.join(dir, 'curl.log');
  fs.writeFileSync(path.join(dir, 'ingress.json'), JSON.stringify(ingress));
  fs.writeFileSync(path.join(dir, 'kubectl'), `#!/usr/bin/env bash
echo "$*" >> "${log}"; n=$((RANDOM*32768+RANDOM))
case "$*" in
  *"get ingress"*) [ "\${FAKE_NO_CLUSTER:-}" = 1 ] && { echo "Unable to connect to the server" >&2; exit 1; }; cat "${dir}/ingress.json"; exit 0;;
  *"get secret"*) [ "\${FAKE_NO_SECRET:-}" = 1 ] && exit 1; exit 0;;
  *" -f -"*) cat > "${dir}/apply-$n.yaml"; echo applied;;
  *"rollout status"*) echo rolled;;
  *" exec "*) m="\${@: -2:1}"; p="\${@: -1}"
     if [ "$m $p" = "GET /api/health" ]; then echo "\${FAKE_HEALTH:-{\\"status\\":200,\\"body\\":\\"{\\\\\\"schema\\\\\\":\\\\\\"demo-health/1\\\\\\",\\\\\\"state\\\\\\":\\\\\\"ready\\\\\\",\\\\\\"demo\\\\\\":{\\\\\\"id\\\\\\":\\\\\\"pingone-events-lab\\\\\\"}}\\"}}"
     else echo "\${FAKE_PROBE:-{\\"status\\":401,\\"body\\":\\"{}\\"}}"; fi;;
  *"get pod"*) echo "\${FAKE_IMAGE_ID:-ghcr.io/example/pingone-events-lab@sha256:abc}";;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'curl'), `#!/usr/bin/env bash
echo "$*" >> "${curlLog}"
cfg=""; for a in "$@"; do [ "$a" = "-K" ] && cfg=$(cat); done
url="\${@: -1}"
case "$url" in
  https://se-host.example/webhook/pingone-events) if grep -q 'user = "${USER}:${PW}"' <<<"$cfg"; then printf '%s' "\${FAKE_PUBLIC_OK:-200}"; else printf '%s' "\${FAKE_PUBLIC_ANON:-401}"; fi;;
  https://ui-host.example/api/info) printf '%s' "\${FAKE_UI_ANON:-401}";;
  *) printf 000;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'docker'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []), curlCalls: () => (fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8').trim().split('\n') : []), applied: () => fs.readdirSync(dir).filter((f) => f.startsWith('apply-')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n---\n') };
}

test('every manifest parses; none carries a namespace; the only tokens are the four the deploy script fills', () => {
  for (const n of [...FILES, 'secret.example']) for (const d of docs[n]) { assert.ok(d.apiVersion && d.kind && d.metadata?.name, n); assert.equal(d.metadata.namespace, undefined, `${n}: no namespace in manifests (deploy.sh takes NAMESPACE)`); }
  const tokens = new Set(); for (const n of FILES) for (const t of read(`${n}.yaml`).match(/__[A-Z_]+__/g) || []) tokens.add(t);
  assert.deepEqual([...tokens].sort(), ['__CLUSTER_ISSUER__', '__IMAGE__', '__SE_HOST__', '__UI_HOST__']);
  assert.equal(new Set(FILES.map((n) => `${one(n).kind}/${one(n).metadata.name}`)).size, FILES.length);
});

test('no real host, registry path, tenant id or secret is in a committed manifest', () => {
  const all = [...FILES, 'secret.example'].map((n) => read(`${n}.yaml`)).join('\n');
  assert.deepEqual(scanHosts(all).filter((h) => !['0.0.0.0', '10.0.0.0', '172.16.0.0', '192.168.0.0', '169.254.0.0'].includes(h)), [], 'only the wildcard bind address and the private / link-local CIDRs the NetworkPolicy excludes are addresses here');
  assert.ok(!/ping-devops|ghcr\.io\/[a-z]|cmuir|curtismu7|ngrok|tunnel/i.test(all), 'no host, registry path, account or tunnel');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(all), 'no real-looking identifier');
});

test('the Deployment is locked down: one pod, Recreate, non-root, read-only filesystem, no capabilities, requests and limits, Host-header probes on the open endpoint', () => {
  const spec = one('deployment').spec; const pod = spec.template.spec; const c = pod.containers[0];
  assert.deepEqual([spec.replicas, spec.strategy.type], [1, 'Recreate']);
  assert.deepEqual([pod.securityContext.runAsNonRoot, pod.securityContext.runAsUser, pod.securityContext.fsGroup, pod.securityContext.seccompProfile.type], [true, 1000, 1000, 'RuntimeDefault']);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual([c.securityContext.allowPrivilegeEscalation, c.securityContext.readOnlyRootFilesystem, c.securityContext.capabilities.drop], [false, true, ['ALL']]);
  assert.ok(c.resources.requests.cpu && c.resources.requests.memory && c.resources.limits.cpu && c.resources.limits.memory);
  assert.equal(c.name, 'app'); assert.equal(c.image, '__IMAGE__'); assert.equal(pod.imagePullSecrets[0].name, 'ghcr-pull-secret');
  const mounts = Object.fromEntries(c.volumeMounts.map((m) => [m.name, m.mountPath])); assert.deepEqual(mounts, { data: '/data', tmp: '/tmp' });
  assert.equal(pod.volumes.find((v) => v.name === 'data').persistentVolumeClaim.claimName, one('pvc').metadata.name);
  assert.equal(pod.volumes.find((v) => v.name === 'tmp').emptyDir.sizeLimit, '16Mi');
  assert.deepEqual(one('pvc').spec.accessModes, ['ReadWriteOnce']);
});

test('the Deployment is hosted EXPLICITLY, takes its credentials from the Secret (which must exist), and the host allow-lists come from placeholders', () => {
  const c = one('deployment').spec.template.spec.containers[0];
  const env = Object.fromEntries(c.env.map((e) => [e.name, e.value]));
  assert.equal(env.PEV_HOSTED, '1', 'hosted is set explicitly, not left to a default'); assert.equal(env.PEV_BIND, '0.0.0.0'); assert.equal(env.PEV_DATA_DIR, '/data'); assert.equal(env.PORT, '7802');
  assert.equal(env.PEV_TRUST_PROXY_HOPS, '1', 'exactly one proxy hop is trusted, stated explicitly');
  assert.equal(env.LAB_ALLOWED_HOSTS, '__UI_HOST__'); assert.equal(env.WEBHOOK_ALLOWED_HOSTS, '__SE_HOST__');
  assert.equal(env.MODE, undefined, 'no MODE: Real by default because the public webhook host is configured, the toggle stays available');
  assert.equal(c.envFrom[0].secretRef.name, one('secret.example').metadata.name);
  assert.notEqual(c.envFrom[0].secretRef.optional, true, 'a missing Secret must stop the pod, not let it start unconfigured');
  assert.ok(!c.env.some((e) => /PASSWORD|SECRET|KEY|TOKEN/.test(e.name)), 'no credential is set inline');
});

test('every environment variable the manifests set or the Secret template offers is one the server code actually reads (a renamed name would silently do nothing)', () => {
  const names = new Set(one('deployment').spec.template.spec.containers[0].env.map((e) => e.name));
  for (const k of Object.keys(one('secret.example').stringData)) names.add(k);
  for (const m of read('secret.example.yaml').matchAll(/^  # ([A-Z][A-Z0-9]*_[A-Z0-9_]+):/gm)) names.add(m[1]);
  const code = fs.readdirSync(path.join(root, 'server/src')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, 'server/src', f), 'utf8')).join('\n');
  const unread = [...names].filter((n) => !new RegExp(`\\benv\\.${n}\\b|\\benv\\[['"]${n}['"]\\]`).test(code));
  assert.deepEqual(unread, [], 'set in a manifest, never read by the server');
  assert.ok(names.has('PEV_WEBHOOK_RPM') && names.has('PEV_TRUST_PROXY_HOPS') && names.has('PEV_HOSTED'));
});

test('the ports line up everywhere: container port, Service targetPort and port name, the ingresses\' backend, the probes\' Host header, the NetworkPolicy, the Dockerfile', () => {
  const c = one('deployment').spec.template.spec.containers[0]; const port = c.ports[0];
  const svc = one('service').spec.ports[0];
  assert.equal(port.name, 'http'); assert.equal(port.containerPort, 7802);
  assert.equal(svc.targetPort, port.name, 'the Service must target the container port BY NAME, and that name must exist');
  assert.equal(svc.name, 'http'); assert.equal(svc.port, 80);
  for (const n of ['ingress-webhook', 'ingress-ui']) {
    const b = one(n).spec.rules[0].http.paths[0].backend.service;
    assert.equal(b.name, one('service').metadata.name, `${n} backend is this Service`);
    assert.ok(b.port.name === svc.name, `${n} backend port name must be a port the Service has`);
    assert.equal(one(n).metadata.annotations['nginx.ingress.kubernetes.io/upstream-vhost'], `127.0.0.1:${port.containerPort}`, `${n} upstream-vhost is a loopback Host on the container port`);
  }
  for (const probe of [c.readinessProbe, c.livenessProbe]) { assert.equal(probe.httpGet.port, port.name); assert.equal(probe.httpGet.path, '/api/health'); assert.deepEqual(probe.httpGet.httpHeaders, [{ name: 'Host', value: `127.0.0.1:${port.containerPort}` }]); }
  assert.equal(c.env.find((e) => e.name === 'PORT').value, String(port.containerPort));
  assert.deepEqual(one('networkpolicy').spec.ingress[0].ports, [{ protocol: 'TCP', port: port.containerPort }]);
  assert.match(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'), new RegExp(`^EXPOSE ${port.containerPort}$`, 'm'));
  assert.deepEqual(one('service').spec.selector, one('deployment').spec.selector.matchLabels, 'the Service selects the Deployment\'s pods');
  assert.deepEqual(one('networkpolicy').spec.podSelector.matchLabels, one('deployment').spec.selector.matchLabels);
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
});

test('the UI Ingress is a second object on its OWN host with its own certificate, a rate limit and a small body', () => {
  const i = one('ingress-ui'); const cert = one('certificate');
  assert.equal(i.spec.ingressClassName, 'nginx-public'); assert.equal(i.spec.rules[0].host, '__UI_HOST__'); assert.notEqual(i.spec.rules[0].host, one('ingress-webhook').spec.rules[0].host);
  assert.deepEqual(i.spec.tls, [{ hosts: ['__UI_HOST__'], secretName: 'pingone-events-lab-tls' }]);
  assert.equal(cert.spec.secretName, 'pingone-events-lab-tls'); assert.deepEqual(cert.spec.dnsNames, ['__UI_HOST__']); assert.equal(cert.spec.issuerRef.name, '__CLUSTER_ISSUER__');
  const a = i.metadata.annotations;
  assert.ok(a['nginx.ingress.kubernetes.io/limit-rps']); assert.equal(a['nginx.ingress.kubernetes.io/proxy-body-size'], '16k'); assert.equal(a['nginx.ingress.kubernetes.io/ssl-redirect'], 'true');
  assert.equal(a['nginx.ingress.kubernetes.io/upstream-vhost'], '127.0.0.1:7802');
  assert.equal(i.spec.rules[0].http.paths[0].path, '/');
});

test('the NetworkPolicy lets only the public ingress controller in, DNS to CoreDNS out, and HTTPS / 9200 out EXCLUDING private and metadata ranges; its comment describes what was read', () => {
  const n = one('networkpolicy');
  assert.deepEqual(n.spec.policyTypes.sort(), ['Egress', 'Ingress']);
  assert.equal(n.spec.ingress.length, 1, 'exactly ONE ingress rule: nothing else may reach the pod');
  assert.equal(n.spec.ingress[0].ports.length, 1);
  assert.deepEqual(n.spec.ingress[0].from, [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx-public' } }, podSelector: { matchLabels: { 'app.kubernetes.io/name': 'ingress-nginx' } } }]);
  assert.equal(n.spec.egress.length, 2, 'exactly two egress rules: DNS, and HTTPS / 9200');
  const [dns, out] = n.spec.egress;
  assert.deepEqual(dns.to, [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }]);
  assert.deepEqual(dns.ports.map((p) => `${p.protocol}/${p.port}`).sort(), ['TCP/53', 'UDP/53']);
  assert.equal(out.to[0].ipBlock.cidr, '0.0.0.0/0');
  for (const r of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']) assert.ok(out.to[0].ipBlock.except.includes(r), `${r} is excluded`);
  assert.deepEqual(out.ports.map((p) => `${p.protocol}/${p.port}`).sort(), ['TCP/443', 'TCP/9200']);
  const text = read('networkpolicy.yaml');
  assert.match(text, /pingone-signin-lab-default-deny/); assert.match(text, /ingress-nginx-public/); assert.match(text, /kube-dns/); assert.match(text, /UNVERIFIED/);
  assert.ok(!/the namespace already uses default-deny plus an allow policy for some labs \(see/i.test(text), 'the old, loose description is gone');
});

test('the Secret template holds only placeholders, only keys the app reads; the two required pairs are separate; the comment claim is the real behaviour', () => {
  const s = one('secret.example'); const data = s.stringData;
  assert.equal(s.kind, 'Secret');
  for (const [k, v] of Object.entries(data)) assert.match(v, /^REPLACE-ME/, `${k} is a placeholder`);
  assert.deepEqual(Object.keys(data).filter((k) => /^WEBHOOK/.test(k)), ['WEBHOOK_BASIC_USER', 'WEBHOOK_BASIC_PASSWORD']);
  assert.notEqual(data.WEBHOOK_BASIC_PASSWORD, data.UI_BASIC_PASSWORD);
  const text = read('secret.example.yaml');
  assert.match(text, /REFUSES TO START when any\s+# of these keys still holds the placeholder text REPLACE-ME/);
  assert.ok(!/an invalid\s+# setting and the pod will refuse/.test(text), 'the old, untrue sentence is gone');
});

test('deploy.sh --dry-run runs the read-only preflight, renders every manifest with no token left, applies nothing, and omits the Secret', () => {
  const f = fakeBin();
  const r = sh(['deploy.sh', '--dry-run'], ENV, K, f.dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/__[A-Z_]+__/.test(r.stdout), 'no token survives');
  for (const needle of ['image: ghcr.io/example/pingone-events-lab:sha-abc1234', 'host: se-host.example', 'host: ui-host.example', 'name: test-issuer', 'value: ui-host.example', 'value: se-host.example', '/webhook/pingone-events']) assert.ok(r.stdout.includes(needle), needle);
  assert.ok(!/kind: Secret/.test(r.stdout), 'the Secret is never rendered or applied');
  assert.match(r.stdout, /DRY RUN: would apply to namespace 'test-ns'/);
  assert.match(r.stdout, /# preflight \(read-only\)[\s\S]*existing  se-host\.example \/ \(other\/ai-demo-ingress\)/, 'the preflight lists what already uses the host');
  assert.deepEqual([...r.stdout.matchAll(/^kind: (\w+)/gm)].map((m) => m[1]), ['PersistentVolumeClaim', 'NetworkPolicy', 'Deployment', 'Service', 'Certificate', 'Ingress', 'Ingress']);
  assert.ok(f.calls().every((c) => /^--context test-ctx /.test(c) && / get ingress /.test(` ${c} `)), 'a dry run only ever READS ingresses, with the pinned context');
  assert.ok(!f.calls().some((c) => / apply /.test(` ${c} `)));
});

test('deploy.sh --dry-run FAILS on an unreplaced __TOKEN__ (a manifest that grew a token the script does not know)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k8s-')); const f = fakeBin();
  for (const x of fs.readdirSync(K)) fs.copyFileSync(path.join(K, x), path.join(tmp, x));
  fs.appendFileSync(path.join(tmp, 'service.yaml'), '# __NEW_TOKEN__\n');
  const r = sh([path.join(tmp, 'deploy.sh'), '--dry-run'], ENV, tmp, f.dir);
  assert.equal(r.status, 2); assert.match(r.stderr, /unreplaced __TOKEN__ in service\.yaml: __NEW_TOKEN__/);
});

test('deploy.sh refuses bad input before doing anything, and an explicit KUBE_CONTEXT is mandatory', () => {
  const f = fakeBin();
  const bad = (over, re) => { const r = sh(['deploy.sh', '--dry-run'], { ...ENV, ...over }, K, f.dir); assert.equal(r.status, 2, JSON.stringify(over)); assert.match(r.stderr, re, JSON.stringify(over)); };
  for (const v of Object.keys(ENV)) bad({ [v]: '' }, new RegExp(`set ${v}`));
  bad({ KUBE_CONTEXT: 'a b' }, /KUBE_CONTEXT has characters/);
  for (const image of ['ghcr.io/example/x:latest', 'ghcr.io/example/x:HEAD', 'ghcr.io/example/x', 'ghcr.io/example/x:v1', 'ghcr.io/example/x:main', 'ghcr.io/example/x:sha-xyz', 'ghcr.io/example/x:sha-abc', 'ghcr.io/example/x:SHA-abc1234', 'ghcr.io/example/x:sha-abc1234;rm', 'GHCR.io/example/x:sha-abc1234', 'x@sha256:abc', ':sha-abc1234', 'ghcr.io/example/x:sha-' + '0'.repeat(41)]) bad({ IMAGE: image }, /IMAGE must end in/);
  for (const ns of ['Bad_NS', '-ns', 'ns-', 'a'.repeat(64), 'ns space']) bad({ NAMESPACE: ns }, /NAMESPACE must be a plain DNS label/);
  for (const host of ['a..b.example', '-a.example', 'a-.example', 'a.example.', '.a.example', 'a_b.example', 'localhost', 'UPPER.example', 'a b.example', 'a.example/path', `${'a'.repeat(64)}.example`]) { bad({ SE_HOST: host }, /SE_HOST must be a fully qualified/); bad({ UI_HOST: host }, /UI_HOST must be a fully qualified/); }
  bad({ UI_HOST: 'se-host.example' }, /must be different/); bad({ CLUSTER_ISSUER: 'x y' }, /plain name/);
  const ok = (over) => assert.equal(sh(['deploy.sh', '--dry-run'], { ...ENV, ...over }, K, f.dir).status, 0, JSON.stringify(over));
  ok({ IMAGE: `ghcr.io/example/x@sha256:${'a'.repeat(64)}` }); ok({ IMAGE: 'localhost:5000/example/x:sha-0123abc' }); ok({ SE_HOST: 'a.b.example' });
});

test('every kubectl call carries the pinned --context (no ambient context), in a dry run and in a real one', () => {
  const f = fakeBin();
  assert.equal(sh(['deploy.sh', '--dry-run'], ENV, K, f.dir).status, 0);
  const r = sh(['deploy.sh'], REAL_ENV, K, f.dir);
  assert.equal(r.status, 0, r.stderr);
  const calls = f.calls(); assert.ok(calls.length >= 10);
  for (const c of calls) assert.match(c, /^--context test-ctx /, c);
});

test('the preflight FAILS on a collision with another ingress (same host and path), allows our own and a broader path on the shared host, and is read-only', () => {
  const ing = (ns, name, host, path_) => ({ metadata: { namespace: ns, name }, spec: { rules: [{ host, http: { paths: [{ path: path_ }] } }] } });
  const run = (items, extra = {}) => { const f = fakeBin({ items }); const r = sh(['deploy.sh', '--dry-run'], { ...ENV, ...extra }, K, f.dir); return { r, f }; };
  let { r } = run([ing('other', 'someone-else', 'ui-host.example', '/')]);
  assert.equal(r.status, 2); assert.match(r.stdout, /COLLISION ui-host\.example \/ \(other\/someone-else\)/); assert.match(r.stderr, /another ingress already uses the same host and path/);
  ({ r } = run([ing('other', 'dup', 'se-host.example', '/webhook/pingone-events')]));
  assert.equal(r.status, 2); assert.match(r.stdout, /COLLISION se-host\.example \/webhook\/pingone-events/);
  ({ r } = run([ing('other', 'broad', 'se-host.example', '/'), ing('other', 'broader', 'se-host.example', '/webhook'), ing('other', 'unrelated', 'x.example', '/')]));
  assert.equal(r.status, 0, 'a different path on the shared host is not a collision (ours is Exact and more specific)'); assert.match(r.stdout, /existing  se-host\.example \/webhook /);
  ({ r } = run([ing('test-ns', 'pingone-events-lab-webhook', 'se-host.example', '/webhook/pingone-events'), ing('test-ns', 'pingone-events-lab-ui', 'ui-host.example', '/')]));
  assert.equal(r.status, 0, 'our own ingresses from an earlier deploy are not a collision'); assert.match(r.stdout, /ours\s+ui-host\.example/);
  ({ r } = run([ing('other', 'sneaky', 'ui-host.example', '/')].map((i) => ({ ...i, metadata: { namespace: 'other', name: 'pingone-events-lab-ui' } }))));
  assert.equal(r.status, 2, 'the same NAME in another namespace is not ours');
});

test('when the cluster cannot be read the preflight says so and STOPS, unless ALLOW_NO_PREFLIGHT=1 is set explicitly', () => {
  const f = fakeBin();
  let r = sh(['deploy.sh', '--dry-run'], { ...ENV, FAKE_NO_CLUSTER: '1' }, K, f.dir);
  assert.equal(r.status, 2); assert.match(r.stderr, /could not be read with context 'test-ctx'/); assert.match(r.stderr, /ALLOW_NO_PREFLIGHT=1/);
  r = sh(['deploy.sh', '--dry-run'], { ...ENV, FAKE_NO_CLUSTER: '1', ALLOW_NO_PREFLIGHT: '1' }, K, f.dir);
  assert.equal(r.status, 0); assert.match(r.stderr, /continuing without it because ALLOW_NO_PREFLIGHT=1/);
});

test('a real apply needs OWNER_APPROVED and the webhook credential, and does not apply anything without them', () => {
  const f = fakeBin();
  let r = sh(['deploy.sh'], { ...REAL_ENV, OWNER_APPROVED: '' }, K, f.dir);
  assert.equal(r.status, 2); assert.match(r.stderr, /owner-approved/);
  for (const v of ['WEBHOOK_BASIC_USER', 'WEBHOOK_BASIC_PASSWORD']) { r = sh(['deploy.sh'], { ...REAL_ENV, [v]: '' }, K, f.dir); assert.equal(r.status, 2, v); assert.match(r.stderr, new RegExp(`set ${v}`)); }
  r = sh(['deploy.sh'], { ...REAL_ENV, WEBHOOK_BASIC_PASSWORD: 'has"quote-in-it-12' }, K, f.dir); assert.equal(r.status, 2); assert.match(r.stderr, /must not contain a quote/);
  assert.ok(!f.calls().some((c) => / apply /.test(` ${c} `) || /rollout|exec/.test(c)), 'nothing was applied');
});

test('a real apply needs the Secret to exist first, and applies nothing when it does not', () => {
  const f = fakeBin();
  const r = sh(['deploy.sh'], { ...REAL_ENV, FAKE_NO_SECRET: '1' }, K, f.dir);
  assert.equal(r.status, 2); assert.match(r.stderr, /Secret 'pingone-events-lab' does not exist/);
  assert.ok(!f.calls().some((c) => / apply /.test(` ${c} `)), 'nothing applied');
});

test('a full run applies the seven manifests (never the Secret), then verifies by content: health, fail-closed 401s in the pod, the image, and the PUBLIC ingress path', () => {
  const f = fakeBin();
  const r = sh(['deploy.sh'], REAL_ENV, K, f.dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const applied = f.applied();
  assert.ok(!/kind: Secret/.test(applied)); assert.ok(!/__[A-Z_]+__/.test(applied));
  assert.equal((applied.match(/^kind: /gm) || []).length, 7);
  const calls = f.calls().join('\n');
  assert.equal(f.calls().filter((c) => / apply /.test(` ${c} `)).length, 7);
  assert.match(calls, /rollout status deployment\/pingone-events-lab/);
  assert.match(r.stdout, /verify ok: \/api\/health says demo-health\/1, ready, pingone-events-lab/);
  assert.match(r.stdout, /verify ok: in the pod, HEAD \/webhook\/pingone-events answers 401 without a credential/);
  assert.match(r.stdout, /verify ok: in the pod, GET \/api\/info answers 401 without a credential/);
  assert.match(r.stdout, /verify ok: pod imageID is ghcr\.io\/example\/pingone-events-lab@sha256:abc/);
  assert.match(r.stdout, /verify ok: public HEAD https:\/\/se-host\.example\/webhook\/pingone-events with the webhook credential -> 200/);
  assert.match(r.stdout, /verify ok: public HEAD https:\/\/se-host\.example\/webhook\/pingone-events without a credential -> 401/);
  assert.match(r.stdout, /verify ok: public GET https:\/\/ui-host\.example\/api\/info without a credential -> 401/);
  assert.ok(!/kubectl.* set image|\*=/.test(calls));
  // The credential reaches curl on stdin only: never on a command line, never in the output.
  assert.ok(!f.curlCalls().join('\n').includes(PW) && !r.stdout.includes(PW) && !r.stderr.includes(PW) && !calls.includes(PW), 'the webhook password appears nowhere');
  assert.deepEqual(f.curlCalls().map((c) => /-K -/.test(c)), [true, false, false], 'only the credentialed check passes a curl config on stdin');
});

test('the verification FAILS when the pod\'s health lacks this app\'s id, the pod would answer without a credential, the image differs, or the public path misbehaves', () => {
  const cases = [
    [{ FAKE_HEALTH: '{"status":200,"body":"{\\"schema\\":\\"demo-health/1\\",\\"state\\":\\"ready\\",\\"demo\\":{\\"id\\":\\"some-other-app\\"}}"}' }, /did not say demo-health\/1, ready, id pingone-events-lab/],
    [{ FAKE_HEALTH: '{"status":200,"body":"{\\"schema\\":\\"demo-health/1\\",\\"state\\":\\"broken\\",\\"demo\\":{\\"id\\":\\"pingone-events-lab\\"}}"}' }, /did not say demo-health\/1, ready/],
    [{ FAKE_PROBE: '{"status":200,"body":"{}"}' }, /did not answer 401 without a credential/],
    [{ FAKE_IMAGE_ID: 'ghcr.io/example/other@sha256:abc' }, /does not match IMAGE/],
    [{ FAKE_PUBLIC_OK: '503' }, /public HEAD .* with the webhook credential -> 503 \(wanted 200\)/],
    [{ FAKE_PUBLIC_ANON: '200' }, /without a credential -> 200 \(wanted 401\)/],
    [{ FAKE_UI_ANON: '200' }, /https:\/\/ui-host\.example\/api\/info without a credential -> 200 \(wanted 401\)/],
  ];
  for (const [env, re] of cases) { const f = fakeBin(); const r = sh(['deploy.sh'], { ...REAL_ENV, ...env }, K, f.dir); assert.equal(r.status, 1, JSON.stringify(env)); assert.match(r.stderr, re, JSON.stringify(env)); }
  const f = fakeBin(); const digest = 'b'.repeat(64);
  const r = sh(['deploy.sh'], { ...REAL_ENV, IMAGE: `ghcr.io/example/pingone-events-lab@sha256:${digest}`, FAKE_IMAGE_ID: `ghcr.io/example/pingone-events-lab@sha256:${'c'.repeat(64)}` }, K, f.dir);
  assert.equal(r.status, 1); assert.match(r.stderr, /does not carry the digest in IMAGE/);
});

test('the public checks retry (DNS and certificates take minutes) and give up with a clear reason', () => {
  const f = fakeBin();
  const r = sh(['deploy.sh'], { ...REAL_ENV, PUBLIC_CHECK_ATTEMPTS: '3', FAKE_PUBLIC_OK: '000' }, K, f.dir);
  assert.equal(r.status, 1); assert.match(r.stderr, /after 3 attempt\(s\): DNS, the certificate or the ingress may not be ready/);
  assert.equal(f.curlCalls().filter((c) => /-K -/.test(c)).length, 3, 'tried three times');
});

test('the deploy script never applies the Secret template and never sets an image with a wildcard', () => {
  const s = read('deploy.sh');
  assert.ok(!/^FILES=.*secret/m.test(s), 'the template is not in the apply list');
  assert.ok(!/set image/.test(s.replace(/^#.*$/gm, '')));
  assert.match(s, /set -euo pipefail/); assert.match(s, /k\(\) \{ kubectl --context "\$KUBE_CONTEXT" "\$@"; \}/);
  assert.ok(!/^\s*kubectl /m.test(s.replace(/^#.*$/gm, '')), 'every kubectl call goes through the pinned-context wrapper k()');
});
