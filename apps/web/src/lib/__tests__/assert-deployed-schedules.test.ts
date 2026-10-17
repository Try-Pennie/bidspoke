import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow, workflowJobBody } from './_scan-utils'

/**
 * The Deploy Ops Worker check that the deploy set the minute cron (#1949). CI's
 * token cannot read a Worker's schedules, so the proof is wrangler deploy's own
 * output, which lists each schedule it set. The fixtures are that output's shape.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/assert-deployed-schedules.sh')

function run(log: string, ...crons: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deployed-schedules-'))
  const file = path.join(dir, 'deploy.log')
  writeFileSync(file, log)
  const r = spawnSync('bash', [SCRIPT, file, ...crons], { encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

const deployed = (...schedules: string[]) =>
  `Uploaded bidspoke-worker-ops (2.1 sec)\nDeployed bidspoke-worker-ops triggers (0.4 sec)\n${schedules.map((s) => `  schedule: ${s}`).join('\n')}\nCurrent Version ID: x\n`

describe('assert-deployed-schedules.sh (#1949)', () => {
  it('passes when the deploy set exactly the expected schedule', () => {
    expect(run(deployed('* * * * *'), '* * * * *')).toMatchObject({ status: 0 })
  })

  it('fails when the schedule is missing, or another is left over', () => {
    const missing = run('Deployed bidspoke-worker-ops triggers (0.4 sec)\n', '* * * * *')
    expect(missing.status).toBe(1)
    expect(missing.out).toMatch(/DEPLOYED SCHEDULES WRONG/)
    const extra = run(deployed('* * * * *', '*/5 * * * *'), '* * * * *')
    expect(extra.status).toBe(1)
    expect(extra.out).toMatch(/\*\/5 \* \* \* \*/)
  })

  it('fails when the output lists no triggers at all, rather than reading silence as success', () => {
    const r = run('Uploaded bidspoke-worker-ops (2.1 sec)\n', '* * * * *')
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/DEPLOYED SCHEDULES UNPROVEN/)
  })

  it('is run by Deploy Ops Worker on its deploy output, with the schedule wrangler.ops.toml declares', () => {
    const job = workflowJobBody(readWorkflow('.github/workflows/deploy.yml'), 'deploy-ops-worker')
    expect(job).toMatch(/wrangler deploy --config wrangler\.ops\.toml 2>&1 \| tee "\$RUNNER_TEMP\/ops-deploy\.log"/)
    expect(job).toMatch(/bash \.github\/scripts\/assert-deployed-schedules\.sh "\$RUNNER_TEMP\/ops-deploy\.log" '\* \* \* \* \*'/)
  })

  it('waits for Deploy Worker, so the OpsGateway entrypoint the ops Worker binds is deployed first', () => {
    const job = workflowJobBody(readWorkflow('.github/workflows/deploy.yml'), 'deploy-ops-worker')
    expect(job).toMatch(/^ {4}needs: \[.*\bdeploy-worker\b.*\]$/m)
  })
})
