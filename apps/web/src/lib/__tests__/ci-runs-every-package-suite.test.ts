import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowJobBody, workflowJobIds, workspacePackages } from './_scan-utils'

/**
 * CI must invoke the test suite of every workspace package that has one (#869).
 *
 * CI names its suites one by one, so a package added to the workspace with tests
 * of its own is not picked up. It gets a green CI while nothing runs it, and the
 * failure mode is silence: the suite passes locally, the pull request is green,
 * and the package's invariants are unguarded from the moment it is created.
 *
 * This is the hazard the worker guard placement rule (#502) already names about
 * the other direction, that "a CI change scoping tests per package would have
 * dropped them without a word". #869 adds the first `packages/*` entry, which is
 * exactly the moment to make the list self checking rather than remembered.
 *
 * Written in the code-to-registry direction (LESSONS L96): it enumerates the
 * packages that EXIST and requires each to appear in CI, so the check cannot be
 * satisfied by a package simply being left off a hand maintained list.
 *
 * #966 split the single `test` job into parallel per-package jobs, and #967
 * pointed the worker at a `test:unit` script. Neither the job names nor the
 * script names are written down here: the jobs are DERIVED by looking for suite
 * invocations across the workflow (L41), so adding a third test job, renaming
 * one, or moving a package between them cannot make this guard blind. Naming
 * them would have made a fourth job exempt from the very check that exists to
 * catch an unrun suite.
 */
const CI = '.github/workflows/ci.yml'

/** Packages that declare a `test` script, by name. */
const packagesWithTests = () =>
  workspacePackages().filter((pkg) => typeof pkg.scripts.test === 'string')

/**
 * Blank YAML comments, so prose ABOUT running a suite cannot be read as running
 * it (L103). A comment naming `--filter web test` would otherwise satisfy the
 * assertion for the web package while no job ran anything.
 */
const stripComments = (yaml: string): string =>
  yaml
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n')

/**
 * Every `pnpm --filter <pkg> <test-script>` invocation in the workflow, as
 * [package, script] pairs.
 *
 * `exec` invocations (`--filter web exec playwright test`) are deliberately not
 * matched: they run one named spec file, not the package's suite, so counting
 * them would let the a11y job answer for the web suite.
 */
function suiteInvocations(): Array<[string, string]> {
  const yaml = stripComments(readWorkflow(CI))
  const pattern = /--filter[= ]([@\w/-]+) (test(?::[\w-]+)?)(?![\w:-])/g
  return [...yaml.matchAll(pattern)].map((m) => [m[1], m[2]])
}

describe('CI runs every workspace package that has tests (#869)', () => {
  it('finds packages to check, so this cannot pass vacuously', () => {
    // An empty list would satisfy every assertion below by having nothing to
    // assert about, and that is exactly what a renamed workspace glob produces
    // (L98).
    expect(packagesWithTests().length).toBeGreaterThanOrEqual(3)
  })

  it('finds suite invocations to check, so this cannot pass vacuously either', () => {
    // The other half of the same hazard: a regex that matches nothing reports
    // every package as missing, but a regex that matches nothing AFTER a
    // workflow rewrite would report them as missing too, so the loud failure is
    // in the next test. This one catches the case where the pattern silently
    // stops matching the workflow's syntax.
    expect(suiteInvocations().length).toBeGreaterThanOrEqual(3)
  })

  it('invokes each package suite somewhere in the workflow', () => {
    const invoked = new Set(suiteInvocations().map(([pkg]) => pkg))
    for (const pkg of packagesWithTests()) {
      expect(
        invoked.has(pkg.name),
        `ci.yml never runs ${pkg.name}'s suite, so its tests are green locally and unrun in CI. It invokes: ${[...invoked].join(', ')}`,
      ).toBe(true)
    }
  })

  it('spreads the suites over more than one job, so they run in parallel (#966)', () => {
    // Not a style preference: the whole point of #966 is that the worker and web
    // suites no longer wait for each other. Collapsing them back into one job
    // would be a silent 75 second regression on every pull request with nothing
    // reporting it.
    const yaml = readWorkflow(CI)
    const jobsRunningSuites = workflowJobIds(yaml).filter((id) =>
      /--filter[= ][@\w/-]+ test(?::[\w-]+)?(?![\w:-])/.test(stripComments(workflowJobBody(yaml, id))),
    )
    expect(
      jobsRunningSuites.length,
      `the package suites all sit in one job (${jobsRunningSuites.join(', ')}), so they run one after another`,
    ).toBeGreaterThanOrEqual(2)
  })
})

