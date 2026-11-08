import { useEffect, useState } from "react";
import { getJson } from "../api";
import Json from "./Json";
import { visible } from "../safeText";

const TAG = { measured: "tag tag--ok", inferred: "tag", UNVERIFIED: "tag tag--warn" };

export default function Setup({ story }) {
  const [setup, setSetup] = useState(null);
  useEffect(() => { getJson("/api/setup").then(setSetup, () => setSetup(null)); }, []);
  if (!story) return null;
  const w = story.setup.webhook; const es = story.setup.elasticsearch;
  return (
    <div className="setup">
      <section className="panel" aria-label="Webhook subscription" data-testid="setup-webhook">
        <h2>The PingOne webhook subscription</h2>
        <p className="muted">{w.note}</p>
        <dl className="kv">
          {w.fields.map(([k, v]) => <div key={k} className="kv__row"><dt>{k}</dt><dd>{visible(v)}</dd></div>)}
        </dl>
        <h3>The same thing through the Management API</h3>
        <p><code>{w.managementApi.method} {w.managementApi.url}</code></p>
        <Json value={w.managementApi.body} label="Subscription request body (placeholders)" testId="mgmt-body" />
        <p className="muted" data-testid="mgmt-note">{w.managementApi.note}</p>
        <h3>Safety</h3>
        <p>{w.safety}</p>
        <p className="muted">{w.local}</p>
        {setup && <p className="muted">This app answers on {setup.receiverPaths.join(" and ")}. {setup.hosted ? "It is running hosted: the page and the read APIs ask for a password." : "It is running on this machine."}</p>}
      </section>

      <section className="panel" aria-label="Settings">
        <h2>Settings</h2>
        <dl className="kv">{story.setup.settings.map(([k, v]) => <div key={k} className="kv__row"><dt>{k}</dt><dd>{visible(v)}</dd></div>)}</dl>
      </section>

      <section className="panel" aria-label="Elasticsearch and Kibana" data-testid="setup-es">
        <h2>Elasticsearch / OpenSearch and Kibana</h2>
        <p>{es.why}</p>
        <Json value={es.indexTemplateCurl} label="curl command for the index template (placeholders)" testId="curl" />
        {setup?.indexTemplate && <><p className="muted">{es.indexTemplateFile}:</p><Json value={setup.indexTemplate} label="Index template" testId="template" /></>}
        <h3>In Kibana (or OpenSearch Dashboards)</h3>
        <ol>{es.kibana.map((k) => <li key={k}>{visible(k)}</li>)}</ol>
      </section>

      <section className="panel" aria-label="Facts" data-testid="facts">
        <h2>What is measured and what is not</h2>
        <ul className="facts">
          {story.facts.map((f) => <li key={f.id}><span className={TAG[f.status]}>{f.status}</span> {visible(f.text)} <span className="muted">Source: {visible(f.source)}</span></li>)}
        </ul>
      </section>
    </div>
  );
}
