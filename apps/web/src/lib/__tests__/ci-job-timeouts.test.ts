import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowJobBody } from './_scan-utils'

/**
 * Every CI job must set `timeout-minutes`.
 *
 * GitHub's default job timeout is 360 minutes. Without an explicit one, a step
 * that stalls does not fail, it HANGS, and a hang is worse than a failure
 * because it is indistinguishable from slowness: the pull request sits at
 * "pending" and nobody has a reason to look (LESSONS L110).
 *
 * Measured 2026-08-19 on PR #885: the `Accessibility (axe)` job stalled on
 * `Install Chromium` three separate times, roughly 20 minutes each, on a branch
 * touching only `apps/worker/src/archive/`. Every other check finished inside
 * three minutes. It never reached a single assertion, and it read as "still
 * working" throughout.
 */

const CI_YML = '.github/workflows/ci.yml'

/** Job keys are exactly two spaces deep under `jobs:`; steps are deeper. */
function jobsWithoutTimeout(yaml: string): string[] {
  const lines = yaml.split('\n')
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  expect(jobsAt, 'ci.yml has a jobs: block').toBeGreaterThanOrEqual(0)

  const offenders: string[] = []
  let current: string | null = null
  let hasTimeout = false

  const flush = () => {
    if (current !== null && !hasTimeout) offenders.push(current)
  }

  for (const line of lines.slice(jobsAt + 1)) {
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (jobMatch) {
      flush()
      current = jobMatch[1]
      hasTimeout = false
      continue
    }
    if (current !== null && /^ {4}timeout-minutes:\s*\d+/.test(line)) hasTimeout = true
  }
  flush()
  return offenders
}

describe('CI job timeouts', () => {
  it('finds the jobs, so the guard cannot pass by parsing nothing', () => {
    // A parser that matches no jobs reports no offenders and reads as a clean
    // pass. Assert the positive case first (LESSONS L159).
    const yaml = readWorkflow(CI_YML)
    const lines = yaml.split('\n')
    const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l))
    const found = lines.slice(jobsAt + 1).filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l))

    expect(found.length).toBeGreaterThanOrEqual(6)
  })

  it('gives every job an explicit timeout, so a stall fails instead of hanging', () => {
    const offenders = jobsWithoutTimeout(readWorkflow(CI_YML))

    expect(offenders, `jobs missing timeout-minutes: ${offenders.join(', ')}`).toEqual([])
  })
})

describe('accessibility job browser cache', () => {
  it('caches the Playwright browser instead of downloading it on every run', () => {
    // The download is the step that stalled three times. Only pnpm packages were
    // cached, so every pull request in the repo re-fetched Chromium and was
    // exposed to that download being slow.
    const a11y = workflowJobBody(readWorkflow(CI_YML), 'a11y')

    expect(a11y).toContain('actions/cache')
    expect(a11y).toMatch(/ms-playwright/)
  })
})
