// Bundled skill mount: the packaged SKILL.md must be byte-for-byte in sync
// with the provider's routing description (the description is the model's
// routing surface — drift between it and the packaged body misroutes skill
// discovery), the served content must be the frontmatter-stripped body, and
// apply() must register the provider at boot.
// Run: node test/skill.test.mjs  (after `npm run build`)

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { apply, stripFrontmatter } from '../lib/index.js'

const SKILL_URL = new URL('../skill/dsh-cron-config/SKILL.md', import.meta.url)

/** Extract one scalar value from the SKILL.md YAML frontmatter. */
function frontmatterValue(markdown, key) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  assert.ok(match, 'SKILL.md must open with a YAML frontmatter block')
  const line = match[1].split('\n').find((l) => l.startsWith(`${key}:`))
  assert.ok(line, `frontmatter must carry "${key}:"`)
  return line.slice(key.length + 1).trim()
}

/** Minimal cordis-like context: only the skills seam is observed. */
function mockCtx() {
  const providers = []
  const ctx = {
    skills: {
      registerProvider(fn) {
        providers.push(fn)
      },
    },
    effect() {},
    inject() {},
    on() {
      return () => {}
    },
    logger: { info() {}, warn() {} },
  }
  return { ctx, providers }
}

const config = {
  fireHistoryLimit: { get: () => 7 },
  historyLimit: { get: () => 50 },
  tickIntervalMs: { get: () => 15000 },
  storageDir: { get: () => '' },
}

test('apply registers the bundled skill provider', async () => {
  const { ctx, providers } = mockCtx()
  await apply(ctx, config)
  assert.equal(providers.length, 1)
  const provider = providers[0]()
  assert.equal(provider.name, 'dsh-cron-config')
  const listed = await provider.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'dsh-cron-config')
  assert.equal(listed[0].source, 'bundled')
  assert.equal(listed[0].invocation.modelInvocable, true)
  assert.equal(listed[0].invocation.userInvocable, true)
})

test('provider description matches the packaged frontmatter byte for byte', async () => {
  const { ctx, providers } = mockCtx()
  await apply(ctx, config)
  const provider = providers[0]()
  const markdown = await readFile(SKILL_URL, 'utf8')
  assert.equal((await provider.list())[0].description, frontmatterValue(markdown, 'description'))
})

test('skill name matches the frontmatter name and the -config convention', async () => {
  const markdown = await readFile(SKILL_URL, 'utf8')
  assert.equal(frontmatterValue(markdown, 'name'), 'dsh-cron-config')
})

test('provider serves the frontmatter-stripped body', async () => {
  const { ctx, providers } = mockCtx()
  await apply(ctx, config)
  const provider = providers[0]()
  const definition = await provider.get((await provider.list())[0])
  assert.equal(definition.name, 'dsh-cron-config')
  assert.ok(definition.content.length > 200, 'served content must be the body, not empty')
  assert.ok(!definition.content.startsWith('---'), 'served content must not carry frontmatter')
  assert.match(definition.content, /# Cron Scheduling/)
  // resourceBase points at the packaged directory so relative links resolve
  assert.equal(definition.resourceBase.kind, 'directory')
})

test('stripFrontmatter', async () => {
  assert.equal(stripFrontmatter('---\nname: x\n---\nbody'), 'body')
  assert.equal(stripFrontmatter('---\r\nname: x\r\n---\r\nbody'), 'body')
  assert.equal(stripFrontmatter('---\nname: x\n---\n\nbody\n'), 'body')
  assert.equal(stripFrontmatter('no frontmatter here'), 'no frontmatter here')
  assert.equal(stripFrontmatter('---\nnever closed\nbody'), '---\nnever closed\nbody')
  assert.equal(stripFrontmatter(''), '')
})

after(() => {
  console.log('skill: done')
})
