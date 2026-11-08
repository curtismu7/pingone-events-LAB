# PingOne Events Lab

**Tier: Demo.** Standalone app (local Docker on OrbStack, port 7802) that shows what PingOne tells you about itself through a webhook subscription, how to tell whether the webhook is really working, and how to forward each event to your own Elasticsearch or OpenSearch so Kibana can chart it.

It is the standalone version of the PingOne events page in AI-DEMO2 (read-only source; nothing is imported). Scaffold copied from observability-LAB (shell, safety, netguard, workspaces, story and diagram plumbing); the events, receiver, delivery health, sink and hosting are new. Catalog id D124 is provisional until the owner confirms it.

> **Exception recorded 2026-11-07 (owner):** this one app ALSO runs on the SE cluster, in Real mode, from the same image, so PingOne's cloud can reach the webhook. That is an exception to the "no hosted standalone apps" rule (2026-11-02) and to the mock-only SE build rule. The local Docker standalone is unchanged. Nothing is exposed from a laptop. See [docs/safety.md](docs/safety.md).

## What you can do in it
- **Events**: the newest events, filter by type, actor or status, click one for its raw JSON. Mock scenarios (a sign-in, failed passwords, a step-up, session noise, a risk result) arrive through the **same receiver and parser** as a real delivery, and a **Send test webhook** button posts to the app's own receiver.
- **Delivery**: PingOne's view of a subscription (status, last attempt, last success, last response) next to the app's view (what was stored). Mock switches the door between healthy, `503`, and **200 with a web page**: the silent discard, where PingOne records success while every event is thrown away and only a count mismatch gives it away. Real: a read-only **pull** of your subscriptions' delivery status and the last 36 hours of activity.
- **Forward**: send each stored event to your Elasticsearch / OpenSearch bulk API (event id as document id, so retries are idempotent), after PingOne has been answered, through a bounded queue with capped retries. It is **off by default**; in Real it needs the target configured and an explicit confirm. Mock shows exactly what would be sent and lets you break the pretend cluster (429, 503, unreachable) to watch the same code cope.
- **Pipeline**, **Setup** (the PingOne console fields, the Management API shape, the index template, a Kibana how-to, labelled facts) and **Talk track**.

## Run it
```sh
./scripts/run.sh                      # host: install, build, preflight, start  ->  http://localhost:7802/
HOST_PORT=7802 docker compose up --build -d     # OrbStack: published on 127.0.0.1 only
npm test                              # server (node --test), web (vitest), scripts (node --test)
npm run doctor                        # preflight; the same checks GET /api/health reports from
# The tests need no web build and no settings file: they run on a fresh clone (npm ci && npm test). With no web build the server still
# starts; the API, the webhook and /api/health work, and every other path answers 404 JSON {"error":"web_not_built"}.
npm run reset                         # Reset a running app's default workspace (the one the browser uses); Real events are kept
```
Mock needs nothing. Real settings come from the shared settings file (`~/Development/.env`; `STANDALONE_ENV` overrides): `PINGONE_ENVIRONMENT_ID`, `PINGONE_REGION`, `PINGONE_CLIENT_ID`, `PINGONE_CLIENT_SECRET` for the pull, `ELASTICSEARCH_URL` plus `ELASTICSEARCH_API_KEY` (or user and password) for forwarding. Real is on by default only when configured, and the header toggle switches back and forth at runtime.

