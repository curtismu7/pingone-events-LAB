#!/usr/bin/env bash
# Deploy PingOne Events Lab to the SE cluster. The first SE deploy of an app is OWNER-APPROVED: a real apply refuses unless OWNER_APPROVED=1.
# This script never builds or pushes an image and never touches the Secret: the owner creates it (k8s/secret.example.yaml is only a template).
#
#   NAMESPACE=<ns> IMAGE=<registry>/<path>:<immutable-tag> SE_HOST=<host PingOne posts to> UI_HOST=<the page's host> CLUSTER_ISSUER=<issuer> \
#     k8s/deploy.sh --dry-run
#   OWNER_APPROVED=1 NAMESPACE=... IMAGE=... SE_HOST=... UI_HOST=... CLUSTER_ISSUER=... k8s/deploy.sh
#
# --dry-run renders every manifest, prints it, and FAILS if any __TOKEN__ is left unreplaced. It never calls kubectl.
# After an apply it verifies by CONTENT, not by a 200: the pod's own /api/health must say demo-health/1, ready, and this app; the receiver
# and the page must answer 401 without a credential (fail closed); and the pod's imageID must match IMAGE (and the registry's manifest, when
# docker is available). It does not hand over a URL: do that after browser proof.
# Updating later: apply again with a new IMAGE. If you use kubectl set image, NAME THE CONTAINER (app=...), never '*=', and read the new ReplicaSet.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "refusing: $*" >&2; exit 2; }
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
for v in NAMESPACE IMAGE SE_HOST UI_HOST CLUSTER_ISSUER; do [ -n "${!v:-}" ] || die "set $v (see the usage lines at the top of this file)"; done
case "$IMAGE" in
  *:latest|*:HEAD|*:|"") die "IMAGE must carry an explicit immutable tag or digest, not latest/HEAD/empty";;
  *[!A-Za-z0-9._:/@-]*) die "IMAGE has characters that are not allowed";;
  *:*|*@sha256:*) ;;
  *) die "IMAGE has no tag or digest";;
esac
case "$NAMESPACE" in *[!a-z0-9-]*|"") die "NAMESPACE must be a plain name";; esac
for v in SE_HOST UI_HOST; do case "${!v}" in *[!a-z0-9.-]*|"") die "$v must be a plain host name";; esac; done
[ "$SE_HOST" != "$UI_HOST" ] || die "SE_HOST (where PingOne posts) and UI_HOST (the page) must be different hosts"
case "$CLUSTER_ISSUER" in *[!a-z0-9.-]*|"") die "CLUSTER_ISSUER must be a plain name";; esac

# Placeholders are the literal tokens __IMAGE__, __SE_HOST__, __UI_HOST__ and __CLUSTER_ISSUER__. Any other token left over fails.
render() {
  local out
  out=$(sed -e "s|__IMAGE__|$IMAGE|g" -e "s|__SE_HOST__|$SE_HOST|g" -e "s|__UI_HOST__|$UI_HOST|g" -e "s|__CLUSTER_ISSUER__|$CLUSTER_ISSUER|g" "$1")
  if grep -qE '__[A-Z_]+__' <<<"$out"; then echo "refusing: unreplaced __TOKEN__ in $1: $(grep -oE '__[A-Z_]+__' <<<"$out" | sort -u | tr '\n' ' ')" >&2; exit 2; fi
  printf '%s\n---\n' "$out"
}
# Apply order: storage, policy, workload, service, then the two ingresses. secret.example.yaml is deliberately NOT in this list.
FILES=(pvc.yaml networkpolicy.yaml deployment.yaml service.yaml certificate.yaml ingress-webhook.yaml ingress-ui.yaml)

if [ "$DRY" = 1 ]; then
  echo "# DRY RUN: would apply to namespace '$NAMESPACE' (nothing is sent to the cluster)"
  for f in "${FILES[@]}"; do echo "# --- $f"; render "$f"; done
  exit 0
fi

[ "${OWNER_APPROVED:-}" = "1" ] || die "the first SE deploy of each app is owner-approved (set OWNER_APPROVED=1)"
# Render everything BEFORE touching the cluster, so a leftover token cannot cause a half-applied deployment.
RENDERED=(); for f in "${FILES[@]}"; do RENDERED+=("$(render "$f")"); done
kubectl -n "$NAMESPACE" get secret pingone-events-lab >/dev/null 2>&1 || die "the Secret 'pingone-events-lab' does not exist in $NAMESPACE: the owner creates it first (see k8s/secret.example.yaml); the pod would not start without it"
for r in "${RENDERED[@]}"; do printf '%s\n' "$r" | kubectl apply -n "$NAMESPACE" -f -; done
kubectl -n "$NAMESPACE" rollout status deployment/pingone-events-lab --timeout=180s

# ---- verify by content ----
fetch_js='const [m,p]=process.argv.slice(1);fetch("http://127.0.0.1:7802"+p,{method:m}).then(async r=>{const t=await r.text();console.log(JSON.stringify({status:r.status,body:t.slice(0,400)}))}).catch(e=>{console.log(JSON.stringify({error:String(e)}));process.exit(1)})'
pod_get() { kubectl -n "$NAMESPACE" exec deploy/pingone-events-lab -c app -- node -e "$fetch_js" "$1" "$2"; }
health=$(pod_get GET /api/health)
grep -q '"schema\\":\\"demo-health/1' <<<"$health" && grep -q '"state\\":\\"ready' <<<"$health" && grep -q 'pingone-events-lab' <<<"$health" || { echo "verify FAILED: /api/health did not say demo-health/1, ready, pingone-events-lab: $health" >&2; exit 1; }
echo "verify ok: /api/health says demo-health/1, ready, pingone-events-lab"
for probe in "HEAD /webhook/pingone-events" "GET /api/info"; do
  set -- $probe; got=$(pod_get "$1" "$2"); grep -q '"status":401' <<<"$got" || { echo "verify FAILED: $probe did not answer 401 without a credential (fail closed): $got" >&2; exit 1; }
  echo "verify ok: $probe answers 401 without a credential"
done
image_id=$(kubectl -n "$NAMESPACE" get pod -l app=pingone-events-lab -o jsonpath='{.items[0].status.containerStatuses[0].imageID}')
want_repo=${IMAGE%%@*}; want_repo=${want_repo%:*}
case "$image_id" in *"${want_repo##*/}"*) echo "verify ok: pod imageID is $image_id";; *) echo "verify FAILED: pod imageID '$image_id' does not match IMAGE $IMAGE" >&2; exit 1;; esac
if command -v docker >/dev/null 2>&1; then
  digest=$(docker --context orbstack buildx imagetools inspect "$IMAGE" --format '{{.Manifest.Digest}}' 2>/dev/null || true)
  if [ -n "$digest" ]; then case "$image_id" in *"$digest"*) echo "verify ok: registry digest $digest matches the pod";; *) echo "verify FAILED: registry digest $digest is not in the pod imageID $image_id" >&2; exit 1;; esac
  else echo "note: could not read the registry manifest; compare it by hand: docker buildx imagetools inspect $IMAGE"; fi
fi
echo "deployed. Hand over the URL only after browser proof; PingOne's destination is https://$SE_HOST/webhook/pingone-events"
