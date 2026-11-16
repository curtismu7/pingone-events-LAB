import React, { useEffect, useState } from "react";

// VerifyMark: the Verified / In progress mark of an app, as the shelf (demo-shelf-LAB) records it. One badge for every app and for the shelf
// itself; vendored byte for byte, never edited in an app (see README.md). The words ("Verified", "In progress") and their meanings come from
// the shelf's one definition (server/src/verification.js there), never from this file.
//
//   <VerifyBadge mark={demo.verification} />        the badge for a mark you already hold ({ status, label, note, updatedAt, source })
//   <VerifyMark id="a2a-lab" />                      an app's own mark: finds its entry in GET /api/shelf (the same call ShelfLink makes)
//
// Both render nothing when there is no mark, when the mark is "none", while loading, and when the shelf cannot be reached: never an error,
// never a placeholder. `note` shows the note under the label (the shelf's cards do); off, the note is the badge's tooltip instead.
//
// <VerifyMark> takes the same request options as ShelfLink so it can sit beside it in any lab: `path` (default "/api/shelf"), `headers` (an object, or a
// function returning one, evaluated when the request fires: a lab that sends X-Workspace-Id on every request passes the same function it gives ShelfLink)
// and `traceparent` (a function returning a W3C traceparent value, for labs whose tests assert one on every request).

export function VerifyBadge({ mark, note = true, className = "" }) {
  if (!mark || mark.status === "none") return null;
  const local = mark.source === "local";
  const title = [!note && mark.note, mark.updatedAt && `Marked ${mark.updatedAt}`, local && "set on this machine, not shipped with the shelf"].filter(Boolean).join(". ");
  return (
    <div className={`verify ${className}`.trim()} data-status={mark.status} title={title || undefined}>
      <span className="verify__badge">
        <svg className="verify__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <circle className="verify__ring" cx="8" cy="8" r="7" />
          <path className="verify__tick" d="M4.6 8.4l2.3 2.3 4.5-4.8" />
        </svg>
        {mark.label}
      </span>
      {note && mark.note && <span className="verify__note">{mark.note}</span>}
      {note && local && <span className="verify__local">Set on this machine</span>}
    </div>
  );
}

export default function VerifyMark({ id, path = "/api/shelf", headers, traceparent, note = false, className = "" }) {
  const [mark, setMark] = useState(null);
  useEffect(() => {
    let alive = true;
    const extra = typeof headers === "function" ? headers() : (headers ?? {});
    fetch(path, { credentials: "omit", headers: { Accept: "application/json", ...extra, ...(traceparent ? { traceparent: traceparent() } : {}) } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setMark(d?.demos?.find((x) => x.id === id)?.verification ?? null); })
      .catch(() => { /* no shelf, no mark */ });
    return () => { alive = false; };
  }, [id, path]); // eslint-disable-line react-hooks/exhaustive-deps
  return <VerifyBadge mark={mark} note={note} className={className} />;
}
