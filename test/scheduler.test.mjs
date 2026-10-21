// Engine delivery semantics: session-bound fires, busy coalescing, missed
// occurrences, expiry, reports, fire retention — all with a fake clock, fake
// store and fake agents (ADR 0002/0003/0006/0010 behavior locked here).

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function makeHarness({ live = ['root-1'], deliver, createDedicated, resolveTarget } = {}) {
  let now = T0
  const clock = { now: () => now }
  const work = mkdtempSync(join(tmpdir(), 'dsh-cron-engine-'))
  const store = createTaskStore(join(work, 'cron'))
  const historyStore = createHistoryStore(join(work, 'cron'), 50)
  const logs = { warn: [], info: [] }
  const logger = {
    warn: (...a) => logs.warn.push(a.join(' ')),
    info: (...a) => logs.info.push(a.join(' ')),
  }
  const submissions = []
  const deliverFn =
    deliver ??
    (async (_agent, _text, policy) => {
      submissions.push({ text: _text, policy })
      return 'delivered'
    })
  // Live session table: resolveTarget hits only for a task bound to a live
  // session (ADR 0010) — the engine must never see a global fallback.
  const agents = new Map((Array.isArray(live) ? live : []).map((id) => [id, makeAgent(id)]))
  const resolveTargetFn =
    resolveTarget ?? (async (task) => agents.get(task.sessionId))
  const engine = new CronEngine({
    clock,
    store,
    historyStore,
    config: { fireHistoryLimit: 7 },
    logger,
    resolveTarget: resolveTargetFn,
    createDedicated,
    deliver: (agent, text, policy) => deliverFn(agent, text, policy),
  })
  const setNow = (ms) => {
    now = ms
  }
  const cleanup = () => rmSync(work, { recursive: true, force: true })
  return { engine, store, historyStore, submissions, logs, setNow, cleanup, clock, agents }
}

function makeAgent(id) {
  return { id }
}

