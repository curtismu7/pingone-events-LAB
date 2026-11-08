import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App, { BANNER_UNKNOWN } from "./App";
import { labelOffsets } from "./components/PatternDiagram";

const STORY = {
  title: "t", intro: "intro text", banner: "SIMULATED: synthetic PingOne events", realBanner: "REAL: events PingOne delivered", verticals: ["retail", "health"], cast: { castClientId: "orders-agent" },
  scenarios: [
    { id: "follow-a-signin", kind: "events", title: "Follow one sign-in", play: "signin-success", lesson: "One id is the join." },
    { id: "receiver-down", kind: "delivery", title: "The receiver answers 503", delivery: "receiver_503", lesson: "Door shut." },
    { id: "cluster-throttled", kind: "sink", title: "The cluster says 429", sink: "throttled", lesson: "Queued and retried." },
  ],
  facts: [{ id: "f1", status: "measured", text: "A measured fact.", source: "One tenant." }, { id: "f2", status: "UNVERIFIED", text: "A cluster claim.", source: "Not tested." }],
  talkTrack: [{ id: "say-first", title: "Say first", say: "Everything is simulated." }, { id: "silent", title: "The silent failure", say: "Compare the two numbers." }, { id: "forward", title: "Forward", say: "It is off until you switch it on." }],
  sinkScenarios: { healthy: "Every document is indexed.", throttled: "429 handling.", unavailable: "503 handling.", unreachable: "Refused." },
  setup: {
    webhook: { destination: "https://<se-host>/webhook/pingone-events", note: "Both paths work.", fields: [["Destination URL", "https://<se-host>/webhook/pingone-events"], ["Event Schema", "Ping Activity"]], managementApi: { method: "POST", url: "https://<management-api-host>/v1/x", body: { name: "PINGONE-EVENTS-LAB" }, note: "UNVERIFIED shape." }, safety: "Credential required.", local: "Not reachable from the cloud." },
    settings: [["Where", "A Kubernetes Secret"]],
    elasticsearch: { indexTemplateFile: "docs/elasticsearch-index-template.json", indexTemplateCurl: "curl -X PUT <your-cluster-url>/_index_template/pingone-events", why: "Run it yourself.", kibana: ["Create a data view named pingone-events*."] },
  },
};
const DIAGRAM = { title: "Event pipeline", intro: "diagram intro", nodes: [{ id: "a", label: "PingOne: activity stream", kind: "product", x: 0, y: 0 }, { id: "b", label: "Receiver", kind: "app", x: 300, y: 0 }], steps: [{ from: "a", to: "b", label: "event matches", say: "PingOne writes an activity." }] };
const ev = (i, over = {}) => ({ eventId: `e${i}`, eventType: "FLOW.CREATED", actorId: `00000000-0000-4000-8000-00000000000${i}`, actorType: "CLIENT", status: "SUCCESS", resource: "res-1", environmentId: "env-1", correlationId: "corr-1", timestamp: `2026-11-07T12:00:0${i}.000Z`, via: "mock", schema: "activity", raw: { action: { type: "FLOW.CREATED" } }, ...over });
const SINK = (over = {}) => ({ source: "mock", configured: true, hint: null, forwarding: false, confirmRequired: false, target: { host: "your-cluster.example", index: "pingone-events" }, scenario: "healthy", scenarios: ["healthy", "throttled", "unavailable", "unreachable"], status: { host: "your-cluster.example", index: "pingone-events", queued: 0, sent: 0, failed: 0, dropped: 0, retried: 0, lastError: null, lastErrorAt: null, lastSuccessAt: null, maxQueue: 1000, batchSize: 50, maxRetries: 3 }, preview: { method: "POST", url: "https://your-cluster.example/_bulk", contentType: "application/x-ndjson", events: 1, body: '{"index":{"_id":"e1"}}\n{"eventType":"FLOW.CREATED"}\n', note: "MOCK: this is what would be sent." }, template: "docs/elasticsearch-index-template.json", ...over });
const DELIVERY = (over = {}) => ({ source: "mock", scenario: "healthy", scenarios: { healthy: { id: "healthy", title: "Healthy", pingoneSees: "HTTP 200 JSON", appDoes: "stores", explain: "Counts agree." }, receiver_503: { id: "receiver_503", title: "Receiver returns 503", pingoneSees: "HTTP 503", appDoes: "nothing", explain: "FAILED." }, spa_html: { id: "spa_html", title: "Site answers 200 with a web page", pingoneSees: "HTTP 200 text/html", appDoes: "nothing", explain: "Silent." } }, subscription: { name: "EXAMPLE-SUBSCRIPTION", enabled: true, destination: "https://<se-host>/webhook/pingone-events", connectionStatus: { status: "SUCCESS", lastAttemptedAt: null, lastSuccessfulAt: null, lastResponseCode: "2xx", lastResponseDetails: "ok" } }, counters: { attempts: 2, acked: 2, refused: 0, stored: 2, duplicates: 0, lost: 0 }, ...over });

