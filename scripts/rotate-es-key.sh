#!/usr/bin/env bash
# Make a new write-only Elasticsearch API key for this app and save it in the settings file. Run it yourself in a terminal.
#
# What it does: asks for the password of an Elasticsearch user that may create API keys (hidden, never stored or printed), creates a key that can
# only write to the pingone-events* indices, and replaces the ELASTICSEARCH_API_KEY line in ~/.config/demo-kit/pingone-events-lab.env.
# It talks to Elasticsearch through the port-forward already running on this Mac (http://localhost:9200). Nothing is sent anywhere else.
#
#   scripts/rotate-es-key.sh --find                         list candidate Secrets (names only)
#   ES_SECRET=<name> ES_SECRET_KEY=<key> scripts/rotate-es-key.sh   read the elastic password from the cluster Secret
#   scripts/rotate-es-key.sh [elastic-user-name]            or type the password (default user: elastic)
set -euo pipefail
ES="${ES_LOCAL_URL:-http://localhost:9200}"
USER_NAME="${1:-elastic}"; [ "$USER_NAME" = "--find" ] && USER_NAME=elastic
FILE="$HOME/.config/demo-kit/pingone-events-lab.env"
[ -f "$FILE" ] || { echo "missing $FILE" >&2; exit 1; }
curl -s -m 5 -o /dev/null "$ES/" || { echo "cannot reach $ES (is the Elasticsearch port-forward running?)" >&2; exit 1; }

# Where the password comes from: a Kubernetes Secret in the cluster (ES_SECRET + ES_SECRET_KEY, read here in your shell, never printed), or typed (hidden).
NS="${ES_NS:-ping-devops-curtismuir}"; CTX="${ES_KUBE_CONTEXT:-us}"
if [ "${1:-}" = "--find" ]; then
  echo "Secrets in $NS that look like Elasticsearch ones, with their key NAMES (no values):"
  kubectl --context "$CTX" -n "$NS" get secrets -o json | python3 -c '
import sys,json
for it in json.load(sys.stdin)["items"]:
    n=it["metadata"]["name"]
    if any(w in n.lower() for w in ("elastic","siem","kibana")): print(" ", n, "->", sorted((it.get("data") or {}).keys()))'
  echo "Then run:  ES_SECRET=<secret name> ES_SECRET_KEY=<key name> scripts/rotate-es-key.sh"
  exit 0
fi
if [ -n "${ES_SECRET:-}" ]; then
  PW=$(kubectl --context "$CTX" -n "$NS" get secret "$ES_SECRET" -o "jsonpath={.data.${ES_SECRET_KEY:-elastic}}" | base64 -d)
  [ -n "$PW" ] || { echo "that secret/key is empty or missing (try --find)" >&2; exit 1; }
  # No user name given on the command line: use the Secret's own "username" key when it has one.
  if [ -z "${1:-}" ]; then U=$(kubectl --context "$CTX" -n "$NS" get secret "$ES_SECRET" -o 'jsonpath={.data.username}' 2>/dev/null | base64 -d 2>/dev/null || true); [ -n "$U" ] && USER_NAME="$U"; fi
else
  read -r -s -p "Password for Elasticsearch user '$USER_NAME' (hidden): " PW; echo
  [ -n "$PW" ] || { echo "no password given" >&2; exit 1; }
fi

BODY='{"name":"pingone-events-lab-writer","role_descriptors":{"writer":{"index":[{"names":["pingone-events*"],"privileges":["create_index","create","index","auto_configure"]}]}}}'
RESP=$(curl -s -m 20 -w '\n%{http_code}' -u "$USER_NAME:$PW" -H 'Content-Type: application/json' -X POST "$ES/_security/api_key" -d "$BODY") || true
unset PW
CODE=${RESP##*$'\n'}; JSON=${RESP%$'\n'*}
if [ "$CODE" != "200" ]; then echo "Elasticsearch answered HTTP $CODE (no key written):"; printf '%s\n' "$JSON" | head -c 400; echo; exit 1; fi

ENCODED=$(printf '%s' "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["encoded"])')
[ -n "$ENCODED" ] || { echo "no key in the answer" >&2; exit 1; }
cp "$FILE" "$FILE.bak.$(date +%s)"
python3 - "$FILE" "$ENCODED" <<'EOF'
import sys
path, enc = sys.argv[1], sys.argv[2]
lines = open(path).read().splitlines()
out, done = [], False
for l in lines:
    if l.startswith('ELASTICSEARCH_API_KEY='):
        out.append('ELASTICSEARCH_API_KEY=' + enc); done = True
    else:
        out.append(l)
if not done: out.append('ELASTICSEARCH_API_KEY=' + enc)
open(path, 'w').write('\n'.join(out) + '\n')
EOF
chmod 600 "$FILE"
echo "Done: new key saved in $FILE (the old line is kept in the .bak file next to it). Tell Claude 'key saved'."
