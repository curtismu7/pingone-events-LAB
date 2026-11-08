// The story as DATA: title, banners, scenarios, facts (each labelled measured / inferred / UNVERIFIED), talk track and the setup text.
// {{castBrand}}, {{castAgentId}}, {{castClientId}}, {{castHost}} are filled from the vertical pack (cast.js); a test fails on an undefined token.
// Hosts in this file are placeholders or .example only. Nothing here names a real tenant, host or cluster.

export const TITLE = 'PingOne Events Lab';
export const INTRO = 'See what PingOne tells you about itself: a webhook subscription delivers activity events to this app, the page shows them, and each one can also be forwarded to your Elasticsearch or OpenSearch so Kibana can chart it. Mock shows the whole path, including the ways it breaks, with nothing leaving this machine.';
export const BANNER = 'SIMULATED: synthetic PingOne events, a pretend webhook subscription and a pretend cluster. Nothing here is sent to PingOne or to any Elasticsearch or OpenSearch cluster.';
export const REAL_BANNER = 'REAL: events PingOne delivered to this app, and what you pulled read-only from the PingOne API. Forwarding to your cluster is a WRITE to a system you own and stays OFF until you turn it on. Real forwarding is UNVERIFIED against a live cluster.';
export const TOKEN_LABEL = 'MOCK events and MOCK identifiers: for education, never real product output';

export const SCENARIOS = [
  { id: 'follow-a-signin', kind: 'events', title: 'Follow one sign-in', play: 'signin-success', lesson: '{{castBrand}}\'s app ({{castClientId}}) starts a flow, the password check passes, access is allowed and a session is created. Four events share ONE correlation id: that id, not the clock, is how you join them.', expect: { types: ['FLOW.CREATED', 'PASSWORD.CHECK_SUCCEEDED', 'USER.ACCESS_ALLOWED', 'SESSION.CREATED'] } },
  { id: 'failed-password', kind: 'events', title: 'Two failed passwords, then denied', play: 'failed-password', lesson: 'Failed attempts arrive as their own events with a FAILED status. Filter the table by status FAILED to see only the trouble. (Event names in this scenario are illustrative: UNVERIFIED.)', expect: { types: ['PASSWORD.CHECK_FAILED', 'USER.ACCESS_DENIED'] } },
  { id: 'step-up', kind: 'events', title: 'A second factor is asked for', play: 'mfa-step-up', lesson: 'A flow that needs more than a password updates, challenges a device and updates the session. (Event names in this scenario are illustrative: UNVERIFIED.)', expect: { types: ['FLOW.UPDATED', 'DEVICE_AUTHENTICATION.SUCCEEDED'] } },
  { id: 'flow-lifecycle', kind: 'events', title: 'A flow is created, updated and deleted', play: 'flow-lifecycle', lesson: 'Most of a busy feed is plumbing like this. It matters when you ask "how many sign-ins?": count the right event type, not the rows.', expect: { types: ['FLOW.CREATED', 'FLOW.DELETED'] } },
  { id: 'session-noise', kind: 'events', title: 'Session updates dominate', play: 'session-update', lesson: 'On a real tenant session updates were the largest group by far. A table sorted by time buries the interesting events: filter by type.', expect: { types: ['SESSION.UPDATED', 'SESSION.DELETED'] } },
  { id: 'risk-event', kind: 'events', title: 'A risk evaluation', play: 'risk-evaluation', lesson: 'A risk result is an event like any other, so it can be forwarded and alerted on. (Event names in this scenario are illustrative: UNVERIFIED.)', expect: { types: ['RISK_EVALUATION.COMPLETED'] } },
  { id: 'receiver-down', kind: 'delivery', title: 'The receiver answers 503', delivery: 'receiver_503', lesson: 'If this app (or the ingress in front of it) is down, PingOne records the delivery as FAILED and nothing arrives. Switch the scenario, press Send test webhook, and compare what PingOne would record with what the app stored.', expect: { types: [] } },
  { id: 'silent-discard', kind: 'delivery', title: 'The site answers 200 with a web page', delivery: 'spa_html', lesson: 'The trap: a destination that serves the single-page app returns 200 OK with HTML. PingOne records SUCCESS, the events are thrown away, and nothing looks wrong. The only tell is that the number PingOne says it delivered and the number stored here do not match. (Inferred, not re-tested: see the facts on the Setup tab.)', expect: { types: [] } },
  { id: 'cluster-throttled', kind: 'sink', title: 'The cluster says 429 (too many requests)', sink: 'throttled', lesson: 'Forwarding is queued and retried with backoff, then counted as failed. The webhook answer to PingOne is never affected, and the events are still on this page.', expect: { types: [] } },
  { id: 'cluster-unavailable', kind: 'sink', title: 'The cluster says 503', sink: 'unavailable', lesson: 'Same handling as 429: capped retries, a visible failed counter, and a bounded queue that drops the oldest event (and counts it) rather than growing without limit.', expect: { types: [] } },
  { id: 'cluster-unreachable', kind: 'sink', title: 'The cluster cannot be reached', sink: 'unreachable', lesson: 'A refused connection is retried too. A down Elasticsearch must never break the receiver or the page, and this scenario proves it: keep sending events and watch the counters, not the page.', expect: { types: [] } },
];

