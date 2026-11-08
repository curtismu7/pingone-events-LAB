import { visible } from "./safeText";

// Short, readable forms of long ids and times. The full values are always one click away in the detail panel.
export const shortId = (s, n = 8) => { const t = visible(s || ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
export const clock = (iso) => (typeof iso === "string" && iso.length >= 19 ? iso.slice(11, 19) : "");
export const when = (iso) => (typeof iso === "string" && iso.length >= 19 ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z` : "never");
export const statusClass = (s) => { const t = String(s || "").toUpperCase(); return /FAIL|DENIED|ERROR|HIGH/.test(t) ? "chip chip--danger" : /SUCCESS|OK|ALLOWED/.test(t) ? "chip chip--ok" : t ? "chip chip--info" : "chip"; };
