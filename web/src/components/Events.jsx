import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Hops from "./Hops";
import Json from "./Json";
import { getEvents, playScenario, sendTestWebhook, setDelivery, setSinkScenario } from "../api";
import { clock, shortId, statusClass } from "../format";
import { makeTestActivity } from "../testWebhook";
import { visible } from "../safeText";

const LIMITS = [25, 50, 100, 200];

export default function Events({ story, info, dataSignal, requestedId, onSelect, onChanged, goTab }) {
  const real = info?.mode === "real";
  const [filters, setFilters] = useState({ eventType: "", actorId: "", status: "", limit: 50 });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [auto, setAuto] = useState(false);
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(null);
  const [scenario, setScenario] = useState(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try { const r = await getEvents(filters); if (mine === seq.current) { setResult(r); setError(null); } } catch (e) { if (mine === seq.current) setError(e.message); }
  }, [filters]);
  useEffect(() => { load(); }, [load, dataSignal]);
  useEffect(() => { if (!auto) return undefined; const t = setInterval(load, 3000); return () => clearInterval(t); }, [auto, load]);

  const pick = useCallback(async (sc) => {
    setScenario(sc); onSelect?.(sc.id); setNote("");
    if (real) { setNote("Scenarios drive the Mock stream. Switch to Mock to use them."); return; }
    if (sc.kind === "events") {
      const r = await playScenario(sc.play);
      if (!r.ok) { setNote(r.body?.detail || "That scenario needs Mock mode."); return; }
      setNote(`Played: ${r.body.sent} event(s) sent to the receiver, ${r.body.stored ?? 0} stored${r.body.status === 200 ? "" : `, the receiver answered ${r.body.status}`}.`);
      onChanged?.();
    } else if (sc.kind === "delivery") {
      const r = await setDelivery(sc.delivery);
      if (r.ok) { onChanged?.(); goTab?.("delivery"); } else setNote(r.body?.detail || "Could not set the scenario.");
    } else if (sc.kind === "sink") {
      const r = await setSinkScenario(sc.sink);
      if (r.ok) { onChanged?.(); goTab?.("forward"); } else setNote(r.body?.detail || "Could not set the scenario.");
    }
  }, [real, onSelect, onChanged, goTab]);

  useEffect(() => {
    if (!requestedId || !story) return;
    const sc = story.scenarios.find((s) => s.id === requestedId);
    if (sc) pick(sc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedId, story]);

  const sendTest = async () => {
    const r = await sendTestWebhook(makeTestActivity(story?.cast?.castClientId));
    setSent(r); onChanged?.();
  };
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const events = result?.events ?? [];

  return (
    <div className="events">
      {!real && story && (
        <section className="panel" aria-label="Scenarios" data-testid="scenarios">
          <h2>Scenarios</h2>
          <p className="muted">Each one plays or sets up something in Mock. Event scenarios send PingOne-shaped deliveries to this app&apos;s own receiver; the others set up a failure on the Delivery or Forward tab.</p>
          <ul className="scenario-list">
            {story.scenarios.map((sc) => (
              <li key={sc.id}>
                <button type="button" aria-pressed={scenario?.id === sc.id} data-testid={`scenario-${sc.id}`} onClick={() => pick(sc)}>{sc.title}</button>
                <span className="tag">{sc.kind}</span>
              </li>
            ))}
          </ul>
          {scenario && <p className="lesson" data-testid="lesson"><strong>{scenario.title}.</strong> {scenario.lesson}</p>}
          {note && <p className="muted" role="status" data-testid="scenario-note">{note}</p>}
        </section>
      )}
      {real && (
        <section className="panel" aria-label="Real events" data-testid="real-note">
          <h2>Real events</h2>
          <p className="muted">These are events PingOne delivered to this app and events you pulled read-only. Nothing is generated here. {info?.webhook?.credentialConfigured ? "PingOne’s credential is configured." : "No webhook credential is configured (fine on this machine; PingOne cannot reach it)."} Use the Delivery tab to pull.</p>
        </section>
      )}

      <section className="panel" aria-label="Events" data-testid="events-panel">
        <div className="panel__head">
          <h2>Events <span className="muted" data-testid="count">{result ? `${events.length} shown of ${result.count} stored (${result.source === "real" ? "REAL" : "MOCK"})` : ""}</span></h2>
          <div className="tools">
            {!real && <button type="button" data-testid="send-test" onClick={sendTest}>Send test webhook</button>}
            <label className="inline"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} data-testid="auto" /> Auto-refresh</label>
            <button type="button" onClick={load} data-testid="refresh">Refresh</button>
          </div>
        </div>
        <form className="filters" onSubmit={(e) => { e.preventDefault(); load(); }} aria-label="Filters">
          <label>Event type<input type="text" value={filters.eventType} onChange={(e) => set("eventType", e.target.value)} placeholder="SESSION" data-testid="f-type" maxLength={80} /></label>
          <label>Actor id<input type="text" value={filters.actorId} onChange={(e) => set("actorId", e.target.value)} placeholder="part of an id" data-testid="f-actor" maxLength={120} /></label>
          <label>Status<select value={filters.status} onChange={(e) => set("status", e.target.value)} data-testid="f-status"><option value="">any</option>{["SUCCESS", "FAILED", "SIGN_ON_REQUIRED", "MFA_REQUIRED", "HIGH"].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label>Show<select value={filters.limit} onChange={(e) => set("limit", Number(e.target.value))} data-testid="f-limit">{LIMITS.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        </form>
        {result?.types?.length > 0 && (
          <p className="typechips" aria-label="Event types in the store">{result.types.slice(0, 12).map((t) => (
            <button key={t.type} type="button" className="linkish" aria-pressed={filters.eventType === t.type} onClick={() => set("eventType", filters.eventType === t.type ? "" : t.type)}>{visible(t.type)} <span className="muted">{t.count}</span></button>
          ))}</p>
        )}
        {error && <p className="field-error" role="alert">Could not load events ({error}).</p>}
        {result?.notice && <p className="muted" role="status">{result.notice}</p>}
        {!error && result && events.length === 0 && (
          <p className="empty" data-testid="empty">{result.count > 0 ? "No stored event matches these filters." : real ? "No events yet. When PingOne delivers one, or you pull from the Delivery tab, it appears here." : "No events yet. Pick a scenario above, or press Send test webhook."}</p>
        )}
        {events.length > 0 && (
          <div className="scroll">
            <table className="tbl logtable" data-testid="events-table">
              <caption className="sr-only">Events, newest first</caption>
              <thead><tr><th>Time (UTC)</th><th>Event</th><th>Actor</th><th>Status</th><th>Resource</th><th>Correlation</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <Fragment key={e.eventId}>
                  <tr data-testid="event-row" className={`row--click${selected === e.eventId ? " row--on" : ""}`} onClick={(ev) => { if (!ev.target.closest("button, a")) setSelected(selected === e.eventId ? null : e.eventId); }}>
                    <td className="nowrap" data-label="Time (UTC)">{clock(e.timestamp)}</td>
                    <td data-label="Event"><button type="button" className="linkish" aria-pressed={selected === e.eventId} aria-label={`Open ${visible(e.eventType)}`} onClick={() => setSelected(selected === e.eventId ? null : e.eventId)}>{visible(e.eventType)}</button></td>
                    <td data-label="Actor"><code>{e.actorType ? `${e.actorType} ` : ""}{shortId(e.actorId)}</code></td>
                    <td data-label="Status">{e.status ? <span className={statusClass(e.status)}>{visible(e.status)}</span> : ""}</td>
                    <td data-label="Resource"><code>{shortId(e.resource)}</code></td>
                    <td data-label="Correlation"><code>{shortId(e.correlationId)}</code></td>
                  </tr>
                  {selected === e.eventId && (
                    <tr className="row--detail">
                      <td colSpan={6}>
                        <aside className="drawer" aria-label="Event detail" data-testid="event-detail">
                          <div className="panel__head"><h2>{visible(e.eventType)}</h2><button type="button" onClick={() => setSelected(null)} data-testid="close-detail">Close</button></div>
                          <dl className="kv">
                            {[["Event id", e.eventId], ["Time", e.timestamp], ["Actor", `${e.actorType || "none"} ${e.actorId}`], ["Status", e.status || "none"], ["Resource", e.resource || "none"], ["Environment", e.environmentId || "none"], ["Correlation id", e.correlationId || "none"], ["Arrived via", e.via], ["Schema", e.schema]].map(([k, v]) => (<div key={k} className="kv__row"><dt>{k}</dt><dd><code>{visible(v)}</code></dd></div>))}
                          </dl>
                          <h3>Raw event</h3>
                          <Json value={e.raw} label="The original event as delivered" testId="raw-json" />
                        </aside>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {sent && (
        <section className="panel" aria-label="Last test delivery" data-testid="sent">
          <h2>Last test webhook</h2>
          <p><strong>The receiver answered</strong> <span className={sent.status === 200 && sent.body ? "chip chip--ok" : "chip chip--danger"} data-testid="sent-status">HTTP {sent.status}</span> <span className="muted">{sent.type.split(";")[0] || "no content type"}</span></p>
          {sent.status === 200 && !sent.body && <p className="field-error" role="alert" data-testid="sent-html">A web page came back instead of the receiver&apos;s answer. PingOne would record this as a success, and the event was not stored.</p>}
          {sent.status === 503 && <p className="field-error" role="alert" data-testid="sent-503">The door is shut (503). PingOne would record a failed delivery; nothing was stored.</p>}
          {sent.body?.hops && <Hops hops={sent.body.hops} traceId={sent.body.traceId} />}
        </section>
      )}
    </div>
  );
}
