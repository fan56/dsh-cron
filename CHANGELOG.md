# @aiwayds/dsh-cron

## 0.1.0 (2026-09-02)

Initial release: bounded cron tasks with calendar & interval rules, per-task
delivery policy (followup | steer), sub-agent execution with cron_report
backfill, per-task fire-record retention (default 7), profile-level
persistence, and /cron command.

Ships with a credential-free podman e2e suite (e2e/) that drives the real
TUI against a scripted mock LLM through the whole chain — create, 60s fire,
followup delivery, cron_report backfill, sub-agent mode, expiry archiving,
and the /cron command surface.
