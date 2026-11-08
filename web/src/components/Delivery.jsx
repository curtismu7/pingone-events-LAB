import { useCallback, useEffect, useState } from "react";
import Hops from "./Hops";
import { getJson, pullPingOne, sendTestWebhook, setDelivery } from "../api";
import { statusClass, when } from "../format";
import { makeTestActivity } from "../testWebhook";
import { visible } from "../safeText";

const ORDER = ["healthy", "receiver_503", "spa_html"];

function StatusRow({ s }) {
  const c = s.connectionStatus || {};
  return (
    <tr data-testid="sub-row">
      <td>{visible(s.name)}{s.enabled ? "" : " (disabled)"}</td>
      <td><span className={statusClass(c.status)}>{visible(c.status || "UNKNOWN")}</span></td>
      <td>{visible(c.lastResponseCode || "none")} <span className="muted">{visible(c.lastResponseDetails || "")}</span></td>
      <td className="nowrap">{when(c.lastAttemptedAt)}</td>
      <td className="nowrap">{when(c.lastSuccessfulAt)}</td>
      <td><code>{visible(s.destination || "none")}</code></td>
    </tr>
  );
}

export default function Delivery({ story, info, dataSignal, onChanged }) {
  const real = info?.mode === "real";
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);
  const [pull, setPull] = useState(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState(null);

  const load = useCallback(() => getJson("/api/delivery").then((j) => { setD(j); setError(null); }, (e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load, dataSignal]);

  const choose = async (scenario) => { const r = await setDelivery(scenario); if (r.ok) { await load(); onChanged?.(); } };
  const sendTest = async () => { setSent(await sendTestWebhook(makeTestActivity(story?.cast?.castClientId))); await load(); onChanged?.(); };
  const doPull = async () => {
    setPulling(true); setPullError(null);
    const r = await pullPingOne();
    setPulling(false);
    if (!r.ok) { setPullError(r.body?.detail || r.body?.error || "The pull failed."); return; }
    setPull(r.body); await load(); onChanged?.();
  };

  if (error) return <p className="field-error" role="alert">Could not load delivery health ({error}).</p>;
  if (!d) return <p className="muted">Loading...</p>;

  if (real) {
    const last = pull || d.pull?.last;
    return (
      <div className="delivery">
        <section className="panel" aria-label="Receiver" data-testid="receiver">
          <h2>Receiver</h2>
          <dl className="kv">
            <div className="kv__row"><dt>Paths</dt><dd><code>{d.receiver.paths.join("  ")}</code></dd></div>
            <div className="kv__row"><dt>Stored here</dt><dd data-testid="stored">{d.receiver.stored} of {d.receiver.capacity} (a repeat of an event is ignored: {d.receiver.duplicates} so far)</dd></div>
            <div className="kv__row"><dt>Webhook credential</dt><dd>{d.receiver.credentialConfigured ? "configured (PingOne must send it)" : "not set"}</dd></div>
            <div className="kv__row"><dt>Public host</dt><dd>{d.receiver.publicHostConfigured ? "configured" : "not set: only this machine can reach the receiver"}</dd></div>
          </dl>
        </section>
        <section className="panel" aria-label="Pull from PingOne" data-testid="pull-panel">
          <h2>Pull from PingOne <span className="tag">read-only</span></h2>
          <p className="muted">Asks PingOne for each subscription&apos;s delivery status and the last 36 hours of activity. Three requests: a token, then two reads. Nothing in PingOne is changed. The pull is not the same feed as the webhook: it can miss sign-in flow and session events the webhook carries.</p>
          <button type="button" data-testid="pull" disabled={!d.pull.available || pulling} title={d.pull.available ? "Make three read-only calls to the PingOne API" : d.pull.hint || "The pull is not configured."} onClick={doPull}>{pulling ? "Pulling..." : "Pull from PingOne (read-only)"}</button>
          {!d.pull.available && <p className="muted" data-testid="pull-hint">{d.pull.hint}</p>}
          {pullError && <p className="field-error" role="alert" data-testid="pull-error">{pullError}</p>}
          {last && (
            <div data-testid="pull-result">
              <p className="muted">Pulled {last.pulled} activities at {when(last.at)}: {last.stored} new, {last.duplicates} already stored{last.rejected ? `, ${last.rejected} not parseable` : ""}.</p>
              <h3>Subscriptions</h3>
              {last.subscriptions.length === 0 ? <p className="muted">No subscriptions found.</p> : (
                <div className="scroll"><table className="tbl"><caption className="sr-only">Subscriptions and their delivery status</caption>
                  <thead><tr><th>Name</th><th>Status</th><th>Last response</th><th>Last attempt</th><th>Last success</th><th>Destination</th></tr></thead>
                  <tbody>{last.subscriptions.map((s) => <StatusRow key={s.id} s={s} />)}</tbody></table></div>
              )}
              <h3>Failed deliveries in the pulled window</h3>
              {last.failedDeliveries.total === 0 ? <p className="muted">None.</p> : (
                <ul>{last.failedDeliveries.bySubscription.map((f) => <li key={f.subscription}><strong>{visible(f.subscription)}</strong>: {f.count} failed, last {when(f.lastAt)} ({visible(f.lastReason || "no reason given")})</li>)}</ul>
              )}
              {pull?.hops && <Hops hops={pull.hops} traceId={pull.traceId} />}
            </div>
          )}
        </section>
      </div>
    );
  }

  const c = d.counters; const sc = d.scenarios[d.scenario];
  const mismatch = c.acked > c.stored + c.duplicates;
  return (
    <div className="delivery">
      <section className="panel" aria-label="What the door does" data-testid="door">
        <h2>What the receiver does</h2>
        <p className="muted">Choose how the door behaves, then press Send test webhook. This is Mock: a pretend subscription called EXAMPLE-SUBSCRIPTION delivering to a pretend host.</p>
        <div className="seg" role="group" aria-label="Delivery scenario">
          {ORDER.map((k) => <button key={k} type="button" aria-pressed={d.scenario === k} data-testid={`door-${k}`} onClick={() => choose(k)}>{d.scenarios[k].title}</button>)}
        </div>
        <p className="lesson" data-testid="door-explain"><strong>PingOne sees:</strong> {sc.pingoneSees}. <strong>The app:</strong> {sc.appDoes}. {sc.explain}</p>
        <button type="button" data-testid="send-test" onClick={sendTest}>Send test webhook</button>
        {sent && (
          <p data-testid="sent">Answer: <span className={sent.status === 200 && sent.body ? "chip chip--ok" : "chip chip--danger"} data-testid="sent-status">HTTP {sent.status}</span> <span className="muted">{sent.type.split(";")[0] || "no content type"}</span></p>
        )}
        {sent?.body?.hops && <Hops hops={sent.body.hops} traceId={sent.body.traceId} />}
      </section>

      <section className="panel" aria-label="Two counts that should agree" data-testid="counts">
        <h2>Two counts that should agree</h2>
        <div className="card-grid">
          <div className="card"><h3>PingOne says delivered</h3><p className="big" data-testid="acked">{c.acked}</p><p className="muted">events it got a 2xx for</p></div>
          <div className="card"><h3>Stored here</h3><p className="big" data-testid="stored">{c.stored}</p><p className="muted">{c.duplicates} repeat(s) ignored</p></div>
          <div className={`card ${mismatch ? "card--danger" : "card--ok"}`}><h3>Silently lost</h3><p className="big" data-testid="lost">{c.lost}</p><p>{mismatch ? <span className="chip chip--danger" data-testid="mismatch">MISMATCH</span> : <span className="chip chip--ok">Agree</span>} {mismatch ? "PingOne thinks these arrived. They did not." : "Every acknowledged event is stored."}</p></div>
          <div className="card"><h3>Refused</h3><p className="big" data-testid="refused">{c.refused}</p><p className="muted">events PingOne was told failed</p></div>
        </div>
      </section>

      <section className="panel" aria-label="Subscription status" data-testid="subscription">
        <h2>The subscription&apos;s delivery status <span className="tag">MOCK</span></h2>
        <div className="scroll"><table className="tbl"><caption className="sr-only">The pretend subscription and its status</caption>
          <thead><tr><th>Name</th><th>Status</th><th>Last response</th><th>Last attempt</th><th>Last success</th><th>Destination</th></tr></thead>
          <tbody><StatusRow s={d.subscription} /></tbody></table></div>
        <p className="muted">PingOne keeps exactly these fields per subscription (measured on one tenant). With the web-page scenario the status stays SUCCESS while events vanish: compare the first two counts above.</p>
      </section>
    </div>
  );
}
