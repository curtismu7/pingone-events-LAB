import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedFrom, hostedProblems, modeFrom, pingoneFrom, pullProblemFrom, realAvailableFrom, realHosts, sinkFrom, sinkProblemFrom, sinkPublic, uiAuthFrom, webhookAuthFrom, webhookFrom } from '../src/config.js';
import { ENV_ID, CLIENT_ID } from './helpers.js';

const PULL = { PINGONE_ENVIRONMENT_ID: ENV_ID, PINGONE_CLIENT_ID: CLIENT_ID, PINGONE_CLIENT_SECRET: 'a-test-secret-value', PINGONE_REGION: 'eu' };
const ES = { ELASTICSEARCH_URL: 'https://cluster.example:9200', ELASTICSEARCH_API_KEY: 'test-api-key-value' };

test('Mock is the default; Real needs the pull settings or a public webhook host', () => {
  assert.equal(modeFrom({}), 'mock'); assert.equal(realAvailableFrom({}), false);
  assert.equal(modeFrom(PULL), 'real');
  assert.equal(modeFrom({ WEBHOOK_ALLOWED_HOSTS: 'hook.example' }), 'real');
  assert.equal(modeFrom({ ...PULL, MODE: 'mock' }), 'mock');
  assert.throws(() => modeFrom({ MODE: 'real' }), /neither the PingOne pull settings nor WEBHOOK_ALLOWED_HOSTS/);
  assert.throws(() => modeFrom({ MODE: 'hosted' }), /not available/);
  assert.equal(realAvailableFrom(ES), false, 'forwarding alone never makes Real available');
});

test('the pull settings are validated; the secret stays inside the settings object', () => {
  const p = pingoneFrom(PULL);
  assert.deepEqual([p.authHost, p.apiHost], ['auth.pingone.eu', 'api.pingone.eu']);
  assert.equal(pingoneFrom({ ...PULL, PINGONE_REGION: undefined }).authHost, 'auth.pingone.com');
  for (const bad of [{ PINGONE_ENVIRONMENT_ID: 'nope' }, { PINGONE_CLIENT_ID: 'nope' }, { PINGONE_CLIENT_SECRET: '' }, { PINGONE_REGION: 'evil.example' }, { PINGONE_REGION: 'NA' }]) {
    assert.equal(pingoneFrom({ ...PULL, ...bad }), null, JSON.stringify(bad).slice(0, 40));
    assert.ok(pullProblemFrom({ ...PULL, ...bad }));
  }
  assert.equal(pullProblemFrom(PULL), null);
  assert.ok(!JSON.stringify(pullProblemFrom({ ...PULL, PINGONE_REGION: 'x' })).includes('a-test-secret-value'));
});

