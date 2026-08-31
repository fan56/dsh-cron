# Dual execution mode: sub-agent default with cron_report backfill

Fire prompts are worked either by the Delivery Target itself (`self`) or, by default, by a background sub-agent the model spawns per the `<cron_fire>` framing (`sub-agent`). The model-mediated port of pi-kimi-cron's flow was chosen over the plugin spawning sub-agents itself: the framing already tells the model exactly what to do, dsh's subagent spawn/notification/report tooling is in place, and model orchestration matches how dsh-schedule treats the model as the actor. After the sub-agent completes, the root agent calls the plugin's `cron_report` tool, which backfills the Fire Record with status and summary — this is what makes the per-task fire history (default 7, persisted) contain real outcomes rather than mere delivery receipts. `self` mode is the escape hatch for prompts that need live session context; its outcomes are best-effort because nothing forces the model to call `cron_report`.

## Considered Options

- **Self-only**: thinnest implementation, but Fire Records could only ever say "delivered" — the traceability requirement rules it out.
- **Plugin-native spawn**: deterministic, but the plugin would have to own spawn parameters, result routing, and surface display; deferred.
