#!/usr/bin/env bash
# Fresh server (scripted demo agents, dev login) + the browser check in the Playwright container. Screenshots go to docs/img.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8097}
DATA=$(mktemp -d)
DATA_DIR=$DATA AUTH_MODE=dev PORT=$PORT PUBLIC_URL=http://localhost:$PORT node src/server.ts >"$DATA/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$DATA"' EXIT
for _ in $(seq 1 30); do curl -sf "localhost:$PORT/healthz" >/dev/null && break; sleep 0.3; done
podman run --rm --network=host -v "$PWD:/work" -w /work mcr.microsoft.com/playwright:v1.55.0-noble bash -c \
  "mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core@1.55.0 >/dev/null 2>&1 && cp /work/scripts/ui-check.mjs . && BASE_URL=http://localhost:$PORT OUT=/work/docs/img node ui-check.mjs"
