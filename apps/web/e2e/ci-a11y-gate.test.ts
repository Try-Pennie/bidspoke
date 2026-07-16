import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Guards the CI accessibility job itself (#673).
 *
 * The premise of #673 is that things nobody runs rot silently: six specs drifted from the
 * UI and were only found months later, because the Playwright suite ran when a human
 * remembered it. A CI job fixes that for the specs, but the job is now the thing that can
 * quietly stop covering: delete it, point it at a spec that no longer exists, or mark it
 * continue-on-error, and CI stays green while nothing is being checked.
 *
 * So this asserts the wiring, not the accessibility. It is deliberately narrow: it does
 * not care how the app is served or what the job is called, only that a11y.spec.ts is
 * actually run and is actually allowed to fail the build.
 */
const CI_YML = path.resolve(__dirname, '../../../.github/workflows/ci.yml')

const readCi = () => {
  const text = fs.readFileSync(CI_YML, 'utf8')
  // Fail loudly rather than let every assertion below pass against an empty string if the
  // workflow is ever moved or renamed.
  expect(text.length, `${CI_YML} is empty`).toBeGreaterThan(0)
  return text
}

/** The `a11y:` job body: from its key to the start of the next top-level job. */
const a11yJob = (ci: string): string => {
  const start = ci.indexOf('\n  a11y:')
  expect(start, 'ci.yml no longer defines an `a11y:` job').toBeGreaterThan(-1)
  const rest = ci.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

describe('CI accessibility gate', () => {
  it('runs the accessibility spec on every PR and push to main', () => {
    const ci = readCi()
    const triggers = ci.slice(0, ci.indexOf('jobs:'))
    expect(triggers).toMatch(/pull_request:/)
    expect(triggers).toMatch(/push:/)
    expect(a11yJob(ci)).toMatch(/playwright test e2e\/a11y\.spec\.ts/)
  })

  it('points at a spec file that exists', () => {
    // Read the path out of the workflow rather than assuming it: `playwright test` exits 0
    // when its filter matches no files, so a typo'd or renamed path would report success
    // having tested nothing. That is exactly the silent non-coverage this issue is about.
    const run = a11yJob(readCi()).match(/playwright test (\S+)/)
    expect(run, 'the a11y job no longer runs `playwright test`').not.toBeNull()
    const spec = path.resolve(__dirname, '..', run![1])
    expect(fs.existsSync(spec), `the a11y job runs ${run![1]}, which does not exist`).toBe(true)
  })

  it('lets an accessibility failure fail the build', () => {
    // continue-on-error would turn the gate into decoration.
    expect(a11yJob(readCi())).not.toMatch(/continue-on-error:\s*true/)
  })
})