let calls; let override; let state;
function mockFetch() {
  calls = [];
  state = { mode: "mock", realAvailable: true, forwarding: false, scenario: "healthy", delivery: "healthy", events: [ev(1), ev(2, { eventType: "SESSION.UPDATED", status: "FAILED" })] };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    calls.push({ url, opts });
    const json = (body, status = 200, ctype = "application/json") => ({ ok: status < 400, status, headers: { get: (k) => (k.toLowerCase() === "content-type" ? ctype : null) }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
    const custom = override[url.split("?")[0]];
    if (custom) return custom(url, opts);
    if (url.startsWith("/api/scenarios")) return json(STORY);
    if (url === "/api/info") return json({ mode: state.mode, source: state.mode, simulated: state.mode === "mock", hosted: false, realAvailable: state.realAvailable, realHint: state.realAvailable ? null : "Real needs the PingOne settings" });
    if (url === "/api/mode") {
      const b = JSON.parse(opts.body);
      if (b.source === "real" && !state.realAvailable) return json({ error: "real_not_configured", detail: "Real needs the PingOne settings" }, 409);
      state.mode = b.source; return json({ source: b.source });
    }
    if (url.startsWith("/api/events")) {
      const q = new URL(url, "http://x").searchParams; const t = q.get("eventType") || "";
      const events = state.events.filter((e) => !t || e.eventType.includes(t));
      return json({ source: state.mode, count: state.events.length, capacity: 500, duplicates: 0, types: [{ type: "FLOW.CREATED", count: 1 }, { type: "SESSION.UPDATED", count: 1 }], events, workspace: "w" });
    }
    if (url === "/api/mock/play") { state.events = [...state.events, ev(3)]; return json({ played: JSON.parse(opts.body).name, status: 200, sent: 4, stored: 4 }); }
    if (url === "/api/mock/delivery") { state.delivery = JSON.parse(opts.body).scenario; return json({ scenario: state.delivery }); }
    if (url === "/webhook/pingone-events") return json({ received: true, count: 1, stored: 1, duplicates: 0, traceId: "a".repeat(32), hops: [{ n: 1, from: "sender", to: "receiver", label: "A delivery reaches the receiver", traceparent: `00-${"a".repeat(32)}-${"1".repeat(16)}-01`, request: "POST /webhook/pingone-events", response: "200: ok" }] });
    if (url === "/api/delivery") return json(state.mode === "real" ? { source: "real", receiver: { paths: ["/webhook/pingone-events", "/webhook/pingone"], publicHostConfigured: false, credentialConfigured: false, stored: 3, capacity: 1000, duplicates: 0 }, pull: { available: false, hint: "The PingOne pull needs the worker settings.", last: null } } : DELIVERY({ scenario: state.delivery }));
    if (url === "/api/sink" && opts.method === "POST") {
      const b = JSON.parse(opts.body);
      if (state.mode === "real" && b.enabled && b.confirm !== true) return json({ error: "confirm_required", detail: "Forwarding writes to your cluster." }, 400);
      state.forwarding = b.enabled; return json(SINK({ forwarding: b.enabled }));
    }
    if (url === "/api/sink") return json(state.mode === "real" ? SINK({ source: "real", forwarding: state.forwarding, confirmRequired: true, target: { host: "cluster.example", index: "pingone-events" }, scenario: null, scenarios: null }) : SINK({ forwarding: state.forwarding, scenario: state.scenario }));
    if (url === "/api/sink/scenario") { state.scenario = JSON.parse(opts.body).scenario; return json(SINK({ scenario: state.scenario, forwarding: state.forwarding })); }
    if (url === "/api/sink/test") return json({ source: "mock", ok: true, status: 200, cluster: "mock-cluster", version: "0.0.0-mock" });
    if (url === "/api/setup") return json({ receiverPaths: ["/webhook/pingone-events", "/webhook/pingone"], publicHostConfigured: false, hosted: false, indexTemplate: { index_patterns: ["pingone-events*"] } });
    if (url.startsWith("/api/diagram")) return json(DIAGRAM);
    if (url === "/api/reset") { state.events = []; return json({ reset: "ok" }); }
    return json({}, 404);
  });
}
beforeEach(() => { override = {}; mockFetch(); window.location.hash = ""; });
const ready = async () => { render(<App />); await screen.findByText("Follow one sign-in"); await screen.findByTestId("events-table"); };
const nav = (name) => userEvent.click(screen.getByRole("link", { name }));

