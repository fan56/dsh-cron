// 5-field cron parser, next-fire math, and human rendering.

import assert from 'node:assert/strict'
import { parseField, parseCronExpression, computeNextCronRun, countCronRunsBetween, cronToHuman } from '../lib/cron-expr.js'

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

await check('parseField: lists, ranges, steps, names', async () => {
  assert.deepEqual([...parseField('1,3,5', 0)].sort(), [1, 3, 5])
  assert.deepEqual([...parseField('1-4', 0)].sort(), [1, 2, 3, 4])
  assert.deepEqual([...parseField('*/20', 1)].sort(), [0, 20])
  assert.deepEqual([...parseField('mon-fri', 4)].sort(), [1, 2, 3, 4, 5])
  assert.deepEqual([...parseField('jan,mar', 3)].sort(), [1, 3])
})

await check('parseField rejects out-of-range and garbage', async () => {
  assert.throws(() => parseField('60', 0), /out of range/)
  assert.throws(() => parseField('0', 2), /out of range/) // dom starts at 1
  assert.throws(() => parseField('*/x', 0), /Invalid step/)
  assert.throws(() => parseField('foo', 0), /Invalid cron field value/)
})

await check('parseCronExpression requires exactly 5 fields', async () => {
  assert.throws(() => parseCronExpression('* * * *'), /exactly 5 fields/)
  assert.throws(() => parseCronExpression('* * * * * *'), /exactly 5 fields/)
  parseCronExpression('*/10 * * * *') // no throw
})

await check('computeNextCronRun: known wall-clock steps', async () => {
  const every5 = parseCronExpression('*/5 * * * *')
  // 10:07 local -> next :10
  const base = new Date(2026, 7, 31, 10, 7, 0).getTime()
  const next = computeNextCronRun(every5, base)
  assert.equal(new Date(next).getMinutes(), 10)

  const daily9 = parseCronExpression('0 9 * * 1-5')
  // Saturday 2026-08-01 -> Monday 2026-08-03 09:00
  const sat = new Date(2026, 7, 1, 12, 0, 0).getTime()
  const monday = new Date(computeNextCronRun(daily9, sat))
  assert.equal(monday.getDay(), 1)
  assert.equal(monday.getHours(), 9)
})

await check('computeNextCronRun returns null inside maxYears when nothing matches', async () => {
  // Feb 30 can never match; the scan must give up, not spin.
  const never = parseCronExpression('0 0 30 2 *')
  const base = new Date(2026, 0, 1).getTime()
  assert.equal(computeNextCronRun(never, base, 1), null)
})

await check('countCronRunsBetween counts bounded backlog', async () => {
  const every5 = parseCronExpression('*/5 * * * *')
  const from = new Date(2026, 7, 31, 10, 0, 0).getTime()
  const to = from + 30 * 60 * 1000 // 30 minutes -> 6 occurrences after `from`
  assert.equal(countCronRunsBetween(every5, from, to), 6)
})

await check('cronToHuman presets and field rendering', async () => {
  assert.equal(cronToHuman('*/5 * * * *'), 'every 5 minutes')
  assert.equal(cronToHuman('0 9 * * 1-5'), 'weekdays at 9:00 AM')
  assert.match(cronToHuman('30 8 1 1 *'), /minute 30/)
})

console.log(`\ncron-expr: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
