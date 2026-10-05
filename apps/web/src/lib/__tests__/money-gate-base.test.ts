import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow, workflowJobBody, workflowStepBody } from './_scan-utils'

/**
 * The commit Deploy's money gate compares the engine against (#1761).
 *
 * On a push that is `github.event.before`, the commit main was at before the
 * push. A dispatched Deploy has no such commit: `github.event.before` is empty,
 * money-gate.sh refuses an empty base, Verify fails, and nothing deploys, behind
 * a red run that reads as a money gate failure rather than "no base". So the base
 * is resolved per event, and a dispatched run that cannot find one says so by
 * name instead of comparing against nothing.
 *
 * A dispatched run compares against the commit the LIVE worker reports, which is
 * the engine production is actually running, so every commit that never had a
 * deploy time gate is covered. An explicit `money_gate_base` input overrides it:
 * the auto-merge passes the commit main was at before its merge, and a person can
 * pass one when the worker is down.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/money-gate-base.sh')
const SHA = 'a'.repeat(40)
const LIVE = 'b'.repeat(40)

const resolve = (
  args: string[],
  curl: { stdout?: string; code?: number } = {},
): { base: string; status: number; stderr: string; curled: boolean } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mg-base-'))
  const stub = path.join(dir, 'curl')
  const called = path.join(dir, 'called')
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\necho "$@" > ${JSON.stringify(called)}\nprintf '%s' ${JSON.stringify(curl.stdout ?? '')}\nexit ${curl.code ?? 0}\n`,
  )
  chmodSync(stub, 0o755)
  const run = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CURL_BIN: stub, WORKER_URL: 'https://worker.example' },
  })
  let curled = false
  try {
    curled = readFileSync(called, 'utf8').includes('https://worker.example/')
  } catch {
    curled = false
  }
  return { base: run.stdout.trim(), status: run.status ?? -1, stderr: run.stderr, curled }
}

describe('money-gate-base on a push', () => {
  it('uses the commit main was at before the push, and asks the worker nothing', () => {
    const r = resolve(['push', SHA, '', ''])
    expect(r).toMatchObject({ base: SHA, status: 0, curled: false })
  })

  it('passes an empty before through, so money-gate.sh refuses it by its own name', () => {
    expect(resolve(['push', '', ''])).toMatchObject({ base: '', status: 0 })
  })
})

describe('money-gate-base on a dispatched run', () => {
  it('uses the money_gate_base input when one is given, and asks the worker nothing', () => {
    expect(resolve(['workflow_dispatch', '', SHA])).toMatchObject({ base: SHA, status: 0, curled: false })
  })

  it('refuses an input that is not a commit hash, naming it', () => {
    const r = resolve(['workflow_dispatch', '', 'main~3'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("'main~3'")
  })

  it('refuses a short hash by name, because the shallow checkout can only fetch a full one', () => {
    // verify-worker checks out at depth 1, so money-gate.sh fetches the base by
    // name, and `git fetch origin <short hash>` dies with "couldn't find remote
    // ref" (measured on a depth 1 clone of this repo) instead of a refusal that
    // says what to change. The short hash is what the GitHub UI shows.
    const r = resolve(['workflow_dispatch', '', '63d3cc3'])
    expect(r.status).toBe(1)
    expect(r.base).toBe('')
    expect(r.stderr).toContain("'63d3cc3'")
    expect(r.stderr).toMatch(/full 40 character commit hash/)
  })

  it('otherwise uses the commit the live worker reports', () => {
    const r = resolve(['workflow_dispatch', '', ''], { stdout: JSON.stringify({ version: LIVE }) })
    expect(r).toMatchObject({ base: LIVE, status: 0, curled: true })
  })

  it.each([
    ['an unstamped worker', JSON.stringify({ version: 'unknown' }), 0],
    ['a worker with no version field', JSON.stringify({ ok: true }), 0],
    ['a body that is not JSON', '<html>', 0],
    ['a worker that did not answer', '', 7],
  ])('refuses by name when the live worker gives no usable commit: %s', (_label, body, code) => {
    const r = resolve(['workflow_dispatch', '', ''], { stdout: body, code })
    expect(r.status).toBe(1)
    expect(r.base).toBe('')
    expect(r.stderr).toMatch(/::error::.*money_gate_base/)
  })

  it('refuses an event it does not know rather than guessing a base', () => {
    const r = resolve(['repository_dispatch', SHA, ''])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('repository_dispatch')
  })
})

describe('deploy.yml resolves the money gate base through the script (#1761)', () => {
  const step = () =>
    workflowStepBody(workflowJobBody(readWorkflow('.github/workflows/deploy.yml'), 'verify-worker'), 'Money gate')

  it('no longer hands money-gate.sh the bare push field, which is empty on a dispatch', () => {
    // The command line itself stays the one ci.yml runs (ci-main-push-coverage
    // compares them); what changes is where MONEY_GATE_BASE comes from.
    expect(step()).not.toMatch(/MONEY_GATE_BASE:\s*\$\{\{\s*github\.event\.before/)
    expect(step()).toMatch(/MONEY_GATE_BASE=\$\(bash \.github\/scripts\/money-gate-base\.sh [^\n]*\) \|\| exit 1\n/)
  })

  it('gives the script the event, the push field, the dispatch input and the worker address', () => {
    expect(step()).toContain('${{ github.event_name }}')
    expect(step()).toContain('${{ github.event.before }}')
    expect(step()).toContain('${{ inputs.money_gate_base }}')
    expect(step()).toContain('${{ vars.NEXT_PUBLIC_WORKER_URL }}')
  })
})
