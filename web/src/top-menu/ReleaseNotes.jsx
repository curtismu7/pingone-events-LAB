import React, { useEffect, useRef } from "react";

// ReleaseNotes: what the version button opens. A small modal dialog with this
// release's notes; Esc and the Close button dismiss it, a click on the backdrop
// does not (so a stray click during a demo cannot close it).
export default function ReleaseNotes({ version, onClose }) {
  const closeRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="rn-backdrop" data-testid="release-notes">
      <dialog className="rn-dialog" open aria-label={`Release notes for version ${version}`}>
        <h2>Token Workbench {version}</h2>
        <ul>
          <li><strong>Real mode maturity.</strong> Decode / Trace and the Profile checker talk to the one configured issuer (PingOne or PingFederate): client_credentials token, real JWKS signature verification, RFC 7662 introspection, metadata profile check, full request trace with the client secret scrubbed.</li>
          <li><strong>Mock/Real toggle</strong> in the header, no restart. Real is owner opt-in and net-guarded: in Mock nothing leaves loopback, in Real only the issuer's origin is reachable.</li>
          <li><strong>Wrong-token tester.</strong> Fifteen cases, each wrong in one way, against a stub MCP-style resource server, with the expected <code>WWW-Authenticate</code> challenge compared to the actual answer.</li>
          <li><strong>OAuth profile checker.</strong> RFC 9700 BCP pack and a simplified (UNVERIFIED) FAPI 2.0 pack, with evidence per rule and honest NOT CHECKED cards for active-probe rules.</li>
          <li><strong>Token-flow catalog.</strong> PKCE, PAR, RAR, DPoP, mTLS and JAR, each simulated with and without its protection against the one attack it stops.</li>
          <li><strong>Widened page frame</strong> (2200&nbsp;px) and the shared lab top menu.</li>
        </ul>
        <button type="button" ref={closeRef} onClick={onClose} data-testid="release-notes-close">Close</button>
      </dialog>
    </div>
  );
}
