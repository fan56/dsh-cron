# @aiwayds/dsh-cron

Cron scheduling for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as an independent plugin: schedule prompts on standard cron expressions or fixed intervals, bound to exactly one session — creator by default, or a dedicated new session — with no global delivery (ADR 0010).

**Requires dsh >= 0.2.0-rc.2** — this plugin targets the dsh RC/stable line only (CI and releases resolve the newest of the `latest`/`next` dist-tags at runtime). **The alpha line is no longer supported.**

Design docs: [CONTEXT.md](./CONTEXT.md) (glossary) and [docs/adr/](./docs/adr) (decisions).

## Why not dsh-schedule?

`@deepseek-ai/dsh-schedule` provides session-scoped reminders (`after` / `at` / `every_seconds ≥ 5min`), and its protocol explicitly excludes cron expressions. dsh-cron is the complement: **recurring tasks on real cron expressions**, using the same session-binding discipline — a fire lands only in the session the task is bound to (creator by default, or a dedicated new one), and a stopped session cancels its tasks, exactly like dsh-schedule's reminders. Where dsh-schedule says "remind this conversation at time X", dsh-cron says "run this bounded cron job for session Y".

As of **dsh 0.2.0, the official automation schedule ships as an OPTIONAL_BUNDLE that is disabled by default** — after upgrading, existing official scheduled tasks silently stop firing until you manually opt in (and the official time-context feature goes dark with it). dsh-cron is unaffected by that switch: it is an **independent, always-resident scheduling plugin** that registers its own cordis plugin and clock, with no dependency on the official bundle — out of the box on every profile it is installed in, no opt-in required. If you relied on official scheduled tasks and do not want to hunt for a hidden settings toggle after each host upgrade, dsh-cron is the always-on alternative; the two can also coexist, since their rule vocabularies do not overlap (at/every reminders vs cron expressions and short bounded intervals).

## Core properties

- **Bound to one session, never global** (ADR 0010): every task carries `attach` — `creator` (default) delivers every fire to the session that ran `cron_create`; `new` opens a dedicated session for the task (background monitors isolated from the conversation). A fire whose session is stopped is never rerouted elsewhere; the occurrence skips (ADR 0002).
- **No infinite cron** (ADR 0006): every recurring task carries a mandatory validity window (`max_duration_seconds` or `end_at`), capped at one year. On expiry the task delivers one terminal `expired` fire and archives itself. One-shot tasks self-archive after their single fire.
- **Two rule shapes** (ADR 0007): `cron` (5-field calendar expression, host-local time) or `every_seconds` (interval ≥ 60s, anchored at `start_at`, first fire one full interval in).
- **The plugin owns the clock** (ADR 0007): the model only expresses intent (`every_seconds: 600`, `end_at: "2026-12-31T00:00:00Z"`); all time math happens in the plugin and tool results echo absolute ISO times (`now`, `next_fire`). The model never needs to know the current time.
- **Per-task delivery policy** (ADR 0003): `followup` (default) queues a new turn via the session agent's idle phase — a busy target waits and coalesces overdue occurrences into one fire annotated with `coalesced_count`. `steer` submits through `agent.steer()` and lands at the nearest step boundary, mid-turn — the watchdog option.
- **Two execution modes** (ADR 0005): `sub-agent` (default) — the framing instructs the model to spawn an isolated background worker, then call `cron_report` to backfill status/summary into the fire record; `self` — handled in the bound conversation itself, best-effort reporting.
- **Missed occurrences are skipped, never delivered late** (ADR 0002): if the profile was down or the bound session was unresolvable when an occurrence came due, it is logged and settled. A one-shot missed in downtime archives as `missed`. Cron means "execute at time X"; dsh-cron does not resurrect stale work.
- **Lifecycle follows the session** (ADR 0010): a cold session (host restarted) is resumed on demand when a fire is due; a stopped session (archived with `stopActivity`) cancels its tasks; archiving a session that still holds cron tasks is refused until they stop — dsh-schedule's discipline, applied to cron.
- **Full traceability** (Q3): every delivered fire produces a durable `FireRecord` (due time, policy, mode, coalesced count, status, summary). Records ride with the task, capped at 7 per task (configurable); ended tasks move to `_history.json` (cap 50).
- **Tools on every top-level agent** (ADR 0006): `cron_create` / `cron_list` / `cron_delete` / `cron_report` are registered on all runtime agents and every task records `createdBy`. Delegated child sessions are refused at creation — their sessions never receive fires.

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
| `cron_create` | Create a task. Exactly one rule (`cron` \| `every_seconds`); recurring tasks require exactly one window bound (`max_duration_seconds` \| `end_at`). `attach` picks the bound session: `creator` (default) or `new` (dedicated). |
| `cron_list` | Active tasks with bound session, next-fire times, and retained fire records. |
| `cron_delete` | Delete and archive (status `cancelled`). |
| `cron_report` | Backfill a fire's outcome (`completed`/`failed` + summary); one-shots archive on report. |

