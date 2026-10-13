/**
 * POST /api/admin/run-strand-recovery: stranded lead recovery now, rather than
 * at the next :27 or :57 pg_cron run (#380).
 *
 * The route calls the SAME function the cron calls, so a run proves the cron's
 * code. Measured 2026-10-13 over the 7 days before: the 30 minute job (lookback
 * 1) averaged 2.3 s and peaked at 22.9 s, the daily deep job (lookback 8) peaked
 * at 7.5 s, so a call fits the worker's 30 s database budget on an ordinary day
 * and the route says so plainly when it does not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/audit')>()
  return { ...actual, writeAuditLog: vi.fn().mockResolvedValue(undefined) }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

type RpcAnswer = { data: unknown; error: { code?: string; message: string } | null }

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function post(app: Awaited<ReturnType<typeof makeApp>>, body?: unknown, headers: Record<string, string> = { Authorization: 'Bearer tok' }) {
  return app.request(
    '/admin/run-strand-recovery',
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
    testEnv,
    mockCtx,
  )
}

function makeSupabase(answer: RpcAnswer) {
  const calls: Array<{ name: string; args: unknown }> = []
  const client = {
    from: () => ({}) as Record<string, unknown>,
    rpc: (name: string, args?: unknown) => {
      if (name === 'auth_user_with_allowlist') return Promise.resolve({ data: [{ ...testUser, allowed: true }], error: null })
      calls.push({ name, args })
      return Promise.resolve(answer)
    },
  }
  return { client, calls }
}

describe('POST /admin/run-strand-recovery', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  function answering(answer: RpcAnswer) {
    const sb = makeSupabase(answer)
    vi.mocked(createSupabaseClient).mockReturnValue(sb.client as unknown as ReturnType<typeof createSupabaseClient>)
    return sb
  }

  it('refuses a caller with no token, running nothing', async () => {
    const sb = answering({ data: 3, error: null })
    const res = await post(app, undefined, {})
    expect(res.status).toBe(401)
    expect(sb.calls).toEqual([])
  })

  it('runs the cron\'s own recovery over the last day and says how many leads it recovered', async () => {
    const sb = answering({ data: 3, error: null })
    const res = await post(app)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, recovered: 3, lookbackDays: 1, scope: 'every organization' })
    expect(sb.calls).toEqual([{ name: 'reduce_finalize_stranded', args: { p_lookback_days: 1 } }])
  })

  it('reaches back as far as the daily deep run when asked', async () => {
    const sb = answering({ data: 0, error: null })
    const res = await post(app, { lookbackDays: 8 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, recovered: 0, lookbackDays: 8, scope: 'every organization' })
    expect(sb.calls[0].args).toEqual({ p_lookback_days: 8 })
  })

  it('reads a body of JSON null as no body, running the default rather than failing', async () => {
    const sb = answering({ data: 2, error: null })
    const res = await post(app, null)
    expect(res.status).toBe(200)
    expect(sb.calls[0].args).toEqual({ p_lookback_days: 1 })
  })

  it('says the run covers every organization', async () => {
    answering({ data: 2, error: null })
    const res = await post(app)
    expect(((await res.json()) as { scope: string }).scope).toBe('every organization')
  })

  it.each([0, 9, 2.5, '3', null])('refuses a lookback of %j without running anything', async (lookbackDays) => {
    const sb = answering({ data: 0, error: null })
    const res = await post(app, { lookbackDays })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/whole number of days from 1 to 8/)
    expect(sb.calls).toEqual([])
  })

  it('records who ran it and what it recovered in the audit log', async () => {
    answering({ data: 4, error: null })
    await post(app)
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(), 'org-abc', 'strand_recovery', 'reduce_finalize_stranded', 'strand_recovery_run', 'dan@pennie.com',
      // The function takes no organization: it recovers every org's leads, as the
      // scheduled job does, and the record says so rather than reading as this org's.
      { lookback_days: 1, recovered: 4, scope: 'every organization' },
    )
  })

  it('says the run was cancelled, and that nothing was kept, when it outruns the database budget', async () => {
    answering({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const res = await post(app)
    expect(res.status).toBe(504)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/30 seconds/)
    expect(body.error).toMatch(/nothing it changed was kept/)
    expect(body.error).toMatch(/:27 and :57/)
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('fails loudly on any other database error', async () => {
    answering({ data: null, error: { code: '42501', message: 'permission denied for function reduce_finalize_stranded' } })
    const res = await post(app)
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toMatch(/permission denied/)
  })

  it('refuses an answer that is not a count rather than reporting it as zero', async () => {
    answering({ data: null, error: null })
    const res = await post(app)
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toMatch(/did not say how many/)
  })
})
