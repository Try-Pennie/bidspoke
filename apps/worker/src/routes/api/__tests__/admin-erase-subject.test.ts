/**
 * POST /api/admin/erase-subject (#875, Phase A7).
 *
 * Moving from a 7 day truncate to a 13 month archive multiplies the SSN
 * exposure window by roughly 56x, and the truncate was the only control. This
 * route is the control that replaces it.
 *
 * The erasure itself is covered against its stores in
 * `lib/__tests__/archive-erasure.test.ts`. What is covered here is what only the
 * route decides: what the caller is told, and what is written down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/archive-erasure')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { eraseSubject } from '../../../lib/archive-erasure'
import { writeAuditLog } from '../../../lib/audit'

const SSN = '123-45-6789'
const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@trypennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@trypennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', SSN_HASH_PEPPER: 'pepper' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const ERASED = {
  verdict: { status: 'erased', totalRows: 9 },
  outcomes: [{ target: 'execution_archive', rowsDeleted: 9, error: null }],
  summary: '9 rows removed from the live tables',
  executionIds: ['e-1'],
}

function makeSupabase() {
  return {
    from: () => ({}),
    rpc: (name: string) =>
      name === 'auth_user_with_allowlist'
        ? Promise.resolve({ data: [{ ...testUser, allowed: true }], error: null })
        : Promise.resolve({ data: [], error: null }),
  }
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function post(app: { request: Function }, body: Record<string, unknown>, env: Env = testEnv) {
  return app.request(
    '/admin/erase-subject',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
    mockCtx
  )
}

// These were written when every call to this route deleted. The route now
// previews unless told otherwise (#823), so they pass dryRun: false explicitly
// rather than silently testing a preview under names that say "erases".
describe('POST /admin/erase-subject', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase() as unknown as ReturnType<typeof createSupabaseClient>
    )
    vi.mocked(eraseSubject).mockResolvedValue(ERASED as unknown as Awaited<ReturnType<typeof eraseSubject>>)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('erases, and returns what was measured per target', async () => {
    const res = await post(app, { ssn: SSN, reason: 'subject request', dryRun: false })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('erased')
    expect(body.outcomes).toEqual(ERASED.outcomes)
  })

  it('never records the SSN, only its peppered hash', async () => {
    // The audit row has to identify the request without storing the value it is
    // about (L19). A row carrying the SSN would put it back in Postgres, in a
    // table nothing in this milestone purges.
    await post(app, { ssn: SSN, reason: 'subject request', dryRun: false })

    const call = vi.mocked(writeAuditLog).mock.calls[0]
    const serialised = JSON.stringify(call)
    expect(serialised).not.toContain('123-45-6789')
    expect(serialised).not.toContain('123456789')
    expect(call[2]).toBe('archive_erasure')
    expect(call[4]).toBe('subject_erased')
  })

  it('answers 500 on a partial erasure, because the identity survives somewhere', async () => {
    // Reporting success would close the matter, which ADR 0009 calls out as
    // worse than not trying.
    vi.mocked(eraseSubject).mockResolvedValue({
      ...ERASED,
      verdict: { status: 'partial', failed: ['lead_sightings'], succeeded: ['execution_archive'] },
      summary: 'PARTIAL: lead_sightings failed',
    } as unknown as Awaited<ReturnType<typeof eraseSubject>>)

    const res = await post(app, { ssn: SSN, reason: 'subject request', dryRun: false })

    expect(res.status).toBe(500)
    expect((await res.json() as { status: string }).status).toBe('partial')
  })

  it('answers 200 but never "erased" when nothing matched', async () => {
    // Telling a subject their data is gone when nothing was found is the exact
    // failure this phase exists to avoid. The operation ran correctly, so it is
    // not an error, and it does not claim an erasure either.
    vi.mocked(eraseSubject).mockResolvedValue({
      ...ERASED,
      verdict: { status: 'no-rows-matched' },
      summary: 'no rows matched in any target',
    } as unknown as Awaited<ReturnType<typeof eraseSubject>>)

    const res = await post(app, { ssn: SSN, reason: 'subject request', dryRun: false })

    expect(res.status).toBe(200)
    expect((await res.json() as { status: string }).status).toBe('no-rows-matched')
  })

  it('records the erasure even when it matched nothing', async () => {
    // The attempt is the auditable event. A request that found nothing still has
    // to be answerable months later (L47).
    vi.mocked(eraseSubject).mockResolvedValue({
      ...ERASED,
      verdict: { status: 'no-rows-matched' },
      executionIds: [],
    } as unknown as Awaited<ReturnType<typeof eraseSubject>>)

    await post(app, { ssn: SSN, reason: 'subject request', dryRun: false })

    expect(writeAuditLog).toHaveBeenCalledTimes(1)
  })

  it('refuses a request with no reason, without erasing anything', async () => {
    // An erasure with no stated reason leaves a ledger row nobody can account
    // for, and that ledger is what the deletion gate subtracts against.
    const res = await post(app, { ssn: SSN })

    expect(res.status).toBe(400)
    expect(eraseSubject).not.toHaveBeenCalled()
  })

  it('refuses anything that is not a nine digit SSN', async () => {
    for (const ssn of ['12345', '', 'not-an-ssn', '1234567890']) {
      const res = await post(app, { ssn, reason: 'subject request' })
      expect(res.status, `"${ssn}" was accepted`).toBe(400)
    }
    expect(eraseSubject).not.toHaveBeenCalled()
  })

  it('refuses to run at all without the pepper, rather than covering less than it claims', async () => {
    // Without it the secondary resolver is absent, so the erasure would silently
    // miss every execution whose sighting row has already been purged.
    const res = await post(app, { ssn: SSN, reason: 'subject request', dryRun: false }, {
      SUPABASE_JWKS_URL: 'https://fake.jwks',
    } as unknown as Env)

    expect(res.status).toBe(503)
    expect(eraseSubject).not.toHaveBeenCalled()
  })

  it('requires a valid token like every other admin route', async () => {
    vi.mocked(verifyJwt).mockRejectedValue(new Error('bad token'))

    const res = await post(app, { ssn: SSN, reason: 'subject request', dryRun: false })

    expect(res.status).toBe(401)
    expect(eraseSubject).not.toHaveBeenCalled()
  })

  it('scopes the erasure to the caller\'s own organization', async () => {
    await post(app, { ssn: SSN, reason: 'subject request', dryRun: false })

    const request = vi.mocked(eraseSubject).mock.calls[0][2]
    expect(request.organizationId).toBe('org-abc')
  })
})

// #823. Erasure DELETES (Dan, 2026-09-09) and this route is the only way to
// invoke it, so the dry run has to be reachable from here or it does not exist
// in practice. The default is the SAFE one: forgetting the flag must preview,
// never destroy, because a gate's default has to be its off value (L72).
describe('POST /admin/erase-subject dry run', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase() as never)
    vi.mocked(eraseSubject).mockResolvedValue(ERASED as never)
    app = await makeApp()
  })

  it('previews by default, so a caller who forgets the flag deletes nothing', async () => {
    await post(app, { ssn: SSN, reason: 'subject request' })
    expect(vi.mocked(eraseSubject).mock.calls[0][2]).toMatchObject({ dryRun: true })
  })

  it('deletes only when the caller says so explicitly', async () => {
    await post(app, { ssn: SSN, reason: 'subject request', dryRun: false })
    expect(vi.mocked(eraseSubject).mock.calls[0][2]).toMatchObject({ dryRun: false })
  })

  it('refuses a dryRun that is not a boolean rather than guessing', async () => {
    const res = await post(app, { ssn: SSN, reason: 'subject request', dryRun: 'no' })
    expect(res.status).toBe(400)
  })

  // A dry run that wrote "subject_erased" would tell a later reader the person
  // was erased when nothing was removed, which is worse than no audit row.
  it('does not audit a preview as an erasure', async () => {
    await post(app, { ssn: SSN, reason: 'subject request' })
    const calls = vi.mocked(writeAuditLog).mock.calls
    expect(calls.every((c) => c[4] !== 'subject_erased')).toBe(true)
  })

  it('still audits a real erasure as one', async () => {
    await post(app, { ssn: SSN, reason: 'subject request', dryRun: false })
    const calls = vi.mocked(writeAuditLog).mock.calls
    expect(calls.some((c) => c[4] === 'subject_erased')).toBe(true)
  })

  it('says in the response that it was a preview', async () => {
    const res = await post(app, { ssn: SSN, reason: 'subject request' })
    const body = (await res.json()) as { dryRun?: boolean }
    expect(body.dryRun).toBe(true)
  })
})
