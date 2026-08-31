# Host-local calendar evaluation, no jitter

Two deliberate deviations from the ported pi-kimi-cron design. First, 5-field cron rules are evaluated in the **host's local time zone** (pi behavior); a per-task IANA `time_zone` field is a planned fast-follow and needs no schema reservation. Every other time surface is already zone-free: intervals and windows are anchored by the plugin's clock, and `end_at`/`start_at` carry their own offsets or are read host-local once (ADR 0007). Second, the deterministic per-task jitter (≤ 5s thundering-herd defense) is **dropped**: it exists for Kimi's multi-machine fleet firing in unison, while dsh-cron is one process on one machine, and under the skip-missed semantics (ADR 0002) staggered timing has no value — it only made pi's timing tests harder (hence its `PI_CRON_NO_JITTER` escape hatch).

## Consequences

- Profiles running in containers or on servers in foreign time zones will misread calendar rules until the per-task `time_zone` fast-follow lands; the README must state this in the limitations section.
- Tests need no clock-independence scaffolding beyond the fixed/offset clock sources already ported.
