import { execFileSync, spawnSync } from 'node:child_process'
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

const MAIN = 'refs/heads/main'

/** The decision for a run on main: the event, then the three filter values. */
const decide = (event: string, ...filters: string[]): Record<string, string> => decideOn(event, MAIN, ...filters)

const parse = (out: string): Record<string, string> =>
  Object.fromEntries(
    out
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.split('=') as [string, string]),
  )

const decideOn = (event: string, ref: string, ...filters: string[]): Record<string, string> =>
  parse(execFileSync('bash', [SCRIPT, event, ref, ...filters], { encoding: 'utf8' }))

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

  it.each([
    ['workflow_dispatch', 'refs/heads/some-feature'],
    ['workflow_dispatch', 'refs/tags/v1'],
    ['workflow_dispatch', ''],
    ['push', 'refs/heads/some-feature'],
  ])('deploys nothing, and refuses by name, on %s from %s, because only main reaches production', (event, ref) => {
    // Deploy Worker and Deploy Worker Tail run `wrangler deploy`, which goes to
    // production whatever branch the run is on, and the worker drift check skips a
    // commit that is not in main's history, so a branch deploy would run unreviewed
    // code with nothing reporting it.
    const run = spawnSync('bash', [SCRIPT, event, ref, 'true', 'true', 'true'], { encoding: 'utf8' })
    expect(parse(run.stdout)).toEqual({ worker: 'false', worker_tail: 'false', pages: 'false' })
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/::error::/)
    expect(run.stderr).toContain(`'${ref}'`)
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

  it('hands the decision script the ref the run is on, so a branch dispatch deploys nothing', () => {
    const step = changes.slice(changes.indexOf('Decide which targets deploy'))
    expect(step).toMatch(/REF:\s*\$\{\{\s*github\.ref\s*\}\}/)
    expect(step).toMatch(/deploy-targets-decision\.sh "\$EVENT_NAME" "\$REF" /)
  })
})

describe('dispatched Deploys queue rather than overlap (#1761)', () => {
  const deploy = readWorkflow('.github/workflows/deploy.yml')
  const head = deploy.slice(0, deploy.indexOf('\njobs:'))
  const block = head.slice(head.indexOf('\nconcurrency:'))

  it('puts every dispatched run in one group that never cancels a run already deploying (L671)', () => {
    // Batched auto-merges each dispatch a Deploy at main's tip a few minutes
    // apart, and each deploys every target, so two running at once can finish in
    // the wrong order and leave the older commit live.
    expect(head).toMatch(/\nconcurrency:\n/)
    expect(block).toMatch(/cancel-in-progress:\s*false/)
    expect(block).toContain("github.event_name == 'workflow_dispatch'")
  })

  it('gives every push run a group of its own, so a pending push is never replaced and its diff lost', () => {
    // GitHub replaces a PENDING run in a group with the newer one. A push run
    // deploys only what its own diff touched, so a replaced push would take its
    // targets with it; a replaced dispatch loses nothing, because the newer
    // dispatch deploys every target at a newer tip.
    expect(block).toContain('github.run_id')
  })
})
