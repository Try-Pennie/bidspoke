import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/**
 * The ops outbound Worker deploys only once the ops lane is live, which the
 * script reads from OPS_WORKER_DEPLOYED in apps/worker/src/lib/secret-lists.ts
 * (#1709 part 3). Each test points it at a flag file of its own through
 * OPS_LIVE_FLAG_FILE, so no test depends on the committed value.
 */
const FLAG_DIR = mkdtempSync(path.join(tmpdir(), 'ops-live-'))
const flagFile = (name: string, text: string) => {
  const file = path.join(FLAG_DIR, name)
  writeFileSync(file, text)
  return file
}
const OPS_OFF = flagFile('off.ts', 'export const OPS_WORKER_DEPLOYED = false\n')
const OPS_ON = flagFile('on.ts', '// a comment\nexport const OPS_WORKER_DEPLOYED = true\n')

/** The decision for a run on main: the event, then the five filter values, with the ops lane not live. */
const decide = (event: string, ...filters: string[]): Record<string, string> => decideOn(event, MAIN, ...filters)

const parse = (out: string): Record<string, string> =>
  Object.fromEntries(
    out
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.split('=') as [string, string]),
  )

const runWith = (flag: string, args: string[]) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, OPS_LIVE_FLAG_FILE: flag } })

const decideOn = (event: string, ref: string, ...filters: string[]): Record<string, string> =>
  parse(execFileSync('bash', [SCRIPT, event, ref, ...filters], { encoding: 'utf8', env: { ...process.env, OPS_LIVE_FLAG_FILE: OPS_OFF } }))

describe('deploy-targets-decision', () => {
  it('deploys every target on a dispatched run, whatever the filter said', () => {
    expect(decide('workflow_dispatch', '', '', '', '', '')).toEqual({ worker: 'true', worker_tail: 'true', pages: 'true', compare_outbound: 'true', ops_outbound: 'false' })
    expect(decide('workflow_dispatch', 'false', 'false', 'false', 'false', 'false')).toEqual({
      worker: 'true',
      worker_tail: 'true',
      pages: 'true',
      compare_outbound: 'true',
      ops_outbound: 'false',
    })
  })

  it('passes the paths filter through on a push', () => {
    expect(decide('push', 'true', 'false', 'false', 'false', 'false')).toEqual({ worker: 'true', worker_tail: 'false', pages: 'false', compare_outbound: 'false', ops_outbound: 'false' })
    expect(decide('push', 'false', 'true', 'true', 'false', 'false')).toEqual({ worker: 'false', worker_tail: 'true', pages: 'true', compare_outbound: 'false', ops_outbound: 'false' })
    // #1708 part B: the compare namespace's outbound Worker ships on its own path.
    expect(decide('push', 'false', 'false', 'false', 'true', 'false')).toEqual({ worker: 'false', worker_tail: 'false', pages: 'false', compare_outbound: 'true', ops_outbound: 'false' })
  })

  it('deploys a target whose filter value on a push is empty or malformed, because a value nobody measured must not skip a deploy', () => {
    expect(decide('push', '', 'yes', 'false', '', 'false')).toEqual({ worker: 'true', worker_tail: 'true', pages: 'false', compare_outbound: 'true', ops_outbound: 'false' })
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
    // With the ops lane live, so ops_outbound is refused by the ref, not the flag.
    const run = runWith(OPS_ON, [event, ref, 'true', 'true', 'true', 'true', 'true'])
    expect(parse(run.stdout)).toEqual({ worker: 'false', worker_tail: 'false', pages: 'false', compare_outbound: 'false', ops_outbound: 'false' })
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/::error::/)
    expect(run.stderr).toContain(`'${ref}'`)
  })

  it('deploys everything on an event it does not know', () => {
    expect(decide('repository_dispatch', 'false', 'false', 'false', 'false', 'false')).toEqual({
      worker: 'true',
      worker_tail: 'true',
      pages: 'true',
      compare_outbound: 'true',
      ops_outbound: 'false',
    })
  })
})

describe('the ops outbound Worker deploys only once the ops lane is live (#1709 part 3)', () => {
  it('is never deployed while OPS_WORKER_DEPLOYED is false, on a push or a dispatched run', () => {
    expect(decide('push', 'false', 'false', 'false', 'false', 'true').ops_outbound).toBe('false')
    expect(decide('workflow_dispatch', 'true', 'true', 'true', 'true', 'true').ops_outbound).toBe('false')
  })

  it('follows its filter on a push, and deploys on a dispatched run, once the lane is live', () => {
    const on = (event: string, filter: string) => parse(runWith(OPS_ON, [event, MAIN, 'false', 'false', 'false', 'false', filter]).stdout)
    expect(on('push', 'true').ops_outbound).toBe('true')
    expect(on('push', 'false').ops_outbound).toBe('false')
    expect(on('push', '').ops_outbound).toBe('true')
    expect(on('workflow_dispatch', 'false').ops_outbound).toBe('true')
  })

  it.each([
    ['missing', path.join(FLAG_DIR, 'nowhere.ts')],
    ['malformed', flagFile('odd.ts', 'export const OPS_WORKER_DEPLOYED = maybe\n')],
    ['absent from the file', flagFile('none.ts', 'export const SOMETHING_ELSE = true\n')],
  ])('holds it back with a warning, and fails no other deploy, when the flag is %s', (_label, flag) => {
    const run = runWith(flag, ['push', MAIN, 'true', 'true', 'true', 'true', 'true'])
    expect(run.status).toBe(0)
    expect(parse(run.stdout)).toEqual({ worker: 'true', worker_tail: 'true', pages: 'true', compare_outbound: 'true', ops_outbound: 'false' })
    expect(run.stderr).toMatch(/::warning::.*OPS_WORKER_DEPLOYED/)
  })

  // That the committed flag is in the shape this reads, and is read by default,
  // is a worker source check: __guards__/worker/ops-deploy-switch.test.ts.
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
    for (const target of ['worker', 'worker_tail', 'pages', 'compare_outbound', 'ops_outbound']) {
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
