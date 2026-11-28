import React, { useEffect, useRef, useState } from "react";
import "./mode-modal.css";

// Real-or-mock modal (owner, 2026-11-28; STANDALONE-RULES rule 2): replaces the long simulation banner. It says one thing, MOCK or REAL, in a short
// line, when the page opens and again when the mode changes. Dismissed once per mode per browser session. `suppress` keeps it off the screen while
// something else owns it (Story mode: its own first page says the same). Vendored, never imported across repos.
const seenKey = (prefix, mode) => `${prefix}-seen-${mode}`;
const wasSeen = (prefix, mode) => { try { return sessionStorage.getItem(seenKey(prefix, mode)) === "1"; } catch { return false; } };
const markSeen = (prefix, mode) => { try { sessionStorage.setItem(seenKey(prefix, mode), "1"); } catch { /* private window: it just shows again */ } };

export const DEFAULT_LINES = {
  mock: "Everything on this page is simulated. Nothing here is real.",
  real: "This page runs against your real tenant.",
};

export default function ModeModal({ mode, lines, suppress = false, storageKey = "mode-modal" }) {
  const m = mode === "real" ? "real" : "mock";
  const [dismissed, setDismissed] = useState(() => wasSeen(storageKey, m));
  const button = useRef(null);
  useEffect(() => { setDismissed(wasSeen(storageKey, m)); }, [storageKey, m]);
  const open = !dismissed && !suppress;
  useEffect(() => { if (open && button.current) button.current.focus(); }, [open]);
  if (!open) return null;
  const close = () => { markSeen(storageKey, m); setDismissed(true); };
  const line = (lines && lines[m]) || DEFAULT_LINES[m];
  return (
    <div className="mode-modal-backdrop" onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
      <div className="mode-modal" role="dialog" aria-modal="true" aria-labelledby="mode-modal-word" data-testid="mode-modal" data-mode={m}>
        <div className="mode-modal-word" id="mode-modal-word">{m === "real" ? "REAL" : "MOCK"}</div>
        <p>{line}</p>
        <button type="button" ref={button} onClick={close} data-testid="mode-modal-ok">Got it</button>
      </div>
    </div>
  );
}