### Cron syntax

Standard 5 fields: `minute hour day-of-month month day-of-week`, with lists (`1,3,5`), ranges (`1-5`), steps (`*/2`), and month/day names (`jan`, `mon`). Evaluated in the **host's local time zone** (a per-task IANA `time_zone` is a planned fast-follow — see ADR 0009).

## Human usage

```
/cron list
/cron create "*/10 * * * *" "检查 CI run 1234，终态则删除本任务" --for=7200
/cron create "0 9 * * 1-5" "生成周报" --until=2026-12-31T23:59:59+08:00
/cron create "0 * * * *" "磁盘水位巡检" --new-session --for=2592000
/cron delete a1b2c3d4
/cron fires a1b2c3d4
/cron history 20
```

`--new-session` opens a dedicated session for the task instead of binding the
conversation you ran the command in.

## Persistence

The store is profile-level so bindings survive restarts; each task file
records the one session it delivers to (ADR 0001 store placement, ADR 0010
binding):

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

## Uninstall

```bash
dsh plugin --profile tui remove @aiwayds/dsh-cron
```

The host reconciles the profile automatically: the `dsh.profile.bundles` entry is spliced and the plugin's patch layer drops — schedules silently stop firing, and the bundled `dsh-cron-config` skill disappears from the registry with the plugin.

What stays on disk, kept on purpose (deleting data is destructive, and a reinstall rehydrates it):

- `<dsh home>/storages/cron/<id>.json` — active tasks with their fire records, including the schedules' validity windows.
- `<dsh home>/storages/cron/_history.json` — the capped archive of ended tasks.

Reinstall semantics follow [ADR 0002](./docs/adr/0002-skip-missed-occurrences.md): occurrences that came due while the plugin was away are **skipped and logged, never delivered late** — a one-shot missed in downtime is archived as `missed`. Cron means "execute at time X"; the plugin does not resurrect stale work after a gap.

Legacy note: releases before 0.2.0 documented a manual skill copy (`cp -r skill/cron $DSH_HOME/skills/`). That copy is obsolete since the skill now mounts through the provider registry — delete a stale `$DSH_HOME/skills/cron` directory if you made one, or it shadows the packaged guide. To purge the task data too:

```bash
rm -r ~/.dsh/storages/cron
```

### Skill (model guidance) — installed by default

The npm tarball ships a `dsh-cron-config` skill (`skill/dsh-cron-config/SKILL.md`) that teaches the model when and how to use the tools (rule selection, window thinking, session binding, the deploy-monitor and watchdog patterns). It mounts **automatically**: the plugin registers it with the host's skill registry at boot (`ctx.skills` provider, bundled rank), so installing the plugin is the skill install — no file copy into `$DSH_HOME/skills`, and removing the plugin removes the skill with it, no residue.

Users never invoke it by hand: say things like "每 10 分钟检查一次 CI" or "watch this deploy until it's done" in any top-level session and the model routes through the skill to `cron_create`. The skill body lives in [skill/dsh-cron-config/SKILL.md](./skill/dsh-cron-config/SKILL.md).

### Settings (`dsh-cron` entry in the profile patch)

Since dsh 0.1.7 the legacy `settings.yaml` is imported once at boot and renamed
`settings.yaml.imported`; plugin settings live in the profile patch
(`~/.dsh/profiles/<profile>/cordis.patch.yml`) under the `dsh-cron` entry. All
four keys are volatile (settings-page editable, live where the engine reads
them per tick); `storageDir` and `tickIntervalMs` are read at plugin mount, so
changes there apply after a restart.

