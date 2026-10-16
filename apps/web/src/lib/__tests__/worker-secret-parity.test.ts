import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'
import { accountIdFrom, listSecretNames, parityVerdict } from '../../../../../.github/scripts/worker-secret-parity.mjs'
import { OPS_ALLOWED_SECRETS, OPS_REQUIRED_SECRETS, REQUIRED_PARTNER_SECRETS, REQUIRED_SECRETS } from '../../../../worker/src/lib/secret-lists'

/**
 * Worker secret parity (#1709, plan 0.E): the money Worker holds every secret it
 * requires, and the ops Worker holds nothing outside its allowlist, above all no
 * money only secret.
 */

const MONEY_ALL = [...REQUIRED_SECRETS, ...REQUIRED_PARTNER_SECRETS]
const lists = { moneyRequired: MONEY_ALL, opsRequired: ['PORTING_CAPTURE_MASTER'], opsAllowed: ['PORTING_CAPTURE_MASTER'] }

function fakeFetch(answers: Record<string, () => Response>) {
  const calls: string[] = []
  const f = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push(url)
    const key = Object.keys(answers).find((k) => url.includes(k))
    return key ? answers[key]() : new Response('no stub', { status: 599 })
  }) as typeof fetch
  return { f, calls }
}

describe('listSecretNames (#1709)', () => {
  it('reads the names of a script\'s secrets from the Cloudflare API', async () => {
    const { f, calls } = fakeFetch({ '/scripts/bidspoke-worker/secrets': () => Response.json({ success: true, result: [{ name: 'B', type: 'secret_text' }, { name: 'A', type: 'secret_text' }] }) })
    expect(await listSecretNames(f, 'tok', 'acct', 'bidspoke-worker')).toEqual({ deployed: true, names: ['A', 'B'] })
    expect(calls[0]).toBe('https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/bidspoke-worker/secrets')
  })

  it('reports a script that does not exist as not deployed, by Cloudflare\'s own error code', async () => {
    const { f } = fakeFetch({ '/secrets': () => Response.json({ success: false, errors: [{ code: 10007, message: 'This Worker does not exist on your account.' }] }, { status: 404 }) })
    expect(await listSecretNames(f, 'tok', 'acct', 'bidspoke-worker-ops')).toEqual({ deployed: false, names: [] })
  })

  it('throws on any other failure rather than reading it as no secrets', async () => {
    const { f } = fakeFetch({ '/secrets': () => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 }) })
    await expect(listSecretNames(f, 'tok', 'acct', 'bidspoke-worker')).rejects.toThrow(/bidspoke-worker.*403.*Authentication error/)
  })
})

