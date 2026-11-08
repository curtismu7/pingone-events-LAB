# Safety notes

What this app does and does not do, in the order a reviewer asks.

## Local (the Docker standalone and `./scripts/run.sh`)
- Binds loopback only (`127.0.0.1:7802`). Docker publishes on `127.0.0.1` only. Host check on every request; writes must be same-origin.
- **Mock makes no outbound call.** The runtime netguard refuses every non-loopback socket, DNS lookup, fetch and UDP send, and Mock mode empties its allow-list, so even a coding mistake cannot leave the machine. A test asserts zero attempts across the Mock flows, including the pretend-cluster failure scenarios.
- **Real contacts only named hosts**, and only when you press a button or turn a switch: the PingOne API hosts for your region (read-only pull: one token request, then two GETs) and the one Elasticsearch / OpenSearch address you configure (forwarding, off until you turn it on and confirm). Redirects are refused, every call has a timeout and a size cap, and the cluster address must be `https` (plain `http` only on loopback) and may not be a link-local or metadata address.
- Secrets are write-only: read from the settings file, used inside the client that needs them, never returned by any API and never logged; every error message is scrubbed of every configured secret before it leaves.
- Everything an event contains is rendered as text. Nothing is executed or injected as markup.

## The webhook receiver
- It answers HEAD (PingOne's connection check) and POST on `/webhook/pingone-events` and `/webhook/pingone`. Any other method is `405`, never the web page (a page answering 200 would make PingOne record success while discarding events: the trap the Delivery tab teaches).
- Bounded: 256 KB body, 100 events per delivery, a per-address rate limit, a 1000-event ring buffer, an event that repeats (same id) is ignored.
- PingOne does not sign the body. On a hosted deployment the receiver requires PingOne's credential (HTTP Basic and/or a static header, compared in constant time) and checks it **before** reading the body. Anyone who holds the credential can post an event. Without a configured credential a hosted deployment does not start.

## Hosted (SE cluster): owner-approved exception, 2026-11-07
- The same image runs on the SE cluster with `PEV_HOSTED=1` so PingOne's cloud can reach the webhook. This is an exception, for this one app, to the "no hosted standalone apps" rule (2026-11-02) and to the mock-only SE build rule. Nothing is exposed from a laptop.
- Real PingOne events carry user ids, IP addresses and user agents, so the page and every `/api` route except `/api/health` sit behind HTTP Basic, with a credential separate from the webhook's. Both come from a Kubernetes Secret, never the repo. A value that still says `REPLACE-ME` is refused.
- Fails closed: a missing or too-short credential stops the process with a message naming the setting.
- Hosted never trusts the `Host` header to decide who is calling (an ingress may rewrite it).

## What is not proven
Forwarding to a real cluster, the PingOne Management API subscription shape, and the SE deployment itself have not been run against live systems by the people who built this lab. Mock proves the shape of what would be sent and how failures are handled.