test('the forwarding target is validated: https (http only on loopback), no credentials/query/path, no metadata or link-local hosts', () => {
  const ok = sinkFrom(ES);
  assert.deepEqual([ok.origin, ok.host, ok.index], ['https://cluster.example:9200', 'cluster.example', 'pingone-events']);
  assert.equal(ok.authorization, 'ApiKey test-api-key-value');
  assert.equal(sinkFrom({ ...ES, ELASTICSEARCH_INDEX: 'my-index' }).index, 'my-index');
  assert.ok(sinkFrom({ ELASTICSEARCH_URL: 'http://127.0.0.1:9200' }), 'a local cluster needs no credentials');
  assert.ok(sinkFrom({ ELASTICSEARCH_URL: 'http://localhost:9200' }));
  const basic = sinkFrom({ ELASTICSEARCH_URL: 'https://cluster.example', ELASTICSEARCH_USERNAME: 'elastic', ELASTICSEARCH_PASSWORD: 'a-test-password' });
  assert.equal(basic.authorization, `Basic ${Buffer.from('elastic:a-test-password').toString('base64')}`);
  assert.equal(sinkFrom({ ...ES, ELASTICSEARCH_USERNAME: 'u', ELASTICSEARCH_PASSWORD: 'p-long-enough' }).authorization, 'ApiKey test-api-key-value', 'an API key wins');
  for (const bad of [
    { ELASTICSEARCH_URL: 'http://cluster.example:9200' }, // plain http to a remote host
    { ELASTICSEARCH_URL: 'https://user:pw@cluster.example' }, { ELASTICSEARCH_URL: 'https://cluster.example/path' }, { ELASTICSEARCH_URL: 'https://cluster.example/?x=1' },
    { ELASTICSEARCH_URL: 'https://169.254.169.254' }, { ELASTICSEARCH_URL: 'https://metadata.google.internal' }, { ELASTICSEARCH_URL: 'https://0.0.0.0' }, { ELASTICSEARCH_URL: 'https://[fe80::1]' },
    { ELASTICSEARCH_URL: 'ftp://cluster.example' }, { ELASTICSEARCH_URL: 'not a url' }, { ELASTICSEARCH_INDEX: 'Bad Index!' }, { ELASTICSEARCH_INDEX: '_hidden' },
    { ELASTICSEARCH_API_KEY: undefined }, // a remote cluster without credentials is refused
  ]) assert.equal(sinkFrom({ ...ES, ...bad }), null, JSON.stringify(bad));
  assert.equal(sinkFrom({}), null); assert.ok(sinkProblemFrom({}));
  assert.ok(sinkProblemFrom({ ELASTICSEARCH_URL: 'http://cluster.example' }));
});

test('the public view of the target never contains a credential', () => {
  const view = JSON.stringify(sinkPublic(sinkFrom({ ...ES, ELASTICSEARCH_USERNAME: 'elastic', ELASTICSEARCH_PASSWORD: 'a-test-password' })));
  assert.ok(!/test-api-key-value|a-test-password|elastic|ApiKey|Basic/.test(view), view);
  assert.equal(sinkPublic(null), null);
});

test('the netguard allow-list: nothing without Real settings; the PingOne hosts when the pull is set; the cluster host when forwarding is set', () => {
  assert.deepEqual(realHosts({}), []);
  assert.deepEqual(realHosts(PULL), ['auth.pingone.eu', 'api.pingone.eu']);
  assert.deepEqual(realHosts({ ...PULL, ...ES }), ['auth.pingone.eu', 'api.pingone.eu', 'cluster.example']);
  assert.deepEqual(realHosts(ES), ['cluster.example']);
});

test('webhook hosts are validated host names', () => {
  assert.deepEqual(webhookFrom({ WEBHOOK_ALLOWED_HOSTS: 'a.example, B.example' }).hosts, ['a.example', 'b.example']);
  assert.equal(webhookFrom({}), null);
  assert.equal(webhookFrom({ WEBHOOK_ALLOWED_HOSTS: 'not a host' }), null);
});

test('webhook credential: Basic and/or a static header; short or odd values are not credentials', () => {
  const pw = 'twelve-chars-or-more';
  assert.deepEqual(webhookAuthFrom({ WEBHOOK_BASIC_USER: 'pingone', WEBHOOK_BASIC_PASSWORD: pw }), { basic: { user: 'pingone', password: pw }, header: null });
  assert.deepEqual(webhookAuthFrom({ WEBHOOK_HEADER_NAME: 'X-Webhook-Key', WEBHOOK_HEADER_VALUE: pw }), { basic: null, header: { name: 'x-webhook-key', value: pw } });
  assert.ok(webhookAuthFrom({ WEBHOOK_BASIC_USER: 'u', WEBHOOK_BASIC_PASSWORD: pw, WEBHOOK_HEADER_NAME: 'x-k', WEBHOOK_HEADER_VALUE: pw }).basic);
  for (const bad of [{}, { WEBHOOK_BASIC_USER: 'u', WEBHOOK_BASIC_PASSWORD: 'short' }, { WEBHOOK_BASIC_USER: 'bad user', WEBHOOK_BASIC_PASSWORD: pw }, { WEBHOOK_BASIC_PASSWORD: pw },
    { WEBHOOK_HEADER_NAME: 'Authorization', WEBHOOK_HEADER_VALUE: pw }, { WEBHOOK_HEADER_NAME: 'x-lab-hops', WEBHOOK_HEADER_VALUE: pw }, { WEBHOOK_HEADER_NAME: 'bad name', WEBHOOK_HEADER_VALUE: pw }, { WEBHOOK_HEADER_NAME: 'x-k', WEBHOOK_HEADER_VALUE: 'short' }, { WEBHOOK_BASIC_USER: 'u', WEBHOOK_BASIC_PASSWORD: `${pw}\nx` }]) assert.equal(webhookAuthFrom(bad), null, JSON.stringify(bad));
});

