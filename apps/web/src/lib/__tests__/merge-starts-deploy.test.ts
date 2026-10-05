import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow, workflowFiles } from './_scan-utils'

/**
 * A merge made by a workflow must start Deploy itself (#1761).
 *
 * The Dependabot auto-merge merges with GITHUB_TOKEN, and GitHub starts no
 * workflow from a push made by that token. So no Deploy ran for any auto-merged
 * pull request (#700, #701, #807, #1046, #1615, #1756): on 2026-10-05 the worker,
 * the site and the tail worker stayed on the previous commit all night while
 * Deploy Drift reported all three every hour. A workflow_dispatch sent with
 * GITHUB_TOKEN is the documented exception that does start a run, so the merge
 * now goes through a script that dispatches Deploy on main once the merge has
 * verifiably landed.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/dependabot-merge-and-deploy.sh')
const MERGE_SHA = 'c'.repeat(40)
const PARENT_SHA = 'd'.repeat(40)

interface Stub {
  mergeExit?: number
  state?: string
  stateExit?: number
  parent?: string
  parentExit?: number
  runExit?: number
}

const run = (stub: Stub = {}): { status: number; calls: string[]; out: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'merge-deploy-'))
  const log = path.join(dir, 'calls')
  writeFileSync(log, '')
  const gh = path.join(dir, 'gh')
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> ${JSON.stringify(log)}`,
      'case "$1 $2" in',
      `  "pr merge") exit ${stub.mergeExit ?? 0} ;;`,
      `  "pr view") printf '%s\\n' ${JSON.stringify(`${stub.state ?? 'MERGED'} ${MERGE_SHA}`)}; exit ${stub.stateExit ?? 0} ;;`,
      `  "workflow run") exit ${stub.runExit ?? 0} ;;`,
      'esac',
      `if [ "$1" = "api" ]; then printf '%s\\n' ${JSON.stringify(stub.parent ?? PARENT_SHA)}; exit ${stub.parentExit ?? 0}; fi`,
      'exit 99',
      '',
    ].join('\n'),
  )
  chmodSync(gh, 0o755)
  const r = spawnSync('bash', [SCRIPT, 'Try-Pennie/bidspoke', '1756'], {
    encoding: 'utf8',
    env: { ...process.env, GH_BIN: gh },
  })
  return {
    status: r.status ?? -1,
    calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    out: r.stdout + r.stderr,
  }
}

const dispatchOf = (calls: string[]) => calls.find((c) => c.startsWith('workflow run'))

describe('dependabot-merge-and-deploy: the merge landed', () => {
  it('dispatches Deploy on main after the merge, naming the pull request', () => {
    const r = run()
    expect(r.status).toBe(0)
    expect(r.calls[0]).toMatch(/^pr merge 1756 --repo Try-Pennie\/bidspoke --squash --delete-branch/)
    expect(dispatchOf(r.calls)).toMatch(/^workflow run deploy\.yml --repo Try-Pennie\/bidspoke --ref main /)
    expect(dispatchOf(r.calls)).toContain('reason=auto-merge of #1756')
  })

  it('gives the money gate the commit main was at before the merge, which is what a push would have carried', () => {
    expect(dispatchOf(run().calls)).toContain(`money_gate_base=${PARENT_SHA}`)
  })

  it('still dispatches when the merge landed but gh reported a failure afterwards (a branch delete that failed)', () => {
    const r = run({ mergeExit: 1 })
    expect(r.status).toBe(0)
    expect(dispatchOf(r.calls)).toBeDefined()
    expect(r.out).toMatch(/::warning::/)
  })

  it('still dispatches when the parent commit cannot be read, leaving the money gate to use the live worker', () => {
    const r = run({ parentExit: 1 })
    expect(r.status).toBe(0)
    expect(dispatchOf(r.calls)).toBeDefined()
    expect(dispatchOf(r.calls)).not.toContain('money_gate_base')
  })
})

describe('dependabot-merge-and-deploy: the failure paths are loud', () => {
  it('fails the job when the dispatch is refused, so a merge that started no Deploy is never green', () => {
    const r = run({ runExit: 1 })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/::error::.*Deploy/)
  })

  it('fails and dispatches nothing when the merge did not land', () => {
    const r = run({ mergeExit: 1, state: 'OPEN' })
    expect(r.status).not.toBe(0)
    expect(dispatchOf(r.calls)).toBeUndefined()
    expect(r.out).toMatch(/::error::.*OPEN/)
  })

  it('fails when the merge command failed and the state cannot be read, rather than guessing', () => {
    const r = run({ mergeExit: 1, stateExit: 1 })
    expect(r.status).not.toBe(0)
    expect(dispatchOf(r.calls)).toBeUndefined()
  })
})

/** Workflow or script text with its comment lines removed: prose ABOUT a merge is not a merge (L103). */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

// `pr merge` rather than `gh pr merge`: a script calls gh through a seam (`"$GH_BIN" pr merge`).
const MERGES = /\bpr merge\b|\/pulls\/[^\s/]+\/merge\b/

const scripts = () =>
  readdirSync(path.join(REPO_ROOT, '.github/scripts'))
    .filter((f) => f.endsWith('.sh'))
    .map((f) => `.github/scripts/${f}`)

describe('no workflow merges a pull request without starting Deploy (#1761)', () => {
  it('finds the merging code at all, so the checks below cannot pass on nothing', () => {
    const merging = [...workflowFiles(), ...scripts()].filter((f) =>
      MERGES.test(code(readFileSync(path.join(REPO_ROOT, f), 'utf8'))),
    )
    expect(merging.length).toBeGreaterThan(0)
  })

  it('merges only inside a script that also dispatches Deploy on main, never inline in a workflow', () => {
    const inline = workflowFiles().filter((f) => MERGES.test(code(readWorkflow(f))))
    expect(inline, 'these workflows merge inline, where nothing guarantees a Deploy follows').toEqual([])

    for (const f of scripts()) {
      const text = code(readFileSync(path.join(REPO_ROOT, f), 'utf8'))
      if (!MERGES.test(text)) continue
      expect(text, `${f} merges without dispatching Deploy`).toMatch(/workflow run deploy\.yml\b[^\n]*--ref main/)
    }
  })

  it('grants actions: write to every workflow that runs a merging script, since the default token cannot dispatch', () => {
    const merging = scripts()
      .filter((f) => MERGES.test(code(readFileSync(path.join(REPO_ROOT, f), 'utf8'))))
      .map((f) => path.basename(f))
    const callers = workflowFiles().filter((wf) => merging.some((s) => code(readWorkflow(wf)).includes(s)))
    expect(callers.length).toBeGreaterThan(0)
    for (const wf of callers) {
      expect(code(readWorkflow(wf)), `${wf} cannot dispatch Deploy without it`).toMatch(/\n\s+actions:\s*write\b/)
    }
  })

  it('makes Deploy dispatchable, or every dispatch would be refused', () => {
    const deploy = readWorkflow('.github/workflows/deploy.yml')
    expect(deploy.slice(0, deploy.indexOf('\njobs:'))).toMatch(/\n {2}workflow_dispatch:/)
  })
})