// Every fact has a status. `measured` stays within what its source says; do not upgrade one without re-reading the source.
export const FACTS = [
  { id: 'schema', status: 'measured', text: 'A real PingOne delivery uses the "Ping Activity" schema: id, recordedAt, correlationId, action.type, actors (user and client, each with an environment), resources[] and result.status. The parser reads exactly those fields.', source: 'Events seen on one tenant\'s local feed, 2026-11-07 (FLOW.CREATED, FLOW.UPDATED, FLOW.DELETED, SESSION.CREATED, SESSION.UPDATED, SESSION.DELETED, USER.ACCESS_ALLOWED, USER.UPDATED, PASSWORD.CHECK_SUCCEEDED).' },
  { id: 'env-on-actor', status: 'inferred', text: 'The environment id is read off the actor, because `_embedded` is an empty object on real deliveries; a top-level `type` is what hand-written curls use and does not exist on real events.', source: 'Written down in the older AI-DEMO2 webhook notes (2026-08); not re-tested here.' },
  { id: 'head-first', status: 'inferred', text: 'PingOne sends a HEAD request before it will POST (that is what the console\'s Test Connection sends), so the receiver answers HEAD with 200.', source: 'Older AI-DEMO2 webhook notes; not re-tested here.' },
  { id: 'activities-limit', status: 'measured', text: 'The Activities API refuses a limit above 500 ("greater than the allowed maximum limit of 500") and accepts the filter recordedat ge "<ISO time>".', source: 'Read-only query on one tenant, 2026-11-07.' },
  { id: 'status-fields', status: 'measured', text: 'A subscription reports connectionStatus with status, lastAttemptedAt, lastSuccessfulAt, lastResponseCode and lastResponseDetails.', source: 'Read-only query on one tenant, 2026-11-07.' },
  { id: 'failed-activity', status: 'measured', text: 'A failed delivery is itself an activity: EVENT_DELIVERY.FAILED with a SUBSCRIPTION resource and the description "Connection attempt failed with error: 503". 24 of them appeared in 36 hours for one subscription whose destination answered 503.', source: 'Read-only query on one tenant, 2026-11-07.' },
  { id: 'retry-rhythm', status: 'inferred', text: 'After a failure PingOne retried about every 10 minutes and reported SUCCESS on its first attempt after the destination came back.', source: 'The attempt times seen on one subscription, 2026-11-07; one tenant, not a documented guarantee.' },
  { id: 'pull-gap', status: 'measured', text: 'The Activities API did NOT contain FLOW.* or SESSION.* events that the webhook delivered in the same period. The pull is useful for delivery health and audit-style activity, not a replacement for the webhook.', source: 'Compared on one tenant over 36 hours, 2026-11-07; may differ on yours.' },
  { id: 'silent-discard', status: 'inferred', text: 'A destination that answers 200 with a web page makes PingOne record SUCCESS while the events are discarded. The first half is inferred: PingOne reported the status 2xx and "Connection attempt successful" when this app answered 200 JSON, and a 2xx is all the status field shows. The HTML case itself has NOT been re-tested.', source: 'The subscription status fields seen on one tenant, 2026-11-07, plus the older AI-DEMO2 webhook notes, which describe a web page being returned with HTTP 200 and recorded as a success. Not reproduced here.' },
  { id: 'es-bulk', status: 'UNVERIFIED', text: 'Forwarding uses the bulk API (POST /_bulk, ndjson) with the event id as the document _id, so a redelivery overwrites the same document. This matches the public Elasticsearch and OpenSearch API descriptions but has NOT been run against a live cluster by the people who built this lab.', source: 'Not tested: agents never use live systems.' },
  { id: 'es-429', status: 'UNVERIFIED', text: 'A cluster under load answers 429 and a node going away answers 503 or refuses the connection; the sink retries all three. The exact body text varies by version and is not parsed beyond the status code.', source: 'Not tested against a live cluster.' },
  { id: 'kibana', status: 'UNVERIFIED', text: 'A Kibana (or OpenSearch Dashboards) data view on pingone-events* with @timestamp as the time field will show the forwarded documents. The raw activity is stored but not indexed, so searches use the flat fields.', source: 'Not tested against a live cluster.' },
];