test('the page credential is separate and has its own settings', () => {
  assert.deepEqual(uiAuthFrom({ UI_BASIC_USER: 'viewer', UI_BASIC_PASSWORD: 'twelve-chars-or-more' }), { user: 'viewer', password: 'twelve-chars-or-more' });
  assert.equal(uiAuthFrom({ WEBHOOK_BASIC_USER: 'u', WEBHOOK_BASIC_PASSWORD: 'twelve-chars-or-more' }), null, 'the webhook credential is not the page credential');
  assert.equal(uiAuthFrom({ UI_BASIC_USER: 'viewer', UI_BASIC_PASSWORD: 'short' }), null);
});

test('the Secret template\'s REPLACE-ME placeholders are never accepted as credentials', () => {
  assert.equal(webhookAuthFrom({ WEBHOOK_BASIC_USER: 'REPLACE-ME-webhook-user', WEBHOOK_BASIC_PASSWORD: 'a-long-enough-password-1' }), null);
  assert.equal(webhookAuthFrom({ WEBHOOK_BASIC_USER: 'pingone', WEBHOOK_BASIC_PASSWORD: 'REPLACE-ME-a-long-random-webhook-password' }), null);
  assert.equal(uiAuthFrom({ UI_BASIC_USER: 'viewer', UI_BASIC_PASSWORD: 'replace-me-a-long-random-page-password' }), null);
  assert.equal(hostedProblems({ PEV_HOSTED: '1', WEBHOOK_BASIC_USER: 'REPLACE-ME-u', WEBHOOK_BASIC_PASSWORD: 'REPLACE-ME-a-long-random-password', UI_BASIC_USER: 'REPLACE-ME-u', UI_BASIC_PASSWORD: 'REPLACE-ME-a-long-random-password' }).length, 2);
});

test('hosted fails closed: both credentials are required, and the problem names the setting, never a value', () => {
  assert.deepEqual(hostedProblems({}), []); assert.equal(hostedFrom({ PEV_HOSTED: '1' }), true); assert.equal(hostedFrom({ PEV_HOSTED: 'true' }), false);
  const none = hostedProblems({ PEV_HOSTED: '1' });
  assert.equal(none.length, 2); assert.match(none[0], /WEBHOOK_BASIC_USER/); assert.match(none[1], /UI_BASIC_USER/);
  const pw = 'twelve-chars-or-more';
  assert.equal(hostedProblems({ PEV_HOSTED: '1', WEBHOOK_BASIC_USER: 'a', WEBHOOK_BASIC_PASSWORD: pw }).length, 1);
  assert.deepEqual(hostedProblems({ PEV_HOSTED: '1', WEBHOOK_HEADER_NAME: 'x-k', WEBHOOK_HEADER_VALUE: pw, UI_BASIC_USER: 'v', UI_BASIC_PASSWORD: pw }), []);
  assert.ok(!hostedProblems({ PEV_HOSTED: '1', WEBHOOK_BASIC_USER: 'a', WEBHOOK_BASIC_PASSWORD: 'secret-value-123' }).join().includes('secret-value-123'));
});