try {
  await check('interval task fires on schedule and records a durable fire', async () => {
    const h = makeHarness()
    try {
      const task = await h.engine.createTask(
        { every_seconds: 600, prompt: 'check build', max_duration_seconds: 3600 },
        'root-1',
      )
      assert.ok(/^[0-9a-f]{8}$/.test(task.id))
      await h.engine.tick() // t0: first occurrence is at +600s
      assert.equal(h.submissions.length, 0)

      h.setNow(T0 + 600 * 1000)
      await h.engine.tick()
      assert.equal(h.submissions.length, 1)
      assert.match(h.submissions[0].text, /\[CRON FIRE\]/)
      assert.match(h.submissions[0].text, /check build/)

      // Durable: the task file on disk carries the fire record.
      const raw = JSON.parse(readFileSync(join(h.store.dir(), `${task.id}.json`), 'utf-8'))
      assert.equal(raw.fires.length, 1)
      assert.equal(raw.fires[0].status, 'delivered')
      assert.equal(raw.cursorAt, T0 + 600 * 1000)
    } finally {
      h.cleanup()
    }
  })

  await check('busy target coalesces into one fire at the first idle tick (ADR 0003)', async () => {
    let busyUntil = T0 + 1800 * 1000 + 1
    let submissions2
    const h = makeHarness({
      deliver: async (_agent, _text, policy) => {
        if (policy === 'followup' && h.clock.now() < busyUntil) return 'busy'
        submissions2.push({ text: _text, policy })
        return 'delivered'
      },
    })
    submissions2 = h.submissions
    try {
      await h.engine.createTask({ every_seconds: 600, prompt: 'monitor', max_duration_seconds: 7200 }, 'root-1')
      // Three ticks during a busy window: occurrences stay due, nothing fires.
      for (const t of [600, 1200, 1800]) {
        h.setNow(T0 + t * 1000)
        await h.engine.tick()
      }
      assert.equal(h.submissions.length, 0)

      h.setNow(T0 + 2400 * 1000) // idle at last
      await h.engine.tick()
      assert.equal(h.submissions.length, 1)
      assert.match(h.submissions[0].text, /coalesced_count: [2-5]/)
      // Cursor settled: the next tick fires nothing new until the next occurrence.
      await h.engine.tick()
      assert.equal(h.submissions.length, 1)
    } finally {
      h.cleanup()
    }
  })

  await check('no live target = missed occurrence, logged, never delivered late (ADR 0002)', async () => {
    const h = makeHarness({ live: [] })
    try {
      await h.engine.createTask({ every_seconds: 60, prompt: 'ping', max_duration_seconds: 3600 }, 'root-1')
      h.setNow(T0 + 120 * 1000)
      await h.engine.tick()
      assert.equal(h.submissions.length, 0)
      assert.ok(h.logs.warn.some((l) => /unavailable/.test(l)))
      await h.engine.tick()
      assert.equal(h.submissions.length, 0) // cursor settled; no double-skip log
    } finally {
      h.cleanup()
    }
  })

  await check('fires land only in the bound session, never in another live session (ADR 0010)', async () => {
    const h = makeHarness({ live: ['root-1', 'other-9'] })
    try {
      await h.engine.createTask({ every_seconds: 60, prompt: 'for root-1', max_duration_seconds: 3600 }, 'root-1')
      h.setNow(T0 + 60 * 1000)
      await h.engine.tick()
      assert.equal(h.submissions.length, 1) // delivered to the bound session's agent
      assert.equal(h.submissions[0].agent, undefined) // submissions carry text only; binding checked via resolver

      // Same task shape but bound to a session that is not live: no delivery,
      // even though 'root-1' is live (the old global fallback is gone).
      const h2 = makeHarness({ live: ['root-1'] })
      try {
        await h2.engine.createTask({ every_seconds: 60, prompt: 'bound elsewhere', max_duration_seconds: 3600 }, 'gone-1')
        h2.setNow(T0 + 60 * 1000)
        await h2.engine.tick()
        assert.equal(h2.submissions.length, 0)
      } finally {
        h2.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })

  await check('attach=new opens a dedicated session and binds the task to it', async () => {
    const dedicated = []
    const h = makeHarness({
      createDedicated: async (createdBy) => {
        const id = `session-dedicated-${dedicated.length}`
        dedicated.push({ id, createdBy })
        return { id }
      },
    })
    try {
      const task = await h.engine.createTask(
        { every_seconds: 60, prompt: 'isolated monitor', max_duration_seconds: 3600, attach: 'new' },
        'root-1',
      )
      assert.equal(task.attach, 'new')
      assert.equal(task.sessionId, 'session-dedicated-0')
      assert.equal(dedicated[0].createdBy, 'root-1')
      // Not resolvable while the dedicated session is not live: the occurrence
      // skips and settles (ADR 0002), no global fallback.
      h.setNow(T0 + 60 * 1000)
      await h.engine.tick()
      assert.equal(h.submissions.length, 0)
      // Resolvable once live: the next occurrence delivers into the dedicated session.
      h.agents.set(task.sessionId, { id: task.sessionId })
      h.setNow(T0 + 120 * 1000)
      await h.engine.tick()
      assert.equal(h.submissions.length, 1)
    } finally {
      h.cleanup()
    }
  })

  await check("attach=new without a session factory is rejected; bad attach mode is rejected", async () => {
    const h = makeHarness()
    try {
      await assert.rejects(
        () => h.engine.createTask({ every_seconds: 60, prompt: 'x', attach: 'new', max_duration_seconds: 60 }, 'root-1'),
        /no session factory/,
      )
      await assert.rejects(
        () => h.engine.createTask({ every_seconds: 60, prompt: 'x', attach: 'bogus' }, 'root-1'),
        /attach must be one of/,
      )
      // Default is creator binding.
      const task = await h.engine.createTask({ every_seconds: 60, prompt: 'x', max_duration_seconds: 60 }, 'root-1')
      assert.equal(task.attach, 'creator')
      assert.equal(task.sessionId, 'root-1')
    } finally {
      h.cleanup()
    }
  })

  await check('rehydrate archives pre-0010 unbound tasks as cancelled (ADR 0010)', async () => {
    const h = makeHarness()
    try {
      // Plant a legacy task file: no attach, no sessionId.
      const legacy = {
        id: 'deadbeef',
        selector: { kind: 'every', everySeconds: 600 },
        prompt: 'old global task',
        recurring: true,
        deliveryPolicy: 'followup',
        executionMode: 'sub-agent',
        createdAt: T0,
        startAt: T0,
        windowEnd: T0 + 86400 * 1000,
        cursorAt: T0,
        lastFiredAt: 0,
        createdBy: 'root-1',
        fires: [],
      }
      mkdirSync(h.store.dir(), { recursive: true })
      writeFileSync(join(h.store.dir(), 'deadbeef.json'), JSON.stringify(legacy, null, 2) + '\n')
      const { unbound } = await h.engine.rehydrate()
      assert.equal(unbound, 1)
      assert.equal(h.engine.getTask('deadbeef'), undefined)
      const hist = await h.historyStore.list(10)
      assert.equal(hist[0].id, 'deadbeef')
      assert.equal(hist[0].status, 'cancelled')
      assert.ok(h.logs.warn.some((l) => /predates session binding/.test(l)))
    } finally {
      h.cleanup()
    }
  })

  await check('rehydrate skips downtime-accrued occurrences; missed one-shots archive', async () => {
    const h = makeHarness()
    try {
      const recurring = await h.engine.createTask(
        { every_seconds: 600, prompt: 'keep going', max_duration_seconds: 86400 },
        'root-1',
      )
      const oneShot = await h.engine.createTask(
        { every_seconds: 600, prompt: 'once', recurring: false },
        'root-1',
      )
      // Simulate a 2-hour outage: cursor stuck at creation, clock way ahead.
      h.setNow(T0 + 7200 * 1000)
      const { skipped, missed } = await h.engine.rehydrate()
      assert.equal(skipped, 12)
      assert.equal(missed, 1)
      assert.equal(h.submissions.length, 0) // never delivered late
      assert.ok(h.logs.warn.some((l) => /skipped 12 occurrence/.test(l)))
      assert.ok(h.logs.warn.some((l) => /archived as missed/.test(l)))
      // One-shot gone from active set, present in history as missed.
      assert.equal(h.engine.getTask(oneShot.id), undefined)
      const hist = await h.historyStore.list(10)
      assert.equal(hist[0].status, 'missed')
      assert.equal(hist[0].id, oneShot.id)
      // Recurring continues at the next future occurrence.
      const resumed = h.engine.getTask(recurring.id)
      assert.equal(resumed.cursorAt, T0 + 7200 * 1000)
      assert.ok(resumed.lastFiredAt === 0)
    } finally {
      h.cleanup()
    }
  })

  await check('window close delivers one expired terminal fire and archives (ADR 0006)', async () => {
    const h = makeHarness()
    try {
      const task = await h.engine.createTask(
        { every_seconds: 600, prompt: 'deploy check', max_duration_seconds: 1200 },
        'root-1',
      )
      h.setNow(T0 + 600 * 1000)
      await h.engine.tick()
      assert.equal(h.submissions.length, 1)

      h.setNow(T0 + 1200 * 1000 + 1) // past windowEnd
      await h.engine.tick()
      assert.equal(h.submissions.length, 2)
      assert.match(h.submissions[1].text, /expiry notice/)
      assert.equal(h.engine.getTask(task.id), undefined)
      const hist = await h.historyStore.list(10)
      assert.equal(hist[0].status, 'expired')
      assert.equal(hist[0].fires.at(-1).status, 'expired')
    } finally {
      h.cleanup()
    }
  })

  await check('cron_report backfills the fire; one-shot archives on report', async () => {
    const h = makeHarness()
    try {
      const oneShot = await h.engine.createTask({ every_seconds: 600, prompt: 'once', recurring: false }, 'root-1')
      h.setNow(T0 + 600 * 1000)
      await h.engine.tick()
      const fireId = h.engine.getTask(oneShot.id).fires[0].fireId
      const result = await h.engine.report(oneShot.id, fireId, { status: 'completed', summary: 'deploy green' })
      assert.equal(result.ok, true)
      assert.equal(result.archived, true)
      const hist = await h.historyStore.list(10)
      assert.equal(hist[0].status, 'done')
      assert.equal(hist[0].fires[0].summary, 'deploy green')

      const bad = await h.engine.report('ffffffff', 'eeeeeeee', { status: 'completed' })
      assert.equal(bad.ok, false)
    } finally {
      h.cleanup()
    }
  })

  await check('fire retention: per-task cap with oldest eviction', async () => {
    let now = T0
    const clock = { now: () => now }
    const work = mkdtempSync(join(tmpdir(), 'dsh-cron-cap-'))
    try {
      const engine = new CronEngine({
        clock,
        store: createTaskStore(join(work, 'cron')),
        historyStore: createHistoryStore(join(work, 'cron'), 50),
        config: { fireHistoryLimit: 3 },
        logger: { warn: () => {}, info: () => {} },
        resolveTarget: async () => makeAgent('root-1'),
        deliver: async () => 'delivered',
      })
      await engine.createTask({ every_seconds: 60, prompt: 'frequent', max_duration_seconds: 3600 }, 'root-1')
      for (let i = 1; i <= 5; i++) {
        now = T0 + i * 60 * 1000
        await engine.tick()
      }
      assert.equal(engine.listTasks()[0].fires.length, 3)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  await check('steer policy submits mid-turn without an idle gate', async () => {
    let calls = 0
    const h = makeHarness({
      deliver: async (_agent, text, policy) => {
        calls += 1
        assert.equal(policy, 'steer')
        h.submissions.push(text)
        return 'delivered'
      },
    })
    try {
      await h.engine.createTask(
        { every_seconds: 600, prompt: 'watchdog', max_duration_seconds: 3600, delivery_policy: 'steer' },
        'root-1',
      )
      h.setNow(T0 + 600 * 1000)
      await h.engine.tick()
      assert.equal(calls, 1)
      assert.match(h.submissions[0], /\[CRON FIRE\]/)
    } finally {
      h.cleanup()
    }
  })
} finally {
  void 0
}

console.log(`\nscheduler: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
