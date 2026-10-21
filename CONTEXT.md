# dsh-cron

An independent dsh plugin that schedules prompts on standard cron expressions, each task bound to exactly one session (ADR 0010). It brings the cron capability dsh itself lacks (see ADR 0001) and complements the official session-scoped `dsh-schedule` reminders under the same session-binding discipline.

## Language

**Cron Task**:
A persisted rule binding a cron expression to a prompt and to exactly one session (`attach`: `creator` or `new`; ADR 0010). The store is profile-level so the binding survives restarts, but delivery is never global. Always bounded: recurring tasks carry a mandatory lifetime capped at one year (ADR 0006). Carries `createdBy` (agent id) for attribution.
_Avoid_: job (collides with dsh `ctx.jobs` background jobs), reminder (that is dsh-schedule's concept), global task (no longer representable)

**Validity Window**:
The lifetime of a recurring Cron Task, from creation to its mandatory end bound. Fires only occur inside the window.
_Avoid_: TTL, lease, expiry date

**Expiry**:
The end of a Validity Window. Delivers one terminal fire (`status=expired`) and archives the task.
_Avoid_: timeout (that is tool-call timeout, a dsh concept), cancellation (user-initiated)

**Calendar Rule**:
A 5-field cron expression defining occurrences by wall-clock date and time, evaluated in host-local time (ADR 0009).
_Avoid_: cron job, schedule expression

**Interval Rule**:
An `every_seconds` rule defining occurrences at a fixed gap from the task's start (minimum 60s). The deployment-polling shape.
_Avoid_: fixed-rate (dsh-schedule's term), setInterval

**Fire**:
One due occurrence of a Cron Task being delivered to its bound session as a followup turn.
_Avoid_: trigger, dispatch (dsh-schedule's term for its own delivery), run

**Fire Record**:
The audit entry for one Fire: due time, delivery time, execution mode, and outcome. Every Fire produces exactly one Fire Record, persisted with its task; per-task records are capped with oldest-eviction (default 7, configurable). Skipped occurrences leave no Fire Record (ADR 0002).
_Avoid_: log entry, history item

**Delivery Target**:
The live agent of the task's bound session (ADR 0010) — resolved live first, then via cold resume. A Fire always has exactly one Delivery Target at the moment it is delivered, and it is always in the bound session.
_Avoid_: any live agent (the pre-0010 global fallback), root pool

**Session Binding**:
The create-time attachment of a Cron Task to one session: `creator` (the session that ran cron_create) or `new` (a dedicated session the plugin opens). A stopped session cancels its tasks; a cold session is resumed on demand; a delegated child session neither creates tasks nor receives Fires (ADR 0010).
_Avoid_: attach to agent (the binding is to the session identity, not the agent instance)

**Sub-agent**:
An ephemeral spawned worker. In `sub-agent` Execution Mode it runs the Fire's prompt and reports back; it never holds cron tools.
_Avoid_: child agent, worker

**Coalescing**:
Collapsing multiple due occurrences that accumulated while the Delivery Target was busy into a single Fire annotated with the missed count. Applies only to a live profile with a busy target (see ADR 0002 for the downtime rule).
_Avoid_: catch-up, replay (replay implies executing each missed occurrence, which we never do)**Missed Occurrence**:
An occurrence whose due time passed while the profile was not running, or while the bound session was unresolvable. It is skipped, logged once, and never delivered (ADR 0002).
_Avoid_: overdue (dsh-schedule's term; implies late delivery), lost fire

**Execution Mode**:
How a Fire's prompt is worked on: the Delivery Target's own conversation handles it, or a spawned sub-agent works in isolation. Orthogonal to Delivery Policy.
_Avoid_: main/sub-agent (pi vocabulary; mapped onto dsh subagent concepts)

**Delivery Policy**:
A per-task create-time choice of how Fires land: `followup` (new turn when the target is idle; busy waits and coalesces) or `steer` (consumed at the nearest step boundary, even mid-turn). Default `followup` (ADR 0003).
_Avoid_: deliverAs (pi's parameter name), interrupt, priority

**Steer**:
A Fire delivered via `agent.steer()`: lands between steps of a running turn. The mode for watchdog tasks.
_Avoid_: interrupt, hijack

**Followup**:
A Fire delivered via `agent.followup()`: becomes the sole message of its own future turn. The default policy.
_Avoid_: queue, defer

**Idle Gate**:
The rule that a Fire is delivered only when the Delivery Target is not mid-turn; due-but-busy Fires wait and coalesce.
_Avoid_: debounce, queue lock

**History**:
The capped archive of ended Cron Tasks (deleted, or one-shots that fired) with their Fire Records.
_Avoid_: audit log, journal
