# SE deployment (build only)

Owner-approved exception, 2026-11-07: this app also runs on the SE cluster so PingOne's cloud can reach the webhook. Nothing in this folder deploys itself.

| File | What |
| --- | --- |
| `deployment.yaml` | one pod, `Recreate`, non-root, read-only root, `PEV_HOSTED=1`, probes on `/api/health` with a loopback `Host` header |
| `service.yaml`, `pvc.yaml` | ClusterIP service, a 1 Gi ReadWriteOnce volume for the event file |
| `networkpolicy.yaml` | app port in; DNS, 443 and 9200 out |
| `ingress-webhook.yaml` | a NEW ingress: one `Exact` path (`/webhook/pingone-events`) on the shared demo host, class `nginx-public`, small body limit, rate limit |
| `ingress-ui.yaml`, `certificate.yaml` | the page on its own host with its own certificate |
| `secret.example.yaml` | a TEMPLATE; the owner creates the real Secret; `deploy.sh` never applies it |
| `deploy.sh` | renders `__TOKEN__` placeholders with sed; `--dry-run` prints and fails on any leftover token; a real run needs `OWNER_APPROVED=1`, then verifies by content |

## The image
```sh
docker --context orbstack buildx build --platform linux/amd64 \
  -t ghcr.io/curtismu7/pingone-events-lab:<immutable-tag> --load .
docker --context orbstack push ghcr.io/curtismu7/pingone-events-lab:<immutable-tag>   # owner step
```
Use an immutable tag (a commit hash), never `:latest` or `:HEAD`: `deploy.sh` refuses them, and two sessions racing the same moving tag is how SE rollouts have gone wrong before. Account for the registry is `curtismu7`. The existing SE deployments pull from a private registry through an image pull secret named `ghcr-pull-secret` (the Deployment names it). Whether that secret's token can read a `ghcr.io/curtismu7/...` package is UNVERIFIED: either make the package public or make sure the secret's token can read it, before the first deploy.

## Deploy
```sh
KUBE_CONTEXT=<ctx> NAMESPACE=<ns> IMAGE=ghcr.io/curtismu7/pingone-events-lab:sha-<hex> SE_HOST=<host PingOne posts to> UI_HOST=<the page host> CLUSTER_ISSUER=<issuer> k8s/deploy.sh --dry-run
OWNER_APPROVED=1 KUBE_CONTEXT=... NAMESPACE=... IMAGE=... SE_HOST=... UI_HOST=... CLUSTER_ISSUER=... WEBHOOK_BASIC_USER=... WEBHOOK_BASIC_PASSWORD=... k8s/deploy.sh
```
- `KUBE_CONTEXT` is mandatory and is passed to every `kubectl` call; there is no ambient context.
- `IMAGE` must be immutable: a `:sha-<hex>` tag or an `@sha256:` digest. `latest`, `HEAD`, an untagged name and any other tag are refused.
- A **read-only preflight** lists every existing ingress host and path that touches `SE_HOST` or `UI_HOST` and fails on a collision (the dry run prints it too). If the cluster cannot be read it stops, unless you set `ALLOW_NO_PREFLIGHT=1`.
- `WEBHOOK_BASIC_USER` / `WEBHOOK_BASIC_PASSWORD` are the webhook credential the Secret holds; they are used only to verify the public path, reach `curl` on stdin (never a command line) and are never printed.
- The script verifies by content: in the pod, `/api/health` says `demo-health/1`, ready, this app, and the receiver and page answer `401` without a credential; the pod's `imageID` matches `IMAGE` (and the registry digest when docker can read it); and through the **public ingress**, `HEAD https://SE_HOST/webhook/pingone-events` answers `200` with the credential and `401` without it, and `https://UI_HOST/api/info` answers `401`. DNS and the certificate can take minutes, so the public checks retry (`PUBLIC_CHECK_ATTEMPTS`, `PUBLIC_CHECK_SLEEP`). Hand over a URL only after browser proof.
- Updating later: apply again with a new `IMAGE`; if you use `kubectl set image`, name the container (`app=...`), never `*=`, and read the new ReplicaSet.

## What the ingress must do
The app trusts exactly one proxy hop for the client address and uses the **right-most** `X-Forwarded-For` entry. nginx-ingress sets or appends that header by default; do not turn that off. If it did stop, every caller would look like the ingress and share one rate-limit bucket (it fails safe, not open).

## NetworkPolicy
It allows the app port from the `ingress-nginx-public` controller pods, DNS to CoreDNS, and HTTPS / 9200 out excluding private and link-local ranges. The kubelet's probes come from the node, which common CNIs allow regardless of policy; whether this cluster's CNI does is **UNVERIFIED**. If the readiness probe fails after a deploy, that is the first place to look. An Elasticsearch on a private address needs its own egress rule.
