#!/usr/bin/env bash
# Browser smoke test. With BASE_URL set it runs against that deployment; without, against a fresh local server (scripted demo).
# Needs podman (the Playwright container). Screenshots go to OUT (default ./ui-smoke-shots).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${OUT:-$PWD/ui-smoke-shots}
mkdir -p "$OUT"
if [ -z "${BASE_URL:-}" ]; then
  PORT=${PORT:-8098}
  DATA=$(mktemp -d)
  DATA_DIR=$DATA AUTH_MODE=dev PORT=$PORT PUBLIC_URL=http://localhost:$PORT SANDBOX_BACKEND=none node src/server.ts >"$DATA/server.log" 2>&1 &
  SRV=$!
  trap 'kill $SRV 2>/dev/null; rm -rf "$DATA"' EXIT
  for _ in $(seq 1 40); do curl -sf "localhost:$PORT/healthz" >/dev/null && break; sleep 0.3; done
  BASE_URL=http://localhost:$PORT
fi
podman run --rm --network=host -v "$PWD/scripts:/s:ro" -v "$OUT:/out" mcr.microsoft.com/playwright:v1.55.0-noble \
  bash -c "mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core@1.55.0 >/dev/null 2>&1 && cp /s/ui-smoke.mjs . && BASE_URL=$BASE_URL OUT=/out node ui-smoke.mjs"
