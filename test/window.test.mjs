// Selector and validity-window validation, interval anchoring (ADR 0006/0007).

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuleInputError, parseSelector, resolveWindow, nextOccurrence, countOccurrencesBetween } from '../lib/rule.js'

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

const NOW = new Date(2026, 7, 31, 12, 0, 0).getTime() // 2026-08-31 12:00 local

await check('selector: exactly one of cron | every_seconds', async () => {
  assert.throws(() => parseSelector({}), /exactly one/)
  assert.throws(() => parseSelector({ cron: '* * * * *', every_seconds: 60 }), /exactly one/)
  assert.throws(() => parseSelector({ every_seconds: 30 }), />= 60/)
  assert.throws(() => parseSelector({ cron: 'bad' }), /5 fields/)
  assert.equal(parseSelector({ cron: '* * * * *' }).kind, 'cron')
  assert.deepEqual(parseSelector({ every_seconds: 600 }), { kind: 'every', everySeconds: 600 })
})

await check('window: recurring tasks need exactly one bound — no infinite cron', async () => {
  assert.throws(() => resolveWindow({}, true, NOW), /no infinite cron/)
  assert.throws(
    () => resolveWindow({ max_duration_seconds: 60, end_at: NOW + 120000 }, true, NOW),
    /exactly one/,
  )
  assert.throws(() => resolveWindow({ max_duration_seconds: 0 }, true, NOW), /positive safe integer/)
  // One year + 1s must be rejected.
  assert.throws(() => resolveWindow({ max_duration_seconds: 366 * 24 * 3600 + 1 }, true, NOW), /one year/)
})

await check('window: one-shot tasks reject bounds', async () => {
  assert.throws(() => resolveWindow({ max_duration_seconds: 60 }, false, NOW), /single fire/)
  const ok = resolveWindow({}, false, NOW)
  assert.equal(ok.windowEnd, null)
  assert.equal(ok.startAt, NOW)
})

await check('window: start_at must be future; end_at inside one year', async () => {
  assert.throws(() => resolveWindow({ start_at: NOW - 1, max_duration_seconds: 60 }, true, NOW), /future/)
  const withStart = resolveWindow({ start_at: NOW + 60000, max_duration_seconds: 60 }, true, NOW)
  assert.equal(withStart.startAt, NOW + 60000)
  assert.equal(withStart.windowEnd, NOW + 120000)
  assert.throws(() => resolveWindow({ end_at: NOW - 1 }, true, NOW), /future/)
  assert.throws(() => resolveWindow({ end_at: NOW + 400 * 24 * 3600 * 1000 }, true, NOW), /one year/)
})

await check('interval rule anchors at startAt, first occurrence one full interval in', async () => {
  const task = { selector: { kind: 'every', everySeconds: 600 }, startAt: NOW }
  assert.equal(nextOccurrence(task, NOW), NOW + 600000) // k=1
  assert.equal(nextOccurrence(task, NOW + 600000), NOW + 1200000) // strictly after
  assert.equal(nextOccurrence(task, NOW + 599999), NOW + 600000)
  // Future start: nothing before the anchor.
  const later = { selector: { kind: 'every', everySeconds: 60 }, startAt: NOW + 300000 }
  assert.equal(nextOccurrence(later, NOW), NOW + 360000)
})

await check('calendar rule respects startAt as a floor', async () => {
  // 0 9 * * * with start tomorrow noon -> first occurrence day after tomorrow 9:00
  const task = { selector: { kind: 'cron', cron: '0 9 * * *' }, startAt: NOW + 24 * 3600 * 1000 }
  const next = new Date(nextOccurrence(task, NOW))
  assert.equal(next.getHours(), 9)
  assert.ok(next.getTime() > NOW + 24 * 3600 * 1000 - 1000)
})

await check('countOccurrencesBetween counts the collapsed backlog', async () => {
  const every10 = { selector: { kind: 'every', everySeconds: 600 }, startAt: NOW }
  assert.equal(countOccurrencesBetween(every10, NOW, NOW + 3600000), 6)
  assert.equal(countOccurrencesBetween(every10, NOW, NOW + 599999), 0)
})

// Silence unused import check for tmp helpers used only in type surface.
void mkdtempSync; void tmpdir; void join

console.log(`\nwindow: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
