/**
 * dsh-cron — cron scheduling for the DeepSeek Harness as an independent
 * plugin: bounded tasks with calendar (cron) and interval (every_seconds)
 * rules, delivered to live agents via followup or steer.
 *
 * Shape follows the ecosystem conventions: a schemastery settings namespace
 * (`cron`), tools registered on every runtime agent through the agent's own
 * tool context (ADR 0006 — no root filter; sub-agents already carry full
 * tool access, and boundedness is what contains risk), the /cron command
 * registered from the plugin itself through the shared dsh-commands registry
 * (optional peer, mounted via ctx.inject), zero npm dependencies in the
 * shipped artifact.
 *
 * @module dsh-cron
 */

import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

// Types only (erased at emit); dsh-commands is an optional peer, so hosts
// without it still load this plugin — see the guarded registration below.
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only side-effect import: loads dsh-settings' `declare module
// '@deepseek-ai/cordis'` augmentation, which is what puts `ctx.settings` on
// the Context type. There is no runtime import — the host provides the
// settings service; dsh-settings 0.1.2-alpha.3 removed the
// settingsNamespace() helper this file used to import.
import type {} from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { CronEngine, type AgentLike, type DeliveryOutcome } from './scheduler.ts'
import { nextOccurrence } from './rule.ts'
import { createHistoryStore, createTaskStore } from './store.ts'
import { registerCronTools, type ToolRegistrarContext } from './tools.ts'
import { defaultCronDir } from './paths.ts'
import { systemClock, type CronConfig, type CronTask } from './types.ts'

export const name = 'dsh-cron'

/** Services required before the engine can mount. */
export const inject = ['settings', 'agents', 'tools']

// dsh-settings 0.1.2-alpha.3 removed the runtime settingsNamespace() helper:
// register() now brand-checks the namespace at the type level
// (SettingsNamespaceInput) and validates the same lowercase-hyphenated
// pattern at runtime via parseSettingsNamespace. A plain literal is the
// supported spelling (same adaptation as dsh-model-sync).
const OWN_NS = 'cron'

/** The `cron` settings namespace: user-editable in settings.yaml. */
const CronSettings = z.object({
  /** Per-task fire-record retention; oldest evicted. Default 7. */
  fireHistoryLimit: z.number().default(7),
  /** Archived-task FIFO cap for _history.json. Default 50. */
  historyLimit: z.number().default(50),
  /** Tick loop period in ms. Default 15000. */
  tickIntervalMs: z.number().default(15000),
  /** Storage directory override; empty = <dsh home>/storages/cron. */
  storageDir: z.string().default(''),
})

