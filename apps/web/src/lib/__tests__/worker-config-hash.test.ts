import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The deploy-time configuration hash (#1420).
 *
 * `dist/index.js` is not the whole of what a worker deploy changes: wrangler.toml
 * carries `[vars]`, `[triggers]` crons, `[limits]` and every binding, and the
 * deploy APPLIES them. None of it reaches the bundle, so the artifact gate was
 * blind to all of it and skipped the deploy that would have shipped it, behind a
 * green pipeline. Measured 2026-09-21 on #1404.
 *
 * This hash is the second dimension. It must move for every setting and hold
 * still for prose, because the gate's cost of a false move is a needless redeploy
 * of the live bidding engine, and the cost of a false hold is a change that never
 * ships and says nothing.
 */
const script = path.join(REPO_ROOT, '.github/scripts/worker-config-hash.sh')

/** Run the script against a throwaway tree holding just the given wrangler.toml. */
function hashOf(toml: string): { hash: string; status: number; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'wconf-'))
  mkdirSync(path.join(dir, 'apps/worker'), { recursive: true })
  writeFileSync(path.join(dir, 'apps/worker/wrangler.toml'), toml)
  const res = spawnSync('bash', [script], { cwd: dir, encoding: 'utf8' })
  return { hash: (res.stdout ?? '').trim(), status: res.status ?? -1, stderr: (res.stderr ?? '').trim() }
}

const BASE = `name = "bidspoke-worker"
main = "src/index.ts"

[vars]
PARTNER_PROBE_ALERTS = "off"
APP_URL = "https://app.example"

[triggers]
crons = ["*/5 * * * *", "* * * * *"]

[limits]
cpu_ms = 30000
`

describe('worker-config-hash: moves for every setting a deploy applies (#1420)', () => {
  it('is deterministic for the same input', () => {
    expect(hashOf(BASE).hash).toBe(hashOf(BASE).hash)
  })

  it('returns a sha256, so it can be compared as a hash', () => {
    expect(hashOf(BASE).hash).toMatch(/^[0-9a-f]{64}$/)
  })

  // The case that shipped nothing on 2026-09-21.
  it('moves when a var changes', () => {
    const flipped = BASE.replace('PARTNER_PROBE_ALERTS = "off"', 'PARTNER_PROBE_ALERTS = "on"')
    expect(hashOf(flipped).hash).not.toBe(hashOf(BASE).hash)
  })

  it('moves when a cron schedule changes', () => {
    const extra = BASE.replace('"*/5 * * * *", "* * * * *"', '"*/5 * * * *", "* * * * *", "0 4 * * *"')
    expect(hashOf(extra).hash).not.toBe(hashOf(BASE).hash)
  })

  it('moves when a limit changes', () => {
    expect(hashOf(BASE.replace('cpu_ms = 30000', 'cpu_ms = 50000')).hash).not.toBe(hashOf(BASE).hash)
  })

  it('moves when a binding is added', () => {
    expect(hashOf(BASE + '\n[[kv_namespaces]]\nbinding = "NEW"\nid = "abc"\n').hash).not.toBe(hashOf(BASE).hash)
  })

  it('holds still for a comment, so prose does not redeploy the live engine', () => {
    const commented = BASE.replace('[vars]', '# why this exists, at length\n[vars]')
    expect(hashOf(commented).hash).toBe(hashOf(BASE).hash)
  })

  it('holds still for blank lines', () => {
    expect(hashOf(BASE.replace('[vars]', '\n\n[vars]')).hash).toBe(hashOf(BASE).hash)
  })

  // Fail-safe direction, matching the gate it feeds: an unreadable input must
  // not produce a hash that could match, it must produce nothing and let the
  // decision script deploy (L42).
  it('prints nothing and fails when wrangler.toml is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wconf-empty-'))
    const res = spawnSync('bash', [script], { cwd: dir, encoding: 'utf8' })
    expect((res.stdout ?? '').trim()).toBe('')
    expect(res.status).not.toBe(0)
  })
})

describe('worker-config-hash: reads the real file (#1420)', () => {
  it('hashes the checked-in wrangler.toml without error', () => {
    const res = spawnSync('bash', [script], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(res.status, res.stderr).toBe(0)
    expect((res.stdout ?? '').trim()).toMatch(/^[0-9a-f]{64}$/)
  })

  // The value the probe flip turned on must be inside what this hash covers,
  // or the gate would still be blind to the change that exposed all this.
  it('covers the section the probe alert switch lives in', () => {
    const toml = readFileSync(path.join(REPO_ROOT, 'apps/worker/wrangler.toml'), 'utf8')
    expect(toml).toMatch(/^PARTNER_PROBE_ALERTS\s*=/m)
    const withoutIt = toml.replace(/^PARTNER_PROBE_ALERTS\s*=.*$/m, 'PARTNER_PROBE_ALERTS = "off"')
    expect(withoutIt).not.toBe(toml)
  })
})
