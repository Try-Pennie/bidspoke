import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

/**
 * The ops host proof (#1709 part 4). After Deploy Ops Worker, one POST to an
 * unknown workflow's capture address must be answered by the ops Worker (its
 * identity header), with its lane right and its master secret set (404
 * unknown_workflow, which stores nothing). The probe is stubbed here: each
 * stub answer is `<status>\t<identity header or empty>\t<body>`, one per line,
 * served in turn.
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/prove-ops-host.sh')

function run(answers: string[], attempts = 3) {
  const dir = mkdtempSync(path.join(tmpdir(), 'prove-ops-'))
  const queue = path.join(dir, 'answers')
  writeFileSync(queue, answers.join('\n') + '\n')
  const stub = path.join(dir, 'probe.sh')
  writeFileSync(stub, `#!/usr/bin/env bash\nline=$(head -n 1 "${queue}")\ntail -n +2 "${queue}" > "${queue}.next" && mv "${queue}.next" "${queue}"\nprintf '%s' "$line"\n`)
  chmodSync(stub, 0o755)
  const slept = path.join(dir, 'slept')
  writeFileSync(slept, '')
  const sleeper = path.join(dir, 'sleep.sh')
  writeFileSync(sleeper, `#!/usr/bin/env bash\necho "$1" >> "${slept}"\n`)
  chmodSync(sleeper, 0o755)
  const r = spawnSync('bash', [SCRIPT, 'https://ops.example/porting/capture/p_deployproof'], {
    env: { ...process.env, PROVE_PROBE: stub, PROVE_SLEEP: sleeper, PROVE_ATTEMPTS: String(attempts) },
    encoding: 'utf8',
  })
  return { status: r.status, out: r.stdout + r.stderr, sleeps: readFileSync(slept, 'utf8').trim().split('\n').filter(Boolean) }
}

const OK = '404\tops\t{"error":"unknown_workflow"}'

describe('prove-ops-host.sh (#1709)', () => {
  it('passes when the ops Worker answers unknown_workflow with its identity header', () => {
    const r = run([OK])
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/ops Worker answered .* lane ops, master secret set/)
    expect(r.sleeps).toEqual([])
  })

  it('waits and asks again while the host is still answered by something else, then passes', () => {
    const r = run(['403\t\t{}', OK])
    expect(r.status).toBe(0)
    expect(r.sleeps).toEqual(['10'])
  })

  it('fails by name when the host never reaches the ops Worker', () => {
    const r = run(['403\t\t{}', '403\t\t{}', '403\t\t{}'])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::.*not answered by the ops Worker after 3 attempt/)
  })

  it('fails by name when the ops Worker answers but its master secret is unset', () => {
    const r = run(['503\tops\t{"error":"master_secret_unset"}', '503\tops\t{"error":"master_secret_unset"}', '503\tops\t{"error":"master_secret_unset"}'])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::.*master_secret_unset/)
  })

  it('fails by name when the ops Worker refuses its lane', () => {
    const r = run(['503\tops\t{"error":"lane_not_ops","lane":"money"}', '503\tops\t{"error":"lane_not_ops","lane":"money"}', '503\tops\t{"error":"lane_not_ops","lane":"money"}'])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/::error::.*lane_not_ops/)
  })

  it('refuses to run with no address rather than passing on nothing (L98)', () => {
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/usage/)
  })

  it('checks for the header the ops Worker sets', () => {
    const code = readFileSync(path.join(REPO_ROOT, 'apps/worker/src/ops/index.ts'), 'utf8')
    const script = readFileSync(SCRIPT, 'utf8')
    const header = /export const OPS_IDENTITY_HEADER = '([^']+)'/.exec(code)?.[1]
    expect(header).toBeTruthy()
    expect(script).toContain(`HEADER=${header}`)
  })
})
