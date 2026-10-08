/**
 * .github/scripts/money-gate.sh refuses a base it cannot compare against by name
 * (#1704). deploy.yml passes github.event.before, which is all zeros on the first
 * push of a branch and after some forced pushes; without this the script would
 * fail somewhere inside git fetch with a message about something else.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ABSENT_AT_BASE } from '../expected-changes'
import { gateVerdict } from '../verdict'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const script = join(repoRoot, '.github', 'scripts', 'money-gate.sh')

function run(...args: string[]) {
  const r = spawnSync('bash', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: '' } })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('money-gate.sh hands the verdict the merge base expected-changes.json', () => {
  it('uses the same absent marker the verdict honours, and decides absence from git', () => {
    const text = readFileSync(script, 'utf8')
    expect(text).toContain(`EXPECTED_BASE="${ABSENT_AT_BASE}"`)
    expect(text).toMatch(/git ls-tree --name-only "\$BASE" -- "\$EXPECTED_PATH"/)
    expect(text).toContain('MONEY_GATE_EXPECTED_BASE="$EXPECTED_BASE"')
  })
})

describe('money-gate.sh refuses a base it cannot use', () => {
  it('refuses an all zeros base by name, before touching git', () => {
    const r = run('0000000000000000000000000000000000000000')
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('the base commit is all zeros')
    expect(r.out).not.toMatch(/fatal:|worktree/)
  })

  it('refuses a missing base by name', () => {
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('no base commit was given')
  })
})

describe('only a pull request asks the live worker about leftover entries (#1836)', () => {
  const workflow = (name: string) => readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8')

  it('hands the verdict what money-gate-live-expected.sh read, whose outcomes live-expected-script.test.ts runs (#1921)', () => {
    const text = readFileSync(script, 'utf8')
    expect(text).toContain('LIVE_READ="$(bash "$ROOT/.github/scripts/money-gate-live-expected.sh" "$WORK")"')
    expect(text).toContain('MONEY_GATE_EXPECTED_LIVE="$EXPECTED_LIVE" MONEY_GATE_LIVE_COMMIT="$LIVE_COMMIT"')
  })

  it('the pull request job passes the worker address, and Deploy never does, so a deploy cannot fail on housekeeping', () => {
    expect(workflow('ci.yml')).toContain('MONEY_GATE_LIVE_WORKER_URL: ${{ vars.NEXT_PUBLIC_WORKER_URL }}')
    expect(workflow('deploy.yml')).not.toContain('MONEY_GATE_LIVE_WORKER_URL')
  })
})

describe('the failure annotation names a shipped leftover entry (#1836)', () => {
  it('the pattern money-gate.sh annotates with matches the line the verdict prints for it', () => {
    const text = readFileSync(script, 'utf8')
    const pattern = /reason="\$\(grep -m1 -E '([^']+)'/.exec(text)?.[1]
    expect(pattern, 'money-gate.sh no longer picks its annotation with grep -m1 -E').toBeDefined()
    const entry = { workflow: 'W', check: 'route', node: 'b', field: 'route', reason: 'An older change' }
    const file = JSON.stringify({ entries: [entry] })
    const fixture = { id: 'W/x', workflow_id: 'w', workflow_name: 'W', variant: 'x', run_kind: 'live' as const, trigger: {}, routes: [], nodes_executed: ['a'], final_node: 'a', response: { status: 200, body: {} }, outbound: [], code_dispatch: [], supabase_writes: [], do_state: {}, kv_state: {} }
    const kinds = (['live', 'test', 'shadow_dry_run'] as const).map((k) => ({ ...fixture, id: `W/x ${k}`, run_kind: k }))
    const t = (side: 'base' | 'head') => ({ version: 1 as const, side, fixtures: kinds, workflows: [{ workflow_id: 'w', workflow_name: 'W', nodes: ['a'], arms: [] }], unstubbed_hosts: [], unknown_tables: [] })
    const v = gateVerdict({ base: t('base'), head: t('head'), shapesExportedAt: '2026-10-01T00:00:00Z', now: new Date('2026-10-02T00:00:00Z'), committedDefinitionIds: ['w'], expectedHead: file, expectedBase: file, expectedLive: { commit: 'a'.repeat(40), text: file } })
    expect(v.exitCode).toBe(1)
    const failureLines = v.output.split('\n').filter((l) => l.startsWith('money gate: ') && l.includes('live worker'))
    expect(failureLines).toHaveLength(1)
    expect(new RegExp(pattern!).test(failureLines[0]), `annotation pattern misses: ${failureLines[0]}`).toBe(true)
  })
})
