import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowJobBody, workspacePackages } from './_scan-utils'

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
const CI = '.github/workflows/ci.yml'

/**
 * Packages that declare a `test` script, by name.
 *
 * The workspace parsing lives in `_scan-utils` because a second guard needs it
 * too (every deploy target must be able to see a shared package change), and two
 * copies of it would be two things to get wrong.
 */
const packagesWithTests = (): string[] =>
  workspacePackages()
    .filter((pkg) => typeof pkg.scripts.test === 'string')
    .map((pkg) => pkg.name)

/** The body of ci.yml's `test:` job, so a mention in another job cannot answer. */
const testJobBody = (): string => workflowJobBody(readWorkflow(CI), 'test')

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
