// Json: raw JSON rendered as text only (never markup). Control and bidi characters are shown as visible escapes.
// Family shared service (owner, 2026-11-13): vendor it, never edit a lab's copy. Depends on the lab's
// web/src/safeText.js `visible()` (same contract as the per-lab copies it replaces).
import { visible } from "../safeText";

export default function Json({ value, label, testId }) {
  return <pre className="json" tabIndex={0} aria-label={label} data-testid={testId}>{visible(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre>;
}
