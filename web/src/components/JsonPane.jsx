import { useSyncExternalStore } from "react";
import { visible } from "../safeText";

// View preference: a tiny per-lab store (localStorage, best effort). The lab does not need
// evidence/lanes for this — the pane persists its own Formatted | Raw choice.
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
//   Formatted = a FORM: a label and a read-only value box per field, nested objects as indented groups, scopes and audiences as chips,
//               timestamps with their date, true / false as chips. It is not coloured JSON.
//   Raw       = the exact JSON text, coloured by what each part is (keys, strings, numbers, true / false, null, urls, ids, tokens with their three
//               segments each in a colour, and the important claims and errors stood out).
// Everything is rendered as React text (never markup) and passes `visible()`, so control and bidi characters show as escapes. Tokens are shown whole.

const KEY = "aag.json.view";
let view = readPref(KEY, (v) => v === "form" || v === "raw", "form");
const subs = new Set();
const setView = (v) => { view = v; writePref(KEY, v); subs.forEach((f) => f()); };
export const setJsonView = setView; // for tests: the choice is module state, shared by every pane
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

const prim = (v) => v === null || typeof v !== "object";
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

function RawJson({ text }) {
  let key = "";
  return scan(text).map((t, i) => {
    if (t.kind === "key") {
      key = t.text.slice(1, -1);
      return <span key={i} className={`jtok jtok--${HOT.has(key) ? "hot" : ALERT.has(key) ? "alert" : "key"}`}>{visible(t.text)}</span>;
    }
    if (t.kind === "string") {
      let inner = t.text.slice(1, -1);
      try { inner = JSON.parse(t.text); } catch { /* keep the escaped text */ }
      const k = kindOf(inner, key);
      if (k === "token") return <span key={i} className="jtok jtok--plain">"<Jwt text={inner} />"</span>;
      return <span key={i} className={`jtok jtok--${k === "string" && ALERT.has(key) ? "alert" : k === "string" && HOT.has(key) ? "hot" : k}`}>{visible(t.text)}</span>;
    }
    if (t.kind === "number") return <span key={i} className={`jtok jtok--${TIME_KEYS.has(key) ? "time" : "number"}`}>{t.text}</span>;
    return <span key={i} className={`jtok jtok--${t.kind}`}>{visible(t.text)}</span>;
  });
}

// ---- Formatted: a form ------------------------------------------------------------------------------------------------------------------------
function Value({ v, k }) {
  const kind = kindOf(v, k);
  if (kind === "null") return <span className="jform__v jform__v--null">none</span>;
  if (kind === "bool") return <span className="jform__chip" data-on={v ? "true" : "false"}>{v ? "true" : "false"}</span>;
  if (kind === "token") return <span className="jform__v jform__v--token"><Jwt text={v} /></span>;
  if (typeof v === "string" && SPLIT.has(k) && /\s/.test(v.trim())) return <ChipList items={v.trim().split(/\s+/)} k={k} />;
  if (kind === "time") { const d = typeof v === "number" ? date(v) : null; return <span className="jform__v jform__v--time">{visible(String(v))}{d && <span className="jform__sub"> {d}</span>}</span>; }
  return <span className={`jform__v jform__v--${kind}`}>{visible(String(v))}</span>;
}

function ChipList({ items, k }) {
  if (!items.length) return <span className="jform__v jform__v--null">none</span>;
  return <ul className="jform__chips" data-hot={HOT.has(k) ? "true" : undefined}>{items.map((x, i) => <li key={`${x}-${i}`} className="jform__chip">{visible(String(x))}</li>)}</ul>;
}

function Form({ value, k = "", depth = 0 }) {
  if (Array.isArray(value)) {
    if (value.every(prim)) return <ChipList items={value} k={k} />;
    return (
      <ol className="jform__list">
        {value.map((x, i) => <li key={i}><span className="jform__idx">{i + 1}</span><Form value={x} depth={depth + 1} /></li>)}
      </ol>
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return <span className="jform__v jform__v--null">empty</span>;
    return (
      <dl className="jform" data-depth={Math.min(depth, 3)}>
        {entries.map(([key, v]) => (
          <div key={key} className="jform__row" data-hot={HOT.has(key) ? "true" : undefined} data-alert={ALERT.has(key) ? "true" : undefined}>
            <dt className="jform__k">{visible(key)}</dt>
            <dd className="jform__d">{prim(v) ? <Value v={v} k={key} /> : <Form value={v} k={key} depth={depth + 1} />}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <Value v={value} k={k} />;
}

// ---- The pane ---------------------------------------------------------------------------------------------------------------------------------
// value: an object or array gets the Formatted | Raw choice; a string (a token, or text) is shown as it is, a token in its three colours.
export function Json({ value, label, testId, toggle = true }) {
  const mode = useView();
  const isJson = typeof value === "object" && value !== null;
  const text = isJson ? JSON.stringify(value, null, 2) : typeof value === "string" ? value : JSON.stringify(value);
  const asForm = isJson && mode === "form";
  return (
    <div className="jsonbox" data-testid={testId ? `${testId}-box` : undefined} data-view={isJson ? mode : "text"}>
      {isJson && toggle && (
        <span className="jsonbox__toggle" role="group" aria-label={`${label || "JSON"} view`}>
          <button type="button" aria-pressed={asForm} onClick={() => setView("form")} data-testid={testId ? `${testId}-formatted` : undefined}>Formatted</button>
          <button type="button" aria-pressed={!asForm} onClick={() => setView("raw")} data-testid={testId ? `${testId}-raw` : undefined}>Raw</button>
        </span>
      )}
      {asForm
        ? <div className="json json--form" tabIndex={0} role="group" aria-label={label} data-testid={testId}><Form value={value} /></div>
        : <pre className="json json--raw" tabIndex={0} aria-label={label} data-testid={testId}>{isJson ? <RawJson text={text} /> : kindOf(text) === "token" ? <Jwt text={text} /> : visible(text)}</pre>}
    </div>
  );
}

export default Json;
