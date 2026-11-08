import { visible } from "../safeText";

// Raw JSON, rendered as text only (never markup). Control and bidi characters are shown as visible escapes.
export default function Json({ value, label, testId }) {
  return <pre className="json" tabIndex={0} aria-label={label} data-testid={testId}>{visible(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre>;
}
