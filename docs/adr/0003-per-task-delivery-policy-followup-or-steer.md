# Per-task delivery policy: followup (default) or steer

dsh's agent runtime exposes both `agent.followup()` (queue a new turn once fully idle) and `agent.steer()` (idle: open a turn; busy: consume at the nearest step boundary). dsh-cron makes the choice a create-time per-task **Delivery Policy**: `followup` is the default and waits out busy targets, coalescing due occurrences into one fire at the next idle tick; `steer` exists for watchdog-style tasks (stuck-loop detection, context guards) that are useless if they wait for a turn that may never end. This resolves busy-state handling per task instead of as a global rule, because downtime (skip, ADR 0002) and busy (transient, user present) are different regimes.

## Consequences

- While a previously submitted steer is still pending in the inbox, later due occurrences of the same task coalesce into it; the cursor advances on submission.
- Delivery Policy (when/how the fire lands) is orthogonal to Execution Mode (who works on the prompt); pi-kimi-cron conflated these via `deliverAs`/`executionMode`.
