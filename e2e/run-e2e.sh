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

# Same resolution rule as ci.yml / release.yml: newest of the `latest`
# (stable) and `next` (rc) dist-tags, never hand-pinned and never the
# retired `alpha` tag. Scalar (not array) so bash 3.2's `set -u` does not
# trip on the empty-array expansion — same fix as dsh-tui-pi's runner.
NPM_VIEW_REG=""
if ! npm view @deepseek-ai/dsh@latest version >/dev/null 2>&1; then
  NPM_VIEW_REG="--registry=https://registry.npmjs.org"
fi
STABLE="$(npm view @deepseek-ai/dsh@latest version $NPM_VIEW_REG)"
RC="$(npm view @deepseek-ai/dsh@next version $NPM_VIEW_REG 2>/dev/null || true)"
DSH_VERSION="$STABLE"
if [ -n "$RC" ] && [ "$(printf '%s\n' "$STABLE" "$RC" | sort -V | tail -1)" = "$RC" ]; then
  DSH_VERSION="$RC"
fi
printf '==> dsh closure: %s\n' "$DSH_VERSION"

# The other dist-tag, used as the image-build fallback: an incomplete
# upstream publish wave (a companion package missing from npm) fails the
# Containerfile's pinned-closure install layer, and we rebuild against the
# other end instead of failing the suite on upstream's breakage. Both ends
# broken stays red — that is a real signal.
ALT=""
if [ "$DSH_VERSION" != "$STABLE" ]; then
  ALT="$STABLE"
elif [ -n "$RC" ] && [ "$RC" != "$DSH_VERSION" ]; then
  ALT="$RC"
fi

# Builds the image for one dsh version. The args array is never empty at
# expansion (bash 3.2 `set -u` safety, same rule as above).
build_image() {
  local args=(--build-arg DSH_VERSION="$1")
  if [ "${CLEAN_NETWORK:-0}" != "1" ]; then
    args+=(--build-arg BASE_IMAGE=docker.m.daocloud.io/library/ubuntu:24.04 \
           --build-arg NODE_DIST_BASE=https://npmmirror.com/mirrors/node)
  fi
  "$ENGINE" build -f "$REPO_ROOT/e2e/Containerfile" -t "$IMAGE" "${args[@]}" "$REPO_ROOT"
}

printf '==> building image %s (context: %s, engine: %s)\n' "$IMAGE" "$REPO_ROOT" "$ENGINE"
if ! build_image "$DSH_VERSION"; then
  if [ -z "$ALT" ]; then
    printf 'run-e2e: dsh@%s image build failed and there is no other dist-tag to fall back to\n' "$DSH_VERSION" >&2
    exit 1
  fi
  printf '==> dsh@%s build failed (incomplete upstream publish wave?) — retrying with %s\n' "$DSH_VERSION" "$ALT"
  build_image "$ALT" || { printf 'run-e2e: neither %s nor %s builds\n' "$DSH_VERSION" "$ALT" >&2; exit 1; }
fi

printf '==> running scenario suite (all state stays inside the container)\n'
"$ENGINE" run --rm --name dsh-cron-e2e \
  -v "$REPO_ROOT/e2e:/e2e:ro" \
  "$IMAGE" \
  bash /e2e/scenarios/run-all.sh

printf '==> e2e finished OK\n'