/** Structural slice of the live dsh agent runtime used for delivery. */
interface RuntimeAgent {
  followup(message: unknown): void
  steer(message: unknown): void
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

export function apply(ctx: Context): void {
  const scope = ctx.settings.register(OWN_NS, CronSettings)
  const cfgNow = (): CronConfig => scope.get() as unknown as CronConfig

  const dir = resolveStorageDir(cfgNow().storageDir)
  const store = createTaskStore(dir)
  const historyStore = createHistoryStore(dir, cfgNow().historyLimit)

  /**
   * Production delivery seam (ADR 0003/0005): steer submits unconditionally
   * (dsh consumes it at the nearest step boundary); followup claims the true
   * idle phase via runMaintenance — a synchronous rejection means the target
   * is mid-turn and the engine keeps the fire due for coalescing.
   */
  const deliver = async (target: AgentLike, text: string, policy: 'followup' | 'steer'): Promise<DeliveryOutcome> => {
    const runtime = target as unknown as RuntimeAgent
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'cron' },
    })
    if (policy === 'steer') {
      runtime.steer(message)
      return 'delivered'
    }
    try {
      await runtime.runMaintenance(async () => {
        runtime.followup(message)
      })
      return 'delivered'
    } catch {
      return 'busy'
    }
  }

  const engine = new CronEngine({
    clock: systemClock,
    store,
    historyStore,
    config: {
      get fireHistoryLimit() {
        return cfgNow().fireHistoryLimit
      },
    },
    logger: ctx.logger,
    targets: () => ctx.agents.roots() as unknown as AgentLike[],
    deliver,
  })

  // Tools on every runtime agent (ADR 0006): the plugin does not apply
  // dsh-schedule's root filter, and the agent-local effect unwinds each
  // registration when the agent is disposed.
  ctx.effect(() => {
    return ctx.on('agent/created', ({ agent }) => {
      agent.ctx.effect(() => registerCronTools(agent.ctx as unknown as ToolRegistrarContext, agent, engine))
    })
  }, 'dsh-cron: agent tools')

  // Boot: rehydrate from disk (skipping downtime-accrued occurrences per
  // ADR 0002) and start the tick loop on a plain unref'd interval, cleared
  // when the plugin is disposed.
  ctx.effect(() => {
    mkdirSync(dir, { recursive: true })
    void engine
      .rehydrate()
      .then(({ skipped, missed }) => {
        if (skipped > 0 || missed > 0) {
          ctx.logger.info(`cron: rehydrated store at ${dir} — ${skipped} occurrence(s) skipped, ${missed} one-shot(s) missed`)
        }
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`cron: rehydrate failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    const timer = setInterval(() => {
      void engine.tick()
    }, Math.max(cfgNow().tickIntervalMs, 1000))
    timer.unref()
    return () => {
      clearInterval(timer)
    }
  }, 'dsh-cron: tick loop')

  // /cron command through the shared registry (optional peer; guarded like
  // dsh-vault so hosts without dsh-commands still load the plugin).
  ctx.inject(['commands'], (cmdCtx) => {
    const commands = (cmdCtx as {
      commands?: { register(definition: CommandDefinition): () => void }
    }).commands
    if (commands?.register === undefined) return
    cmdCtx.effect(() => {
      const definition: CommandDefinition = {
        name: 'cron',
        description: '定时任务：list | create | delete | fires | history | help（跨会话、有界、可追溯）',
        input: {
          hint: '[list | create "<cron|every=N>" "<prompt>" [--once] [--steer] [--self] (--for=<seconds>|--until=<iso>) [--start=<iso>] | delete <id> | fires <id> | history [N] | help]',
        },
        handler: (invocation) => handle(invocation),
      }
      return commands.register(definition)
    }, 'dsh-cron: /cron')
  })

  const handle = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const raw = invocation.rawInput.trim()
    const [action = '', ...rest] = raw.split(/\s+/)
    try {
      switch (action) {
        case '':
          return ok(HELP)
        case 'list':
        case 'ls':
          return await doList()
        case 'create':
        case 'add':
          return await doCreate(rest)
        case 'delete':
        case 'rm':
          return await doDelete(rest[0] ?? '')
        case 'fires':
          return await doFires(rest[0] ?? '')
        case 'history':
          return await doHistory(rest[0] ?? '10')
        case 'help':
        case '?':
          return ok(HELP)
        default:
          return fail(`未知子动作 “${action}”。\n\n${HELP}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(`cron ${action} 失败：${message}`)
    }
  }

  function describe(task: CronTask): string {
    const next = nextOccurrence(task, task.cursorAt)
    return [
      `${task.id}  ${task.recurring ? '↻ recurring' : '→ one-shot'}  ${ruleHuman(task)}  mode=${task.executionMode}  policy=${task.deliveryPolicy}`,
      `  prompt: ${task.prompt}`,
      `  created_by: ${task.createdBy}  |  window_end: ${task.windowEnd === null ? '—' : new Date(task.windowEnd).toISOString()}`,
      `  last: ${task.lastFiredAt === 0 ? 'never' : new Date(task.lastFiredAt).toISOString()}  |  next: ${next === null ? '—' : new Date(next).toISOString()}  |  fires: ${task.fires.length}`,
    ].join('\n')
  }

  async function doList(): Promise<CommandResult> {
    const tasks = engine.listTasks()
    if (tasks.length === 0) return ok('当前没有定时任务。')
    return ok(`${tasks.length} 个任务：\n\n${tasks.map((t) => describe(t)).join('\n\n')}`)
  }

  async function doCreate(args: string[]): Promise<CommandResult> {
    // create "<cron|every=N>" "<prompt...>" [--once] [--steer] [--self] (--for=S|--until=iso) [--start=iso]
    const positional: string[] = []
    const flags = new Map<string, string | true>()
    for (const token of args) {
      if (token.startsWith('--')) {
        const body = token.slice(2)
        const eq = body.indexOf('=')
        if (eq === -1) flags.set(body, true)
        else flags.set(body.slice(0, eq), body.slice(eq + 1))
      } else {
        positional.push(token)
      }
    }
    const rule = positional[0]
    const prompt = positional.slice(1).join(' ')
    if (rule === undefined || prompt.length === 0) {
      return fail(USAGE_CREATE)
    }
    const input: Record<string, unknown> = { prompt }
    if (rule.startsWith('every=')) input.every_seconds = Number(rule.slice('every='.length))
    else input.cron = rule
    if (flags.has('once')) input.recurring = false
    if (flags.has('steer')) input.delivery_policy = 'steer'
    if (flags.has('self')) input.execution_mode = 'self'
    const forSeconds = flags.get('for')
    if (typeof forSeconds === 'string') input.max_duration_seconds = Number(forSeconds)
    const until = flags.get('until')
    if (typeof until === 'string') input.end_at = until
    const start = flags.get('start')
    if (typeof start === 'string') input.start_at = start
    try {
      const task = await engine.createTask(input, 'human:/cron')
      const next = nextOccurrence(task, task.cursorAt)
      return ok(
        `已创建 ${task.id}：${ruleHuman(task)}${task.recurring ? '（循环）' : '（一次性）'}\n` +
          `  prompt: ${task.prompt}\n` +
          `  窗口截止: ${task.windowEnd === null ? '—' : new Date(task.windowEnd).toISOString()}\n` +
          `  下次触发: ${next === null ? '—' : new Date(next).toISOString()}`,
      )
    } catch (error) {
      return fail(`创建被拒绝：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function doDelete(id: string): Promise<CommandResult> {
    if (!id) return fail('用法：/cron delete <id>')
    const removed = await engine.deleteTask(id)
    if (!removed) return fail(`没有 id 为 ${id} 的任务。`)
    return ok(`已删除 ${id}（历史归档为 cancelled）。`)
  }

  async function doFires(id: string): Promise<CommandResult> {
    if (!id) return fail('用法：/cron fires <taskId>')
    const active = engine.getTask(id)
    const fires = active?.fires ?? (await historyStore.get(id))?.fires ?? []
    if (fires.length === 0) return fail(`任务 ${id} 没有触发记录（不在活动列表也不在历史）。`)
    const body = fires
      .map(
        (f) =>
          `fire ${f.fireId}  status=${f.status}  coalesced=${f.coalescedCount}\n` +
          `    due: ${new Date(f.dueAt).toISOString()}  |  delivered: ${new Date(f.deliveredAt).toISOString()}` +
          (f.summary ? `\n    summary: ${f.summary.split('\n')[0]?.slice(0, 160)}` : '') +
          (f.error ? `\n    error: ${f.error}` : ''),
      )
      .join('\n\n')
    return ok(`任务 ${id} 的触发记录（每任务最多保留 ${cfgNow().fireHistoryLimit} 条）：\n\n${body}`)
  }

  async function doHistory(limitRaw: string): Promise<CommandResult> {
    const parsed = Number.parseInt(limitRaw, 10)
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, cfgNow().historyLimit) : 10
    const entries = await historyStore.list(limit)
    if (entries.length === 0) return ok('还没有归档任务。')
    const body = entries
      .map((e) => {
        const last = e.fires[e.fires.length - 1]
        return [
          `${e.id}  ${e.recurring ? '↻' : '→'}  status=${e.status}`,
          `    ended: ${new Date(e.endedAt).toISOString()}  |  fires: ${e.fires.length}${last?.summary ? `  |  last: ${last.summary.split('\n')[0]?.slice(0, 120)}` : ''}`,
        ].join('\n')
      })
      .join('\n\n')
    return ok(`最近 ${entries.length} 条归档（上限 ${cfgNow().historyLimit}）：\n\n${body}`)
  }
}

function ruleHuman(task: CronTask): string {
  return task.selector.kind === 'cron' ? task.selector.cron : `every ${task.selector.everySeconds}s`
}

function resolveStorageDir(configured: string): string {
  return configured.trim() === '' ? defaultCronDir() : resolve(configured)
}

const USAGE_CREATE =
  '用法：/cron create "<cron|every=N>" "<prompt>" [--once] [--steer] [--self] (--for=<seconds>|--until=<iso>) [--start=<iso>]\n' +
  '例：/cron create "*/10 * * * *" "检查 CI run 1234，终态则删除本任务" --for=7200'

const HELP = [
  '定时任务（有界、可追溯、跨会话）：',
  '  /cron list                                — 全部活动任务',
  `  ${USAGE_CREATE.split('\n')[0]}`,
  '        循环任务必须给窗口：--for=<秒> 或 --until=<RFC3339>，最长 1 年',
  '  /cron delete <id>                         — 删除并归档',
  '  /cron fires <id>                          — 某任务的触发记录（每任务留最近 N 条）',
  '  /cron history [N=10]                      — 归档历史',
  '  /cron help                                — 本帮助',
  '',
  '更推荐直接用自然语言让模型调 cron_create / cron_list / cron_delete / cron_report。',
].join('\n')

function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

function fail(text: string): CommandResult {
  return { kind: 'error', text }
}
