import { useState, useSyncExternalStore } from "react";
import { visible } from "../safeText";

// View preference: a tiny per-lab store (localStorage, best effort). The lab does not need
// evidence/lanes for this — the pane persists its own Form | JSON choice.
function readPref(key, valid, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return valid(v) ? v : fallback;
  } catch { return fallback; }
}
function writePref(key, v) {
  try { window.localStorage.setItem(key, v); } catch { /* private mode: choice lives for the session */ }
}

// The one JSON pane of this lab (owner, 2026-11-14). Two views, one choice for every pane on the page:
//   Form      = a FORM: a label and a read-only value box per field, nested objects as indented groups, scopes and audiences as chips,
//               timestamps with their date, true / false as chips. It is not coloured JSON.
//   JSON      = the exact JSON text, coloured by what each part is (keys, strings, numbers, true / false, null, urls, ids, tokens with their three
//               segments each in a colour, and the important claims and errors stood out).
// Everything is rendered as React text (never markup) and passes `visible()`, so control and bidi characters show as escapes. Tokens are shown whole.
// FULL VIEW (owner, 2026-11-14): the pane never scrolls. It grows to its content and long lines wrap (JsonPane.css enforces it).
// IMPORTANT parts: HOT below is the default set (who, for whom, what). A lab marks the keys that matter in ITS payloads with `hot={["decision", ...]}`.

const KEY = "aag.json.view";
let view = readPref(KEY, (v) => v === "form" || v === "raw", "form");
const subs = new Set();
const setView = (v) => { view = v; writePref(KEY, v); subs.forEach((f) => f()); };
export const setJsonView = setView; // for tests: the choice is module state, shared by every pane
// A lab that teaches the wire format can open on JSON instead of Form: call setDefaultJsonView("raw") once in main.jsx, before rendering.
// A visitor's own saved choice still wins; with none saved, this is the default.
export function setDefaultJsonView(v) {
  if (v !== "form" && v !== "raw") return;
  let saved = null;
  try { saved = window.localStorage.getItem(KEY); } catch { /* no storage: the default applies */ }
  if (saved !== "form" && saved !== "raw") { view = v; subs.forEach((f) => f()); }
}
const useView = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => view, () => "form");

const JWT = /^eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*$/;
const BEARER = /^(Bearer|DPoP) (eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*)$/;
const URLISH = /^https?:\/\/\S+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;
const TIME_KEYS = new Set(["iat", "exp", "nbf", "auth_time"]);
// The parts of a token exchange a reader looks for first: who (sub, act), for whom (aud), what (scope), and which app.
const HOT = new Set(["sub", "act", "may_act", "aud", "scope", "client_id", "azp", "iss", "cnf", "grant_type", "subject_token", "actor_token", "access_token", "authorization"]);
const ALERT = new Set(["error", "error_description", "detail_code", "outcome", "decision", "verdict", "reason", "note"]);
const SPLIT = new Set(["scope", "aud", "scp"]);

// JSON that arrives as TEXT (a log line, an HTTP body, tool output): an object or array in a string gets the same Form | JSON panes.
// Anything else (a token, plain text, a bare number or string) stays text.
export function parseJsonText(s) {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return undefined;
  try { const v = JSON.parse(t); return v !== null && typeof v === "object" ? v : undefined; } catch { return undefined; }
}

// An HTTP transcript with a JSON body (a hop's request or response: request / status line, headers, blank line, body): the head stays text,
// the body gets its own Form | JSON pane. Anything that is not clearly that shape is left alone (a string stays text).
const WIRE_START = /^(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+(?: HTTP\/\d(?:\.\d)?)?\s*$|HTTP\/\d(?:\.\d)?\s+\d{3}|HTTP\s+\d{3})/m;
export function splitWire(s) {
  if (typeof s !== "string") return undefined;
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return undefined;
  const head = s.slice(0, m.index);
  const body = s.slice(m.index + m[0].length);
  if (!WIRE_START.test(head.split(/\r?\n/)[0])) return undefined;
  return parseJsonText(body) !== undefined ? { head, body } : undefined;
}