describe("shell and rule 19 toggle", () => {
  it("shows the shell bar, the banner above the title, the mode, and sends X-Workspace on API calls", async () => {
    await ready();
    expect(document.querySelector("header.shell-bar .shell-brand")).not.toBeNull();
    expect(screen.getByTestId("banner")).toHaveTextContent(/^SIMULATED/);
    expect(screen.getByTestId("banner").compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("mode")).toHaveTextContent("Mock");
    expect(calls.find((c) => c.url.startsWith("/api/events")).opts.headers["x-workspace"]).toMatch(/^[a-z0-9-]{1,40}$/);
    expect(screen.getByRole("link", { name: "Events" })).toHaveAttribute("aria-current", "page");
  });

  it("the toggle reflects the mode (aria-pressed), switches both ways without a reload, reloads the data, and the banner follows", async () => {
    await ready();
    const mock = screen.getByTestId("mode-mock"); const real = screen.getByTestId("mode-real");
    expect(mock).toHaveAttribute("aria-pressed", "true"); expect(real).toHaveAttribute("aria-pressed", "false");
    const before = calls.filter((c) => c.url.startsWith("/api/events")).length;
    await userEvent.click(real);
    await waitFor(() => expect(screen.getByTestId("mode-real")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("banner")).toHaveTextContent(/^REAL/);
    expect(screen.getByTestId("banner")).toHaveAttribute("data-state", "live");
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith("/api/events")).length).toBeGreaterThan(before));
    expect(JSON.parse(calls.filter((c) => c.url === "/api/mode").at(-1).opts.body)).toEqual({ source: "real" });
    await userEvent.click(screen.getByTestId("mode-mock"));
    await waitFor(() => expect(screen.getByTestId("mode-mock")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("banner")).toHaveTextContent(/^SIMULATED/);
  });

  it("Real is disabled with a how-to tooltip when it is not configured", async () => {
    state.realAvailable = false;
    await ready();
    const real = screen.getByTestId("mode-real");
    expect(real).toBeDisabled(); expect(real).toHaveAttribute("title", expect.stringContaining("Real needs the PingOne settings"));
  });

  it("a 409 from the server leaves the mode alone and shows why", async () => {
    await ready();
    state.realAvailable = false; // the button was enabled when rendered; the server now refuses
    await userEvent.click(screen.getByTestId("mode-real"));
    expect(await screen.findByTestId("notice")).toHaveTextContent("Real needs the PingOne settings");
    expect(screen.getByTestId("mode-mock")).toHaveAttribute("aria-pressed", "true");
  });

  it("the banner stays visible on every tab, and says SIMULATED when the server cannot be read", async () => {
    await ready();
    for (const name of ["Delivery", "Forward", "Pipeline", "Setup", "Talk track", "Events"]) { await nav(name); expect(screen.getByTestId("banner")).toBeVisible(); }
  });
  it("when both calls fail, the banner says SIMULATED and stays visible", async () => {
    const dead = async () => ({ ok: false, status: 500, json: async () => ({}) });
    override["/api/info"] = dead; override["/api/scenarios"] = dead;
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(BANNER_UNKNOWN));
    expect(screen.getByTestId("banner")).toBeVisible();
  });
});

