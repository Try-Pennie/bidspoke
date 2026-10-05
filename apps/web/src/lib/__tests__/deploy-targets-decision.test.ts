import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow, workflowJobBody } from './_scan-utils'

/**
 * Which deploy legs run, decided in a tested script rather than in workflow YAML
 * (#1761).
 *
 * Deploy used to start only on a push to main, and its paths filter compares
 * the push with the commit before it. A Deploy started by hand, or dispatched by
 * the Dependabot auto-merge (a merge made with GITHUB_TOKEN starts no push run),
 * has no previous push: dorny/paths-filter then compares only HEAD with HEAD^, so
 * a dispatched run on a tip that touched only docs would deploy nothing and look
 * green. That is exactly the stranded case a dispatched run exists to repair.
 *
 * So a dispatched run deploys every target. Over deploying is safe: Deploy
 * Worker still skips a byte identical bundle, a Pages redeploy is free, and a
 * tail redeploy is harmless.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/deploy-targets-decision.sh')

const decide = (...args: string[]): Record<string, string> => {
  const out = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' })
  return Object.fromEntries(
    out
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.split('=') as [string, string]),
  )
}

describe('deploy-targets-decision', () => {
  it('deploys every target on a dispatched run, whatever the filter said', () => {
    expect(decide('workflow_dispatch', '', '', '')).toEqual({ worker: 'true', worker_tail: 'true', pages: 'true' })
    expect(decide('workflow_dispatch', 'false', 'false', 'false')).toEqual({
      worker: 'true',
      worker_tail: 'true',
      pages: 'true',
    })
  })

  it('passes the paths filter through on a push', () => {
    expect(decide('push', 'true', 'false', 'false')).toEqual({ worker: 'true', worker_tail: 'false', pages: 'false' })
    expect(decide('push', 'false', 'true', 'true')).toEqual({ worker: 'false', worker_tail: 'true', pages: 'true' })
  })

  it('deploys a target whose filter value on a push is empty or malformed, because a value nobody measured must not skip a deploy', () => {
    expect(decide('push', '', 'yes', 'false')).toEqual({ worker: 'true', worker_tail: 'true', pages: 'false' })
  })

  it('deploys everything on an event it does not know', () => {
    expect(decide('repository_dispatch', 'false', 'false', 'false')).toEqual({
      worker: 'true',
      worker_tail: 'true',
      pages: 'true',
    })
  })
})

describe('deploy.yml routes its targets through the script (#1761)', () => {
  const deploy = readWorkflow('.github/workflows/deploy.yml')
  const changes = workflowJobBody(deploy, 'changes')

  it('can be started by workflow_dispatch', () => {
    const on = deploy.slice(deploy.indexOf('\non:'), deploy.indexOf('\njobs:'))
    expect(on).toMatch(/\n {2}workflow_dispatch:/)
  })

  it('runs the paths filter only on a push, where it has a previous commit to compare with', () => {
    const filter = changes.slice(changes.indexOf('dorny/paths-filter'), changes.indexOf('filters:'))
    expect(filter).toMatch(/if:\s*github\.event_name == 'push'/)
  })

  it('takes every output from the decision script, never straight from the filter', () => {
    const outputs = changes.slice(changes.indexOf('outputs:'), changes.indexOf('steps:'))
    for (const target of ['worker', 'worker_tail', 'pages']) {
      expect(outputs).toContain(`${target}: \${{ steps.targets.outputs.${target} }}`)
    }
    expect(outputs).not.toContain('steps.filter.outputs')
    expect(changes).toContain('.github/scripts/deploy-targets-decision.sh')
  })
})
