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
TUI_VERSION="$(npm view @aiwayds/dsh-tui-pi version)"
printf '  dsh-tui-pi: %s | dsh: %s\n' "$TUI_VERSION" "$(dsh --version 2>/dev/null || echo '?')"

cat > "$PROFILE_DIR/cordis.yml" <<'EOF'
# e2e profile root — the tree is composed from the bundle patches
[]
EOF
cat > "$PROFILE_DIR/cordis.patch.yml" <<'EOF'
# e2e profile: no extra patch layer
[]
EOF
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF

TARBALL="$(ls /dist/*.tgz | head -1)"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-e2e",
  "private": true,
  "dependencies": {
    "@aiwayds/dsh-cron": "file:$TARBALL",
    "@aiwayds/dsh-tui-pi": "^$TUI_VERSION"
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

# settings.yaml: the mock provider route lives under the llm-pi-ai settings
# namespace (dsh-llm-pi-ai installs its `providers` dict there), the default
# model selection, and a 1s tick loop (floor in src/index.ts) so 60s
# occurrences fire predictably.
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
cron:
  tickIntervalMs: 1000
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