describe("events", () => {
  it("lists events newest first with chips, filters by type, and opens the raw JSON as text", async () => {
    await ready();
    expect(screen.getAllByTestId("event-row")).toHaveLength(2);
    expect(screen.getByTestId("count")).toHaveTextContent("2 shown of 2 stored (MOCK)");
    await userEvent.type(screen.getByTestId("f-type"), "SESSION");
    await userEvent.click(screen.getByTestId("refresh"));
    await waitFor(() => expect(screen.getAllByTestId("event-row")).toHaveLength(1));
    expect(calls.at(-1).url).toContain("eventType=SESSION");
    await userEvent.click(screen.getByRole("button", { name: "Open SESSION.UPDATED" }));
    const detail = await screen.findByTestId("event-detail");
    expect(within(detail).getByTestId("raw-json")).toHaveTextContent('"type": "FLOW.CREATED"');
    await userEvent.click(screen.getByTestId("close-detail"));
    expect(screen.queryByTestId("event-detail")).toBeNull();
  });

  it("hostile text in an event is rendered as text, never as markup", async () => {
    state.events = [ev(1, { eventType: "A.B", status: "<img src=x onerror=alert(1)>", actorId: "<script>alert(1)</script>", raw: { note: "<b>bold</b>‮evil" } })];
    await ready();
    expect(document.querySelector("img[src='x']")).toBeNull(); expect(document.querySelector("script")).toBeNull();
    expect(screen.getByTestId("events-table")).toHaveTextContent("<img src=x onerror=alert(1)>");
    await userEvent.click(screen.getByRole("button", { name: "Open A.B" }));
    expect(screen.getByTestId("raw-json").textContent).toContain("\\u202e");
    expect(document.querySelector("b")).toBeNull();
  });

  it("the picked scenario plays through the server and reloads the table", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("scenario-follow-a-signin"));
    expect(await screen.findByTestId("lesson")).toHaveTextContent("One id is the join.");
    await waitFor(() => expect(screen.getAllByTestId("event-row")).toHaveLength(3));
    expect(JSON.parse(calls.find((c) => c.url === "/api/mock/play").opts.body)).toEqual({ name: "signin-success" });
    expect(window.location.hash).toBe("#scenario-follow-a-signin");
  });

  it("delivery and sink scenarios set up their failure and move to the right tab", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("scenario-receiver-down"));
    expect(await screen.findByTestId("door")).toBeInTheDocument();
    expect(state.delivery).toBe("receiver_503");
    await nav("Events");
    await userEvent.click(await screen.findByTestId("scenario-cluster-throttled"));
    expect(await screen.findByTestId("forward-panel")).toBeInTheDocument();
    expect(state.scenario).toBe("throttled");
  });

  it("Send test webhook is a real POST to the receiver asking for hops, and shows the answer and the hops", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("send-test"));
    const sent = await screen.findByTestId("sent");
    expect(within(sent).getByTestId("sent-status")).toHaveTextContent("HTTP 200");
    expect(within(sent).getByTestId("hops")).toBeInTheDocument();
    const c = calls.find((x) => x.url === "/webhook/pingone-events");
    expect(c.opts.method).toBe("POST"); expect(c.opts.headers["x-lab-hops"]).toBe("1");
    const body = JSON.parse(c.opts.body); expect(Array.isArray(body)).toBe(true); expect(body[0].action.type).toBe("USER.ACCESS_ALLOWED"); expect(body[0].actors.client.environment.id).toBeTruthy();
  });

  it("a web page answering instead of the receiver is called out", async () => {
    override["/webhook/pingone-events"] = async () => ({ ok: true, status: 200, headers: { get: () => "text/html; charset=utf-8" }, text: async () => "<!doctype html><title>spa</title>" });
    await ready();
    await userEvent.click(screen.getByTestId("send-test"));
    expect(await screen.findByTestId("sent-html")).toHaveTextContent("A web page came back");
    expect(document.querySelector("title")?.textContent).not.toBe("spa");
  });

  it("Real mode: no scenarios, no test button, an honest empty state", async () => {
    state.mode = "real"; state.events = [];
    render(<App />);
    expect(await screen.findByTestId("real-note")).toBeInTheDocument();
    expect(screen.queryByTestId("scenarios")).toBeNull(); expect(screen.queryByTestId("send-test")).toBeNull();
    expect(await screen.findByTestId("empty")).toHaveTextContent(/PingOne delivers one/);
  });
});

