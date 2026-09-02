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

assert_contains 'mock provider segment in the footer' 'mock' "$(capture)"

type_text 'e2e-boot-marker'
assert_contains 'editor echoes the typed marker' 'e2e-boot-marker' "$(capture)"
clear_editor 20
assert_not_contains 'editor cleared after backspaces' 'e2e-boot-marker' "$(capture)"

summary
