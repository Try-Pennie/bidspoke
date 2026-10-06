/**
 * The ops lane's deploy switch is readable where it is committed (#1709 part 3).
 *
 * .github/scripts/deploy-targets-decision.sh holds Deploy Ops Outbound back until
 * OPS_WORKER_DEPLOYED in apps/worker/src/lib/secret-lists.ts is true, reading that
 * line as text. A reshaped line would leave the ops outbound Worker held back
 * with only a warning, so this fails first: the line is in the shape the script
 * reads, and the script reads it by default without a warning. Since #1709 part 4
 * the lane is live (the ops Worker was first deployed 2026-10-06), so the
 * committed switch lets both ops deploy legs run; the test asserting the opposite
 * was inverted in that change, whose premise it was (L373).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'
import { OPS_WORKER_DEPLOYED } from '../../../../../worker/src/lib/secret-lists'

const SCRIPT = path.join(REPO_ROOT, '.github/scripts/deploy-targets-decision.sh')

describe('the ops lane deploy switch (#1709)', () => {
  it('is one line in the shape the decision script reads, and agrees with the exported value', () => {
    const src = readFileSync(path.join(WORKER_SRC, 'lib/secret-lists.ts'), 'utf8')
    const lines = src.split('\n').filter((l) => l.includes('OPS_WORKER_DEPLOYED ='))
    expect(lines).toEqual([`export const OPS_WORKER_DEPLOYED = ${String(OPS_WORKER_DEPLOYED)}`])
  })

  it('is read by default, without a warning, and now lets both ops deploy legs run (#1709 part 4)', () => {
    expect(OPS_WORKER_DEPLOYED).toBe(true)
    const run = spawnSync('bash', [SCRIPT, 'workflow_dispatch', 'refs/heads/main', 'true', 'true', 'true', 'true', 'true'], {
      encoding: 'utf8',
      env: { ...process.env, OPS_LIVE_FLAG_FILE: '' },
    })
    expect(run.status).toBe(0)
    expect(run.stderr).not.toMatch(/::warning::/)
    expect(run.stdout).toMatch(/^ops_outbound=true$/m)
    expect(run.stdout).toMatch(/^ops_worker=true$/m)
    expect(run.stdout).toMatch(/^compare_outbound=true$/m)
  })
})
