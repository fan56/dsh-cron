#!/usr/bin/env bash
# Scenario 4 — the sub-agent fire chain as far as dsh-cron owns it:
#
#   prompt -> cron_create(execution_mode=sub-agent) -> fire -> the [CRON FIRE]
#   framing carries the sub-agent spawn instructions (mock proves it) ->
#   cron_report backfills -> FireRecord: status=completed, mode=sub-agent.
#
# The delegation transport itself is a deployment property: this harness
# (tui-pi preset policy) disables the raw `subagent` tool in favor of a
# registered-agents dispatch tool, so the scripted model reports from this
# conversation — cron_report accepts the outcome from any agent (ADR 0006).
set -u
. "$(dirname "$0")/lib/common.sh"
scenario '40-fire-subagent'

STORE="$DSH_HOME_DIR/storages/cron"
MOCK_LOG=/tmp/mock-llm.log

send_text 'cron e2e create subagent task: run the isolated deployment audit.'

wait_for_text 'e2e-ack' 60 || bad 'no ack for the subagent-mode create (60s)'

# Fire (+60s) with sub-agent instructions in the framing, then the report.
# (The report itself is asserted from the store below — tool_call arguments
# do not render as transcript text.)
sleep 90

if grep -aq 'sub-agent fire framing seen' "$MOCK_LOG" 2>/dev/null; then
  ok 'fire framing carried the sub-agent spawn instructions (mock-verified)'
else
  bad 'mock never saw the sub-agent spawn framing'
fi

TASK_JSON="$(node -e '
const fs = require("fs");
const dir = process.argv[1];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_history.json");
const tasks = files.map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")));
const task = tasks.find((t) => t.executionMode === "sub-agent");
if (!task) { console.error("no sub-agent task among: " + tasks.map((t) => t.id + ":" + t.executionMode).join(",")); process.exit(3); }
console.log(JSON.stringify({ id: task.id, mode: task.executionMode, fire: task.fires.at(-1) }));
' "$STORE" 2>&1)"

if [ $? -eq 0 ]; then
  assert_matches 'fire record status=completed' '"status":"completed"' "$TASK_JSON"
  assert_matches 'executionMode=sub-agent recorded' '"mode":"sub-agent"' "$TASK_JSON"
  assert_contains 'summary carries the task id' 'sub-agent done' "$TASK_JSON"
else
  bad 'could not read the sub-agent task record: '"$TASK_JSON"
fi

summary