Run locally, the app cannot receive PingOne deliveries (PingOne's cloud cannot reach a laptop). Use Mock to see the whole path, the pull to read delivery health, or the SE deployment for the real thing.

## SE deployment (hosted)
Manifests, a Secret template and `k8s/deploy.sh` are in [k8s/](k8s/); see [k8s/README.md](k8s/README.md). Build only: nothing here deploys itself, pushes an image or touches a cluster. PingOne's destination is `https://<se-host>/webhook/pingone-events` with Basic authentication; the page is on its own host behind a separate password.

Hosted behaves differently from local in ways that matter:
- **Fails closed.** Any `PEV_HOSTED` value except an explicit falsy one (`""`, `0`, `false`, `no`, `off`) means hosted. Hosted will not start without a webhook credential and a different page credential (each at least 12 characters, not whitespace, not a `REPLACE-ME` placeholder), or with a placeholder in any setting, or with half-set or invalid PingOne / Elasticsearch settings.
- **The receiver is always Real.** A caller holding PingOne's credential is answered as a Real receiver and stored in the Real store whatever any viewer does with the toggle; the toggle there is per workspace and only changes what that viewer sees.
- **Authenticate first.** The credential is checked before the body is read. A request that fails goes into a small per-address bucket of its own (`PEV_WEBHOOK_UNAUTH_RPM`, default 30 a minute); a valid one has a separate, larger bucket (`PEV_WEBHOOK_RPM`, 600 on SE). A flood of bad requests cannot use up PingOne's allowance. `429` carries `Retry-After`.
- **The client address comes from one trusted proxy hop** (`PEV_TRUST_PROXY_HOPS`, 1 when hosted): the right-most `X-Forwarded-For` entry, the one the ingress appended. A client cannot choose its own rate-limit bucket by writing to the left of it. **The SE ingress must set or append `X-Forwarded-For`** (nginx-ingress does by default); if it ever stops, every caller looks like the ingress and shares one bucket (it fails safe, not open).

## Durability, honestly
Events are written to one JSON file within 50 ms of arriving (`PERSIST_DELAY_MS`), atomically, and flushed on SIGTERM. A **SIGKILL (or power loss) inside that 50 ms window loses the newest events**: a write per event would cost far more, and PingOne retries only what it was not given a 2xx for. If a write fails it is **counted and shown** (Delivery tab, `/api/info`, `/api/events` notice), the receiver's answer says `durability: "failing"`, and `GET /api/health` reports `state: "broken"` (the health contract allows no extra fields) until a write succeeds. A corrupt events file is moved aside to `events.json.corrupt-<time>` (never overwritten) and the notice clears after the first good write.

## Known items
- **Dev-only advisories.** `npm audit` reports 3 (1 moderate, 2 critical) in the test toolchain: vitest, tinypool and @vitest/mocker. The fix is a major vitest upgrade (`--force`), which is out of scope here. `npm audit --omit=dev` (production dependencies) reports 0 and runs in CI.
- **The pipeline diagram is this app's own `diagram-studio/1` file** (`server/diagrams/event-pipeline.json`), loaded by name and checked with a copy of the studio's validator (and its `wire.js`, re-copied from curtismu7/diagram-studio-LAB main on 2026-11-07). It is not fetched from the shared diagram-studio at run time: a standalone app must work offline, and the studio has no run-time API for other apps. Rule 17 asks for data, not a hand-built node list; that is what this is.
- **Event ordering** is by arrival time, never by the sender's `recordedAt` (which is shown, and replaced by the arrival time if it is outside 2000 to one day ahead).

## Honest scope
- **UNVERIFIED**: forwarding to a real Elasticsearch / OpenSearch, the Kibana how-to, the PingOne Management API subscription shape, and the SE deployment have not been run against live systems by the people who built this (agents never use live systems). Mock proves the shape of what would be sent and how failures are handled, nothing more.
- Measured on one tenant, 2026-11-07: the event schema fields, the Activities API limit of 500, the subscription status fields, that failed deliveries are themselves activities, and that the Activities API did **not** contain the flow and session events the webhook delivered. Each fact in the app carries its label.
- Event names in the failed-password, step-up and risk scenarios are illustrative (UNVERIFIED).
- The page loads Montserrat from Google Fonts like the sibling labs; that is the browser, not the app process, and it can be removed for a strictly offline page.

## Rules it follows
Loopback bind, same-origin writes, netguard (zero outbound in Mock; named hosts only in Real), one port (7802), `GET /api/health` = `demo-health/1`, rule 19 Mock/Real toggle (`POST /api/mode {source}`, `409` when Real is not configured), workspace id for Mock state, W3C `traceparent` on hops, diagram loaded by name from diagram-studio data, labelled facts, no real tenant ids, hostnames or secrets in the repo. Details in [CLAUDE.md](CLAUDE.md).
