# Follow-ups (owner and other sessions)

Done in this repo: everything below the line "Owner steps". Nothing here has been pushed, deployed or registered; this app is a LOCAL repo (no GitHub repo yet), the same way observability-LAB started.

## Owner steps for the SE deployment (the exception recorded 2026-11-07)
1. **Create the Kubernetes Secret** `pingone-events-lab` in the target namespace (template: `k8s/secret.example.yaml`). Required: `WEBHOOK_BASIC_USER` / `WEBHOOK_BASIC_PASSWORD` (what PingOne sends) and `UI_BASIC_USER` / `UI_BASIC_PASSWORD` (the page; a different credential). Optional: `PINGONE_*` (the read-only pull), `ELASTICSEARCH_*` (forwarding). Delete any key you do not use: a placeholder left in is refused and the pod will not start.
2. **Build and push the image** (immutable tag): see `k8s/README.md`. Decide the pull secret: the existing SE deployments use `ghcr-pull-secret`; a `ghcr.io/curtismu7/...` package must be public or readable by that secret's token (UNVERIFIED).
3. **Run `k8s/deploy.sh`**: `--dry-run` first, then with `OWNER_APPROVED=1`.
4. **Re-point the existing disabled PingOne subscription `PINGONE-EVENTS-LAB`** (coordinator will do this) to `https://<se-host>/webhook/pingone-events` with Basic authentication (the webhook credential), Event Schema Ping Activity, payload limit 1, JSON array, TLS verify on; then enable it. The Management API body shape is in the Setup panel and is UNVERIFIED.
5. **Elasticsearch / OpenSearch** (only if you forward): run the index template yourself (`docs/elasticsearch-index-template.json`, the exact curl is in Setup), then turn forwarding on in the page. Real forwarding has not been run against a live cluster.

## Shelf, proxy and repo (as for every new lab)
6. **Repo**: create `curtismu7/pingone-events-LAB` (owner approval each time), set the `FORBIDDEN_STRINGS` secret, push this history. `ci.yml` is present (Node 26, GitHub-hosted, gitleaks, forbidden-strings, no-AI-attribution).
7. **demo-shelf-LAB `data/demos.json`**: add the entry in `docs/shelf-entry.json` (id `pingone-events-lab`, port 7802, catalog `D124` provisional: the owner picks the final id), then `npm run ports` / `npm run doctor` there. The port 7802 is claimed on the board.
8. **lab-proxy** (`AI-DEMO-Standalone/shared/lab-proxy`): one entry location, one cookie-map pair and the lab's compose network, with a request-time `proxy_pass` (`set $x container:port`), then `shared/lab-proxy/check-config.sh`. Labs accept the name through `LAB_ALLOWED_HOSTS` (compose default `local.ping-devops.com`).
9. **Meta repo**: after the GitHub repo exists, add the submodule `standalone/pingone-events-LAB` and pin it.
10. **Learning Hub**: `content-pack.json` validates (`npm run content-pack`); the hub reads it from the repo once registered.

## Known gaps
- The Air (`air-test`) was unreachable during the build (hostname did not resolve); the suites were run locally.
- `kubeconform` is not installed here, so the manifests are checked by structure tests (parse, security context, tokens, routing) and by running `deploy.sh` against a fake `kubectl`; they have not been checked by a Kubernetes API server.
- The page loads Montserrat from Google Fonts, like the sibling labs. Remove the `<link>` in `web/index.html` for a strictly offline page.
