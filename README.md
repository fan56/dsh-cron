# @aiwayds/dsh-cron

Cron scheduling for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as an independent plugin: schedule prompts on standard cron expressions or fixed intervals and have them delivered to live agents — across TUI, web, and feishu surfaces.

Design docs: [CONTEXT.md](./CONTEXT.md) (glossary) and [docs/adr/](./docs/adr) (decisions).

## Why not dsh-schedule?

`@deepseek-ai/dsh-schedule` provides session-scoped reminders (`after` / `at` / `every_seconds ≥ 5min`) that only fire while the original session stays live, and its protocol explicitly excludes cron expressions. dsh-cron is the complement: **profile-anchored recurring tasks** — a fire lands in whichever live root agent exists, regardless of which surface the session belongs to.

## Core properties

- **No infinite cron** (ADR 0006): every recurring task carries a mandatory validity window (`max_duration_seconds` or `end_at`), capped at one year. On expiry the task delivers one terminal `expired` fire and archives itself. One-shot tasks self-archive after their single fire.
- **Two rule shapes** (ADR 0007): `cron` (5-field calendar expression, host-local time) or `every_seconds` (interval ≥ 60s, anchored at `start_at`, first fire one full interval in).
- **The plugin owns the clock** (ADR 0007): the model only expresses intent (`every_seconds: 600`, `end_at: "2026-12-31T00:00:00Z"`); all time math happens in the plugin and tool results echo absolute ISO times (`now`, `next_fire`). The model never needs to know the current time.
- **Per-task delivery policy** (ADR 0003): `followup` (default) queues a new turn via the agent's idle phase — a busy target waits and coalesces overdue occurrences into one fire annotated with `coalesced_count`. `steer` submits through `agent.steer()` and lands at the nearest step boundary, mid-turn — the watchdog option.
- **Two execution modes** (ADR 0005): `sub-agent` (default) — the framing instructs the model to spawn an isolated background worker, then call `cron_report` to backfill status/summary into the fire record; `self` — handled in the target conversation itself, best-effort reporting.
- **Missed occurrences are skipped, never delivered late** (ADR 0002): if the profile was down or no agent was live when an occurrence came due, it is logged and settled. A one-shot missed in downtime archives as `missed`. Cron means "execute at time X"; dsh-cron does not resurrect stale work.
- **Full traceability** (Q3): every delivered fire produces a durable `FireRecord` (due time, policy, mode, coalesced count, status, summary). Records ride with the task, capped at 7 per task (configurable); ended tasks move to `_history.json` (cap 50).
- **Tools for every agent** (ADR 0006): `cron_create` / `cron_list` / `cron_delete` / `cron_report` are registered on all runtime agents — root or sub-agent — and every task records `createdBy`.

## Agent usage (primary)

The LLM calls the tools directly. Humans just talk:

- "每 10 分钟检查一次 CI run 1234，最多查两小时，成功或失败就停" →
  `cron_create({ every_seconds: 600, prompt: "检查 CI run 1234，终态则 cron_delete 本任务并汇报", max_duration_seconds: 7200 })`
- "工作日每天早上 9 点生成周报，到年底为止" →
  `cron_create({ cron: "0 9 * * 1-5", prompt: "生成本周周报", end_at: "2026-12-31T23:59:59+08:00" })`
- "每小时看一眼磁盘，如果超过 90% 立刻插进来提醒我" →
  `cron_create({ cron: "0 * * * *", prompt: "检查磁盘使用率", delivery_policy: "steer", execution_mode: "self", max_duration_seconds: 86400 })`

### Tool reference

| Tool | Purpose |
| ---- | ------- |
| `cron_create` | Create a task. Exactly one rule (`cron` \| `every_seconds`); recurring tasks require exactly one window bound (`max_duration_seconds` \| `end_at`). |
| `cron_list` | Active tasks with next-fire times and retained fire records. |
| `cron_delete` | Delete and archive (status `cancelled`). |
| `cron_report` | Backfill a fire's outcome (`completed`/`failed` + summary); one-shots archive on report. |

