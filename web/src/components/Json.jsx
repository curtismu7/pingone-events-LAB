// Json: family shared service (owner, 2026-11-13), now rendering through JsonPane
// (Rule 24, owner 2026-11-14, amended): Formatted | Raw toggle, colored Raw,
// visible() guard in both modes. The pane reads the lab's guard from
// ../safeText (vendored alongside; wired per the shared README).
import JsonPane from "./JsonPane.jsx";

export default function Json({ value, label, testId }) {
  return <JsonPane value={value} label={label} testId={testId} />;
}
