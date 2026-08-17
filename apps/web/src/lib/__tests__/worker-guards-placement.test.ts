import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * Every guard that reads WORKER source must live where the WORKER test scope
 * runs it (#502).
 *
 * Twenty three guards scan `apps/worker/src` while living in the web package, so
 * `pnpm --filter=worker test` passing said nothing about whether the worker's
 * invariants held, and a CI change scoping tests per package would have dropped
 * them without a word. They now live in `src/lib/__guards__/worker/`, and the
 * worker's own `test` script runs that directory.
 *
 * This is the code-to-registry direction (LESSONS L96). Without it the
 * arrangement holds only for as long as everyone remembers it: the next guard
 * written against worker source lands in `__tests__/` beside its neighbours,
 * runs in the web scope only, and is silently exempt from the very scope it was
 * written to protect. The guard reports green while blind.
 *
 * The rule has no exemptions on purpose (L129). A category excluded from a check
 * needs something else named to cover it, and there is nothing else here, so
 * every file that reads worker source from disk is in scope, including the
 * shared helper's own test.
 */
const TESTS_DIR = path.join(REPO_ROOT, 'apps/web/src/lib/__tests__')
const GUARDS_DIR = path.join(REPO_ROOT, 'apps/web/src/lib/__guards__/worker')

/**
 * True when a test READS worker source off disk, as opposed to merely mentioning
 * a worker path inside a fixture string. The distinction matters: several tests
 * about `.github` scripts pass a worker path to those scripts as input without
 * ever opening a worker file, and dragging them in would make the rule
 * arbitrary. It is worker SOURCE specifically: reading the worker's
 * package.json, as the wiring check below does, is not scanning its code.
 */

// Assembled from fragments rather than written as literals, so this file does not
// itself contain the patterns it searches for. A guard whose own source satisfies
// its own predicate reports itself as a violation, and the obvious repair, adding
// its own filename to an exclusion list, is a name that silently stops matching
// the day the file is renamed (L103, L135).
const WORKER_SRC_PATH = ['apps', 'worker', 'src'].join('/')
const SRC_CONST = ['WORKER', 'SRC'].join('_')

const readsWorkerSource = (src: string): boolean =>
  new RegExp(`\\b${SRC_CONST}\\b`).test(src) ||
  new RegExp(`path\\.(join|resolve)\\(\\s*REPO_ROOT\\s*,\\s*'${WORKER_SRC_PATH}`).test(src) ||
  (/REPO_ROOT\s*=\s*path\.resolve/.test(src) && new RegExp(`'${WORKER_SRC_PATH}`).test(src))

const testsIn = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.test.ts'))

describe('worker guards live in the worker guard directory (#502)', () => {
  it('has guards to check, so this cannot pass vacuously', () => {
    // A renamed or emptied directory would otherwise satisfy every assertion
    // below by having nothing to assert about (L98).
    const guards = testsIn(GUARDS_DIR).filter((f) =>
      readsWorkerSource(readFileSync(path.join(GUARDS_DIR, f), 'utf8')),
    )
    expect(guards.length, 'no worker-scanning guards found in the guard directory').toBeGreaterThan(10)
  })

  it('leaves no worker-scanning guard behind in the general test directory', () => {
    const stragglers = testsIn(TESTS_DIR).filter((f) =>
      readsWorkerSource(readFileSync(path.join(TESTS_DIR, f), 'utf8')),
    )
    expect(
      stragglers,
      'these tests read worker source but live outside src/lib/__guards__/worker, so the worker test scope does not run them',
    ).toEqual([])
  })

  it('every file in the guard directory is actually about worker source', () => {
    // The other direction. A directory that accumulates unrelated tests stops
    // meaning anything, and the worker scope then pays to run them.
    const strays = testsIn(GUARDS_DIR).filter(
      (f) => !readsWorkerSource(readFileSync(path.join(GUARDS_DIR, f), 'utf8')),
    )
    expect(strays, 'these tests do not read worker source, so they do not belong in the worker guard directory').toEqual([])
  })
})

describe('the worker test scope actually runs them (#502)', () => {
  it('runs the guard directory from the worker package test script', () => {
    // The half that makes the move worth anything. Moving the files and not
    // wiring the scope would leave exactly the state this issue describes, while
    // looking solved.
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'apps/worker/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }
    const test = pkg.scripts?.test ?? ''
    expect(test, 'apps/worker has no test script').not.toBe('')
    expect(
      test,
      'the worker test script no longer runs the worker guards, so worker tests passing says nothing about worker invariants again',
    ).toContain('__guards__/worker')
  })
})
