// One-time legacy settings import (0.1.5 → 0.1.7): the host's one-shot
// settings.yaml import keys sections by "section name = entry id", so this
// plugin's old `cron:` section was silently dropped. Parser tests are pure
// string-in/string-out; import-logic tests run against a tmp dsh home with a
// fake settings seam (the marker file is the observable contract).

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENTRY_ID,
  LEGACY_KEYS,
  LEGACY_SECTION,
  inferScalar,
  legacyMarkerPath,
  legacySettingsCandidates,
  parseFlatSection,
  runLegacySettingsImport,
} from '../lib/legacy-import.js'

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

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-cron-legacy-'))
}

function writeLegacyDoc(home, name, body) {
  writeFileSync(join(home, name), body)
}

/** Fake settings seam recording update() calls; `fail` makes update reject. */
function fakeSettings({ fail = false } = {}) {
  const calls = []
  return {
    seam: {
      async update(ns, patch) {
        if (fail) throw new Error('settings service exploded')
        calls.push({ ns, patch })
      },
    },
    calls,
  }
}

function fakeLogger() {
  const lines = []
  return {
    logger: {
      info: (m) => lines.push({ level: 'info', message: m }),
      warn: (m) => lines.push({ level: 'warn', message: m }),
    },
    lines,
  }
}

// ---- Parser (pure) -----------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'dsh-cron-legacy-work-'))

await check('parse: flat section collects scalars with number/boolean/string inference', async () => {
  const doc = [
    'ui-theme:',
    '  preference: light',
    'cron:',
    '  fireHistoryLimit: 12',
    '  historyLimit: 80',
    '  tickIntervalMs: 5000',
    "  storageDir: '/tmp/my-cron'",
    'dsh-tui:',
    '  preference: dark',
  ].join('\n')
  assert.deepEqual(parseFlatSection(doc, LEGACY_SECTION), {
    fireHistoryLimit: 12,
    historyLimit: 80,
    tickIntervalMs: 5000,
    storageDir: '/tmp/my-cron',
  })
})

await check('parse: quoted values are unquoted (single and double)', async () => {
  const doc = [
    'cron:',
    `  storageDir: '~/cron store'`,
    '  tickIntervalMs: "3000"',
  ].join('\n')
  const parsed = parseFlatSection(doc, 'cron')
  assert.equal(parsed.storageDir, '~/cron store')
  assert.equal(parsed.tickIntervalMs, '3000', 'a quoted number stays a string')
})

await check('parse: single-line quoted flow JSON is JSON-parsed after unquoting', async () => {
  const doc = [
    'cron:',
    `  storageDir: '["a","b"]'`,
    `  tickIntervalMs: '{"k": 1}'`,
    `  historyLimit: '[not json'`,
  ].join('\n')
  const parsed = parseFlatSection(doc, 'cron')
  assert.deepEqual(parsed.storageDir, ['a', 'b'])
  assert.deepEqual(parsed.tickIntervalMs, { k: 1 })
  assert.equal(parsed.historyLimit, '[not json') // malformed JSON stays a string
})

await check('parse: nested blocks and folded values are skipped conservatively', async () => {
  const doc = [
    'cron:',
    '  fireHistoryLimit: 12',
    '  nested:',
    '    inner: 1',
    '    deeper:',
    '      leaf: 2',
    '  tickIntervalMs: 5000',
    'other:',
    '  key: value',
  ].join('\n')
  const parsed = parseFlatSection(doc, 'cron')
  // `nested` opens a block (skipped), its children sit at a deeper indent
  // (skipped), and scalars before/after the block at the child indent survive.
  assert.deepEqual(parsed, { fireHistoryLimit: 12, tickIntervalMs: 5000 })
})

await check('parse: absent section and inline-value section both yield an empty map', async () => {
  assert.deepEqual(parseFlatSection('other:\n  key: 1\n', 'cron'), {})
  assert.deepEqual(parseFlatSection('cron: []\n', 'cron'), {}, 'inline value = not a flat block map')
})

await check('parse: section ends at the next top-level key — no leakage', async () => {
  const doc = 'cron:\n  historyLimit: 3\nafter:\n  tickIntervalMs: 999\n'
  assert.deepEqual(parseFlatSection(doc, 'cron'), { historyLimit: 3 })
})

await check('parse: inferScalar covers the scalar vocabulary directly', async () => {
  assert.equal(inferScalar('plain'), 'plain')
  assert.equal(inferScalar('4'), 4)
  assert.equal(inferScalar('0.3'), 0.3)
  assert.equal(inferScalar('true'), true)
  assert.equal(inferScalar('false'), false)
  assert.equal(inferScalar("'quoted: value'"), 'quoted: value')
  assert.deepEqual(inferScalar(`'["x"]'`), ['x'])
})

// ---- Import logic (tmp home + fake seam) --------------------------------------

const LEGACY_DOC = [
  'cron:',
  '  fireHistoryLimit: 12',
  '  historyLimit: 80',
  '  tickIntervalMs: 5000',
  "  storageDir: '/tmp/my-cron'",
  '',
].join('\n')

/** Defaults mirroring the live schema so "equal" is deterministic per key. */
const CURRENT = {
  fireHistoryLimit: 7,
  historyLimit: 50,
  tickIntervalMs: 15000,
  storageDir: '',
}

