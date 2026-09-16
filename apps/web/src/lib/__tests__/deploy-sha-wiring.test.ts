import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

/**
 * Guards the DELIVERY of DEPLOYED_SHA, which #327 depends on and which has never worked.
 *
 * apps/worker's health-version.test.ts already covers the runtime half: given DEPLOYED_SHA
 * in env, the root handler reports it. That test passes by handing the value straight to
 * the handler, so it is structurally incapable of noticing that the deploy never supplies
 * one. It did not notice: the live worker has always answered `version: "unknown"`.
 *
 * The cause is argument forwarding. `pnpm --filter=worker run deploy -- --var K:V` does not
 * hand `--var K:V` to wrangler as a flag; pnpm forwards the `--` separator literally, so
 * wrangler receives `wrangler deploy -- --var K:V`, reads `--` as end of options, treats the
 * rest as positional junk, ignores it, and exits 0. Observed in run 30550347565.
 *
 * Because both halves fail quietly, the hourly deploy-drift check that consumes the stamp
 * has skipped with exit 0 since the day it was written. So this asserts the two properties
 * that make that guard able to fail at all: the stamp reaches wrangler, and a missing stamp
 * is treated as a failure rather than an excuse to skip.
 *
 * Lives in apps/web with the other build-time guards because apps/worker compiles against
 * the Workers runtime and has no node filesystem types.
 */
const readWorkflow = (name: string): string => {
  const file = path.join(REPO_ROOT, '.github/workflows', name)
  const text = readFileSync(file, 'utf8')
  // Fail loudly rather than let every assertion below pass against an empty string if a
  // workflow is ever moved or renamed.
  expect(text.length, `${file} is empty`).toBeGreaterThan(0)
  return text
}

/** Every line that stamps DEPLOYED_SHA onto a deploy. */
const stampLines = (yml: string): string[] =>
  yml.split('\n').filter((line) => line.includes('DEPLOYED_SHA') && line.includes('--var'))

describe('DEPLOYED_SHA is actually delivered to the deployed worker (#327)', () => {
  it('stamps the commit on the worker deploy', () => {
    const lines = stampLines(readWorkflow('deploy.yml'))
    expect(
      lines.length,
      'deploy.yml no longer stamps DEPLOYED_SHA, so nothing can report the live commit',
    ).toBeGreaterThan(0)
  })

  it('does not hide the stamp behind pnpm argument forwarding', () => {
    // The whole defect in one assertion. `run <script> --` makes pnpm forward the separator
    // verbatim, and wrangler then discards every flag after it without failing, so the
    // deploy is green and the worker is unstamped. Use `exec`, or pass the flag inside the
    // package script, so the flag arrives as a real wrangler argument.
    for (const line of stampLines(readWorkflow('deploy.yml'))) {
      expect(
        line,
        'the DEPLOYED_SHA flag is passed after a bare `--`, which wrangler silently ignores',
      ).not.toMatch(/run\s+\S+\s+--\s+--var/)
    }
  })
})

describe('the deploy-drift check can actually fail (#327)', () => {
  it('does not treat a missing stamp as a reason to skip', () => {
    // An unstamped worker was the pre-#327 state and is now the signal that stamping has
    // broken, which is the very condition this job exists to report. Skipping on it makes
    // the job structurally unable to go red: it has reported success hourly while checking
    // nothing. A missing stamp must fail, not exit 0.
    const lines = readWorkflow('deploy-drift.yml').split('\n')
    // Target the `if` that BRANCHES on an unknown stamp, not the assignment that defaults
    // to the string "unknown". Both mention LIVE_SHA and unknown, and matching the
    // assignment first made an earlier version of this test scan a window with no `exit 0`
    // in it and pass while the skip was still there.
    const branch = lines.findIndex(
      (line) => /^\s*if\s/.test(line) && /LIVE_SHA/.test(line) && /unknown/.test(line),
    )
    expect(branch, 'deploy-drift.yml no longer branches on an unknown stamp').toBeGreaterThan(-1)
    // Take the branch body up to its closing `fi`, so the window cannot miss the skip.
    const end = lines.slice(branch).findIndex((line) => /^\s*fi\s*$/.test(line))
    expect(end, 'the unknown-stamp branch is never closed').toBeGreaterThan(0)
    // Executable lines only. The branch carries a comment recording what it used to do,
    // and that comment naming the old behaviour must not read as the old behaviour.
    const branchBody = lines
      .slice(branch, branch + end + 1)
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    // Since #1373 the branch records the verdict and stops only this step, so the
    // site and tail worker are still checked; the worker_probe_alert step then pages
    // and fails the run. What must never happen is the branch skipping without that
    // verdict, which is the silent success this test exists to prevent.
    expect(
      branchBody,
      'a missing DEPLOYED_SHA no longer records alert-unstamped, so nothing reports the broken stamp',
    ).toContain('verdict=alert-unstamped')
    const drift = readWorkflow('deploy-drift.yml')
    const alertStep = drift.slice(drift.indexOf('id: worker_probe_alert'))
    expect(alertStep.length, 'there is no worker_probe_alert step to report the broken stamp').toBeLessThan(drift.length)
    expect(alertStep.slice(0, alertStep.indexOf('\n      - name:')), 'the alert step does not page on an unstamped worker').toMatch(
      /alert-unstamped\)[\s\S]*exit 1/,
    )
  })
})
