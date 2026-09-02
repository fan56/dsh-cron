#!/usr/bin/env bash
# Scenario 3 — the self-mode fire chain, end to end with a scripted model:
#
#   prompt -> cron_create(every 60s, self) -> mock ack
#   t+60s  scheduler tick -> followup fire -> [CRON FIRE] framing lands in a
#          real turn -> model calls cron_report -> FireRecord status=completed
#
# Task JSON assertions read the real store under <DSH_HOME>/storages/cron.
set -u
. "$(dirname "$0")/lib/common.sh"
scenario '30-fire-self'

STORE="$DSH_HOME_DIR/storages/cron"

send_text 'cron e2e create task: run the self-mode deploy check.'

if wait_for_text 'e2e-ack' 60; then
  ok 'cron_create round-tripped through the model (ack rendered)'
else
  bad 'no model ack after the create prompt (60s)'
fi

if wait_for_text '[CRON FIRE]' 120; then
  ok 'fire framing delivered into a real turn ([CRON FIRE] on screen)'
else
  bad 'no [CRON FIRE] framing within 120s of the create'
fi

# Store assertions: the fire record must be completed with the model summary.
TASK_JSON="$(node -e '
const fs = require("fs");
const dir = process.argv[1];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_history.json");
const tasks = files.map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")));
const task = tasks.find((t) => t.prompt.includes("self-mode deploy check") || (t.prompt.includes("deploy status") && t.fires.length > 0));
if (!task) { console.error("task not found among: " + tasks.map((t) => t.id).join(",")); process.exit(3); }
console.log(JSON.stringify({ id: task.id, mode: task.executionMode, fire: task.fires.at(-1) }));
' "$STORE" 2>&1)"

if [ $? -eq 0 ]; then
  assert_matches 'fire record status=completed' '"status":"completed"' "$TASK_JSON"
  assert_matches 'fire record executionMode=self' '"mode":"self"' "$TASK_JSON"
  assert_contains 'summary carries the model text' 'self-mode work done' "$TASK_JSON"
else
  bad 'could not read the task record: '"$TASK_JSON"
fi

summary
