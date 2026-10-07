#!/usr/bin/env bash
# The extensive tests against a deployed Entropi: API suites (rights, privacy, SSE, inputs), the pod-restart tests (kubectl needed),
# and the browser smoke test. Not part of `npm test`: it talks to a real system and a real model.
#   ENTROPI_URL=http://entropi.<BASE_DOMAIN>   (default: derived from .deploy.env)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .deploy.env ] && . ./.deploy.env
export ENTROPI_URL="${ENTROPI_URL:-http://entropi.${BASE_DOMAIN:?set ENTROPI_URL or BASE_DOMAIN}}"
echo "==> API suites and cluster tests against $ENTROPI_URL"
node --test --test-concurrency=1 --test-timeout=480000 test/suites/*.test.ts test/cluster/*.test.ts
echo "==> browser smoke test"
BASE_URL="$ENTROPI_URL" scripts/ui-smoke.sh