function boot(input = {}) {
  const home = input.home ?? tmpHome()
  const settings = 'settings' in input ? input.settings : fakeSettings()
  const logger = input.logger ?? fakeLogger()
  return {
    home,
    settings,
    logger,
    getCurrent: input.getCurrent ?? ((key) => CURRENT[key]),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

await check('import: differing keys are written through settings.update and the audit marker lands', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, logger: t.logger.logger, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'imported')
    // Only keys whose legacy value differs from the current effective value.
    assert.deepEqual(t.settings.calls, [{
      ns: 'dsh-cron',
      patch: { fireHistoryLimit: 12, historyLimit: 80, tickIntervalMs: 5000, storageDir: '/tmp/my-cron' },
    }])
    // The marker is the persistent audit record.
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'imported')
    assert.equal(marker.source.endsWith('settings.yaml.imported'), true)
    assert.equal(marker.imported.tickIntervalMs, 5000)
    assert.deepEqual(marker.skipped, {})
    assert.equal(typeof marker.at, 'string')
    // One summary line, naming the migrated keys.
    const summary = t.logger.lines.find((l) => l.message.includes('legacy settings import'))
    assert.ok(summary, 'a summary line is logged')
    assert.ok(summary.message.includes('fireHistoryLimit, historyLimit, tickIntervalMs, storageDir'))
  } finally {
    t.cleanup()
  }
})

await check('import: existing marker short-circuits everything (idempotent, no resurrection)', async () => {
  const t = boot()
  try {
    mkdirSync(join(t.home, 'storages', 'dsh-cron'), { recursive: true })
    writeFileSync(legacyMarkerPath(t.home), '{"at":"2026-09-25T00:00:00.000Z","outcome":"imported"}\n')
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: () => undefined })
    assert.equal(result.outcome, 'marker-exists')
    assert.equal(t.settings.calls.length, 0, 'settings.update never called')
    assert.equal(readFileSync(legacyMarkerPath(t.home), 'utf8').includes('2026-09-25T00:00:00.000Z'), true, 'marker untouched')
  } finally {
    t.cleanup()
  }
})

await check('import: every legacy value equal → no update, marker no-op with equal reasons', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', [
      'cron:',
      '  fireHistoryLimit: 7',
      "  storageDir: ''",
    ].join('\n'))
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, logger: t.logger.logger, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'no-op')
    assert.equal(t.settings.calls.length, 0)
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'no-op')
    assert.deepEqual(marker.imported, {})
    assert.deepEqual(marker.skipped, { fireHistoryLimit: 'equal', storageDir: 'equal' })
  } finally {
    t.cleanup()
  }
})

await check('import: unknown keys are recorded and left out of the update', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', [
      'cron:',
      '  oldRenamedKey: 42',
      '  historyLimit: 9',
    ].join('\n'))
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'imported')
    assert.deepEqual(t.settings.calls[0].patch, { historyLimit: 9 })
    assert.deepEqual(result.skipped, { oldRenamedKey: 'unknown-key' })
  } finally {
    t.cleanup()
  }
})

await check('import: settings.update rejects → warn, NO marker (next boot retries)', async () => {
  const t = boot({ settings: fakeSettings({ fail: true }) })
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, logger: t.logger.logger, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'update-failed')
    assert.equal(existsSync(legacyMarkerPath(t.home)), false, 'no marker on a failed update')
    assert.ok(t.logger.lines.some((l) => l.level === 'warn' && l.message.includes('retry next boot')))
  } finally {
    t.cleanup()
  }
})

await check('import: no settings seam → no marker, nothing read or written', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: undefined, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'no-settings')
    assert.equal(existsSync(legacyMarkerPath(t.home)), false)
  } finally {
    t.cleanup()
  }
})

await check('import: no legacy document at all → marker no-legacy', async () => {
  const t = boot()
  try {
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'no-legacy')
    assert.equal(t.settings.calls.length, 0)
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'no-legacy')
    assert.deepEqual(marker.imported, {})
  } finally {
    t.cleanup()
  }
})

await check('import: legacy document without our section → marker no-section', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', 'ui-theme:\n  preference: light\n')
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: (k) => CURRENT[k] })
    assert.equal(result.outcome, 'no-section')
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'no-section')
  } finally {
    t.cleanup()
  }
})

await check('import: settings.yaml.imported wins over settings.yaml', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    writeLegacyDoc(t.home, 'settings.yaml', 'cron:\n  historyLimit: 999\n')
    await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: (k) => CURRENT[k] })
    assert.deepEqual(t.settings.calls[0].patch, { fireHistoryLimit: 12, historyLimit: 80, tickIntervalMs: 5000, storageDir: '/tmp/my-cron' })
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.source.endsWith('settings.yaml.imported'), true)
  } finally {
    t.cleanup()
  }
})

await check('import: settings.yaml is the fallback when nothing was renamed', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml', 'cron:\n  tickIntervalMs: 1000\n')
    await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: (k) => CURRENT[k] })
    assert.deepEqual(t.settings.calls[0].patch, { tickIntervalMs: 1000 })
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.source.endsWith('settings.yaml'), true)
  } finally {
    t.cleanup()
  }
})

await check('contract: entry id, section name, marker dir and key mapping are stable', async () => {
  assert.equal(ENTRY_ID, 'dsh-cron')
  assert.equal(LEGACY_SECTION, 'cron')
  assert.equal(legacyMarkerPath('/home/x/.dsh'), join('/home/x/.dsh', 'storages', 'dsh-cron', 'legacy-import.json'))
  assert.deepEqual(legacySettingsCandidates('/d'), [join('/d', 'settings.yaml.imported'), join('/d', 'settings.yaml')])
  assert.deepEqual(
    [...LEGACY_KEYS],
    ['fireHistoryLimit', 'historyLimit', 'tickIntervalMs', 'storageDir'],
    'identity key mapping: legacy name = Config key name',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
rmSync(work, { recursive: true, force: true })
