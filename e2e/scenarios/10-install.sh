#!/usr/bin/env bash
# Scenario 1 — profile assembly (no TUI): build the scratch e2e profile from
# the packed dsh-cron tarball + the rolling @aiwayds/dsh-tui-pi + the dsh CLI
# closure, point the LLM at the in-container mock, speed the tick up, and
# prove the plugin composed into the tree before any scenario touches the TUI.
set -u
. "$(dirname "$0")/lib/common.sh"
scenario '10-install'

PROFILE_DIR="$DSH_HOME_DIR/profiles/e2e"
rm -rf "$DSH_HOME_DIR"
mkdir -p "$PROFILE_DIR"

# Rolling resolution, same policy as ci.yml: never hand-pin the dsh closure.
# Official registry explicitly — the container default (npmmirror) syncs
# @aiwayds releases minutes-to-hours late, and this canary is meaningless
# against a stale tui-pi (it booted 2.22.0 — pre-footer-fix — as "^2.22.0"
# and failed the exact assertion the fix closes).
NPM_REG="https://registry.npmjs.org"
TUI_VERSION="$(npm view @aiwayds/dsh-tui-pi version --registry="$NPM_REG")"
printf '  dsh-tui-pi: %s | dsh: %s\n' "$TUI_VERSION" "$(dsh --version 2>/dev/null || echo '?')"
# Canary override: a locally packed dsh-tui-pi tarball dropped into the
# mounted e2e tree (e2e/dist-tui/*.tgz, untracked build artifact) wins over
# the rolling npm version — for iterating on a footer-seed fix before it
# publishes. Absent the directory (CI, other machines) the rolling rule
# above is untouched; since 2.23.0 the rolling version carries the deferred
# seed and the import-path assertion guards it permanently.
TUI_DEP="^$TUI_VERSION"
LOCAL_TUI="$(ls /e2e/dist-tui/*.tgz 2>/dev/null | head -1 || true)"
if [ -n "$LOCAL_TUI" ]; then
  TUI_DEP="file:$LOCAL_TUI"
  printf '  dsh-tui-pi: local canary tarball %s\n' "$LOCAL_TUI"
fi

cat > "$PROFILE_DIR/cordis.yml" <<'EOF'
# e2e profile root — the tree is composed from the bundle patches
[]
EOF
# Profile patch — ONLY the dsh-cron tick entry (the 1s loop floor in
# src/index.ts) so 60s occurrences fire predictably. The tick must live in
# the patch: a legacy `cron:` yaml section no longer reaches the plugin under
# the 0.1.7 entry-id settings namespace (`dsh-cron`), which the settings
# import does not translate — that one block stays in native patch form.
cat > "$PROFILE_DIR/cordis.patch.yml" <<'EOF'
- id: dsh-cron
  name: "@aiwayds/dsh-cron"
  config:
    tickIntervalMs: 1000
EOF
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF
# Same official-registry rule for the install itself (pnpm reads .npmrc).
printf 'registry=%s\n' "$NPM_REG" > "$PROFILE_DIR/.npmrc"

TARBALL="$(ls /dist/*.tgz | head -1)"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-e2e",
  "private": true,
  "dependencies": {
    "@aiwayds/dsh-cron": "file:$TARBALL",
    "@aiwayds/dsh-tui-pi": "$TUI_DEP"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@aiwayds/dsh-tui-pi",
        "@aiwayds/dsh-cron"
      ]
    }
  }
}
EOF

# settings.yaml — the mock provider route and the default model selection,
# deliberately restored to the LEGACY settings.yaml form (revert of the
# 79c733f bypass): dsh 0.1.7 boots a cold home by importing settings.yaml
# into the profile patch once, and this scenario is the canary that keeps
# that import path covered. The 0.1.7-rc.1 race that forced the bypass
# (import landing after the TUI's eager footer seed froze the builtin
# default) is fixed dsh-tui-pi-side: the footer seed defers to
# settings/document-updated, so the composed default fills in once the
# import lands. The tick stays in cordis.patch.yml above — a `cron:` section
# in entry-id form is not imported.
mkdir -p "$DSH_HOME_DIR"
cat > "$DSH_HOME_DIR/settings.yaml" <<'EOF'
llm-pi-ai:
  providers:
    mock:
      displayName: Mock LLM
      api: openai-completions
      baseURL: http://127.0.0.1:8899/v1
      apiKeyEnv: MOCK_API_KEY
      models:
        - id: mock-flash
          name: Mock Flash
          contextWindow: 200000
          maxTokens: 8192
    # The subagent runtime dispatches child LLM calls through the "spawn"
    # provider route (dsh-subagent-spawn-in-process); without it every
    # sub-agent execution fails and sub-agent fires stall as delivered.
    spawn:
      displayName: Mock Spawn
      api: openai-completions
      baseURL: http://127.0.0.1:8899/v1
      apiKeyEnv: MOCK_API_KEY
      models:
        - id: mock-flash
          name: Mock Flash
          contextWindow: 200000
          maxTokens: 8192
agent-default-model:
  provider: mock
  model: mock-flash
EOF

if pnpm --dir "$PROFILE_DIR" install --silent; then
  ok 'profile dependencies installed'
else
  bad 'pnpm install in the e2e profile failed'
  summary; exit 0
fi

DUMP="$(env DSH_HOME="$DSH_HOME_DIR" dsh --profile e2e --dump-config 2>&1)"
assert_contains 'composed tree includes dsh-cron' '@aiwayds/dsh-cron' "$DUMP"

# Mock LLM up before any scenario boots the TUI against it.
nohup node /e2e/mock-llm/server.mjs > /tmp/mock-llm.log 2>&1 &
MOCK_PID=$!
sleep 1
if kill -0 "$MOCK_PID" 2>/dev/null; then
  ok 'mock OpenAI server listening on :8899'
else
  bad 'mock OpenAI server failed to start'
  cat /tmp/mock-llm.log
fi
summary