describe("delivery", () => {
  it("shows the two counts that should agree and flags the silent discard as a mismatch", async () => {
    await ready(); await nav("Delivery");
    expect(await screen.findByTestId("counts")).toHaveTextContent("Agree");
    expect(screen.queryByTestId("mismatch")).toBeNull();
    override["/api/delivery"] = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => DELIVERY({ scenario: "spa_html", counters: { attempts: 3, acked: 3, refused: 0, stored: 1, duplicates: 0, lost: 2 } }) });
    await userEvent.click(screen.getByTestId("door-spa_html"));
    expect(await screen.findByTestId("mismatch")).toHaveTextContent("MISMATCH");
    expect(screen.getByTestId("lost")).toHaveTextContent("2");
    expect(screen.getByTestId("door-explain")).toHaveTextContent("HTTP 200 text/html");
    expect(state.delivery).toBe("spa_html");
  });
  it("Real: the pull is disabled with the reason when it is not configured", async () => {
    state.mode = "real";
    render(<App />);
    await nav("Delivery");
    const pull = await screen.findByTestId("pull");
    expect(pull).toBeDisabled(); expect(pull).toHaveAttribute("title", expect.stringContaining("worker settings"));
    expect(screen.getByTestId("pull-hint")).toBeInTheDocument();
    expect(screen.getByTestId("receiver")).toHaveTextContent("/webhook/pingone-events");
  });
  it("Real: a pull shows subscriptions and failed deliveries", async () => {
    state.mode = "real";
    override["/api/delivery"] = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ source: "real", receiver: { paths: ["/webhook/pingone-events"], publicHostConfigured: true, credentialConfigured: true, stored: 0, capacity: 1000, duplicates: 0 }, pull: { available: true, hint: null, last: null } }) });
    override["/api/pull"] = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ at: "2026-11-07T12:00:00.000Z", pulled: 5, stored: 5, duplicates: 0, rejected: 0, traceId: "a".repeat(32), hops: [], subscriptions: [{ id: "s1", name: "EXAMPLE-SUB", enabled: true, destination: "https://hook.example/webhook/pingone-events", connectionStatus: { status: "FAILED", lastResponseCode: "503", lastResponseDetails: "Delivery failed", lastAttemptedAt: "2026-11-07T11:00:00Z", lastSuccessfulAt: null } }], failedDeliveries: { total: 2, bySubscription: [{ subscription: "EXAMPLE-SUB", count: 2, lastAt: "2026-11-07T11:00:00Z", lastReason: "Connection attempt failed with error: 503" }] } }) });
    render(<App />);
    await nav("Delivery");
    await userEvent.click(await screen.findByTestId("pull"));
    const res = await screen.findByTestId("pull-result");
    expect(res).toHaveTextContent("Pulled 5 activities"); expect(within(res).getByTestId("sub-row")).toHaveTextContent("FAILED");
    expect(res).toHaveTextContent("EXAMPLE-SUB: 2 failed");
  });
});

describe("forward to Elasticsearch", () => {
  it("is OFF by default; Mock turns on without a confirm and shows the exact body and the counters", async () => {
    await ready(); await nav("Forward");
    expect(await screen.findByTestId("fwd-state")).toHaveTextContent("OFF");
    expect(screen.getByTestId("bulk-body")).toHaveTextContent('"_id":"e1"');
    expect(screen.getByTestId("preview")).toHaveTextContent("MOCK: this is what would be sent.");
    await userEvent.click(screen.getByTestId("fwd-on"));
    await waitFor(() => expect(screen.getByTestId("fwd-state")).toHaveTextContent("ON"));
    expect(JSON.parse(calls.filter((c) => c.url === "/api/sink" && c.opts.method === "POST").at(-1).opts.body)).toEqual({ enabled: true });
    await userEvent.click(screen.getByTestId("sink-throttled"));
    await waitFor(() => expect(state.scenario).toBe("throttled"));
    await userEvent.click(screen.getByTestId("fwd-off"));
    await waitFor(() => expect(screen.getByTestId("fwd-state")).toHaveTextContent("OFF"));
  });
  it("Real: the switch is disabled until the owner confirms, then sends confirm:true", async () => {
    state.mode = "real";
    render(<App />);
    await nav("Forward");
    const on = await screen.findByTestId("fwd-on");
    expect(on).toBeDisabled();
    await userEvent.click(screen.getByTestId("confirm"));
    expect(on).toBeEnabled();
    await userEvent.click(on);
    await waitFor(() => expect(screen.getByTestId("fwd-state")).toHaveTextContent("ON"));
    expect(JSON.parse(calls.filter((c) => c.url === "/api/sink" && c.opts.method === "POST").at(-1).opts.body)).toEqual({ enabled: true, confirm: true });
    expect(screen.getByTestId("target")).toHaveTextContent("cluster.example");
    expect(document.body.textContent).not.toMatch(/ApiKey|api-key/i);
  });
  it("Real without a configured target: disabled with the how-to", async () => {
    state.mode = "real";
    override["/api/sink"] = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => SINK({ source: "real", configured: false, hint: "Forwarding needs ELASTICSEARCH_URL", confirmRequired: true, scenario: null, scenarios: null, target: null }) });
    render(<App />);
    await nav("Forward");
    expect(await screen.findByTestId("fwd-hint")).toHaveTextContent("ELASTICSEARCH_URL");
    expect(screen.getByTestId("fwd-on")).toBeDisabled(); expect(screen.getByTestId("test-conn")).toBeDisabled();
  });
  it("test connection shows a bounded result", async () => {
    await ready(); await nav("Forward");
    await userEvent.click(await screen.findByTestId("test-conn"));
    expect(await screen.findByTestId("test-result")).toHaveTextContent("Reachable: mock-cluster");
  });
});

