# Session-anchored delivery: every task binds exactly one session

ADR 0001 positioned dsh-cron tasks as profile-anchored: fires landed in
"whichever live root agent exists", regardless of surface. That is global
delivery, and it is wrong as a default: a fire should arrive where its work
belongs, not in whatever conversation happens to be open. As of ADR 0010
every task is bound to exactly one session at creation time, and the engine
has no global fallback.

The decision: `cron_create` takes `attach`, choosing between

- `creator` (default) — the session that ran cron_create owns the task; every
  fire lands there. This covers the dominant case (schedule follow-up work for
  this conversation).
- `new` — the plugin opens a dedicated session (host session-id convention:
  `session-<uuid>`, cwd inherited from the creator) and the task binds to it.
  This covers background monitors that should not pollute a conversation.

A task with no binding is not representable anymore. Visibility is not
delivery: `cron_list` still shows every task with its bound session, but
fires go only to the bound session.

## Precedent

This aligns dsh-cron with the official dsh-schedule: reminders are stored
host-level but each row carries a `sessionId`, delivery resolves the bound
session through `sessionController.resolveAgent`, delegated child sessions
never receive fires, and a session stop cancels its reminders. dsh-cron keeps
its own reason to exist — calendar (cron) and bounded-interval rules, which
dsh-schedule does not support.

## Lifecycle

- **Cold sessions** (process restarted, session persisted but not live): a due
  fire resumes the bound session through `sessionController.resolveAgent` and
  delivers — same contract as dsh-schedule. Occurrences missed entirely while
  down are still skipped, never delivered late (ADR 0002 unchanged).
- **Stopped sessions** (archived with `stopActivity`): the host's
  `workspace/session-stop` dispatch cancels every task bound to that session
  (archived as `cancelled`), mirroring dsh-schedule's reminder deletion.
  Archiving a session that still holds cron tasks without stopping them is
  refused: the plugin reports a `cron` entry through the
  `workspace/session-activity` waterfall.
- **Boot sweep**: tasks whose bound session exists neither live nor in
  persistence are archived as `cancelled` once at rehydrate (a session that
  died without a stop dispatch cannot leave zombies). Hosts without the
  optional `sessionQuery`/`sessionController`/`workspace` services stand down
  to live-only delivery and skip on unresolvable targets (ADR 0002).

## Considered Options

- **Creator-bound only, dead session archives the task**: simplest, but a
  recurring task would die with one closed conversation; dedicated sessions
  could not outlive a single host process without it.
- **Creator-bound with automatic migration to a fresh session**: keeps tasks
  running forever, but work continues in a conversation the user never
  opened — the same surprise global delivery produced, one step removed.

## Consequences

- `CronTask` carries `attach` and `sessionId`; pre-0010 task files (no
  binding) are archived as `cancelled` at rehydrate — global delivery no
  longer exists, and history keeps the audit trail.
- Delegated child sessions cannot create tasks (tool-level refusal) and never
  receive fires (resolver-level refusal), matching dsh-schedule's target
  refusal; the depth formula mirrors dsh-subagent's `delegationDepthOf`.
- The store stays profile-level: the binding is durable data that survives
  restarts, which is what makes cold resume and the boot sweep possible.
  ADR 0001's store placement survives; its "fires into whichever live root
  agent exists" delivery rule is superseded by this ADR.

Supersedes the delivery half of ADR 0001 (profile-anchored in-process
scheduler); the in-process scheduler decision itself stands.
