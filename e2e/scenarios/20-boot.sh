#!/usr/bin/env bash
# Scenario 2 — real TUI boot in tmux against the scratch profile and the mock
# provider: the shell reaches the composer, the footer paints a clock, and a
# typed marker echoes back through the real editor.
set -u
. "$(dirname "$0")/lib/common.sh"
scenario '20-boot'

start_dsh
if wait_tui_up 120; then
  ok 'composer ready (footer hint visible)'
else
  bad 'TUI composer never became ready (120s)'
fi

# The mock segment is EVENTUAL under 0.1.7: the settings.yaml import lands
# asynchronously after the TUI is up, and the footer's deferred seed picks it
# up from settings/document-updated (or the 2.5s fallback). The hint bar
# paints before any of that, so a single-shot capture here races on slow
# runners (CI red, local green). Poll bounded — "mock within 30s" is exactly
# the deferred-seed contract; a regression (eager seed freezing the builtin
# default) never satisfies it.
if wait_for_text 'mock' 30; then
  ok 'mock provider segment in the footer (deferred seed)'
else
  bad 'mock provider never appeared in the footer (30s)'
fi

type_text 'e2e-boot-marker'
assert_contains 'editor echoes the typed marker' 'e2e-boot-marker' "$(capture)"
clear_editor 20
assert_not_contains 'editor cleared after backspaces' 'e2e-boot-marker' "$(capture)"

summary
