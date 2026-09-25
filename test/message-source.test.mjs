import assert from 'node:assert/strict'
import test from 'node:test'

import { cronFireMessage } from '../lib/fire-message.js'

test('cron fire message uses the cron source kind', () => {
  const message = cronFireMessage('x')
  assert.equal(message.source.kind, 'cron')
})

test('cron fire message passes its text content through unchanged', () => {
  const message = cronFireMessage('x')
  assert.deepEqual(message.content, [{ type: 'text', text: 'x' }])
})

test('cron fire message keeps the user role required by the host', () => {
  const message = cronFireMessage('x')
  assert.equal(message.role, 'user')
})