const MAX_PANE_CHARS = 150000; // above this a pane is plain text
const MAX_FORM_DEPTH = 60; // deeper than this the Form view shows the rest as text
const prim = (v) => v === null || typeof v !== "object";
// An object, or a list of objects, goes UNDER its label at full width (a deep payload must not spend a label column per level); scalars and chip lists stay beside it.
// A HAL-style link — an object whose only entry is a string `href` — collapses in the Form view to its
// parent key with the URL as the value (one row, no nested "href" label).
const hrefOnly = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.href === "string";
const nestedValue = (v) => !prim(v) && !hrefOnly(v) && !(Array.isArray(v) && v.every(prim));
const date = (n) => (Number.isFinite(n) && n > 1e9 && n < 1e11 ? `${new Date(n * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC` : null);

export function kindOf(v, key = "") {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return TIME_KEYS.has(key) ? "time" : "number";
  if (typeof v !== "string") return "string";
  if (JWT.test(v) || BEARER.test(v)) return "token";
  if (URLISH.test(v)) return "url";
  if (UUID.test(v)) return "id";
  if (ISO.test(v)) return "time";
  return "string";
}

// A token in three colours: header . payload . signature (a Bearer / DPoP prefix stays plain).
export function Jwt({ text }) {
  const m = BEARER.exec(text);
  const raw = m ? m[2] : text;
  const parts = raw.split(".");
  return (
    <span className="jwt">
      {m && <span className="jtok jtok--plain">{m[1]} </span>}
      {parts.map((p, i) => <span key={i}>{i > 0 && <span className="jtok jtok--punct">.</span>}<span className={`jtok jtok--jwt${Math.min(i, 2) + 1}`}>{visible(p)}</span></span>)}
    </span>
  );
}

