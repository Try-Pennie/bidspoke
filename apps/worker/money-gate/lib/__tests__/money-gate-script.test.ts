/**
 * .github/scripts/money-gate.sh refuses a base it cannot compare against by name
 * (#1704). deploy.yml passes github.event.before, which is all zeros on the first
 * push of a branch and after some forced pushes; without this the script would
 * fail somewhere inside git fetch with a message about something else.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const script = join(repoRoot, '.github', 'scripts', 'money-gate.sh')

function run(...args: string[]) {
  const r = spawnSync('bash', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: '' } })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

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
