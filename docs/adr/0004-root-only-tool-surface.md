# Cron tools are registered on runtime roots only

Every cron tool (`cron_create`, `cron_list`, `cron_delete`, `cron_report`) is registered exclusively on root agents, following dsh-schedule's root-only precedent. Unlike dsh-schedule we have no session-boundary objection — our tasks are profile-anchored (ADR 0001), so a sub-agent could create a perfectly valid task — but v1 keeps the write path user-visible: the sub-agent in the fire flow (ADR 0005's execution flow) is a dumb executor that reports to its spawner, so it needs no cron tools, and background workers silently scheduling tasks whose fires land in the user's conversation is a trust hazard. A sub-agent that needs a scheduled follow-up reports back and the root agent schedules on its behalf.

## Consequences

- Tasks carry a `createdBy` (agent id) field from day one, so attribution stays unambiguous if sub-agent creation is unlocked later.
- Unlocking sub-agent access later is a tool-registration filter change, not a schema change.
