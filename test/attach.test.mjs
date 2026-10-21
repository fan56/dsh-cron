// Session-binding glue (ADR 0010): target resolution (live, cold resume,
// subagent refusal), dedicated session factory, orphan pruning, and
// session-stop cancellation — all against structural fakes.

import assert from 'node:assert/strict'
import { createTargetResolver, createDedicatedSessionFactory, pruneOrphanTasks, cancelTasksOfSession, delegationDepthOf } from '../lib/attach.js'

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

function makeAgent(id, { depth, runtimeDepth } = {}) {
  return {
    id,
    session: { header: { delegationDepth: depth } },
    options: { subagentDepth: runtimeDepth },
  }
}

try {
  await check('resolver returns the live agent bound to the task session', async () => {
    const live = new Map([['root-1', makeAgent('root-1')]])
    const resolve = createTargetResolver({ getAgent: (id) => live.get(id) })
    const agent = await resolve({ sessionId: 'root-1' })
    assert.equal(agent?.id, 'root-1')
    assert.equal(await resolve({ sessionId: 'nope' }), undefined)
  })

  await check('resolver refuses a live delegated child session', async () => {
    const live = new Map([['child-1', makeAgent('child-1', { depth: 1 })]])
    const resolve = createTargetResolver({ getAgent: (id) => live.get(id) })
    assert.equal(await resolve({ sessionId: 'child-1' }), undefined)
  })

  await check('resolver resumes a cold session through sessionController', async () => {
    const cold = makeAgent('cold-1')
    let resumed = 0
    const resolve = createTargetResolver({
      getAgent: () => undefined,
      resolveSessionAgent: async (id) => {
        assert.equal(id, 'cold-1')
        resumed += 1
        return { agent: cold }
      },
    })
    const agent = await resolve({ sessionId: 'cold-1' })
    assert.equal(agent?.id, 'cold-1')
    assert.equal(resumed, 1)
  })

  await check('resolver skips a session the controller cannot find', async () => {
    const resolve = createTargetResolver({
      getAgent: () => undefined,
      resolveSessionAgent: async () => ({ error: { code: 'session/not-found' } }),
    })
    assert.equal(await resolve({ sessionId: 'gone' }), undefined)
  })

  await check('resolver refuses a cold-resumed delegated child and works without a controller', async () => {
    const subagentChild = createTargetResolver({
      getAgent: () => undefined,
      resolveSessionAgent: async () => ({ agent: makeAgent('child-cold', { depth: 1 }) }),
    })
    assert.equal(await subagentChild({ sessionId: 'child-cold' }), undefined)

    const noController = createTargetResolver({ getAgent: () => undefined })
    assert.equal(await noController({ sessionId: 'cold-2' }), undefined)
  })

  await check('dedicated factory mints a host-convention session id and inherits cwd', async () => {
    const calls = []
    const factory = createDedicatedSessionFactory({
      createAgent: async (options) => {
        calls.push(options)
        return { agent: { id: options.sessionId } }
      },
      cwdOf: () => '/repo/foo',
    })
    const agent = await factory('root-1')
    assert.match(agent.id, /^session-[0-9a-f-]{36}$/)
    assert.deepEqual(calls[0].meta, { cwd: '/repo/foo' })

    const noCwd = createDedicatedSessionFactory({
      createAgent: async (options) => {
        calls.push(options)
        return { agent: { id: options.sessionId } }
      },
      cwdOf: () => undefined,
    })
    await noCwd('root-1')
    assert.equal(calls[1].meta, undefined)
  })

  await check('pruneOrphanTasks archives only tasks whose session is gone', async () => {
    const existing = [
      { id: 'aaaaaaaa', sessionId: 'live-1' },
      { id: 'bbbbbbbb', sessionId: 'dead-1' },
      { id: 'cccccccc', sessionId: 'cold-1' },
    ]
    const cancelledIds = []
    const engine = {
      listTasks: () => existing,
      deleteTask: async (id) => {
        cancelledIds.push(id)
        return existing.find((t) => t.id === id)
      },
    }
    const pruned = await pruneOrphanTasks(
      engine,
      async (id) => id === 'live-1' || id === 'cold-1',
    )
    assert.equal(pruned, 1)
    assert.deepEqual(cancelledIds, ['bbbbbbbb'])
  })

  await check('cancelTasksOfSession cancels only the stopped session tasks', async () => {
    const tasks = [
      { id: 'aaaaaaaa', sessionId: 's-1' },
      { id: 'bbbbbbbb', sessionId: 's-2' },
      { id: 'cccccccc', sessionId: 's-1' },
    ]
    const cancelledIds = []
    const engine = {
      listTasks: () => tasks,
      deleteTask: async (id) => {
        cancelledIds.push(id)
        return tasks.find((t) => t.id === id)
      },
    }
    const cancelled = await cancelTasksOfSession(engine, 's-1')
    assert.deepEqual(cancelledIds, ['aaaaaaaa', 'cccccccc'])
    assert.deepEqual(
      cancelled.map((t) => t.id),
      ['aaaaaaaa', 'cccccccc'],
    )
  })

  await check('delegationDepthOf takes the max of header and runtime depth', async () => {
    assert.equal(delegationDepthOf(makeAgent('a')), 0)
    assert.equal(delegationDepthOf(makeAgent('a', { depth: 2 })), 2)
    assert.equal(delegationDepthOf(makeAgent('a', { runtimeDepth: 3 })), 3)
    assert.equal(delegationDepthOf(makeAgent('a', { depth: 1, runtimeDepth: 4 })), 4)
  })
} finally {
  void 0
}

console.log(`\nattach: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
