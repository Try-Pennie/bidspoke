import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REPO_ROOT,
  evaluateWorkflowIf,
  readWorkflow,
  workflowIf,
  workflowJobBody,
  workflowJobIds,
  workflowNeeds,
} from './_scan-utils'

/**
 * `CI passed` is the one check the main ruleset requires from ci.yml (#2749).
 *
 * Try-Pennie moved to GitHub Team on 2026-10-23, so the ruleset that was
 * unavailable on the free plan now exists. Requiring every CI job by name
 * would make each job's display name load-bearing: rename or split one and
 * every pull request waits on a check that never reports, with nothing saying
 * why (L305). So the ruleset requires this summary job, and the job decides
 * from its legs' results through a tested script.
 *
 * Two things make a summary job unsafe, and each half below pins one:
 *   1. GitHub counts a SKIPPED required check as passing. Without `always()`,
 *      a failed leg skips the summary and the pull request merges red.
 *   2. A job added to ci.yml later and left out of `needs` is never consulted,
 *      so its failure merges. The guard reads the job list from the file.
 */
const scriptPath = path.join(REPO_ROOT, '.github/scripts/ci-passed-decision.sh')

function decide(needsJson: string): { code: number | null; out: string } {
  const r = spawnSync('bash', [scriptPath, needsJson], { encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

const leg = (result: string) => ({ result, outputs: {} })

describe('ci-passed-decision', () => {
  it('passes when every leg succeeded', () => {
    const r = decide(JSON.stringify({ lint: leg('success'), typecheck: leg('success') }))
    expect(r.code, r.out).toBe(0)
  })

  it('fails on a failed leg and names it', () => {
    const r = decide(JSON.stringify({ lint: leg('success'), 'test-web': leg('failure') }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('test-web=failure')
  })

  it('fails on a cancelled leg, which is not a pass', () => {
    expect(decide(JSON.stringify({ lint: leg('cancelled') })).code).toBe(1)
  })

  it('fails on a skipped leg, because no leg of ci.yml is skipped on a pull request', () => {
    expect(decide(JSON.stringify({ lint: leg('skipped') })).code).toBe(1)
  })

  it('fails when it read no legs at all, rather than passing having checked nothing', () => {
    expect(decide('{}').code).toBe(1)
  })

  it('fails when the results cannot be read', () => {
    expect(decide('').code).toBe(1)
    expect(decide('not json').code).toBe(1)
  })
})

describe('the CI passed job in ci.yml', () => {
  const yaml = readWorkflow('.github/workflows/ci.yml')
  const body = () => workflowJobBody(yaml, 'ci-passed')

  it('reports under the name the main ruleset requires', () => {
    expect(body()).toMatch(/^ {4}name: CI passed$/m)
  })

  it('needs every other job in ci.yml, read from the file so a new job is covered the day it lands', () => {
    const others = workflowJobIds(yaml).filter((id) => id !== 'ci-passed')
    expect(others.length).toBeGreaterThan(0)
    expect([...workflowNeeds(body())].sort()).toEqual([...others].sort())
  })

  it('still runs when a leg failed, since a skipped required check counts as passing', () => {
    const cond = workflowIf(body(), 4)
    expect(cond, 'the job has an if:').not.toBeNull()
    expect(evaluateWorkflowIf(cond as string, { github: { event_name: 'pull_request' } })).toBe(true)
    expect(cond).toMatch(/always\(\)/)
  })

  it('stays off on a push to main, where five legs are skipped by design and no ruleset reads it', () => {
    expect(evaluateWorkflowIf(workflowIf(body(), 4) as string, { github: { event_name: 'push' } })).toBe(false)
  })

  it('decides through the tested script alone, handed every leg result', () => {
    // Only the script, because ci-main-push-coverage.test.ts exempts this job on
    // the grounds that it checks nothing itself; a real check added here would
    // ride that exemption and never run on main.
    const runs = [...body().matchAll(/^\s*run:\s*(\S.*)$/gm)].map((m) => m[1].trim())
    expect(runs).toEqual(['bash .github/scripts/ci-passed-decision.sh "$NEEDS"'])
    expect(body()).toMatch(/NEEDS: \$\{\{ toJSON\(needs\) \}\}/)
  })
})