// ---- Raw: the exact text, coloured ------------------------------------------------------------------------------------------------------------
// A tiny scanner (no eval, no HTML): strings, numbers, literals and punctuation. Total: anything unparsable becomes one plain token.
function scan(text) {
  const out = [];
  let i = 0;
  const nextMeaning = (from) => { let j = from; while (j < text.length && /\s/.test(text[j])) j += 1; return text[j]; };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1; let esc = false;
      while (j < text.length) { if (esc) esc = false; else if (text[j] === "\\") esc = true; else if (text[j] === '"') break; j += 1; }
      out.push({ kind: nextMeaning(j + 1) === ":" ? "key" : "string", text: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/\s/.test(ch)) { // whitespace is its own token, so the value after `"key": ` is seen as a value (a number, true, false, null), not swallowed as plain text
      let j = i; while (j < text.length && /\s/.test(text[j])) j += 1;
      out.push({ kind: "plain", text: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let j = i; while (j < text.length && /[-0-9.eE+]/.test(text[j])) j += 1;
      out.push({ kind: "number", text: text.slice(i, j) });
      i = j;
      continue;
    }
    const word = text.slice(i).match(/^(true|false|null)/);
    if (word) { out.push({ kind: word[1] === "null" ? "null" : "bool", text: word[1] }); i += word[1].length; continue; }
    if (/[{}[\],:]/.test(ch)) { out.push({ kind: "punct", text: ch }); i += 1; continue; }
    let j = i; while (j < text.length && !/["{}[\],:]/.test(text[j])) j += 1;
    out.push({ kind: "plain", text: text.slice(i, j) });
    i = j;
  }
  return out;
}

function RawJson({ text, hot }) {
  let key = "";
  return scan(text).map((t, i) => {
    if (t.kind === "key") {
      key = t.text.slice(1, -1);
      return <span key={i} className={`jtok jtok--${hot.has(key) ? "hot" : ALERT.has(key) ? "alert" : "key"}`}>{visible(t.text)}</span>;
    }
    if (t.kind === "string") {
      let inner = t.text.slice(1, -1);
      try { inner = JSON.parse(t.text); } catch { /* keep the escaped text */ }
      const k = kindOf(inner, key);
      if (k === "token") return <span key={i} className="jtok jtok--plain">"<Jwt text={inner} />"</span>;
      return <span key={i} className={`jtok jtok--${k === "string" && ALERT.has(key) ? "alert" : k === "string" && hot.has(key) ? "hot" : k}`}>{visible(t.text)}</span>;
    }
    if (t.kind === "number") return <span key={i} className={`jtok jtok--${TIME_KEYS.has(key) ? "time" : "number"}`}>{t.text}</span>;
    return <span key={i} className={`jtok jtok--${t.kind}`}>{visible(t.text)}</span>;
  });
}

// ---- Formatted: a form ------------------------------------------------------------------------------------------------------------------------
function Value({ v, k, hot }) {
  const kind = kindOf(v, k);
  if (kind === "null") return <span className="jform__v jform__v--null">none</span>;
  if (kind === "bool") return <span className="jform__chip" data-on={v ? "true" : "false"}>{v ? "true" : "false"}</span>;
  if (kind === "token") return <span className="jform__v jform__v--token"><Jwt text={v} /></span>;
  if (typeof v === "string" && SPLIT.has(k) && /\s/.test(v.trim())) return <ChipList items={v.trim().split(/\s+/)} k={k} hot={hot} />;
  if (kind === "time") { const d = typeof v === "number" ? date(v) : null; return <span className="jform__v jform__v--time">{visible(String(v))}{d && <span className="jform__sub"> {d}</span>}</span>; }
  // A string that would read as another type (the text "{}", "[]", "5", "true", "null") keeps its quotes, so the Form view never hides string-versus-object.
  const typed = typeof v === "string" && /^(?:\{[\s\S]*\}|\[[\s\S]*\]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/.test(v.trim());
  return <span className={`jform__v jform__v--${kind}`}>{visible(typed ? JSON.stringify(v) : String(v))}</span>;
}

function ChipList({ items, k, hot }) {
  if (!items.length) return <span className="jform__v jform__v--null">none</span>;
  return <ul className="jform__chips" data-hot={hot.has(k) ? "true" : undefined}>{items.map((x, i) => <li key={`${x}-${i}`} className="jform__chip">{visible(String(x))}</li>)}</ul>;
}

function Form({ value, hot, k = "", depth = 0 }) {
  if (depth > MAX_FORM_DEPTH) return <span className="jform__v">{visible(JSON.stringify(value))}</span>;
  if (Array.isArray(value)) {
    if (value.every(prim)) return <ChipList items={value} k={k} hot={hot} />;
    return (
      <ol className="jform__list">
        {value.map((x, i) => <li key={i}><span className="jform__idx">{i + 1}</span><Form value={x} hot={hot} depth={depth + 1} /></li>)}
      </ol>
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return <span className="jform__v jform__v--null">empty</span>;
    // A HAL-style link ({ href: "..." }) collapses to one row here: the parent key with the URL as its value.
    if (hrefOnly(value) && depth > 0) return <Value v={value.href} k={k} hot={hot} />;
    return (
      <dl className="jform" data-depth={Math.min(depth, 3)}>
        {entries.map(([key, v]) => (
          <div key={key} className="jform__row" data-hot={hot.has(key) ? "true" : undefined} data-alert={ALERT.has(key) ? "true" : undefined} data-nested={nestedValue(v) ? "true" : undefined}>
            <dt className="jform__k">{visible(key)}</dt>
            <dd className="jform__d">{prim(v) ? <Value v={v} k={key} hot={hot} /> : <Section value={v} name={key} hot={hot} />}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <Value v={value} k={k} />;
}

// ---- Hybrid C+A sections (owner, 2026-11-19): a nested object or array is one collapsed line until opened -------------------------------
// The section header names the key with its kind and size (object · 3 fields / array · 2 items); opening it
// reveals ONE flat list of dot-path rows (customer.email, items[0].amount) — no boxes inside boxes. Every
// existing cue survives: hot keys tint their row, alert keys colour it, chips / tokens / times render as before.
function Section({ value, name, hot }) {
  const [open, setOpen] = useState(false);
  const isArr = Array.isArray(value);
  const count = isArr ? value.length : Object.keys(value).length;
  const kindLabel = isArr ? "array" : "object";
  const noun = isArr ? "items" : "fields";
  // The one-line preview of a collapsed section: the first scalar leaf, so a common payload (a nested
  // name, a status) often needs no click at all.
  const preview = firstLeaf(value);
  return (
    <details className="jsec" data-open={open ? "true" : undefined} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="jsec__head">
        <span className="jsec__caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="jsec__name">{visible(name)}</span>
        <span className="jsec__meta">{kindLabel} · {count} {count === 1 ? noun.slice(0, -1) : noun}</span>
      </summary>
      {preview !== undefined && !open && <span className="jsec__preview"><Value v={preview.v} k={preview.k} hot={hot} /></span>}
      <div className="jsec__body">
        <FlatRows value={value} prefix={name} hot={hot} />
      </div>
    </details>
  );
}

// The first scalar leaf of a branch, with the key it was found under — the preview line.
function firstLeaf(value, path = "") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const f = firstLeaf(value[i], `${path}[${i}]`);
      if (f) return f;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    if (hrefOnly(value)) return { v: value.href, k: path };
    for (const [k, v] of Object.entries(value)) {
      const f = firstLeaf(v, path ? `${path}.${k}` : k);
      if (f) return f;
    }
    return undefined;
  }
  return { v: value, k: path };
}

// Every leaf of a branch as `dot.path[index]` rows, in order. A nested group inside (an object in an
// array, say) flattens too — one flat list, no recursion boxes.
function FlatRows({ value, prefix, hot }) {
  const rows = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) {
      if (!v.length) { rows.push({ path: p, empty: "[ ] empty list" }); return; }
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      const entries = Object.entries(v);
      if (!entries.length) { rows.push({ path: p, empty: "{ } no fields" }); return; }
      if (hrefOnly(v)) { rows.push({ path: p, v: v.href, k: p }); return; }
      for (const [k, x] of entries) walk(x, p ? `${p}.${k}` : k);
      return;
    }
    rows.push({ path: p, v, k: p });
  };
  walk(value, prefix);
  const base = prefix.split(/[.[]/)[0];
  return (
    <dl className="jform jform--flat" data-depth="1">
      {rows.map((r, i) => {
        const leafKey = r.k ? r.k.split(/[.[]/).pop().replace(/\]$/, "") : "";
        return (
          <div key={`${r.path}-${i}`} className="jform__row" data-hot={hot.has(base) || hot.has(leafKey) ? "true" : undefined} data-alert={ALERT.has(leafKey) ? "true" : undefined}>
            <dt className="jform__k">{visible(r.path)}</dt>
            <dd className="jform__d">{r.empty ? <span className="jform__v jform__v--null">{r.empty}</span> : <Value v={r.v} k={r.k} hot={hot} />}</dd>
          </div>
        );
      })}
    </dl>
  );
}

// ---- The pane ---------------------------------------------------------------------------------------------------------------------------------
// value: an object or array (or a string holding one) gets the Form | JSON choice; `hot` (optional array of key names) stands those keys out in both views; a string (a token, or text) is shown as it is, a token in its three colours.
function JsonPane({ value: given, label, testId, toggle = true, hot }) {
  const mode = useView();
  const value = given === undefined ? "" : given; // a missing value is an empty pane, never the word "undefined"
  const hotSet = hot && hot.length ? new Set([...HOT, ...hot]) : HOT;
  const fromText = typeof value === "string" ? parseJsonText(value) : undefined;
  const wire = fromText === undefined ? splitWire(value) : undefined;
  if (wire) {
    return (
      <div className="jwire" data-testid={testId ? `${testId}-box` : undefined}>
        <pre className="json json--raw json--wirehead" tabIndex={0} aria-label={label ? `${label} headers` : "Headers"} data-testid={testId ? `${testId}-head` : undefined}>{visible(wire.head)}</pre>
        <Json value={wire.body} label={label ? `${label} body` : "Body"} testId={testId ? `${testId}-body` : undefined} toggle={toggle} hot={hot} />
      </div>
    );
  }
  const data = fromText !== undefined ? fromText : value;
  const isJson = typeof data === "object" && data !== null;
  // A string is shown EXACTLY as given in the JSON view (a hashed or signed payload must not be re-serialized: key order, number text, spacing).
  // The Form view reads the parsed value. Only a value that is an object or array is laid out with JSON.stringify.
  const text = typeof value === "string" ? value : isJson ? JSON.stringify(data, null, 2) : JSON.stringify(value);
  // Safety: a very large payload is shown as plain text (no colouring, no form) so a page can never freeze on it.
  if (text.length > MAX_PANE_CHARS) {
    return (
      <div className="jsonbox" data-testid={testId ? `${testId}-box` : undefined} data-view="text">
        <pre className="json json--raw" tabIndex={0} aria-label={label} data-testid={testId}>{visible(text)}</pre>
      </div>
    );
  }
  const asForm = isJson && mode === "form";
  return (
    <div className="jsonbox" data-testid={testId ? `${testId}-box` : undefined} data-view={isJson ? mode : "text"}>
      {isJson && toggle && (
        <span className="jsonbox__toggle" role="group" aria-label={`${label || "JSON"} view`}>
          <button type="button" aria-pressed={asForm} onClick={() => setView("form")} data-testid={testId ? `${testId}-formatted` : undefined}>Form</button>
          <button type="button" aria-pressed={!asForm} onClick={() => setView("raw")} data-testid={testId ? `${testId}-raw` : undefined}>JSON</button>
        </span>
      )}
      {asForm
        ? <div className="json json--form" tabIndex={0} role="group" aria-label={label} data-testid={testId}><Form value={data} hot={hotSet} /></div>
        : <pre className="json json--raw" tabIndex={0} aria-label={label} data-testid={testId}>{isJson ? <RawJson text={text} hot={hotSet} /> : kindOf(text) === "token" ? <Jwt text={text} /> : visible(text)}</pre>}
    </div>
  );
}


// ---- Decoded tokens (Rule 24b, owner 2026-11-18): every whole JWT a value carries is also shown decoded ---------------------------------------------------------------------------------------
// Under the pane, one card per token named by its field path: Header, Payload, Signature, each the standard Form | JSON pane.
// `decode={false}` marks a pane that IS a decoded part of a token (or a lab viewer that decodes itself), so a token is never decoded twice.
// A token that is cut short or is not a JWT is skipped; at most six per pane and eight levels deep; every string is rendered as text through visible().
const WHOLE_JWT = /^(?:(?:Bearer|DPoP) )?(eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*)$/;
const DECODE_MAX = 6;
const DECODE_DEPTH = 8;

export function decodeSegment(seg) {
  const t = seg.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

export function decodedTokensIn(v, path = "", out = [], depth = 0) {
  if (out.length >= DECODE_MAX || depth > DECODE_DEPTH) return out;
  if (typeof v === "string") {
    const m = WHOLE_JWT.exec(v.trim());
    if (m) {
      if (!out.some((o) => o.raw === m[1])) {
        try { const [h, c, s] = m[1].split("."); const header = decodeSegment(h); const claims = decodeSegment(c); if (header && claims) out.push({ name: path || "token", raw: m[1], header, claims, signature: s }); } catch { /* not a decodable JWT */ }
      }
      return out;
    }
    // JSON that arrives as text (a body, a log line) is searched too, as the pane itself would show it.
    const inner = depth < 3 ? parseJsonText(v) : undefined;
    if (inner !== undefined) return decodedTokensIn(inner, path, out, depth + 1);
    return out;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => decodedTokensIn(x, `${path}[${i}]`, out, depth + 1)); return out; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) decodedTokensIn(x, path ? `${path}.${k}` : k, out, depth + 1);
  return out;
}

// One token in the jwt.io order: Header, Payload, Signature. The signature is shown as sent; the receiving server is the one that checks it
// (this pane decodes, it never verifies). A token the lab only has a masked form of shows a note instead.
export function TokenParts({ header, claims, raw, label, hot, claimsTestId }) {
  const signature = typeof raw === "string" ? WHOLE_JWT.exec(raw.trim())?.[1].split(".")[2] ?? null : null;
  return (
    <>
      <p className="jdec__h">Header</p>
      <Json value={header} label={`${label} header`} decode={false} />
      <p className="jdec__h">Payload</p>
      <Json value={claims} label={`${label} payload`} decode={false} hot={hot} testId={claimsTestId} />
      <p className="jdec__h">Signature</p>
      {signature ? <Json value={signature} label={`${label} signature`} decode={false} /> : <p className="jdec__none">This token has no signature segment.</p>}
    </>
  );
}

export function DecodedTokens({ value, label, hot }) {
  const toks = decodedTokensIn(value);
  if (!toks.length) return null;
  return (
    <div className="jdec" role="group" aria-label={`${label || "JSON"} decoded tokens`} data-testid="decoded-tokens">
      <p className="jdec__h">Decoded {toks.length === 1 ? "token" : "tokens"}</p>
      {toks.map((t) => (
        <article key={`${t.name}-${t.raw.slice(-12)}`} className="jdec__card" data-testid="decoded-token">
          <p className="jdec__name">{visible(t.name)}</p>
          <TokenParts header={t.header} claims={t.claims} raw={t.raw} label={`${label || "JSON"} ${t.name}`} hot={hot} />
        </article>
      ))}
    </div>
  );
}

export function Json({ decode = true, ...props }) {
  const pane = <JsonPane {...props} />;
  return decode ? <>{pane}<DecodedTokens value={props.value} label={props.label} hot={props.hot} /></> : pane;
}

export default Json;