| Key | Default | Meaning |
| --- | ------- | ------- |
| `fireHistoryLimit` | 7 | Fire records kept per task (oldest evicted). |
| `historyLimit` | 50 | Archived tasks kept in `_history.json`. |
| `tickIntervalMs` | 15000 | Scheduler tick period. |
| `storageDir` | — | Storage override; empty = `<dsh home>/storages/cron`. |

Upgrading from a pre-0.1.7 install: a top-level `cron:` section in the old
`settings.yaml` (which the host renames to `settings.yaml.imported` after its
one-shot import — the section name does not match this plugin's entry id) is
migrated ONCE at the next plugin boot. Keys whose legacy value differs from the
current effective value are written into the `dsh-cron` entry automatically;
the pass is recorded in the audit marker
`<dsh home>/storages/dsh-cron/legacy-import.json` (a present marker means the
migration never re-runs; a failed write retries on the next boot).

## Limitations

- **Fires need a live profile**: dsh-cron is an in-process plugin by design (ADR 0001; an MCP server cannot push). Nothing fires while dsh is not running, and downtime-accrued occurrences are skipped by policy. A cold session is resumed on demand when a fire is due (ADR 0010), but only while the host process is up.
- **Delivery follows the bound session only** (ADR 0010): a task whose session is stopped skips until the session returns or is stopped-with-activity (which cancels the task). There is no reroute to another conversation, by design.
- **Sub-agent sessions neither create nor receive**: delegated child sessions are refused at `cron_create` and never resolve as delivery targets.
- **Host-local calendar time**: calendar rules read the host clock's zone; containers in UTC will shift wall-clock schedules (ADR 0009).
- **`self`-mode outcomes are best-effort**: nothing can force the model to call `cron_report`; sub-agent mode is the traceable default.
- **One steer per tick**: while a steer sits unconsumed in an inbox, later occurrences still submit once per tick rather than collapsing (dsh's inbox cannot be introspected from a plugin).

## Architecture

```
src/
  index.ts        plugin entry: settings, agent/created mount, /cron, tick loop, session lifecycle
  scheduler.ts    dsh-free tick engine (fires, coalescing, skip, expiry)
  attach.ts       session binding glue: target resolution, cold resume, dedicated sessions
  rule.ts         selector + validity-window validation, occurrence math
  cron-expr.ts    5-field cron parser + next-fire computation
  framing.ts      [CRON FIRE] model framing (injection-resistant)
  tools.ts        cron_create / cron_list / cron_delete / cron_report
  store.ts        per-id JSON task store + capped history (atomic writes)
  legacy-import.ts one-time `cron:` section migration (0.1.5 → 0.1.7) + audit marker
  types.ts        data model and clock seam
  paths.ts        dsh home resolution
test/             unit suites over the compiled lib (fake clocks/agents)
scripts/
  smoke-boot.mjs  real-host smoke: pack → scratch profile → boot
e2e/              podman suite: real dsh TUI in tmux driven against a scripted mock LLM
```

## E2E

`e2e/run-e2e.sh` builds a container image (Ubuntu + Node + a global dsh install + the packed plugin tarball) and drives the real TUI in tmux against an in-container **mock OpenAI-compatible LLM** — no credentials, fully deterministic, the same suite that gates CI. The scenarios exercise the whole chain end to end:

1. profile assembly — the plugin composes into the real dsh bundle tree
2. TUI boot against the scripted provider
3. self-mode chain — the model creates a task, the scheduler fires after 60s, the `[CRON FIRE]` framing lands in a live turn, `cron_report` backfills the record, the store asserts `status: completed`
4. sub-agent chain — the fire spawns a real dsh subagent whose `cron_report` is backfilled by the child
5. commands & expiry — `/cron list` / `/cron help`, the window closes, the task archives itself as `expired`, `/cron delete` archives as `cancelled`

```bash
./e2e/run-e2e.sh                   # dev machine (uses registry mirrors)
CLEAN_NETWORK=1 ./e2e/run-e2e.sh   # CI-like network (official endpoints)
```

Ported from [@aiwayds/pi-kimi-cron](https://github.com/fan56/pi-kimi-cron) (itself ported from Kimi Code's cron module), redesigned for dsh's runtime — the deltas are all recorded in [docs/adr/](./docs/adr).

## License

[MIT](./LICENSE)
