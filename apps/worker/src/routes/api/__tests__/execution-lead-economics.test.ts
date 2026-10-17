/**
 * #1160: the per-lead margin on the execution detail response.
 *
 * Both halves are now recorded and nothing puts them together.
 * `lead_sightings.winning_bid_cents` is what a buyer paid for the lead, and
 * `quoted_rate_cents` (#1158) is what we quoted the source that sent it. The
 * difference is the margin on that lead, and on the RML flows the quote is a
 * consistent 65% of the buyer's bid, so the gap is real and steady rather than
 * noise. Measured on prod shortly after #1159 deployed: one LendSwift lead
 * quoted 216 against a 333 bid, a 117 cent margin, and nothing showed it.
 *
 * The sighting is a SEPARATE row with a SHORTER life than the execution:
 * executions are kept 7 days, lead_sightings roughly two before the export
 * purges it. So an execution 3 to 7 days old legitimately has no sighting, and
 * that state must be distinguishable from a lead that simply earned nothing
 * (L11, L622). An absent row is `null`; a present row with no numbers in it is
 * an object full of nulls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../engine/definition-loader')
vi.mock('../../../lib/audit')
vi.mock('../../../engine/index')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase } from './_supabase-mock'

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const execution = {
  id: 'exec-1',
  workflow_id: 'wf-1',
  status: 'completed',
  started_at: '2026-09-04T09:00:00Z',
  duration_ms: 150,
}
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {} } as unknown as Env
const mockCtx = recordingContext()

async function getExecution(sighting: Record<string, unknown> | null) {
  vi.mocked(verifyJwt).mockResolvedValue(validPayload as never)
  vi.mocked(createSupabaseClient).mockReturnValue(
    makeSupabase({
      users: { single: testUser },
      workflow_executions: { single: execution, list: [] },
      execution_steps: { list: [] },
      lead_sightings: { maybeSingle: sighting },
    }) as never,
  )
  const { default: api } = await import('../index')
  const res = await api.request(
    '/executions/exec-1',
    { method: 'GET', headers: { Authorization: 'Bearer tok' } },
    testEnv,
    mockCtx,
  )
  return { res, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => vi.clearAllMocks())

describe('GET /executions/:id lead economics (#1160)', () => {
  it('returns the quote, the winning bid and the margin between them', async () => {
    const { res, body } = await getExecution({
      quoted_rate_cents: 216,
      winning_bid_cents: 333,
      winning_partner_slug: 'lendswift',
    })
    expect(res.status).toBe(200)
    expect(body.lead_economics).toEqual({
      quoted_rate_cents: 216,
      winning_bid_cents: 333,
      margin_cents: 117,
      winning_partner_slug: 'lendswift',
    })
  })

  it('reports no sighting row as null, not as a lead that earned nothing', async () => {
    // An execution older than the sighting retention window lands here, and it
    // must not read as a zero margin.
    const { body } = await getExecution(null)
    expect(body.lead_economics).toBeNull()
  })

  it('leaves the margin null when only one side is recorded', async () => {
    // A difference computed against a missing number is not a margin, and
    // treating the absent side as zero would report the whole bid as profit.
    const { body } = await getExecution({
      quoted_rate_cents: null,
      winning_bid_cents: 333,
      winning_partner_slug: 'lendswift',
    })
    expect(body.lead_economics).toMatchObject({ winning_bid_cents: 333, margin_cents: null })
  })

  it('leaves the margin null when the bid is missing but the quote is not', async () => {
    const { body } = await getExecution({
      quoted_rate_cents: 216,
      winning_bid_cents: null,
      winning_partner_slug: null,
    })
    expect(body.lead_economics).toMatchObject({ quoted_rate_cents: 216, margin_cents: null })
  })

  it('reports a negative margin rather than hiding it', async () => {
    // Quoting a source more than the buyer paid is a real and important state.
    const { body } = await getExecution({
      quoted_rate_cents: 400,
      winning_bid_cents: 333,
      winning_partner_slug: 'gigfi',
    })
    expect(body.lead_economics).toMatchObject({ margin_cents: -67 })
  })

  it('reports a zero margin as 0, distinct from an unknown one', async () => {
    const { body } = await getExecution({
      quoted_rate_cents: 333,
      winning_bid_cents: 333,
      winning_partner_slug: 'gigfi',
    })
    expect(body.lead_economics).toMatchObject({ margin_cents: 0 })
  })

  it('still returns the execution itself when the sighting lookup finds nothing', async () => {
    const { res, body } = await getExecution(null)
    expect(res.status).toBe(200)
    expect(body.id).toBe('exec-1')
  })
})
