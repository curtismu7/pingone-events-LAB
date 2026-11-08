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
NAMESPACE=<ns> IMAGE=ghcr.io/curtismu7/pingone-events-lab:<tag> SE_HOST=<host PingOne posts to> UI_HOST=<the page host> CLUSTER_ISSUER=<issuer> k8s/deploy.sh --dry-run
OWNER_APPROVED=1 NAMESPACE=... IMAGE=... SE_HOST=... UI_HOST=... CLUSTER_ISSUER=... k8s/deploy.sh
```
The script verifies by content: the pod's own `/api/health` says `demo-health/1`, ready, this app; the receiver and the page answer `401` without a credential; the pod's `imageID` matches `IMAGE` (and the registry digest when docker can read it). Hand over a URL only after browser proof. Updating later: apply again with a new `IMAGE`; if you use `kubectl set image`, name the container (`app=...`), never `*=`, and read the new ReplicaSet.
