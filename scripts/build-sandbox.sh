#!/usr/bin/env bash
# Builds the sandbox image (node 22, git, python3, jq, curl). Needs network once, for apt; copy the image to airgapped hosts
# with `podman save` / `podman load`. Locally the runner is bind-mounted, so any image that has node works.
set -euo pipefail
cd "$(dirname "$0")/.."
podman build -f Dockerfile.sandbox -t "${1:-localhost/entropi-sandbox:dev}" .
