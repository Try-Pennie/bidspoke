import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * CI must invoke the test suite of every workspace package that has one (#869).
 *
 * The CI test job names its suites one by one, `pnpm --filter worker test` and
 * `pnpm --filter web test`, so a package added to the workspace with tests of its
 * own is not picked up. It gets a green CI while nothing runs it, and the failure
 * mode is silence: the suite passes locally, the pull request is green, and the
 * package's invariants are unguarded from the moment it is created.
 *
 * This is the hazard the worker guard placement rule (#502) already names about
 * the other direction, that "a CI change scoping tests per package would have
 * dropped them without a word". #869 adds the first `packages/*` entry, which is
 * exactly the moment to make the list self checking rather than remembered.
 *
 * Written in the code-to-registry direction (LESSONS L96): it enumerates the
 * packages that EXIST and requires each to appear in CI, so the check cannot be
 * satisfied by a package simply being left off a hand maintained list.
 */
const CI = path.join(REPO_ROOT, '.github/workflows/ci.yml')

/** Every workspace package directory, from the globs the workspace file declares. */
const workspaceDirs = (): string[] => {
  const workspace = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')
  const globs = [...workspace.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1])
  expect(globs.length, 'no package globs found in pnpm-workspace.yaml').toBeGreaterThan(0)

  const dirs: string[] = []
  for (const glob of globs) {
    // Only the single-level `dir/*` form the workspace actually uses. A deeper
    // glob would need real matching, and silently ignoring it is what would make
    // this pass while blind, so it is refused loudly instead.
    const match = /^([^*]+)\/\*$/.exec(glob)
    expect(match, `workspace glob '${glob}' is not the dir/* form this check understands`).not.toBeNull()
    const parent = path.join(REPO_ROOT, match![1])
    if (!existsSync(parent)) continue
    for (const entry of readdirSync(parent)) {
      if (existsSync(path.join(parent, entry, 'package.json'))) dirs.push(path.join(parent, entry))
    }
  }
  return dirs
}

/** Package name plus whether it declares a `test` script. */
const packagesWithTests = (): string[] =>
  workspaceDirs()
    .map((dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name: string
      scripts?: Record<string, string>
    })
    .filter((pkg) => typeof pkg.scripts?.test === 'string')
    .map((pkg) => pkg.name)

/** The body of ci.yml's `test:` job, so a mention in another job cannot answer. */
const testJobBody = (): string => {
  const text = readFileSync(CI, 'utf8')
  const start = text.indexOf('\n  test:\n')
  expect(start, 'ci.yml has no job called test').toBeGreaterThan(-1)
  // Up to the next top-level job key, so this is scoped to the one job. A match
  // anywhere in the file would be answered by an unrelated job that happens to
  // filter the same package (L135).
  const rest = text.slice(start + 1)
  const next = rest.search(/\n {2}\w[\w-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('CI runs every workspace package that has tests (#869)', () => {
  it('finds packages to check, so this cannot pass vacuously', () => {
    // An empty list would satisfy every assertion below by having nothing to
    // assert about, and that is exactly what a renamed workspace glob produces
    // (L98).
    expect(packagesWithTests().length).toBeGreaterThanOrEqual(3)
  })

  it('invokes each one from the test job', () => {
    const body = testJobBody()
    for (const name of packagesWithTests()) {
      expect(
        body,
        `ci.yml's test job never runs ${name}'s suite, so its tests are green locally and unrun in CI`,
      ).toContain(`--filter ${name} test`)
    }
  })
})
