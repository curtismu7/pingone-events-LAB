# Talk track

<!-- Generated from server/src/eventsData.js by `npm run talk-track`. Do not edit by hand. -->

## Say this first

PingOne can tell you everything that happens in your environment, but only if something is listening. A webhook subscription is PingOne knocking on a door you choose. This lab is that door, and a way to see what comes through it.

## What a delivery looks like

Each event is one JSON object with a type, who did it, what it touched and the result. The receiver stores every one, answers PingOne straight away, and ignores a repeat of an event it already has, so a retry never shows twice.

## Follow a sign-in

One sign-in is several events. They do not arrive in a neat row; they share a correlation id. Click an event and look for it in the raw JSON.

## Delivery health

PingOne keeps a status for each subscription: when it last tried, when it last succeeded, and what the door answered. A 503 means the door was shut.

## The silent failure

The worst failure is not an error. If the address serves a web page, PingOne gets 200 OK and records success while every event is thrown away. Compare the two numbers: what PingOne says it delivered, and what this app stored. This is inferred from PingOne's own status fields and older notes, not re-tested here.

## Pull is not the same feed

You can also ask PingOne for its activity list. That is handy for delivery health, but on the tenant we measured it did not contain the sign-in flow and session events the webhook carries. Use it to check on the webhook, not to replace it.

## Forward to Elasticsearch

Each stored event can also be sent to your own Elasticsearch or OpenSearch so Kibana can chart it. That is a write to your system, so it is off until you switch it on, and it never slows the answer to PingOne. If the cluster is down, the page keeps working and a counter shows what was lost.

## In Kibana

Create a data view on pingone-events*, use @timestamp as the time field, and search by eventType, actorId, status or correlationId. The full original event is kept under raw.

## What is not proven

Mock proves the shape of what would be sent and how failures are handled. Forwarding to a real cluster has not been run against one by the people who built this lab. Treat it as unverified until you have seen a document arrive.

## The scenarios

1. **Follow one sign-in.** Northwind Retail's app (orders-agent) starts a flow, the password check passes, access is allowed and a session is created. Four events share ONE correlation id: that id, not the clock, is how you join them.
2. **Two failed passwords, then denied.** Failed attempts arrive as their own events with a FAILED status. Filter the table by status FAILED to see only the trouble. (Event names in this scenario are illustrative: UNVERIFIED.)
3. **A second factor is asked for.** A flow that needs more than a password updates, challenges a device and updates the session. (Event names in this scenario are illustrative: UNVERIFIED.)
4. **A flow is created, updated and deleted.** Most of a busy feed is plumbing like this. It matters when you ask "how many sign-ins?": count the right event type, not the rows.
5. **Session updates dominate.** On a real tenant session updates were the largest group by far. A table sorted by time buries the interesting events: filter by type.
6. **A risk evaluation.** A risk result is an event like any other, so it can be forwarded and alerted on. (Event names in this scenario are illustrative: UNVERIFIED.)
7. **The receiver answers 503.** If this app (or the ingress in front of it) is down, PingOne records the delivery as FAILED and nothing arrives. Switch the scenario, press Send test webhook, and compare what PingOne would record with what the app stored.
8. **The site answers 200 with a web page.** The trap: a destination that serves the single-page app returns 200 OK with HTML. PingOne records SUCCESS, the events are thrown away, and nothing looks wrong. The only tell is that the number PingOne says it delivered and the number stored here do not match. (Inferred, not re-tested: see the facts on the Setup tab.)
9. **The cluster says 429 (too many requests).** Forwarding is queued and retried with backoff, then counted as failed. The webhook answer to PingOne is never affected, and the events are still on this page.
10. **The cluster says 503.** Same handling as 429: capped retries, a visible failed counter, and a bounded queue that drops the oldest event (and counts it) rather than growing without limit.
11. **The cluster cannot be reached.** A refused connection is retried too. A down Elasticsearch must never break the receiver or the page, and this scenario proves it: keep sending events and watch the counters, not the page.
