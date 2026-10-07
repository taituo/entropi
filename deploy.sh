#!/usr/bin/env bash
# Build the images, load them into k3s and (re)deploy Entropi into its own namespaces (entropi, entropi-sandboxes).
# Idempotent: the session secret is generated once and kept in the cluster. Touches no other namespace.
#   BASE_DOMAIN  required, e.g. 203.0.113.10.nip.io (host: entropi.<BASE_DOMAIN>)
#   LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL / LOCAL_LLM_API_KEY_FILE  any OpenAI-compatible endpoint (without one: scripted demo agents)
set -euo pipefail
cd "$(dirname "$0")"
[ -f .deploy.env ] && . ./.deploy.env
: "${BASE_DOMAIN:?set BASE_DOMAIN (copy .deploy.env.example to .deploy.env)}"
export BASE_DOMAIN AUTH_MODE="${AUTH_MODE:-dev}"
export LOCAL_LLM_BASE_URL="${LOCAL_LLM_BASE_URL:-}" LOCAL_LLM_MODEL="${LOCAL_LLM_MODEL:-}"
export AGENT_OPS_MODEL="${AGENT_OPS_MODEL:-}" AGENT_DEVELOPER_MODEL="${AGENT_DEVELOPER_MODEL:-}" AGENT_REVIEWER_MODEL="${AGENT_REVIEWER_MODEL:-}" AGENT_INSIGHT_MODEL="${AGENT_INSIGHT_MODEL:-}" OPTCHAT_MODEL="${OPTCHAT_MODEL:-}"
STAMP=$(date +%Y%m%d-%H%M%S)
export IMAGE="localhost/entropi:$STAMP" SANDBOX_IMAGE="localhost/entropi-sandbox:$STAMP"
NS=entropi

[ -d node_modules/typescript ] && [ "${SKIP_TYPECHECK:-}" != "1" ] && { echo "==> typecheck"; npx tsc -p . ; }

echo "==> build $IMAGE and $SANDBOX_IMAGE"
podman build -q -t "$IMAGE" . >/dev/null
podman save "$IMAGE" | sudo -n k3s ctr -n k8s.io images import - >/dev/null
[ -d node_modules/@earendil-works/pi-durable/dist/env ] || npm ci >/dev/null   # the sandbox image copies Pi's execution environment from here
podman build -q -f Dockerfile.sandbox -t "$SANDBOX_IMAGE" . >/dev/null
podman save "$SANDBOX_IMAGE" | sudo -n k3s ctr -n k8s.io images import - >/dev/null

echo "==> namespaces and sandbox policy"
kubectl apply -f k8s/sandboxes.yaml >/dev/null
kubectl get ns $NS >/dev/null 2>&1 || kubectl create ns $NS >/dev/null
if ! kubectl -n $NS get secret entropi-secrets >/dev/null 2>&1; then
  kubectl -n $NS create secret generic entropi-secrets --from-literal=session-secret="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 48)" >/dev/null
fi
if [ -n "${LOCAL_LLM_API_KEY_FILE:-}" ]; then
  kubectl -n $NS create secret generic entropi-inference --from-file=local-api-key="$LOCAL_LLM_API_KEY_FILE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
fi

echo "==> apply"
envsubst '${BASE_DOMAIN} ${IMAGE} ${AUTH_MODE} ${SANDBOX_IMAGE} ${LOCAL_LLM_BASE_URL} ${LOCAL_LLM_MODEL} ${AGENT_OPS_MODEL} ${AGENT_DEVELOPER_MODEL} ${AGENT_REVIEWER_MODEL} ${AGENT_INSIGHT_MODEL} ${OPTCHAT_MODEL}' < k8s/entropi.yaml | kubectl apply -f - >/dev/null
kubectl -n $NS rollout status deploy/entropi --timeout=180s
echo; echo "Entropi: http://entropi.${BASE_DOMAIN}   (auth: $AUTH_MODE)"
