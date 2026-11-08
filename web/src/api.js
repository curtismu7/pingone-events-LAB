import { workspaceFetch } from "./workspace";

export async function getJson(url) {
  const r = await workspaceFetch(url, { method: "GET" });
  if (!r.ok) {
    let detail = "";
    try { const b = await r.json(); detail = b.detail || b.error || ""; } catch { /* not JSON */ }
    const e = new Error(detail ? `${detail}` : `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// A write that answers with data on 2xx and on 4xx alike: the caller decides what a 409 means.
export async function postJson(url, payload) {
  const r = await workspaceFetch(url, { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

// POST /api/mode: the rule 19 Mock/Real toggle. 409 when Real is not configured.
export const setMode = (source) => postJson("/api/mode", { source });
export const playScenario = (name) => postJson("/api/mock/play", { name });
export const setDelivery = (scenario) => postJson("/api/mock/delivery", { scenario });
export const setSinkScenario = (scenario) => postJson("/api/sink/scenario", { scenario });
export const setForwarding = (enabled, confirm = false) => postJson("/api/sink", confirm ? { enabled, confirm: true } : { enabled });
export const testSink = () => postJson("/api/sink/test", {});
export const pullPingOne = () => postJson("/api/pull", {});
export const resetWorkspace = () => workspaceFetch("/api/reset", { method: "POST", body: "{}" }).then((r) => r.ok);
export const getEvents = ({ limit = 50, eventType = "", actorId = "", status = "" } = {}) => {
  const q = new URLSearchParams({ limit: String(limit) });
  if (eventType) q.set("eventType", eventType); if (actorId) q.set("actorId", actorId); if (status) q.set("status", status);
  return getJson(`/api/events?${q}`);
};

// The Mock "Send test webhook" button: a real HTTP POST to this app's own receiver (the same handler PingOne would call), asking for the hops.
export async function sendTestWebhook(activity) {
  const r = await workspaceFetch("/webhook/pingone-events", { method: "POST", headers: { "x-lab-hops": "1" }, body: JSON.stringify([activity]) });
  const type = r.headers.get("content-type") || "";
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* html or empty */ }
  return { status: r.status, type, text: text.slice(0, 400), body };
}
