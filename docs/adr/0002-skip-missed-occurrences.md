# Skip occurrences missed during downtime; log, never deliver late

Both precedents we ported from and integrate with deliver late: pi-kimi-cron coalesces missed fires on restart, and dsh-schedule catches up with the latest overdue occurrence on session resume. dsh-cron deliberately deviates: an occurrence whose due time passes while the dsh profile is not running is **skipped** — one logger line records the task id, expression, missed count, and interval — and the cursor advances to the next future occurrence. Rationale: cron means "execute at time X"; if the host was down, the occurrence did not happen, and silently firing it later would surprise the user with stale work. Visibility comes from the log line, not from late delivery.

## Consequences

- There is no overdue machinery: no queue of pending fires, no catch-up path, no one-shot "fire late" behavior. A one-shot due during downtime is logged and archived as missed, never executed.
- Delivery additionally requires a live root agent at the due tick (see ADR 0001); the same skip-and-log applies when the profile runs but no agent exists.
