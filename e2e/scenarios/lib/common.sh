#!/usr/bin/env bash
# Minimal tmux driver + assertion helpers for the dsh-cron e2e scenarios.
# Self-contained on purpose (no dsh-tui-pi dependency): one tmux session per
# suite run, a capture/assert/summary trio, and a per-scenario result file
# under $RESULTS_DIR consumed by run-all.sh.

set -u

SESSION="${E2E_TMUX_SESSION:-cron-e2e}"
RESULTS_DIR="${RESULTS_DIR:-/tmp/e2e-results}"
mkdir -p "$RESULTS_DIR"
SCENARIO_NAME="unknown"
PASS=0; FAIL=0; WARN=0

scenario() {
	SCENARIO_NAME="$1"
	printf '\n----- scenario: %s -----\n' "$SCENARIO_NAME"
}

ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
warn() { WARN=$((WARN + 1)); printf '  warn %s\n' "$1"; }

summary() {
	printf '%s %s %s\n' "$PASS" "$FAIL" "$WARN" > "$RESULTS_DIR/$SCENARIO_NAME.result"
	printf '  (%s: %d pass, %d fail, %d warn)\n' "$SCENARIO_NAME" "$PASS" "$FAIL" "$WARN"
}

assert_contains() {
	local what="$1" needle="$2" haystack="$3"
	if printf '%s' "$haystack" | grep -qF -- "$needle"; then
		ok "$what"
	else
		bad "$what — missing: $needle"
	fi
}

assert_not_contains() {
	local what="$1" needle="$2" haystack="$3"
	if printf '%s' "$haystack" | grep -qF -- "$needle"; then
		bad "$what — unexpected: $needle"
	else
		ok "$what"
	fi
}

assert_matches() {
	local what="$1" pattern="$2" haystack="$3"
	if printf '%s' "$haystack" | grep -qE -- "$pattern"; then
		ok "$what"
	else
		bad "$what — no match: $pattern"
	fi
}

# --- tmux helpers ---------------------------------------------------------

capture() {
	# -S -3000 includes the scrollback: transcript assertions must survive
	# later turns pushing earlier text off the visible pane.
	tmux capture-pane -p -S -3000 -t "$SESSION" 2>/dev/null || true
}

# Type into the TUI editor and submit with Enter. Multi-space words survive;
# tmux send-keys -l handles the literal text.
send_text() {
	tmux send-keys -t "$SESSION" -l "$1"
	sleep 1
	tmux send-keys -t "$SESSION" Enter
}

# Type without submitting (echo probes); clear with clear_editor afterwards.
type_text() {
	tmux send-keys -t "$SESSION" -l "$1"
	sleep 1
}

clear_editor() {
	local n="${1:-40}"
	for _ in $(seq 1 "$n"); do tmux send-keys -t "$SESSION" BSpace; done
	sleep 1
}

# Wait until the pane shows the needle (polling), else give up after $2 s.
wait_for_text() {
	local needle="$1" timeout_s="${2:-60}" waited=0
	while (( waited < timeout_s )); do
		if capture | grep -qF -- "$needle"; then return 0; fi
		sleep 2
		waited=$((waited + 2))
	done
	return 1
}

# Boot `dsh --profile e2e` in the tmux session with a clean scratch DSH_HOME.
DSH_HOME_DIR="${E2E_DSH_HOME:-$HOME/.dsh-e2e}"
start_dsh() {
	tmux kill-session -t "$SESSION" 2>/dev/null || true
	tmux new-session -d -s "$SESSION" -x 200 -y 50
	tmux send-keys -t "$SESSION" -l "env DSH_HOME=$DSH_HOME_DIR TERM=xterm-256color MOCK_API_KEY=e2e-dummy dsh --profile e2e 2>&1 | tee /tmp/e2e-dsh.log"
	tmux send-keys -t "$SESSION" Enter
}

# The TUI is up when the composer hint line appears in the capture (the
# footer clock proved unreliable across terminal widths).
wait_tui_up() {
	wait_for_text 'Enter: send' "${1:-120}" || true
	capture | grep -qF 'Enter: send'
}

quit_dsh() {
	tmux send-keys -t "$SESSION" C-c
	sleep 1
	tmux send-keys -t "$SESSION" C-c
	sleep 2
	tmux kill-session -t "$SESSION" 2>/dev/null || true
}