describe('parityVerdict (#1709)', () => {
  it('passes when money holds every required secret and ops only its allowlist', () => {
    const v = parityVerdict({ deployed: true, names: [...MONEY_ALL, 'GIGFI_API_KEY'] }, { deployed: true, names: ['PORTING_CAPTURE_MASTER'] }, lists, true)
    expect(v.ok).toBe(true)
    expect(v.lines).toEqual([
      `bidspoke-worker: ${MONEY_ALL.length + 1} secret(s), every required one present`,
      'bidspoke-worker-ops: 1 secret(s), all allowed, every required one present',
    ])
  })

  it('fails naming a required secret missing from the money Worker', () => {
    const v = parityVerdict({ deployed: true, names: MONEY_ALL.filter((n) => n !== 'SSN_HASH_PEPPER') }, { deployed: true, names: ['PORTING_CAPTURE_MASTER'] }, lists, true)
    expect(v.ok).toBe(false)
    expect(v.lines.join('\n')).toMatch(/bidspoke-worker: missing required SSN_HASH_PEPPER/)
  })

  it('fails naming a money only secret found on the ops Worker', () => {
    const v = parityVerdict({ deployed: true, names: MONEY_ALL }, { deployed: true, names: ['PORTING_CAPTURE_MASTER', 'SECRET_ENCRYPTION_KEY', 'SOMETHING_NEW'] }, lists, true)
    expect(v.ok).toBe(false)
    const text = v.lines.join('\n')
    expect(text).toMatch(/bidspoke-worker-ops: holds SECRET_ENCRYPTION_KEY, a money Worker secret/)
    expect(text).toMatch(/bidspoke-worker-ops: holds SOMETHING_NEW, which its allowlist does not name/)
  })

  it('fails naming a required secret missing from the ops Worker', () => {
    const v = parityVerdict({ deployed: true, names: MONEY_ALL }, { deployed: true, names: [] }, lists, true)
    expect(v.ok).toBe(false)
    expect(v.lines.join('\n')).toMatch(/bidspoke-worker-ops: missing required PORTING_CAPTURE_MASTER/)
  })

  it('reports an undeployed ops Worker as not measured while it is not meant to exist yet', () => {
    const v = parityVerdict({ deployed: true, names: MONEY_ALL }, { deployed: false, names: [] }, lists, false)
    expect(v.ok).toBe(true)
    expect(v.lines.at(-1)).toBe('bidspoke-worker-ops: NOT MEASURED, not deployed yet (OPS_WORKER_DEPLOYED is false)')
  })

  it('fails on a missing ops Worker once it is meant to be deployed', () => {
    const v = parityVerdict({ deployed: true, names: MONEY_ALL }, { deployed: false, names: [] }, lists, true)
    expect(v.ok).toBe(false)
    expect(v.lines.at(-1)).toMatch(/bidspoke-worker-ops: not deployed, but OPS_WORKER_DEPLOYED says it is/)
  })

  it('fails on a missing money Worker whatever else is true', () => {
    expect(parityVerdict({ deployed: false, names: [] }, { deployed: false, names: [] }, lists, false).ok).toBe(false)
  })
})

describe('the committed lists (#1709)', () => {
  it('allow no money Worker secret on the ops Worker', () => {
    expect(OPS_ALLOWED_SECRETS.filter((n) => (MONEY_ALL as readonly string[]).includes(n))).toEqual([])
  })

  it('allow the ops database secrets on the ops Worker without requiring them, since nothing reads them before Phase 1 (#1709 part 3)', () => {
    expect(OPS_ALLOWED_SECRETS).toEqual(expect.arrayContaining(['OPS_SUPABASE_URL', 'OPS_SUPABASE_SECRET_KEY']))
    expect(OPS_REQUIRED_SECRETS).not.toContain('OPS_SUPABASE_URL')
    expect(OPS_REQUIRED_SECRETS).not.toContain('OPS_SUPABASE_SECRET_KEY')
    // Every required ops secret is allowed, or parity would fail a Worker for holding it.
    for (const name of OPS_REQUIRED_SECRETS) expect(OPS_ALLOWED_SECRETS).toContain(name)
  })

  it('no longer allow Spike 0\'s arm on the ops Worker, whose probes are removed (#1946)', () => {
    expect(OPS_ALLOWED_SECRETS).not.toContain('OPS_SPIKE_ARM')
  })

  it('reads the account id from the money Worker\'s wrangler.toml', () => {
    expect(accountIdFrom('name = "x"\naccount_id = "3e7f907a9c19e51417873e2cce4fbc5c"\n')).toBe('3e7f907a9c19e51417873e2cce4fbc5c')
    expect(() => accountIdFrom('name = "x"\n')).toThrow(/account_id/)
  })
})

describe('the script as CI runs it (#1709)', () => {
  it('runs when started by a relative path, and fails by name with no token (L98)', () => {
    const r = spawnSync('node', ['.github/scripts/worker-secret-parity.mjs'], { cwd: REPO_ROOT, env: { ...process.env, CLOUDFLARE_API_TOKEN: '' }, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/CLOUDFLARE_API_TOKEN is not set, so nothing was checked/)
  })
})