describe('a suite invoked by a variant script still covers the whole suite (#967)', () => {
  /**
   * #967 points CI's worker step at `test:unit` rather than `test`, because
   * `test` also boots the web vitest project to run the worker guards, which the
   * web job already runs in the same CI run.
   *
   * That saving is real and the duplication was, but it opens a gap: anything
   * `test` does BEYOND `test:unit` is, by construction, not run by the job that
   * calls `test:unit`. Whoever adds a second command to `test` gets a green CI
   * and no signal at all.
   *
   * So every variant must be a PREFIX of the package's own `test`, and the
   * remainder is checked against what the rest of CI covers. Derived from the
   * scripts themselves rather than remembered beside them (L41).
   */
  it('names a variant script that the package actually declares', () => {
    for (const [pkgName, script] of suiteInvocations()) {
      if (script === 'test') continue
      const pkg = workspacePackages().find((p) => p.name === pkgName)
      expect(pkg, `ci.yml runs ${pkgName} ${script} but there is no such workspace package`).toBeDefined()
      expect(
        typeof pkg!.scripts[script],
        `ci.yml runs \`pnpm --filter ${pkgName} ${script}\` but ${pkgName} declares no ${script} script`,
      ).toBe('string')
    }
  })

  /**
   * A package's `test` script is a chain of commands joined by `&&`. Each
   * variant CI invokes must be exactly one of those commands (#1410 added a
   * second variant, `test:do`, beside `test:unit`, so "a prefix" became "a
   * segment"), and every command that no variant covers is checked below
   * against what the rest of CI runs.
   */
  const segments = (script: string): string[] => script.split(/\s*&&\s*/).map((s) => s.trim()).filter(Boolean)

  it('runs variants that are each one segment of the full test script', () => {
    for (const [pkgName, script] of suiteInvocations()) {
      if (script === 'test') continue
      const pkg = workspacePackages().find((p) => p.name === pkgName)!
      const full = pkg.scripts.test
      const variant = pkg.scripts[script]
      expect(
        segments(full).includes(variant),
        `${pkgName}'s ${script} script is not one command of its test script, so CI running ${script} runs something the package's own suite does not, or skips something it does.\n  test:      ${full}\n  ${script}: ${variant}`,
      ).toBe(true)
    }
  })

  it('has every segment no variant runs covered elsewhere in CI', () => {
    // The one live case, stated rather than assumed: worker's `test` runs its
    // own vitest projects and THEN the worker guards that live in apps/web. CI's
    // worker job runs the vitest projects through the variants; the guards are
    // covered because the web job runs the whole web suite, which includes them.
    //
    // Asserted concretely so that a remainder doing anything ELSE fails here
    // rather than being waved through by a rule general enough to permit it
    // (L129: an exemption needs a named reviewer, and this is it).
    const byPackage = new Map<string, Set<string>>()
    for (const [pkgName, script] of suiteInvocations()) {
      const set = byPackage.get(pkgName) ?? new Set<string>()
      set.add(script)
      byPackage.set(pkgName, set)
    }
    const invoked = new Set(byPackage.keys())
    for (const [pkgName, scripts] of byPackage) {
      if (scripts.has('test')) continue
      const pkg = workspacePackages().find((p) => p.name === pkgName)!
      const covered = new Set([...scripts].map((s) => pkg.scripts[s]))
      const uncovered = segments(pkg.scripts.test).filter((seg) => !covered.has(seg))
      for (const remainder of uncovered) {
        const guardDir = remainder.match(/--filter=?(\S+) exec vitest run (\S+)/)
        expect(
          guardDir,
          `${pkgName}'s test script runs a command that no CI variant runs, and it is not the known "run a sibling package's guard files" shape, so nothing here can say whether CI covers it:\n  ${remainder}`,
        ).not.toBeNull()

        const [, sibling, dir] = guardDir!
        expect(
          invoked.has(sibling),
          `${pkgName}'s test script runs ${sibling}'s ${dir} guards, but CI never runs ${sibling}'s own suite, so those guards run nowhere in CI`,
        ).toBe(true)
        expect(dir).toMatch(/^src\//)
      }
    }
  })
})
