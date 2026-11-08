// Rule 13: a workspace id keeps one visitor's Mock state apart from another's, and every API call that touches server state sends it as X-Workspace.
// The browser uses the `default` workspace (the one `npm run reset` and POST /api/reset act on without a header), unless the page is opened with
// ?workspace=<id> to get a separate, isolated Mock state (letters, digits and dashes, up to 40).
const OK = /^[a-z0-9-]{1,40}$/;
let memo = null;

export function workspaceId() {
  if (memo) return memo;
  let q = null;
  try { q = new URLSearchParams(window.location.search).get("workspace"); } catch { /* no location */ }
  memo = q && OK.test(q) ? q : "default";
  return memo;
}

export const workspaceFetch = (url, opts = {}) => fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}), "x-workspace": workspaceId() } });
