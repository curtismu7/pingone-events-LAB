import { useCallback, useEffect, useState } from "react";
import Events from "./components/Events";
import Delivery from "./components/Delivery";
import Forward from "./components/Forward";
import Setup from "./components/Setup";
import DiagramTab from "./components/DiagramTab";
import TalkTrack from "./components/TalkTrack";
import { getJson, resetWorkspace, setMode } from "./api";

export const TABS = [
  { id: "events", label: "Events" },
  { id: "delivery", label: "Delivery" },
  { id: "forward", label: "Forward" },
  { id: "pipeline", label: "Pipeline" },
  { id: "setup", label: "Setup" },
  { id: "talk", label: "Talk track" },
];
// The banner is never blank: until /api/scenarios answers (or if it fails) it says the safe thing.
export const BANNER_UNKNOWN = "SIMULATED: synthetic PingOne events and a pretend cluster. Nothing here is sent to PingOne or to any Elasticsearch or OpenSearch cluster.";
const SAY = { events: ["say-first", "receive", "join"], delivery: ["health", "silent"], forward: ["forward", "unverified"], pipeline: ["say-first"], setup: ["pull", "kibana"] };
const THEMES = ["auto", "light", "dark"];

const hashParts = () => {
  const h = window.location.hash.replace("#", "");
  const m = /^scenario-([a-z0-9-]{1,40})$/.exec(h);
  if (m) return { tab: "events", scenario: m[1] };
  return { tab: TABS.some((t) => t.id === h) ? h : "events", scenario: null };
};
const savedTheme = () => { try { const t = window.localStorage.getItem("pev.theme"); return THEMES.includes(t) ? t : "auto"; } catch { return "auto"; } };

export default function App() {
  const [vertical, setVertical] = useState("retail");
  const [story, setStory] = useState(null);
  const [info, setInfo] = useState(undefined); // undefined = loading, null = failed
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(hashParts().tab);
  const [requested, setRequested] = useState(hashParts().scenario);
  const [presenter, setPresenter] = useState(false);
  const [dataSignal, setDataSignal] = useState(0); // bump = every panel reloads its data
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState(savedTheme);
  const bump = useCallback(() => setDataSignal((n) => n + 1), []);

  const loadInfo = useCallback(() => getJson("/api/info").then(setInfo, () => setInfo(null)), []);
  useEffect(() => { loadInfo(); }, [loadInfo]);
  useEffect(() => { getJson(`/api/scenarios?vertical=${encodeURIComponent(vertical)}`).then((j) => { setStory(j); setError(null); }, (e) => setError(e.message)); }, [vertical]);
  useEffect(() => {
    const on = () => { const p = hashParts(); setTab(p.tab); setRequested(p.scenario); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", theme);
    try { window.localStorage.setItem("pev.theme", theme); } catch { /* storage blocked */ }
  }, [theme]);
  const select = useCallback((id) => { setTab(id); setRequested(null); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } }, []);
  const pickScenario = useCallback((sid) => { try { window.history.replaceState(null, "", `#scenario-${sid}`); } catch { /* ignore */ } }, []);

  useEffect(() => {
    const on = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const reset = useCallback(async () => {
    const ok = await resetWorkspace().catch(() => false);
    bump();
    setNotice(ok ? "Reset: your Mock events, delivery scenario, counters and pretend cluster are back to defaults. Real events are kept." : "Reset failed on the server; the view was reloaded.");
  }, [bump]);

  // Rule 19: switch server-side, then reload every panel's data (no page reload, no restart).
  const switchTo = async (source) => {
    if (info?.mode === source) return;
    const res = await setMode(source).catch(() => ({ ok: false, body: {} }));
    if (!res.ok) { setNotice(res.body?.detail || "Could not switch mode."); return; }
    await loadInfo(); bump();
    setNotice(`Switched to ${source === "real" ? "Real" : "Mock"}: all data reloaded.`);
  };

  const real = info?.mode === "real";
  const banner = story ? (real ? story.realBanner : story.banner) : BANNER_UNKNOWN;
  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header className="shell-bar">
        <span className="shell-brand"><img className="shell-logo" src="/ping-logo.png" alt="Ping Identity" width="30" height="30" />PingOne Events Lab <span className="shell-badge" data-testid="mode">{info ? (real ? "Real" : "Mock") : "..."}</span></span>
        <nav className="shell-nav" aria-label="Sections">
          {TABS.map((t) => <a key={t.id} id={`tab-${t.id}`} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined} onClick={(e) => { e.preventDefault(); select(t.id); }}>{t.label}</a>)}
        </nav>
        <span className="shell-right">
          {info && (
            <span className="seg" role="group" aria-label="Data source" data-testid="mode-toggle">
              <button type="button" aria-pressed={!real} data-testid="mode-mock" onClick={() => switchTo("mock")}>Mock</button>
              <button type="button" aria-pressed={real} data-testid="mode-real" disabled={!info.realAvailable && !real}
                title={info.realAvailable ? "Show real events: delivered by PingOne, or pulled read-only" : info.realHint || "Real is not configured. Mock keeps working."}
                onClick={() => switchTo("real")}>Real</button>
            </span>
          )}
          <button type="button" onClick={reset} data-testid="reset">Reset</button>
          <button type="button" aria-pressed={presenter} onClick={() => setPresenter((v) => !v)} data-testid="presenter">{presenter ? "Exit presenter (Esc)" : "Presenter (P)"}</button>
          <label className="shell-theme">Theme <select value={theme} onChange={(e) => setTheme(e.target.value)} data-testid="theme" aria-label="Theme">{THEMES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        </span>
      </header>
      <main>
        <p className="banner" role="note" data-testid="banner" data-state={real ? "live" : undefined}>{banner}</p>
        <div className="head">
          <div>
            <h1>PingOne Events Lab</h1>
            {!presenter && story && <p className="intro">{story.intro}</p>}
          </div>
          {!presenter && (
            <label className="inline">Vertical{" "}
              <select value={vertical} onChange={(e) => setVertical(e.target.value)}>{(story ? story.verticals : ["retail"]).map((v) => <option key={v} value={v}>{v}</option>)}</select>
            </label>
          )}
        </div>
        <p className="sr-only" role="status" aria-live="polite" data-testid="status">{notice}</p>
        {notice && !presenter && <p className="muted" data-testid="notice">{notice}</p>}
        {info === null && <p className="app-error" role="alert">Could not read the app&apos;s settings. Is the server running?</p>}
        <div id={`panel-${tab}`} role="region" aria-labelledby={`tab-${tab}`}>
          {error ? <p className="app-error" role="alert">Could not load the lab ({error}). Is the server running?</p> : !story ? <p className="muted">Loading...</p> : (
            <>
              {presenter && tab !== "talk" && (
                <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
                  {story.talkTrack.filter((t) => (SAY[tab] || ["say-first"]).includes(t.id)).map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
                </aside>
              )}
              {tab === "events" && <Events key={vertical} story={story} info={info} dataSignal={dataSignal} requestedId={requested} onSelect={pickScenario} onChanged={bump} goTab={select} />}
              {tab === "delivery" && <Delivery story={story} info={info} dataSignal={dataSignal} onChanged={bump} />}
              {tab === "forward" && <Forward story={story} info={info} dataSignal={dataSignal} onChanged={bump} />}
              {tab === "pipeline" && <DiagramTab vertical={vertical} resetSignal={dataSignal} />}
              {tab === "setup" && <Setup story={story} />}
              {tab === "talk" && <TalkTrack talk={story.talkTrack} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