export const TALK_TRACK = [
  { id: 'say-first', title: 'Say this first', say: 'PingOne can tell you everything that happens in your environment, but only if something is listening. A webhook subscription is PingOne knocking on a door you choose. This lab is that door, and a way to see what comes through it.' },
  { id: 'receive', title: 'What a delivery looks like', say: 'Each event is one JSON object with a type, who did it, what it touched and the result. The receiver stores every one, answers PingOne straight away, and ignores a repeat of an event it already has, so a retry never shows twice.' },
  { id: 'join', title: 'Follow a sign-in', say: 'One sign-in is several events. They do not arrive in a neat row; they share a correlation id. Click an event and look for it in the raw JSON.' },
  { id: 'health', title: 'Delivery health', say: 'PingOne keeps a status for each subscription: when it last tried, when it last succeeded, and what the door answered. A 503 means the door was shut.' },
  { id: 'silent', title: 'The silent failure', say: 'The worst failure is not an error. If the address serves a web page, PingOne gets 200 OK and records success while every event is thrown away. Compare the two numbers: what PingOne says it delivered, and what this app stored. This is inferred from PingOne\'s own status fields and older notes, not re-tested here.' },
  { id: 'pull', title: 'Pull is not the same feed', say: 'You can also ask PingOne for its activity list. That is handy for delivery health, but on the tenant we measured it did not contain the sign-in flow and session events the webhook carries. Use it to check on the webhook, not to replace it.' },
  { id: 'forward', title: 'Forward to Elasticsearch', say: 'Each stored event can also be sent to your own Elasticsearch or OpenSearch so Kibana can chart it. That is a write to your system, so it is off until you switch it on, and it never slows the answer to PingOne. If the cluster is down, the page keeps working and a counter shows what was lost.' },
  { id: 'kibana', title: 'In Kibana', say: 'Create a data view on pingone-events*, use @timestamp as the time field, and search by eventType, actorId, status or correlationId. The full original event is kept under raw.' },
  { id: 'unverified', title: 'What is not proven', say: 'Mock proves the shape of what would be sent and how failures are handled. Forwarding to a real cluster has not been run against one by the people who built this lab. Treat it as unverified until you have seen a document arrive.' },
];

export const DELIVERY_SCENARIOS = {
  healthy: { id: 'healthy', title: 'Healthy', pingoneSees: 'HTTP 200 JSON', appDoes: 'parses and stores every event', explain: 'PingOne records SUCCESS and the app stores the events: the two counts agree.' },
  receiver_503: { id: 'receiver_503', title: 'Receiver returns 503', pingoneSees: 'HTTP 503', appDoes: 'nothing: the door is shut, no event is stored', explain: 'PingOne records FAILED ("Connection attempt failed with error: 503") and retries later. Nothing is lost on PingOne\'s side yet, but nothing reaches you until the door opens.' },
  spa_html: { id: 'spa_html', title: 'Site answers 200 with a web page', pingoneSees: 'HTTP 200 text/html', appDoes: 'nothing: the page is returned instead of the receiver, so the events are discarded', explain: 'PingOne records SUCCESS. The events are gone. The only sign is the mismatch between "PingOne says delivered" and "stored here". INFERRED, not re-tested: this lab shows what would be seen if PingOne treats every 2xx as delivered.', fact: 'silent-discard' },
};

export const SINK_SCENARIO_TEXT = {
  healthy: 'Every document is indexed.',
  throttled: 'The cluster answers 429. Each batch is retried with backoff, then counted as failed.',
  unavailable: 'The cluster answers 503. Same handling.',
  unreachable: 'The connection is refused. Same handling.',
};

