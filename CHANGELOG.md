# @aiwayds/dsh-cron

## 0.2.1 (2026-09-05)

Clean uninstall, documented and proven:

- README gains an Uninstall section: the removal command, what the host
  auto-cleans (bundles entry + patch layer — schedules silently stop firing),
  what stays on disk and why (`storages/cron/` task files and `_history.json`
  are kept so a reinstall rehydrates them), the purge command, and the ADR
  0002 reinstall semantics (downtime-accrued occurrences are skipped; missed
  one-shots are archived as `missed`, never delivered late).
- The boot smoke (`scripts/smoke-boot.mjs`) adds an uninstall leg: after the
  boot proof it runs `dsh plugin --profile smoke remove` and asserts the
  composed tree is reconciled back to stock (plugin id gone from a fresh
  `--dump-config`).

## 0.2.0 (2026-09-03)

Rides the dsh RC/stable line; the alpha line is retired (policy 2026-09-03):

- CI and release workflows install the dsh CLI by resolving the newest of the
  `latest` (stable) and `next` (rc) dist-tags at runtime — never `@alpha`,
  never hand-pinned. When a stable 0.1.2+ lands on `latest` it wins over the
  rc by plain semver compare.
- Dependencies: peer floors move to `>=0.1.2-rc.1` and the dev closure is
  pinned exactly at 0.1.2-rc.1 (was 0.1.2-alpha.4).
- README now states the plugin targets the dsh RC/stable line only — the
  alpha line is no longer supported.

## 0.1.0 (2026-09-02)

Initial release: bounded cron tasks with calendar & interval rules, per-task
delivery policy (followup | steer), sub-agent execution with cron_report
backfill, per-task fire-record retention (default 7), profile-level
persistence, and /cron command.

Ships with a credential-free podman e2e suite (e2e/) that drives the real
TUI against a scripted mock LLM through the whole chain — create, 60s fire,
followup delivery, cron_report backfill, sub-agent mode, expiry archiving,
and the /cron command surface.
