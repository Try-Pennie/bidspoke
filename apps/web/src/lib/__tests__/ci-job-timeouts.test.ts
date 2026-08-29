import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowFiles, workflowJobBody } from './_scan-utils'

/**
 * Every job in every workflow must set `timeout-minutes` (#885, widened by
 * #1062).
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
 *
 * The guard written then read ci.yml and nothing else, which is the defect its
 * own subject names: a rule enforced on one file while three others are exempt
 * (L135, L30). The same Chromium install could hang the Pages build; a Verify
 * that stalls holds the whole deploy for six hours while reading as in
 * progress; and an hourly drift job that hangs for six hours also blocks the
 * next five scheduled runs from meaning anything, which is the one job whose
 * silence is supposed to be evidence.
 *
 * So it now reads EVERY `.github/workflows/*.yml`, enumerated from disk rather
 * than listed here, so a workflow added later is covered on the day it lands
 * rather than the day someone remembers this file (L96).
 */

/** Job keys are exactly two spaces deep under `jobs:`; steps are deeper. */
function jobsWithoutTimeout(yaml: string): string[] {
  const lines = yaml.split('\n')
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  expect(jobsAt, 'workflow has a jobs: block').toBeGreaterThanOrEqual(0)

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

const jobKeysIn = (yaml: string): string[] => {
  const lines = yaml.split('\n')
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  return lines.slice(jobsAt + 1).filter((l) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l))
}

describe('job timeouts across every workflow (#1062)', () => {
  it('finds workflows to check, so the guard cannot pass by reading nothing', () => {
    expect(workflowFiles().length).toBeGreaterThanOrEqual(4)
  })

  it.each(workflowFiles())('%s declares jobs, so it cannot pass by parsing nothing', (file) => {
    // Per file, not once overall: a single total would be satisfied by one big
    // workflow while another parsed to nothing at all (L178).
    expect(jobKeysIn(readWorkflow(file)).length).toBeGreaterThanOrEqual(1)
  })

  it.each(workflowFiles())('%s gives every job an explicit timeout', (file) => {
    const offenders = jobsWithoutTimeout(readWorkflow(file))

    expect(
      offenders,
      `${file} jobs missing timeout-minutes: ${offenders.join(', ')}. Without one a stalled step hangs for six hours instead of failing, and reads as "still working" the whole time.`,
    ).toEqual([])
  })
})

describe('accessibility job browser cache', () => {
  it('caches the Playwright browser instead of downloading it on every run', () => {
    const a11y = workflowJobBody(readWorkflow('.github/workflows/ci.yml'), 'a11y')

    expect(a11y).toContain('actions/cache')
    expect(a11y).toMatch(/ms-playwright/)
  })
})
