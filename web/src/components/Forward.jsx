import { useCallback, useEffect, useState } from "react";
import { getJson, setForwarding, setSinkScenario, testSink } from "../api";
import { when } from "../format";
import { visible } from "../safeText";
import Json from "./Json";

const ORDER = ["healthy", "throttled", "unavailable", "unreachable"];
const LABEL = { healthy: "Healthy", throttled: "Returns 429", unavailable: "Returns 503", unreachable: "Unreachable" };

export default function Forward({ story, info, dataSignal, onChanged }) {
  const real = info?.mode === "real";
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [ack, setAck] = useState(false);
  const [msg, setMsg] = useState("");
  const [test, setTest] = useState(null);

  const load = useCallback(() => getJson("/api/sink").then((j) => { setS(j); setError(null); }, (e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load, dataSignal]);
  const busy = s && (s.forwarding || s.status.queued > 0);
  useEffect(() => { if (!busy) return undefined; const t = setInterval(load, 1500); return () => clearInterval(t); }, [busy, load]);

  if (error) return <p className="field-error" role="alert">Could not load the forwarding status ({error}).</p>;
  if (!s) return <p className="muted">Loading...</p>;
  const st = s.status;

  const turn = async (enabled) => {
    const r = await setForwarding(enabled, enabled && real);
    if (!r.ok) setMsg(r.body?.detail || "Could not change forwarding."); else { setMsg(enabled ? "Forwarding is ON for new events." : "Forwarding is OFF. The queue was emptied."); setAck(false); setS(r.body); onChanged?.(); }
  };
  const scenario = async (k) => { const r = await setSinkScenario(k); if (r.ok) setS(r.body); };
  const runTest = async () => { const r = await testSink(); setTest(r.body); if (!r.ok) setMsg(r.body?.detail || "The test could not run."); };

  return (
    <div className="forward">
      <section className="panel" aria-label="Forward to Elasticsearch or OpenSearch" data-testid="forward-panel">
        <h2>Forward to Elasticsearch / OpenSearch {s.forwarding ? <span className="chip chip--warn" data-testid="fwd-state">ON</span> : <span className="chip" data-testid="fwd-state">OFF</span>}</h2>
        <p className="muted">{real ? "Each new event is also sent to YOUR cluster through its bulk API, after PingOne has been answered. This is a write to a system you own, so it is off until you turn it on. Real forwarding is UNVERIFIED against a live cluster." : "MOCK: nothing is sent anywhere. A pretend cluster answers in-process so you can watch the same queue, retries and counters work. Real forwarding is UNVERIFIED against a live cluster."}</p>
        <dl className="kv">
          <div className="kv__row"><dt>Target</dt><dd><code data-testid="target">{visible(s.target?.host || "not configured")}</code> index <code>{visible(s.target?.index || "pingone-events")}</code></dd></div>
          <div className="kv__row"><dt>Request</dt><dd><code>{s.preview.method} {visible(s.preview.url)}</code> <span className="muted">{s.preview.contentType}</span></dd></div>
        </dl>
        {real && !s.configured && <p className="field-error" data-testid="fwd-hint">{s.hint}</p>}
        {!s.forwarding ? (
          <div className="turn">
            {real && s.configured && <label className="inline"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="confirm" /> I understand this writes to my cluster.</label>}
            <button type="button" className="primary" data-testid="fwd-on" disabled={real && (!s.configured || !ack)} title={real && !s.configured ? s.hint : undefined} onClick={() => turn(true)}>Turn forwarding on</button>
          </div>
        ) : <button type="button" data-testid="fwd-off" onClick={() => turn(false)}>Turn forwarding off</button>}
        {msg && <p className="muted" role="status" data-testid="fwd-msg">{msg}</p>}
        {!real && (
          <div>
            <p className="muted">What does the pretend cluster do?</p>
            <div className="seg" role="group" aria-label="Cluster scenario">{ORDER.map((k) => <button key={k} type="button" aria-pressed={s.scenario === k} data-testid={`sink-${k}`} onClick={() => scenario(k)}>{LABEL[k]}</button>)}</div>
            {story?.sinkScenarios && <p className="lesson">{story.sinkScenarios[s.scenario]}</p>}
          </div>
        )}
      </section>

      <section className="panel" aria-label="Forwarding status" data-testid="fwd-status">
        <h2>Status</h2>
        <div className="card-grid">
          {[["Sent", st.sent, "sent"], ["Failed", st.failed, "failed"], ["Queued", st.queued, "queued"], ["Dropped", st.dropped, "dropped"], ["Retried", st.retried, "retried"]].map(([label, v, id]) => (
            <div key={id} className={`card ${id === "failed" && v > 0 ? "card--danger" : id === "sent" && v > 0 ? "card--ok" : "card--neutral"}`}><h3>{label}</h3><p className="big" data-testid={`n-${id}`}>{v}</p></div>
          ))}
        </div>
        <dl className="kv">
          <div className="kv__row"><dt>Last success</dt><dd>{when(st.lastSuccessAt)}</dd></div>
          <div className="kv__row"><dt>Last error</dt><dd data-testid="last-error">{st.lastError ? `${visible(st.lastError)} (${when(st.lastErrorAt)})` : "none"}</dd></div>
          <div className="kv__row"><dt>Limits</dt><dd>queue {st.maxQueue} (the oldest is dropped when full), batches of {st.batchSize}, {st.maxRetries} retries with backoff</dd></div>
        </dl>
        <button type="button" data-testid="test-conn" onClick={runTest} disabled={real && !s.configured} title="Owner-run: one read-only GET of the cluster address">Test connection (read-only)</button>
        {test && <p data-testid="test-result">{test.ok ? `Reachable: ${visible(test.cluster || "cluster")} ${visible(test.version || "")}` : `Not reachable: ${visible(test.detail || `HTTP ${test.status}`)}`}</p>}
      </section>

      <section className="panel" aria-label="What would be sent" data-testid="preview">
        <h2>{real ? "What is sent" : "What would be sent"}</h2>
        <p className="muted">{s.preview.note} The action line carries the event id as the document id, so a retry or a redelivery overwrites the same document.</p>
        {s.preview.body ? <Json value={s.preview.body} label="Bulk request body (ndjson)" testId="bulk-body" /> : <p className="empty">No events yet. Play a scenario or send a test webhook, and the body appears here.</p>}
        <p className="muted">Create the index template yourself first: see Setup ({s.template}). The app never changes anything on your cluster except adding these documents.</p>
      </section>
    </div>
  );
}
