/**
 * GET /api/admin/ops-connections-probe (#2335, PR 9 of phase 5 of #1689): the
 * deploy's real call through the OPS_CONNECTIONS binding. Deploy runs it after
 * the Workers deploy (.github/scripts/ops-connections-probe.mjs) and fails the
 * run unless it answers 200, because Cloudflare deploys a binding to an
 * entrypoint ops does not export green, and every call then throws (#2330).
 *
 * What matters: a signed in caller only; the call is the probe's health
 * request, which ops refuses by name before reading anything, so the route
 * touches no table but the sign in check; and each outcome is its own status:
 * 200 answered as expected, 503 ops_connections_unavailable (with the
 * reference id of a throw), 502 answered something else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import { OPS_CONNECTIONS_METHODS, type OpsConnectionsBinding } from '../../../lib/ops-connections-contract'
import { OPS_CONNECTIONS_PROBE_REQUEST } from '../../../lib/ops-connections-client'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'

const USER_ID = '3b4b7f61-2a51-4c2e-9d55-0c7d3c1b9e01'
const ORG_ID = '8d0f5a1c-6e2b-4b0a-a7c4-5f9e3d2c1b00'
const testUser = { id: USER_ID, organization_id: ORG_ID, email: 'dan@pennie.com' }
const validPayload = { sub: USER_ID, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const mockCtx = recordingContext()

/** Answers only the sign in check, and records every other table or function reached. */
function databaseDouble() {
  const touched: string[] = []
  const table = (name: string) => new Proxy({}, { get: (_t, op) => { touched.push(`${String(op)} ${name}`); return () => Promise.resolve({ data: null, error: { message: 'unexpected' } }) } })
  const client = {
    from: (name: string) => table(name),
    rpc(name: string) {
      if (name === 'auth_user_with_allowlist') return Promise.resolve({ data: [{ ...testUser, allowed: true }], error: null })
      touched.push(`rpc ${name}`)
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } })
    },
  }
  return { client, touched }
}

function binding(answer: (method: string, request: unknown) => Promise<unknown>) {
  const calls: Array<{ method: string; request: unknown }> = []
  const methods = Object.fromEntries(OPS_CONNECTIONS_METHODS.map((m) => [m, (request: unknown) => { calls.push({ method: m, request }); return answer(m, request) }]))
  return { binding: methods as unknown as OpsConnectionsBinding, calls }
}

const refusedInvalid = async () => ({ ok: false, refused: 'ops_connections_request_invalid', detail: "the request's organization_id is not a uuid", retry_at: null })

describe('GET /admin/ops-connections-probe (#2335)', () => {
  let db: ReturnType<typeof databaseDouble>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    db = databaseDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db.client as unknown as ReturnType<typeof createSupabaseClient>)
  })

  const get = async (opsConnections: OpsConnectionsBinding | undefined, headers: Record<string, string> = { Authorization: 'Bearer tok' }) => {
    const { default: api } = await import('../index')
    const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', ...(opsConnections ? { OPS_CONNECTIONS: opsConnections } : {}) } as unknown as Env
    return api.request('/admin/ops-connections-probe', { method: 'GET', headers }, env, mockCtx)
  }

  it('refuses a caller with no token, calling nothing', async () => {
    const { binding: b, calls } = binding(refusedInvalid)
    const res = await get(b, {})
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('answers 200 when ops refuses the probe request by name, having sent health only that request and touched no table', async () => {
    const { binding: b, calls } = binding(refusedInvalid)
    const res = await get(b)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, method: 'health', answer: 'ops_connections_request_invalid' })
    expect(calls).toEqual([{ method: 'health', request: OPS_CONNECTIONS_PROBE_REQUEST }])
    expect(db.touched).toEqual([])
  })

  it('answers 503 ops_connections_unavailable with the reference id when the binding throws', async () => {
    const { binding: b } = binding(async () => { throw new Error('internal error; reference = 5c4b3a29180f') })
    const res = await get(b)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'ops_connections_unavailable', cause: 'threw', reference: '5c4b3a29180f' })
  })

  it('answers 503 naming an absent binding', async () => {
    const res = await get(undefined)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'ops_connections_unavailable', cause: 'binding_absent', reference: null })
  })

  it('answers 502 naming the code when ops answers anything else', async () => {
    const { binding: b } = binding(async () => ({ ok: false, refused: 'lane_not_ops', detail: 'x', retry_at: null }))
    const res = await get(b)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'ops_connections_probe_unexpected', answer: 'lane_not_ops' })
  })
})
