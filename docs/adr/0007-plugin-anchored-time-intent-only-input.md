# Plugin-anchored time: intent-only input, ISO echoes out

The model never needs to know the current time (dsh ships no model clock by default — dsh-time-context is opt-in, and upstream discussion #4983 documents the resulting pain). All time mathematics are done by the plugin against the system clock; tool results echo absolute ISO timestamps (`now`, `next_fire`) so the model and user see concrete times without the model computing any. Inputs express intent only. A create call supplies exactly one schedule selector — `cron` (5-field calendar rule) or `every_seconds` (interval rule, ≥ 60s, creation-anchored) — and, for recurring tasks, exactly one window bound — `max_duration_seconds` or `end_at` (absolute, capped one year) — plus an optional `start_at` (default: creation time, must be in the future), which lets interval tasks start at a calendar moment. Absolute times supplied by the user pass through the model untouched; the plugin validates them (not in the past, within the one-year horizon).

## Consequences

- A future per-task `time_zone` field refines calendar-rule evaluation without changing any of these shapes.
- The one-year cap applies to `end_at` as a horizon check (end_at ≤ now + 1 year) and to `max_duration_seconds` directly.
