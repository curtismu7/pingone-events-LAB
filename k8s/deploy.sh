#!/usr/bin/env bash
# Deploy PingOne Events Lab to the SE cluster. The first SE deploy of an app is OWNER-APPROVED: a real apply refuses unless OWNER_APPROVED=1.
# This script never builds or pushes an image and never touches the Secret: the owner creates it (k8s/secret.example.yaml is only a template).
#
#   KUBE_CONTEXT=<ctx> NAMESPACE=<ns> IMAGE=<registry>/<path>:sha-<hex> SE_HOST=<host PingOne posts to> UI_HOST=<the page's host> CLUSTER_ISSUER=<issuer> \
#     k8s/deploy.sh --dry-run
#   OWNER_APPROVED=1 KUBE_CONTEXT=... NAMESPACE=... IMAGE=... SE_HOST=... UI_HOST=... CLUSTER_ISSUER=... \
#     WEBHOOK_BASIC_USER=... WEBHOOK_BASIC_PASSWORD=... k8s/deploy.sh
#
# KUBE_CONTEXT is REQUIRED and is passed to every kubectl call: there is no ambient context, so a shell left on another cluster cannot be deployed to.
# IMAGE must be an immutable reference: a tag of the form sha-<7-40 hex digits>, or an @sha256:<64 hex> digest. latest, HEAD, an untagged name and any
# other mutable tag are refused.
#
# Before anything is applied, a READ-ONLY preflight lists the existing ingress hosts and paths that touch SE_HOST or UI_HOST and FAILS when another ingress
# already uses the same host and path. If the cluster cannot be read, it says so and stops, unless ALLOW_NO_PREFLIGHT=1.
# --dry-run runs that preflight, renders every manifest, prints it, and FAILS if any __TOKEN__ is left unreplaced. It changes nothing.
#
# After an apply it verifies by CONTENT, not by a 200: the pod's own /api/health must say demo-health/1, ready, and this app; the pod's receiver and page
# answer 401 without a credential; the pod's imageID matches IMAGE (and the registry digest when docker can read it); and the PUBLIC ingress path works:
# HEAD on https://SE_HOST/webhook/pingone-events answers 200 with the webhook credential (WEBHOOK_BASIC_USER / WEBHOOK_BASIC_PASSWORD from your
# environment, never printed and never on a command line) and 401 without it, and https://UI_HOST/api/info answers 401 without a credential. DNS and
# the certificate can take minutes: the public checks retry (PUBLIC_CHECK_ATTEMPTS, default 30, every PUBLIC_CHECK_SLEEP seconds, default 10).
# It does not hand over a URL: do that after browser proof.
# The client address: the ingress must set or append X-Forwarded-For (nginx-ingress does by default). The app trusts exactly one hop (the right-most entry).
# Updating later: apply again with a new IMAGE. If you use kubectl set image, NAME THE CONTAINER (app=...), never '*=', and read the new ReplicaSet.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "refusing: $*" >&2; exit 2; }
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
for v in KUBE_CONTEXT NAMESPACE IMAGE SE_HOST UI_HOST CLUSTER_ISSUER; do [ -n "${!v:-}" ] || die "set $v (see the usage lines at the top of this file)"; done
case "$KUBE_CONTEXT" in *[!A-Za-z0-9._@:/-]*) die "KUBE_CONTEXT has characters that are not allowed";; esac
# Strictly immutable: sha-<hex> tag or an @sha256 digest, on a plain registry path.
[[ "$IMAGE" =~ ^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9._/-]+)*(:sha-[0-9a-f]{7,40}|@sha256:[0-9a-f]{64})$ ]] || die "IMAGE must end in :sha-<7-40 hex digits> or @sha256:<64 hex digits> (latest, HEAD, untagged and other mutable tags are refused)"
[[ "$NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "NAMESPACE must be a plain DNS label"
HOST_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
for v in SE_HOST UI_HOST; do val=${!v}; { [[ "$val" =~ $HOST_RE ]] && [ "${#val}" -le 253 ]; } || die "$v must be a fully qualified lower-case host name (at least two labels; letters, digits and hyphens; no leading or trailing dot or hyphen)"; done
[ "$SE_HOST" != "$UI_HOST" ] || die "SE_HOST (where PingOne posts) and UI_HOST (the page) must be different hosts"
[[ "$CLUSTER_ISSUER" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "CLUSTER_ISSUER must be a plain name"

k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

# Placeholders are the literal tokens __IMAGE__, __SE_HOST__, __UI_HOST__ and __CLUSTER_ISSUER__. Any other token left over fails.
render() {
  local out
  out=$(sed -e "s|__IMAGE__|$IMAGE|g" -e "s|__SE_HOST__|$SE_HOST|g" -e "s|__UI_HOST__|$UI_HOST|g" -e "s|__CLUSTER_ISSUER__|$CLUSTER_ISSUER|g" "$1")
  if grep -qE '__[A-Z_]+__' <<<"$out"; then echo "refusing: unreplaced __TOKEN__ in $1: $(grep -oE '__[A-Z_]+__' <<<"$out" | sort -u | tr '\n' ' ')" >&2; exit 2; fi
  printf '%s\n---\n' "$out"
}
# Apply order: storage, policy, workload, service, then the two ingresses. secret.example.yaml is deliberately NOT in this list.
FILES=(pvc.yaml networkpolicy.yaml deployment.yaml service.yaml certificate.yaml ingress-webhook.yaml ingress-ui.yaml)

# ---- read-only preflight: does another ingress already use these hosts and paths? ----
preflight() {
  command -v node >/dev/null 2>&1 || die "node is needed for the ingress preflight"
  local tmp; tmp=$(mktemp); trap 'rm -f "$tmp"' RETURN
  if ! k get ingress -A -o json >"$tmp" 2>/dev/null && ! k -n "$NAMESPACE" get ingress -o json >"$tmp" 2>/dev/null; then
    echo "preflight: the cluster could not be read with context '$KUBE_CONTEXT' (unreachable, no permission, or no such context)" >&2
    [ "${ALLOW_NO_PREFLIGHT:-}" = "1" ] && { echo "preflight: continuing without it because ALLOW_NO_PREFLIGHT=1" >&2; return 0; }
    die "could not run the ingress preflight (set ALLOW_NO_PREFLIGHT=1 to continue without it)"
  fi
  SE_HOST="$SE_HOST" UI_HOST="$UI_HOST" NAMESPACE="$NAMESPACE" node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const ours = (i) => i.metadata.namespace === process.env.NAMESPACE && /^pingone-events-lab-(webhook|ui)$/.test(i.metadata.name);
    let bad = 0; const lines = [];
    for (const i of j.items || []) for (const r of i.spec?.rules || []) {
      if (r.host !== process.env.SE_HOST && r.host !== process.env.UI_HOST) continue;
      for (const p of r.http?.paths || [{ path: "(no paths)" }]) {
        const mine = ours(i);
        const clash = !mine && ((r.host === process.env.UI_HOST) || (r.host === process.env.SE_HOST && p.path === "/webhook/pingone-events"));
        lines.push(`${clash ? "COLLISION" : mine ? "ours     " : "existing "} ${r.host} ${p.path} (${i.metadata.namespace}/${i.metadata.name})`);
        if (clash) bad += 1;
      }
    }
    console.log(lines.length ? lines.join("\n") : "(no existing ingress uses either host)");
    process.exit(bad ? 3 : 0);
  ' "$tmp" || { echo "preflight: another ingress already uses the same host and path" >&2; exit 2; }
}
echo "# preflight (read-only): existing ingress hosts and paths for $SE_HOST and $UI_HOST, context $KUBE_CONTEXT"
preflight

if [ "$DRY" = 1 ]; then
  echo "# DRY RUN: would apply to namespace '$NAMESPACE' (nothing is sent to the cluster)"
  for f in "${FILES[@]}"; do echo "# --- $f"; render "$f"; done
  exit 0
fi

[ "${OWNER_APPROVED:-}" = "1" ] || die "the first SE deploy of each app is owner-approved (set OWNER_APPROVED=1)"
# The webhook credential is needed for the public-path verification; check it BEFORE changing anything. It must be safe to put in a curl config line.
for v in WEBHOOK_BASIC_USER WEBHOOK_BASIC_PASSWORD; do [ -n "${!v:-}" ] || die "set $v (the webhook credential the Secret holds): the deploy verifies the public webhook path with it"; [[ "${!v}" != *[\"\\]* && "${!v}" != *$'\n'* ]] || die "$v must not contain a quote, a backslash or a newline"; done
# Render everything BEFORE touching the cluster, so a leftover token cannot cause a half-applied deployment.
RENDERED=(); for f in "${FILES[@]}"; do RENDERED+=("$(render "$f")"); done
k -n "$NAMESPACE" get secret pingone-events-lab >/dev/null 2>&1 || die "the Secret 'pingone-events-lab' does not exist in $NAMESPACE: the owner creates it first (see k8s/secret.example.yaml); the pod would not start without it"
for r in "${RENDERED[@]}"; do printf '%s\n' "$r" | k apply -n "$NAMESPACE" -f -; done
k -n "$NAMESPACE" rollout status deployment/pingone-events-lab --timeout=180s

# ---- verify by content: inside the pod ----
fetch_js='const [m,p]=process.argv.slice(1);fetch("http://127.0.0.1:7802"+p,{method:m}).then(async r=>{const t=await r.text();console.log(JSON.stringify({status:r.status,body:t.slice(0,400)}))}).catch(e=>{console.log(JSON.stringify({error:String(e)}));process.exit(1)})'
pod_get() { k -n "$NAMESPACE" exec deploy/pingone-events-lab -c app -- node -e "$fetch_js" "$1" "$2"; }
health=$(pod_get GET /api/health)
grep -q '"schema\\":\\"demo-health/1' <<<"$health" && grep -q '"state\\":\\"ready' <<<"$health" && grep -q '\\"id\\":\\"pingone-events-lab' <<<"$health" || { echo "verify FAILED: /api/health did not say demo-health/1, ready, id pingone-events-lab: $health" >&2; exit 1; }
echo "verify ok: /api/health says demo-health/1, ready, pingone-events-lab"
for probe in "HEAD /webhook/pingone-events" "GET /api/info"; do
  set -- $probe; got=$(pod_get "$1" "$2"); grep -q '"status":401' <<<"$got" || { echo "verify FAILED: $probe did not answer 401 without a credential (fail closed): $got" >&2; exit 1; }
  echo "verify ok: in the pod, $probe answers 401 without a credential"
done
image_id=$(k -n "$NAMESPACE" get pod -l app=pingone-events-lab -o jsonpath='{.items[0].status.containerStatuses[0].imageID}')
want_repo=${IMAGE%%@*}; want_repo=${want_repo%:*}
case "$image_id" in *"${want_repo##*/}"*) ;; *) echo "verify FAILED: pod imageID '$image_id' does not match IMAGE $IMAGE" >&2; exit 1;; esac
if [[ "$IMAGE" == *@sha256:* ]]; then case "$image_id" in *"${IMAGE##*@sha256:}"*) ;; *) echo "verify FAILED: pod imageID '$image_id' does not carry the digest in IMAGE" >&2; exit 1;; esac; fi
echo "verify ok: pod imageID is $image_id"
if command -v docker >/dev/null 2>&1; then
  digest=$(docker --context orbstack buildx imagetools inspect "$IMAGE" --format '{{.Manifest.Digest}}' 2>/dev/null || true)
  if [ -n "$digest" ]; then case "$image_id" in *"$digest"*) echo "verify ok: registry digest $digest matches the pod";; *) echo "verify FAILED: registry digest $digest is not in the pod imageID $image_id" >&2; exit 1;; esac
  else echo "note: could not read the registry manifest; compare it by hand: docker buildx imagetools inspect $IMAGE"; fi
fi

# ---- verify by content: through the PUBLIC ingress ----
code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || echo 000; }
# The credential reaches curl on stdin as a config line: it is never on a command line (so never in ps) and never printed.
code_with_cred() { printf 'user = "%s:%s"\n' "$WEBHOOK_BASIC_USER" "$WEBHOOK_BASIC_PASSWORD" | code -K - "$@"; }
expect() { # label, wanted, command...
  local label=$1 want=$2; shift 2; local n=${PUBLIC_CHECK_ATTEMPTS:-30} got=000 i
  for ((i = 1; i <= n; i++)); do got=$("$@"); [ "$got" = "$want" ] && { echo "verify ok: $label -> $got"; return 0; }; [ "$i" -lt "$n" ] && sleep "${PUBLIC_CHECK_SLEEP:-10}"; done
  echo "verify FAILED: $label -> $got (wanted $want) after $n attempt(s): DNS, the certificate or the ingress may not be ready, or the credential is wrong" >&2; exit 1
}
expect "public HEAD https://$SE_HOST/webhook/pingone-events with the webhook credential" 200 code_with_cred -I "https://$SE_HOST/webhook/pingone-events"
expect "public HEAD https://$SE_HOST/webhook/pingone-events without a credential" 401 code -I "https://$SE_HOST/webhook/pingone-events"
expect "public GET https://$UI_HOST/api/info without a credential" 401 code "https://$UI_HOST/api/info"
echo "deployed. Hand over the URL only after browser proof; PingOne's destination is https://$SE_HOST/webhook/pingone-events"
