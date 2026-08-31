---
name: cron
description: Schedule bounded recurring or one-shot tasks with cron_create — interval polling (每 10 分钟检查一次), calendar rules (每天 9 点/每周一/工作日), deployment monitors that stop on success/failure, and mid-turn watchdogs (卡死检测/上下文守卫). Use when the user says 定时任务、cron、每 N 分钟、每天几点、到点自动跑、监控直到成功、watchdog, or wants work to happen later across sessions. Not for within-this-session reminders of a few minutes (that is dsh-schedule's after/at) — cron tasks are cross-session and profile-anchored.
---

# Cron Scheduling

Every cron task is **bounded** — there is no infinite cron. Recurring tasks require a validity window capped at one year; on expiry the task delivers one terminal notice and archives itself. Fires only happen while the dsh profile is running: occurrences missed during downtime are skipped and logged, never delivered late.

## Choosing the rule shape

| Situation | Rule |
| --------- | ---- |
| Fixed-gap polling (deploy status, job progress) | `every_seconds` (≥ 60) |
| Wall-clock schedule (daily 9am, weekdays, monthly) | `cron` (5-field, host-local time) |

Always pass exactly one. **Never compute times yourself** — you do not know the current time. Express intent (`every_seconds: 600`, `end_at: "<user-stated date>"`) and read the absolute ISO `next_fire` echoed in the tool result; quote it back to the user.

## The window is the safety net

- Recurring tasks: exactly one of `max_duration_seconds` or `end_at`. Think about the natural lifetime before creating: deploy monitors 1–2h, daily reports until a stated date, watchdogs for the current session only.
- The user's stated deadline is an `end_at` you pass through verbatim (`"2026-12-31T23:59:59+08:00"`); "two hours" is `max_duration_seconds: 7200`. Do the conversion, not the clock-reading.
- One-shots (`recurring: false`) need no window — they self-archive after one fire.

## The deploy-monitor pattern (most common)

```json
cron_create({
  "every_seconds": 600,
  "prompt": "Check CI run 1234 (gh run view 1234). If the run reached a terminal state, report success/failure, call cron_delete on this task, and summarize. Otherwise reply briefly that it is still running.",
  "max_duration_seconds": 7200
})
```

Three layers make this reliable: the prompt's terminal-condition → `cron_delete`, `cron_report` backfills every check into the fire trail, and the window guarantees the monitor cannot outlive its usefulness.

## Delivery policy and execution mode

- `delivery_policy` — `followup` (default): fires become their own turn when the agent is idle; busy targets coalesce. `steer`: lands mid-turn at the next step boundary — use **only** for watchdogs whose whole point is interrupting a possibly-stuck turn (context-overflow guard, loop detection).
- `execution_mode` — `sub-agent` (default): an isolated background worker runs the prompt and `cron_report` carries the result back; this is the traceable path. `self`: the target conversation handles the prompt directly — only when live session state is required.

## After a fire: report discipline

When a cron-fired sub-agent completes, call `cron_report` with `task_id`, `fire_id`, `status`, and a one-line `summary` that includes the task id. This is what makes the fire history traceable. Without it, `self`-mode outcomes are lost.

## Anti-patterns

- Creating a recurring task with no thought to the window — ask "when should this stop?" first.
- Expecting fires while the profile is closed, or promising catch-up: missed occurrences are skipped by design (ADR 0002).
- Using cron for "remind me in 5 minutes" inside the current session — that is dsh-schedule's `after_seconds`, not a cross-session cron task.
- Computing `end_at` from a guessed current time — pass user-stated absolutes through and let the plugin validate.
- Steering a normal monitor: `steer` interrupts the user's live turn; reserve it for genuine watchdogs.
