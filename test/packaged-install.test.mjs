// Regression for #2: the published tarball must be npm-installable. The dev
// install hook (the root `prepare` script) references
// scripts/link-dsh-closure.mjs, so scripts/ has to ship — and the linker's
// repo guard must stand down inside a consumer tree (the guard markers,
// tsconfig.json and .git, must therefore never ship). Runs the reporter's
// exact failing step: `npm install` of the packed tarball, lifecycle scripts
// included. Since pnpm 11 gates dependency install hooks (strictDepBuilds),
// the tarball itself carries no preinstall/install/postinstall hook.
// Run: node test/packaged-install.test.mjs  (after `npm run build`)
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const ownName = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).name

if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  throw new Error('lib/index.js missing — run `npm run build` before the test chain')
}

const scratch = mkdtempSync(join(tmpdir(), 'registry-packaged-install-'))
try {
  // 1. Pack from the repo the way CI's release job does. npm < 11 runs the
  //    root `prepare` script during `npm pack` even with --ignore-scripts, and
  //    its output lands on stdout — so do not parse `npm pack --json`; locate
  //    the tarball in the destination dir instead.
  const pack = spawnSync('npm', ['pack', '--pack-destination', scratch], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.equal(pack.status, 0, `npm pack failed:\n${pack.stdout}\n${pack.stderr}`)
  const tarballName = readdirSync(scratch).find((f) => f.endsWith('.tgz'))
  assert.ok(tarballName, 'npm pack produced a tarball')
  const tarball = join(scratch, tarballName)

  // 2. Tarball contents: the install-hook target ships; the guard markers do
  //    not, and the manifest carries no install lifecycle hook at all.
  const contents = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n')
  assert.ok(
    contents.includes('package/scripts/link-dsh-closure.mjs'),
    'prepare target scripts/link-dsh-closure.mjs is in the tarball (#2)',
  )
  assert.ok(!contents.some((f) => f.startsWith('package/tsconfig.json')), 'tsconfig.json never ships (linker guard marker)')
  assert.ok(!contents.some((f) => f.includes('/.git')), '.git never ships (linker guard marker)')
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    assert.ok(!(hook in (manifest.scripts ?? {})), `published manifest carries no ${hook} hook (pnpm 11 strictDepBuilds)`)
  }

  // 3. The reporter's exact failing step: a plain npm install of the tarball,
  //    lifecycle scripts included. Must exit 0 — MODULE_NOT_FOUND here is #2
  //    again.
  const consumer = join(scratch, 'consumer')
  execFileSync('npm', ['install', tarball, '--prefix', consumer, '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: scratch,
    encoding: 'utf8',
  })
  const installed = join(consumer, 'node_modules', ...ownName.split('/'))
  assert.ok(existsSync(join(installed, 'scripts', 'link-dsh-closure.mjs')), 'installed package carries the hook target')

  // 4. Consumer safety: the linker must have stood down — no @deepseek-ai
  //    scope dir materialized inside the consumer's package tree.
  assert.ok(
    !existsSync(join(installed, 'node_modules', '@deepseek-ai')),
    'linker did not touch the consumer tree (guard markers held)',
  )
  console.log('packaged-install: tarball installs cleanly, linker stands down outside the repo')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
