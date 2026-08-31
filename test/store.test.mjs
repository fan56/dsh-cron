// Persistence: per-id task files, atomic writes, corrupt-file tolerance,
// capped history FIFO, fire-record eviction.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskStore, createHistoryStore, withFire, HISTORY_FILE } from '../lib/store.js'
import { generateId } from '../lib/types.js'

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

const work = mkdtempSync(join(tmpdir(), 'dsh-cron-store-'))

function makeTask(id = generateId()) {
  return {
    id,
    selector: { kind: 'every', everySeconds: 600 },
    prompt: 'check the build',
    recurring: true,
    deliveryPolicy: 'followup',
    executionMode: 'sub-agent',
    createdAt: 1000,
    startAt: 1000,
    windowEnd: 2000,
    cursorAt: 1000,
    lastFiredAt: 0,
    createdBy: 'agent-1',
    fires: [],
  }
}

try {
  await check('task store: write, list, remove round-trip', async () => {
    const dir = join(work, 'roundtrip')
    const store = createTaskStore(dir)
    const task = makeTask()
    await store.write(task)
    const listed = await store.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, task.id)
    assert.equal(listed[0].selector.everySeconds, 600)
    await store.remove(task.id)
    assert.equal((await store.list()).length, 0)
    await store.remove(task.id) // idempotent
  })

  await check('task store: skips corrupt and foreign files', async () => {
    const dir = join(work, 'corrupt')
    const store = createTaskStore(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'zz-not-a-task.json'), '{}')
    writeFileSync(join(dir, 'aaaaaaaa.json'), '{broken json')
    await store.write(makeTask('bbbbbbbb'))
    const listed = await store.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, 'bbbbbbbb')
  })

  await check('history store: FIFO cap keeps the newest entries', async () => {
    const dir = join(work, 'history')
    const history = createHistoryStore(dir, 3)
    for (let i = 0; i < 5; i++) {
      await history.archive({
        id: generateId(),
        selector: { kind: 'every', everySeconds: 60 },
        prompt: `task ${i}`,
        recurring: true,
        createdBy: 'agent-1',
        createdAt: i,
        endedAt: i,
        status: 'cancelled',
        fires: [],
      })
    }
    const listed = await history.list(10)
    assert.equal(listed.length, 3)
    assert.equal(listed[0].prompt, 'task 4') // newest first
    assert.equal(listed[2].prompt, 'task 2')
  })

  await check('withFire evicts oldest beyond the retention limit', async () => {
    let task = makeTask()
    for (let i = 0; i < 5; i++) {
      task = withFire(task, {
        fireId: `fire${i}x`,
        dueAt: 1000 + i,
        deliveredAt: 1000 + i,
        policy: 'followup',
        executionMode: 'sub-agent',
        coalescedCount: 1,
        status: 'delivered',
      }, 3)
    }
    assert.equal(task.fires.length, 3)
    assert.equal(task.fires[0].fireId, 'fire2x')
  })
} finally {
  rmSync(work, { recursive: true, force: true })
}

void HISTORY_FILE
console.log(`\nstore: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
