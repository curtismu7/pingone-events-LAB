import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { portProblem } from '../server/src/safety.js';

// Every published port must be bound to loopback on the host. A small line parser (no YAML dependency).
export function publishedPorts(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ports:\s*$/.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(lines[j]);
      if (!item || lines[j].search(/\S/) <= m[1].length) break;
      out.push(item[1]);
    }
  }
  return out;
}
const here = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('docker-compose.yml publishes only on 127.0.0.1', () => {
  const ports = publishedPorts(here('docker-compose.yml'));
  assert.deepEqual(ports, ['127.0.0.1:${HOST_PORT:-7803}:7802']);
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:/, `${p} must start with 127.0.0.1:`);
});

test('the parser flags an unbound or wildcard publish', () => {
  for (const bad of ['- "7803:7802"', '- "0.0.0.0:7803:7802"', '- 7803', '- "::1:7803:7802"']) {
    const ports = publishedPorts(`services:\n  a:\n    ports:\n      ${bad}\n`);
    assert.equal(ports.length, 1);
    assert.doesNotMatch(ports[0], /^127\.0\.0\.1:/);
  }
});

test('compose default host port and Dockerfile port are allowed ports and agree', () => {
  const compose = here('docker-compose.yml');
  const host = Number(/\$\{HOST_PORT:-(\d+)\}/.exec(compose)[1]);
  assert.equal(portProblem(host), null);
  const docker = here('Dockerfile');
  const port = Number(/^EXPOSE (\d+)/m.exec(docker)[1]);
  assert.equal(portProblem(port), null);
  assert.match(compose, new RegExp(`:${port}"`));
  assert.match(docker, /^ENV PEV_BIND=0\.0\.0\.0$/m);
  assert.match(docker, /^USER node$/m);
});

test('the container is locked down: read-only fs, no capabilities, no new privileges, a data volume the unprivileged user owns', () => {
  const compose = here('docker-compose.yml'); const docker = here('Dockerfile');
  assert.match(compose, /read_only: true/); assert.match(compose, /cap_drop: \[ALL\]/); assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /pingone-events-data:\/data/); assert.match(docker, /chown node:node \/data/); assert.match(docker, /^ENV PEV_DATA_DIR=\/data$/m);
  assert.ok(!/privileged|network_mode: host|docker\.sock/.test(compose), 'no docker socket, no host network');
});

test('one image for the local standalone and SE: no MODE and no hosted flag baked in; Real settings come from the optional shared settings file', () => {
  const compose = here('docker-compose.yml'); const docker = here('Dockerfile');
  assert.ok(!/^ENV .*\bMODE=/m.test(docker), 'no MODE in the image'); assert.ok(!/PEV_HOSTED/.test(docker) && !/PEV_HOSTED/.test(compose), 'hosted is only set by the SE manifests');
  assert.match(compose, /env_file:[\s\S]*STANDALONE_ENV:-\$\{HOME\}\/Development\/\.env[\s\S]*required: false/);
  assert.match(compose, /extra_hosts:[\s\S]*local\.ping-devops\.com:host-gateway/);
  assert.ok(!/\/Users\//.test(compose), 'no absolute home path');
  assert.ok(!/elasticsearch:|kibana|opensearch:|image: docker\.elastic/i.test(compose.replace(/#.*$/gm, '')), 'no Elasticsearch or Kibana container: forwarding goes to a URL the owner configures');
  assert.ok(!/^\s+profiles:/m.test(compose), 'no compose profile');
});

test('the Dockerfile ships the index template the API serves and nothing from the repo\'s scripts or manifests', () => {
  assert.match(here('Dockerfile'), /COPY docs\/elasticsearch-index-template\.json/);
  const ignore = here('.dockerignore');
  assert.match(ignore, /^k8s$/m); assert.match(ignore, /^!docs\/elasticsearch-index-template\.json$/m);
});

test('the image does not depend on the build machine\'s file modes: everything under /app is made readable for the unprivileged user (a 0600 package.json once made the container unstartable)', () => {
  const docker = here('Dockerfile');
  const run = /^RUN chmod -R a\+rX \/app && mkdir -p \/data && chown node:node \/data$/m.exec(docker);
  assert.ok(run, 'a RUN that chmods /app a+rX and prepares /data');
  assert.ok(docker.indexOf(run[0]) > docker.indexOf('COPY --from=build /app/web/dist web/dist'), 'it runs AFTER the last COPY, so it covers every copied file');
  assert.ok(docker.indexOf(run[0]) < docker.indexOf('USER node'), 'and before the switch to the unprivileged user');
});
