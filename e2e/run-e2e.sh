#!/usr/bin/env bash
# Host-side driver: build the Ubuntu 24.04 e2e image from this source tree
# and run the whole scenario suite inside one container (the container's
# isolated DSH_HOME keeps the host config untouched).
#
# Usage:  ./e2e/run-e2e.sh          (from anywhere; resolves the repo root)
#
# Requirements: podman or docker with a working daemon.
#
# The base image / node dist default to the DaoCloud / npmmirror mirrors
# because docker.io and nodejs.org are not reachable from this machine's
# podman VM; pass CLEAN_NETWORK=1 on a CI-like network to use the official
# endpoints.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-localhost/dsh-cron-e2e:latest}"
ENGINE="$(command -v podman || command -v docker)"

if [ -z "${ENGINE}" ]; then
  printf 'run-e2e: need podman or docker on PATH\n' >&2
  exit 1
fi

if [ "${CLEAN_NETWORK:-0}" = "1" ]; then
  BUILD_ARGS=()
else
  BUILD_ARGS=(--build-arg BASE_IMAGE=docker.m.daocloud.io/library/ubuntu:24.04 \
              --build-arg NODE_DIST_BASE=https://npmmirror.com/mirrors/node)
fi

printf '==> building image %s (context: %s, engine: %s)\n' "$IMAGE" "$REPO_ROOT" "$ENGINE"
"$ENGINE" build -f "$REPO_ROOT/e2e/Containerfile" -t "$IMAGE" "${BUILD_ARGS[@]}" "$REPO_ROOT"

printf '==> running scenario suite (all state stays inside the container)\n'
"$ENGINE" run --rm --name dsh-cron-e2e \
  -v "$REPO_ROOT/e2e:/e2e:ro" \
  "$IMAGE" \
  bash /e2e/scenarios/run-all.sh

printf '==> e2e finished OK\n'
