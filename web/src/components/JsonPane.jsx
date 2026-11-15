import { useSyncExternalStore } from "react";
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
const nestedValue = (v) => !prim(v) && !(Array.isArray(v) && v.every(prim));
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
    return (
      <dl className="jform" data-depth={Math.min(depth, 3)}>
        {entries.map(([key, v]) => (
          <div key={key} className="jform__row" data-hot={hot.has(key) ? "true" : undefined} data-alert={ALERT.has(key) ? "true" : undefined} data-nested={nestedValue(v) ? "true" : undefined}>
            <dt className="jform__k">{visible(key)}</dt>
            <dd className="jform__d">{prim(v) ? <Value v={v} k={key} hot={hot} /> : <Form value={v} hot={hot} k={key} depth={depth + 1} />}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <Value v={value} k={k} />;
}

// ---- The pane ---------------------------------------------------------------------------------------------------------------------------------
// value: an object or array (or a string holding one) gets the Form | JSON choice; `hot` (optional array of key names) stands those keys out in both views; a string (a token, or text) is shown as it is, a token in its three colours.
export function Json({ value: given, label, testId, toggle = true, hot }) {
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

export default Json;
