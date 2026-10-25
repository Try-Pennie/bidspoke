import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'
import { timeoutsFor } from '../../../../../vitest.runner-timeouts'

/**
 * Test time limits on a shared runner (#2768).
 *
 * Vitest gives each test 5 seconds. On GitHub's runners a job has the machine to
 * itself; on the Mac runners it shares Dan's work MacBook with the other runner,
 * Slate's jobs and everything Dan runs, and on 2026-10-25 three different tests
 * that take a fraction of a second alone (isolate-memory 0.14 s) timed out there,
 * one at 8.5 s, with the load average at 24 on 14 cores. A per test limit is a
 * guard against a HANG, not a statement about speed, so on a self-hosted runner
 * it widens, and everywhere else stays exactly the default.
 *
 * Every vitest config reads the one module, which this pins: a config that does
 * not would time out on the Mac for a reason unrelated to its change.
 */
describe('timeoutsFor', () => {
  it('widens the limits only on a self-hosted runner', () => {
    expect(timeoutsFor('self-hosted')).toEqual({ testTimeout: 30_000, hookTimeout: 60_000 })
  })

  it('leaves the defaults untouched on GitHub and locally', () => {
    expect(timeoutsFor('github-hosted')).toEqual({})
    expect(timeoutsFor(undefined)).toEqual({})
    expect(timeoutsFor('')).toEqual({})
  })
})

const configs = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /(^|\/)vitest[^/]*\.config\.m?ts$/.test(f))

describe('every vitest config', () => {
  it('is found', () => {
    // Known answer on 2026-10-25: 20 configs. Zero would mean the scan read nothing (L98).
    expect(configs.length).toBeGreaterThanOrEqual(20)
  })

  it.each(configs)('%s gives every test block the shared limits or its own', (file) => {
    const src = readFileSync(path.join(REPO_ROOT, file), 'utf8')
    const blocks = src.split(/\btest: \{/).slice(1)
    // A project with `extends: true` inherits the root block, which is the first.
    const extendsRoot = /extends: true/.test(src)
    // A constant the file builds from runnerTimeouts (the workerd projects take the
    // larger of theirs and the runner's) counts as the shared limits too.
    const derived = [...src.matchAll(/const (\w+) = \{ \.\.\.runnerTimeouts\b/g)].map((m) => m[1])
    const spread = new RegExp(`\\.\\.\\.(?:${['runnerTimeouts', ...derived].join('|')})\\b|\\btestTimeout:`)
    const sets = (b: string) => spread.test(b)
    if (extendsRoot) {
      expect(sets(blocks[0]), 'the root test block, which every project extends').toBe(true)
      return
    }
    const withInclude = blocks.filter((b) => /\binclude:/.test(b))
    expect(withInclude.length).toBeGreaterThan(0)
    for (const b of withInclude) expect(sets(b), `the block including ${/include: (\[[^\]]*\])/.exec(b)?.[1]}`).toBe(true)
  })
})
