// Tool surface: the four cron tools through the real defineTool pipeline —
// schema validation, engine wiring, and the report flow.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerCronTools } from '../lib/tools.js'
import { CronEngine } from '../lib/scheduler.js'
import { createTaskStore, createHistoryStore } from '../lib/store.js'

let failed = 0
let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

const T0 = new Date(2026, 7, 31, 12, 0, 0).getTime()
const AGENT = { id: 'agent-abc' }

function makeFixture() {
  const work = mkdtempSync(join(tmpdir(), 'dsh-cron-tools-'))
  const registered = []
  const toolCtx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const i = registered.indexOf(definition)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    },
  }
  const engine = new CronEngine({
    clock: { now: () => T0 },
    store: createTaskStore(join(work, 'cron')),
    historyStore: createHistoryStore(join(work, 'cron'), 50),
    config: { fireHistoryLimit: 7 },
    logger: { warn: () => {}, info: () => {} },
    targets: () => [AGENT],
    deliver: async () => 'delivered',
  })
  registerCronTools(toolCtx, AGENT, engine)
  const byName = Object.fromEntries(registered.map((d) => [d.name, d]))
  const exec = { agent: AGENT, signal: new AbortController().signal }
  const cleanup = () => rmSync(work, { recursive: true, force: true })
  return { byName, engine, exec, cleanup }
}

try {
  await check('four tools registered', async () => {
    const f = makeFixture()
    try {
      for (const name of ['cron_create', 'cron_list', 'cron_delete', 'cron_report']) {
        assert.ok(f.byName[name], `${name} missing`)
      }
    } finally {
      f.cleanup()
    }
  })

  await check('cron_create happy path echoes ISO times and creates the task', async () => {
    const f = makeFixture()
    try {
      const value = await f.byName.cron_create.execute(
        { prompt: 'check build', every_seconds: 600, max_duration_seconds: 3600 },
        f.exec,
      )
      assert.equal(value.ok, true)
      assert.match(value.id, /^[0-9a-f]{8}$/)
      assert.equal(value.next_fire, new Date(T0 + 600000).toISOString())
      assert.equal(value.window_end, new Date(T0 + 3600000).toISOString())
      assert.equal(f.engine.size, 1)
    } finally {
      f.cleanup()
    }
  })

  await check('cron_create rejects unbounded recurring tasks with a stable error', async () => {
    const f = makeFixture()
    try {
      const value = await f.byName.cron_create.execute({ prompt: 'forever', cron: '* * * * *' }, f.exec)
      assert.equal(value.ok, false)
      assert.match(value.error, /no infinite cron/)
    } finally {
      f.cleanup()
    }
  })

  await check('cron_create validates the cron expression at the schema boundary', async () => {
    const f = makeFixture()
    try {
      const value = await f.byName.cron_create.execute({ prompt: 'x', cron: '99 * * * *', max_duration_seconds: 60 }, f.exec)
      assert.equal(value.ok, false)
    } finally {
      f.cleanup()
    }
  })

  await check('cron_list returns task views with fire trails', async () => {
    const f = makeFixture()
    try {
      await f.byName.cron_create.execute(
        { prompt: 'watch', cron: '*/10 * * * *', max_duration_seconds: 3600 },
        f.exec,
      )
      const value = await f.byName.cron_list.execute({}, f.exec)
      assert.equal(value.ok, true)
      assert.equal(value.tasks.length, 1)
      assert.equal(value.tasks[0].rule_human, 'every 10 minutes')
      assert.deepEqual(value.tasks[0].fires, [])
      assert.equal(value.tasks[0].created_by, 'agent-abc')
    } finally {
      f.cleanup()
    }
  })

  await check('cron_delete archives; unknown id returns deleted=false', async () => {
    const f = makeFixture()
    try {
      const created = await f.byName.cron_create.execute(
        { prompt: 'x', every_seconds: 600, max_duration_seconds: 60 },
        f.exec,
      )
      const gone = await f.byName.cron_delete.execute({ id: created.id }, f.exec)
      assert.equal(gone.deleted, true)
      const again = await f.byName.cron_delete.execute({ id: created.id }, f.exec)
      assert.equal(again.deleted, false)
    } finally {
      f.cleanup()
    }
  })

  await check('cron_report rejects bad status and unknown ids', async () => {
    const f = makeFixture()
    try {
      const bad = await f.byName.cron_report.execute(
        { task_id: 'aaaaaaaa', fire_id: 'bbbbbbbb', status: 'meh', summary: 'x' },
        f.exec,
      )
      assert.equal(bad.ok, false)
      const unknown = await f.byName.cron_report.execute(
        { task_id: 'aaaaaaaa', fire_id: 'bbbbbbbb', status: 'completed', summary: 'x' },
        f.exec,
      )
      assert.equal(unknown.ok, false)
    } finally {
      f.cleanup()
    }
  })
} finally {
  void 0
}

console.log(`\ntools: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
