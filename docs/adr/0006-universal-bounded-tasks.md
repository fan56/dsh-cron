# Universal bounded tasks: every cron task has a lifetime, at most one year

Supersedes [ADR 0004](./0004-root-only-tool-surface.md). Cron tools are registered on every runtime agent — root or sub-agent alike (sub-agents already carry full tool access; the plugin simply omits dsh-schedule's root filter) — because boundedness, not registration filtering, is what contains risk: **every recurring Cron Task carries a mandatory lifetime, capped at one year**. There is no infinite cron. The deployment-monitoring scenario motivated this: a sub-agent inside a CI/CD run creates a check-every-10-minutes task, bounded; when a fire observes terminal status the framing instructs `cron_delete`, and the lifetime cap backstops the model forgetting.

## Consequences

- One-shot tasks (`recurring: false`) self-terminate after one fire and are exempt from the lifetime requirement.
- On expiry the task delivers one terminal fire (`status=expired`, "monitoring window closed") before archiving — a bounded task that silently stops checking is the worst outcome for a deploy monitor. This is a deliberate terminal notice, not a missed-occurrence delivery (ADR 0002 unaffected).
- No root/subagent privilege split remains in the tool surface; `createdBy` (ADR 0004) still records who created what.