describe("setup, pipeline, talk track, presenter", () => {
  it("setup shows the SE destination, the management API shape with its UNVERIFIED note, Kibana steps and labelled facts; no tunnel", async () => {
    await ready(); await nav("Setup");
    expect(await screen.findByTestId("setup-webhook")).toHaveTextContent("https://<se-host>/webhook/pingone-events");
    expect(screen.getByTestId("mgmt-note")).toHaveTextContent("UNVERIFIED");
    expect(screen.getByTestId("setup-es")).toHaveTextContent("pingone-events*");
    expect(screen.getByTestId("facts")).toHaveTextContent("measured"); expect(screen.getByTestId("facts")).toHaveTextContent("UNVERIFIED");
    expect(document.body.textContent).not.toMatch(/tunnel|ngrok/i);
  });
  it("draws the boxes from /api/diagram by name and Simulate highlights a step; Reset clears it", async () => {
    await ready(); await nav("Pipeline");
    expect(await screen.findByText("PingOne: activity stream")).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith("/api/diagram?vertical=retail&name=event-pipeline"))).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /simulate/i }));
    expect(await screen.findByTestId("pattern-now")).toHaveTextContent("Step 1: event matches");
    await userEvent.click(screen.getByTestId("reset"));
    await waitFor(() => expect(screen.queryByTestId("pattern-now")).toBeNull());
  });
  it("presenter mode keeps the banner and shows the say-text; Esc leaves", async () => {
    await ready();
    await nav("Talk track");
    expect(screen.getByTestId("talk-track")).toHaveTextContent("Everything is simulated.");
    await nav("Events");
    await userEvent.keyboard("p");
    expect(await screen.findByTestId("presenter-say")).toHaveTextContent("Everything is simulated.");
    expect(screen.getByTestId("banner")).toBeVisible();
    expect(document.querySelector(".app--presenter")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".app--presenter")).toBeNull();
  });
  it("Reset clears the Mock events and says what it kept", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("reset"));
    expect(await screen.findByTestId("notice")).toHaveTextContent("Real events are kept");
    await waitFor(() => expect(screen.queryAllByTestId("event-row")).toHaveLength(0));
  });
  it("the theme control sets data-theme and remembers it", async () => {
    await ready();
    await userEvent.selectOptions(screen.getByTestId("theme"), "dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await userEvent.selectOptions(screen.getByTestId("theme"), "auto");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("UI standard", () => {
  it("imports the vendored standalone-ui.css before app.css", async () => {
    const main = (await import("./main.jsx?raw")).default;
    expect(main.indexOf('import "./standalone-ui.css"')).toBeGreaterThan(-1);
    expect(main.indexOf('import "./standalone-ui.css"')).toBeLessThan(main.indexOf('import "./app.css"'));
  });
  it("no component uses dangerouslySetInnerHTML or innerHTML", async () => {
    const files = import.meta.glob("./**/*.jsx", { query: "?raw", import: "default", eager: true });
    for (const [name, src] of Object.entries(files)) { if (name.endsWith(".test.jsx")) continue; expect(src, name).not.toMatch(/dangerouslySetInnerHTML|innerHTML/); }
  });
});

describe("diagram edge labels", () => {
  it("nudges the two labels of a back-and-forth pair in opposite directions and leaves the rest alone", () => {
    expect(labelOffsets([{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "c" }])).toEqual([-16, 16, 0]);
    expect(labelOffsets([])).toEqual([]);
  });
});
