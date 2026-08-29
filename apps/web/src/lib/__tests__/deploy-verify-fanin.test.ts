import { describe, expect, it } from 'vitest'
import { readWorkflow, workflowJobBody, workflowJobIds } from './_scan-utils'

/**
 * The deploy gate is a fan-in, and it must need every leg (#1061).
 *
 * Verify used to be one job running typecheck, lint, `pnpm -r test`, the docs
 * check and the migration check in a line, 216 to 249s, with every deploy job
 * waiting on it. It is now four parallel jobs behind a fan-in that keeps the job
 * id `verify`, because that id is load-bearing: five jobs name it in `needs` and
 * two re-assert `needs.verify.result == 'success'` by hand.
 *
 * THE FAILURE THIS FILE EXISTS FOR: a leg left out of the fan-in's `needs` runs,
 * reports its own red check, and gates NOTHING. Every deploy would go ahead on a
 * red suite from that leg, and the pipeline would look entirely normal, because
 * the leg is still there and still visibly running (L3, L247).
 *
 * So the requirement is derived from the file rather than listed here: every job
 * in deploy.yml that runs a test, typecheck or lint command must be in the
 * fan-in's `needs`. Adding a fifth leg and forgetting to wire it fails here.
 */
const DEPLOY = '.github/workflows/deploy.yml'

const stripComments = (yaml: string): string =>
  yaml
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n')

/** Jobs whose steps run a verification command. */
function verifyingJobs(): string[] {
  const yaml = readWorkflow(DEPLOY)
  return workflowJobIds(yaml).filter((id) => {
    if (id === 'verify') return false
    const body = stripComments(workflowJobBody(yaml, id))
    return /run:\s*pnpm (-r )?(typecheck|lint|test)\b/.test(body) ||
      /run:\s*pnpm --filter[= ][@\w/-]+ (test|typecheck|lint)(?::[\w-]+)?(?![\w:-])/.test(body)
  })
}

/** The fan-in's `needs` list. */
function faninNeeds(): string[] {
  const body = workflowJobBody(readWorkflow(DEPLOY), 'verify')
  const line = body.split('\n').find((l) => /^ {4}needs:/.test(l))
  expect(line, "deploy.yml's verify job declares no needs, so it gates nothing").toBeDefined()
  return [...line!.matchAll(/[\w-]+/g)].map((m) => m[0]).filter((w) => w !== 'needs')
}

describe('the deploy fan-in needs every verification leg (#1061)', () => {
  it('finds verifying jobs, so this cannot pass vacuously', () => {
    expect(verifyingJobs().length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the job id `verify`, which five jobs depend on by name', () => {
    const ids = workflowJobIds(readWorkflow(DEPLOY))
    expect(ids, 'renaming verify silently unhooks every needs: [verify] in this file').toContain('verify')
  })

  it('needs every job that runs a verification command', () => {
    const needs = faninNeeds()
    for (const job of verifyingJobs()) {
      expect(
        needs.includes(job),
        `deploy.yml's ${job} job runs verification commands but the verify fan-in does not need it, so it gates nothing and a red result there still deploys. Fan-in needs: ${needs.join(', ')}`,
      ).toBe(true)
    }
  })

  it('fails when a leg fails, rather than passing or quietly skipping', () => {
    // `always()` is required so a failed leg produces a RED verify rather than a
    // grey skipped one. But `always()` also discards the implicit
    // all-needs-succeeded rule, so the hand check is what actually blocks the
    // deploy. Both halves, or the gate is decorative (the same trap deploy-worker
    // documents about its own always()).
    const body = stripComments(workflowJobBody(readWorkflow(DEPLOY), 'verify'))
    expect(body).toMatch(/if:\s*always\(\)/)
    expect(body, 'the fan-in never fails, so a failed leg would still deploy').toMatch(/exit 1/)
    for (const job of faninNeeds()) {
      expect(
        body,
        `the fan-in needs ${job} but never reads its result, so that leg failing does not stop the deploy`,
      ).toContain(`needs.${job}.result`)
    }
  })

  it('treats anything other than success as a failure', () => {
    // A cancelled or skipped leg verified nothing. Reading only for 'failure'
    // would let a leg that never ran count as a pass, which is the exact shape
    // of a gate that reports green while checking nothing (L98).
    const body = stripComments(workflowJobBody(readWorkflow(DEPLOY), 'verify'))
    expect(body).toMatch(/=\s*"success"\s*\]\s*\|\|/)
    expect(body).not.toMatch(/=\s*"failure"\s*\]\s*&&/)
  })
})

describe('the deploy path runs every workspace suite (#1061, #869)', () => {
  /**
   * Splitting `pnpm -r test` into named per-package invocations removed a real
   * safety property from the MERGE path: the recursive form picked up a new
   * package automatically, and a named list does not.
   *
   * This is the same guard ci.yml already carries, pointed at deploy.yml, and it
   * is written in the code-to-registry direction: it enumerates the packages
   * that EXIST and requires each to appear (L96).
   */
  it('invokes every package that declares a test script', async () => {
    const { workspacePackages } = await import('./_scan-utils')
    const yaml = stripComments(readWorkflow(DEPLOY))
    const invoked = new Set(
      [...yaml.matchAll(/--filter[= ]([@\w/-]+) (test(?::[\w-]+)?)(?![\w:-])/g)].map((m) => m[1]),
    )
    const withTests = workspacePackages().filter((p) => typeof p.scripts.test === 'string')

    expect(withTests.length, 'no packages declare tests, so this cannot pass vacuously').toBeGreaterThanOrEqual(3)
    for (const pkg of withTests) {
      expect(
        invoked.has(pkg.name),
        `deploy.yml never runs ${pkg.name}'s suite, so a change to it reaches production unverified. It invokes: ${[...invoked].join(', ')}`,
      ).toBe(true)
    }
  })
})
