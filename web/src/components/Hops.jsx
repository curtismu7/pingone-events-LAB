import Json from "./Json";

// The raw request/response of each hop with its W3C traceparent (rule 14). Text only.
export default function Hops({ hops, traceId }) {
  if (!hops?.length) return null;
  return (
    <section aria-label="Hops with traceparent" data-testid="hops">
      <h3>Hops (W3C traceparent) <span className="muted">trace {traceId}</span></h3>
      {hops.map((h) => (
        <details key={h.n}>
          <summary>{h.n}. {h.label}</summary>
          <p className="muted">Request</p><Json value={h.request} label={`Request of hop ${h.n}`} />
          <p className="muted">Response</p><Json value={h.response} label={`Response of hop ${h.n}`} />
        </details>
      ))}
    </section>
  );
}