### Cron syntax

Standard 5 fields: `minute hour day-of-month month day-of-week`, with lists (`1,3,5`), ranges (`1-5`), steps (`*/2`), and month/day names (`jan`, `mon`). Evaluated in the **host's local time zone** (a per-task IANA `time_zone` is a planned fast-follow — see ADR 0009).

## Human usage

```
/cron list
/cron create "*/10 * * * *" "检查 CI run 1234，终态则删除本任务" --for=7200
/cron create "0 9 * * 1-5" "生成周报" --until=2026-12-31T23:59:59+08:00
/cron delete a1b2c3d4
/cron fires a1b2c3d4
/cron history 20
```

## Persistence

Profile-level, not per-session (ADR 0001):

```
$DSH_HOME/storages/cron/<8-hex-id>.json   # active tasks with their fire records
$DSH_HOME/storages/cron/_history.json     # capped archive of ended tasks
```

Atomic writes (tmp + fsync + rename); corrupt files are skipped, never fatal.

## Installation

```bash
dsh plugin --profile tui add @aiwayds/dsh-cron
```

Then add the package to the profile's `dsh.profile.bundles` (after `@deepseek-ai/dsh-base`) and restart the profile.

### Skill (model guidance)

The npm tarball ships a `cron` skill (`skill/cron/SKILL.md`) that teaches the model when and how to use the tools (rule selection, window thinking, the deploy-monitor and watchdog patterns). Install it by copying to the dsh skill root:

```bash
mkdir -p $DSH_HOME/skills && cp -r <package>/skill/cron $DSH_HOME/skills/
```

### Settings (`cron` namespace in settings.yaml)

| Key | Default | Meaning |
| --- | ------- | ------- |
| `fireHistoryLimit` | 7 | Fire records kept per task (oldest evicted). |
| `historyLimit` | 50 | Archived tasks kept in `_history.json`. |
| `tickIntervalMs` | 15000 | Scheduler tick period. |
| `storageDir` | — | Storage override; empty = `<dsh home>/storages/cron`. |

## Limitations

- **Fires need a live profile**: dsh-cron is an in-process plugin by design (ADR 0001; an MCP server cannot push). Nothing fires while dsh is not running, and downtime-accrued occurrences are skipped by policy.
- **Host-local calendar time**: calendar rules read the host clock's zone; containers in UTC will shift wall-clock schedules (ADR 0009).
- **`self`-mode outcomes are best-effort**: nothing can force the model to call `cron_report`; sub-agent mode is the traceable default.
- **One steer per tick**: while a steer sits unconsumed in an inbox, later occurrences still submit once per tick rather than collapsing (dsh's inbox cannot be introspected from a plugin).

## Architecture

```
src/
  index.ts        plugin entry: settings, agent/created mount, /cron, tick loop
  scheduler.ts    dsh-free tick engine (fires, coalescing, skip, expiry)
  rule.ts         selector + validity-window validation, occurrence math
  cron-expr.ts    5-field cron parser + next-fire computation
  framing.ts      [CRON FIRE] model framing (injection-resistant)
  tools.ts        cron_create / cron_list / cron_delete / cron_report
  store.ts        per-id JSON task store + capped history (atomic writes)
  types.ts        data model and clock seam
  paths.ts        dsh home resolution
test/             unit suites over the compiled lib (fake clocks/agents)
scripts/
  smoke-boot.mjs  real-host smoke: pack → scratch profile → boot
```

Ported from [@aiwayds/pi-kimi-cron](https://github.com/fan56/pi-kimi-cron) (itself ported from Kimi Code's cron module), redesigned for dsh's runtime — the deltas are all recorded in [docs/adr/](./docs/adr).

## License

[MIT](./LICENSE)
