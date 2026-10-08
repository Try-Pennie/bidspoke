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
import { ABSENT_AT_BASE, ABSENT_AT_LIVE } from '../expected-changes'

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

  it('hands the verdict the live copy, or why it could not be read, only when given a worker address', () => {
    const text = readFileSync(script, 'utf8')
    expect(text).toContain('if [ -n "${MONEY_GATE_LIVE_WORKER_URL:-}" ]; then')
    expect(text).toContain('MONEY_GATE_EXPECTED_LIVE="$EXPECTED_LIVE"')
    expect(text).toContain(`EXPECTED_LIVE="${ABSENT_AT_LIVE}"`)
  })

  it('the pull request job passes the worker address, and Deploy never does, so a deploy cannot fail on housekeeping', () => {
    expect(workflow('ci.yml')).toContain('MONEY_GATE_LIVE_WORKER_URL: ${{ vars.NEXT_PUBLIC_WORKER_URL }}')
    expect(workflow('deploy.yml')).not.toContain('MONEY_GATE_LIVE_WORKER_URL')
  })
})
