/**
 * Deploy Ops Worker follows a bidding Worker deploy that landed or was not
 * needed, and stops after one that failed or was cancelled (#2510, L789).
 *
 * The ops Worker binds the bidding Worker's OpsGateway entrypoint, so it needs
 * deploy-worker (#1949). It runs under always(), because most ops changes do not
 * touch the bidding Worker and its deploy is then SKIPPED, which must not hold
 * ops back. But always() tolerates a FAILED or CANCELLED bidding deploy too, and
 * an ops change that relies on something new on the bidding side (a new gateway
 * method, a moved key id) would then ship against a bidding Worker that does not
 * have it. So the job's first step refuses those two results by name, writes why
 * to the step summary and fails, and nothing after it runs.
 *
 * The conditions are evaluated, not read: "the ops Worker deploys" is computed
 * from the job's `if:` and the refusal step's `if:` together.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateWorkflowIf, readWorkflow, workflowIf, workflowJobBody, workflowNeeds, workflowSteps } from './_scan-utils'

const deploy = readWorkflow('.github/workflows/deploy.yml')
const opsJob = workflowJobBody(deploy, 'deploy-ops-worker')
const steps = workflowSteps(opsJob)
const REFUSAL = 'Refuse when the bidding Worker deploy did not land'
const refusalAt = steps.findIndex((s) => s.name === REFUSAL)
const refusal = steps[refusalAt]?.body ?? ''
const deployAt = steps.findIndex((s) => s.name === 'Deploy Ops Worker')

interface Run {
  bidding: string
  verify?: string
  opsChanged?: string
}

const contextOf = ({ bidding, verify = 'success', opsChanged = 'true' }: Run) => ({
  needs: {
    verify: { result: verify },
    changes: { outputs: { ops_worker: opsChanged } },
    'deploy-ops-outbound': { result: 'skipped' },
    'deploy-worker': { result: bidding },
  },
})

/** Whether the ops Worker's deploy step is reached: the job starts, and the refusal before it does not fire. */
function opsDeploys(run: Run): boolean {
  const jobIf = workflowIf(opsJob, 4)
  const refusalIf = workflowIf(refusal, 8)
  if (jobIf === null) throw new Error('Deploy Ops Worker has no if:, so it no longer waits on anything')
  if (refusalIf === null) throw new Error(`the step '${REFUSAL}' has no if:, so it refuses every run or none`)
  return evaluateWorkflowIf(jobIf, contextOf(run)) && !evaluateWorkflowIf(refusalIf, contextOf(run))
}

/** The refusal step's `run: |` script, as bash would receive it. */
function refusalScript(): string {
  const lines = refusal.split('\n')
  const at = lines.findIndex((l) => /^ {8}run: \|\s*$/.test(l))
  if (at === -1) throw new Error(`the step '${REFUSAL}' has no run: | block`)
  const body: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break
    body.push(line.slice(10))
  }
  return body.join('\n')
}

describe('Deploy Ops Worker follows the bidding Worker deploy (#2510, L789)', () => {
  it('needs deploy-worker, so the bidding Worker deploys first (#1949)', () => {
    expect(workflowNeeds(opsJob)).toEqual(expect.arrayContaining(['verify', 'changes', 'deploy-ops-outbound', 'deploy-worker']))
  })

  it('an ops change that did not touch the bidding Worker still deploys ops: its deploy was skipped', () => {
    expect(opsDeploys({ bidding: 'skipped' })).toBe(true)
  })

  it('a change to both deploys ops once the bidding deploy succeeded', () => {
    expect(opsDeploys({ bidding: 'success' })).toBe(true)
  })

  it.each(['failure', 'cancelled'])('a bidding deploy that ended %s stops the ops deploy', (bidding) => {
    expect(opsDeploys({ bidding })).toBe(false)
  })

  it('still needs a passing Verify and an ops change', () => {
    expect(opsDeploys({ bidding: 'skipped', verify: 'failure' })).toBe(false)
    expect(opsDeploys({ bidding: 'skipped', opsChanged: 'false' })).toBe(false)
  })

  it('refuses first, before anything is installed or deployed', () => {
    expect(refusalAt, `no step named '${REFUSAL}'`).toBe(0)
    expect(deployAt).toBeGreaterThan(refusalAt)
  })

  it('a refusal stops the job: it fails, and no later step runs after a failed one', () => {
    expect(refusal).not.toMatch(/continue-on-error/)
    for (const step of steps.slice(refusalAt + 1)) {
      const condition = workflowIf(step.body, 8) ?? ''
      expect(condition, `step '${step.name ?? '(unnamed)'}' would run after the refusal failed`).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/)
    }
  })

  it.each(['failure', 'cancelled'])('says why in the step summary and the log when the bidding deploy ended %s, and fails', (bidding) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ops-refusal-'))
    const summary = path.join(dir, 'summary.md')
    const script = path.join(dir, 'refuse.sh')
    writeFileSync(summary, '')
    writeFileSync(script, refusalScript())
    const run = spawnSync('bash', ['-e', script], { env: { ...process.env, BIDDING_RESULT: bidding, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8' })
    expect(run.status).toBe(1)
    const written = readFileSync(summary, 'utf8')
    for (const said of [written, run.stdout]) {
      expect(said).toContain('Deploy Ops Worker stopped')
      expect(said).toContain(`Deploy Worker ended ${bidding}`)
    }
    expect(run.stdout).toMatch(/^::error /m)
  })
})
