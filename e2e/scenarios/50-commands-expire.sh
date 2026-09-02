#!/usr/bin/env bash
# Scenario 5 — slash-command surface + window expiry + delete path:
#
#   /cron list  shows the live tasks; /cron help renders usage
#   the S30 task's end_at passes -> one expired terminal fire -> the task
#   archives itself to _history.json with status=expired (ADR 0006)
#   /cron delete on the remaining task -> status=cancelled in history
set -u
. "$(dirname "$0")/lib/common.sh"
scenario '50-commands-expire'

STORE="$DSH_HOME_DIR/storages/cron"
HISTORY="$STORE/_history.json"

send_text '/cron list'
sleep 3
assert_contains '/cron list renders the live sub-agent task' 'mode=sub-agent' "$(capture)"

send_text '/cron help'
sleep 3
assert_contains '/cron help renders usage' 'cron_create' "$(capture)"

# Wait for the S30 self task (end_at ~170s after its create) to expire and
# archive. The expired terminal fire also lands in the transcript.
EXPIRED_WAIT=0
while (( EXPIRED_WAIT < 150 )); do
  if [ -f "$HISTORY" ] && node -e '
    const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(h.some((e) => e.status === "expired") ? 0 : 1);
  ' "$HISTORY" 2>/dev/null; then
    break
  fi
  sleep 3
  EXPIRED_WAIT=$((EXPIRED_WAIT + 3))
done
if [ -f "$HISTORY" ] && node -e '
  const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.exit(h.some((e) => e.status === "expired") ? 0 : 1);
' "$HISTORY" 2>/dev/null; then
  ok 'task archived itself as expired after its window closed'
else
  bad 'no expired history entry after 150s past the window end'
fi

if wait_for_text 'expiry notice received' 90; then
  ok 'expired terminal notice reached the transcript (model ack rendered)'
else
  bad 'no expiry notice ack within 90s of the archive'
fi

# Delete the remaining task; it must land in history as cancelled.
SUB_ID="$(node -e '
const fs = require("fs");
const dir = process.argv[1];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_history.json");
const tasks = files.map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")));
const task = tasks.find((t) => t.executionMode === "sub-agent");
console.log(task ? task.id : "");
' "$STORE" 2>/dev/null || true)"

if [ -n "$SUB_ID" ]; then
  send_text "/cron delete $SUB_ID"
  sleep 3
  assert_contains 'delete confirms the id' "$SUB_ID" "$(capture)"
  node -e '
    const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const hit = h.find((e) => e.id === process.argv[2]);
    process.exit(hit && hit.status === "cancelled" ? 0 : 1);
  ' "$HISTORY" "$SUB_ID" && ok 'deleted task archived as cancelled' || bad 'delete did not archive the task as cancelled'
else
  bad 'no sub-agent task file left to delete'
fi

quit_dsh
summary