// The Setup panel. Placeholders only: the SE host, the credentials and your cluster address are yours to fill in.
export const SETUP = {
  webhook: {
    destination: 'https://<se-host>/webhook/pingone-events',
    note: 'Both /webhook/pingone-events and /webhook/pingone reach the same receiver. On the SE cluster the public path is /webhook/pingone-events on the existing demo host; the page itself lives on its own host and asks for its own password.',
    fields: [
      ['Destination URL', 'https://<se-host>/webhook/pingone-events'],
      ['Basic authentication', 'Username and password: the webhook credential you put in the Kubernetes Secret (WEBHOOK_BASIC_USER / WEBHOOK_BASIC_PASSWORD). A custom static header works instead or as well (WEBHOOK_HEADER_NAME / WEBHOOK_HEADER_VALUE).'],
      ['Event Schema', 'Ping Activity (the parser reads action.type, actors, result, resources, recordedAt)'],
      ['Payload Limit', 'Limit by Events, 1 (at the default 500 nothing appears until a batch fills; batches still work)'],
      ['JSON Format', 'JSON array'],
      ['TLS', 'Verify certificates ON: leave "Allow TLS with untrusted certificates" unchecked'],
      ['Test Connection', 'Sends HEAD with your credential; the receiver answers 200. Without the credential it answers 401, which is correct.'],
    ],
    managementApi: {
      method: 'POST',
      url: 'https://<management-api-host>/v1/environments/<environment-id>/subscriptions',
      body: {
        name: 'PINGONE-EVENTS-LAB',
        enabled: true,
        format: 'ACTIVITY',
        protocol: 'HTTPS',
        httpEndpoint: { url: 'https://<se-host>/webhook/pingone-events', headers: { Authorization: 'Basic <base64 of webhook-user:webhook-password>' } },
        filterOptions: { includedActionTypes: ['FLOW.CREATED', 'FLOW.UPDATED', 'FLOW.DELETED', 'SESSION.CREATED', 'SESSION.UPDATED', 'SESSION.DELETED', 'USER.ACCESS_ALLOWED', 'PASSWORD.CHECK_SUCCEEDED'] },
        verifyTlsCertificates: true,
      },
      note: 'The management API host is the one for your PingOne region. UNVERIFIED shape: the field names name, enabled, format, protocol, httpEndpoint.url, filterOptions.includedActionTypes and verifyTlsCertificates were seen on a real subscription; where the credential goes (httpEndpoint.headers above) and the payload options were not confirmed. Check the PingOne Management API reference, or use the console fields above.',
    },
    safety: 'The receiver requires PingOne\'s credential, compared in constant time, and a hosted deployment will not start without one. PingOne does not sign the body, so anyone who holds the credential can post an event: keep it in a Kubernetes Secret, rotate it if it leaks. The app also bounds what it accepts (body size, events per delivery, rate per address, store size) and renders everything as text, but it cannot tell a real event from a forged one sent with the right credential.',
    local: 'Run locally, this app cannot receive PingOne deliveries: PingOne\'s cloud cannot reach a laptop, and nothing is exposed from it. Mock shows the whole path; Real locally can still pull, read-only, and forward to your cluster.',
  },
  settings: [
    ['Real pull (read-only)', 'PINGONE_ENVIRONMENT_ID, PINGONE_REGION, PINGONE_CLIENT_ID, PINGONE_CLIENT_SECRET (a worker app that can read subscriptions and activities)'],
    ['Public webhook host', 'WEBHOOK_ALLOWED_HOSTS (comma-separated host names PingOne posts to; those hosts may reach the two webhook paths and nothing else)'],
    ['Webhook credential (hosted: required)', 'WEBHOOK_BASIC_USER + WEBHOOK_BASIC_PASSWORD, and/or WEBHOOK_HEADER_NAME + WEBHOOK_HEADER_VALUE (12+ characters)'],
    ['Page credential (hosted: required)', 'UI_BASIC_USER + UI_BASIC_PASSWORD (a different credential from the webhook\'s; the health endpoint stays open for probes)'],
    ['Forward to Elasticsearch / OpenSearch', 'ELASTICSEARCH_URL, then ELASTICSEARCH_API_KEY or ELASTICSEARCH_USERNAME + ELASTICSEARCH_PASSWORD; ELASTICSEARCH_INDEX is optional (default pingone-events)'],
    ['Where', 'Locally: the shared settings file (~/Development/.env; STANDALONE_ENV overrides it). On SE: a Kubernetes Secret (k8s/secret.example.yaml is the template). Secrets are write-only: no page or API returns them and nothing logs them.'],
  ],
  elasticsearch: {
    indexTemplateFile: 'docs/elasticsearch-index-template.json',
    indexTemplateCurl: 'curl -X PUT "<your-cluster-url>/_index_template/pingone-events" -H "Authorization: ApiKey <your-api-key>" -H "Content-Type: application/json" --data-binary @docs/elasticsearch-index-template.json',
    why: 'Run this once yourself. The app never creates or changes anything on your cluster. The template makes @timestamp a date, the ids and event type keywords, and stores the raw activity without indexing it.',
    kibana: [
      'In Kibana (or OpenSearch Dashboards) open Stack Management > Data Views (Index Patterns) and create a data view named pingone-events*.',
      'Choose @timestamp as the time field.',
      'Useful fields: eventType, status, actorId, actorType, correlationId, environmentId, resource, via. Add them as columns in Discover.',
      'Saved search to create: "Failures" with the query status : "FAILED" (or eventType : PASSWORD.CHECK_FAILED), sorted by @timestamp.',
      'To follow one sign-in, filter by one correlationId and sort ascending.',
    ],
  },
};
