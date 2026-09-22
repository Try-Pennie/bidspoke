/**
 * makeBidLogger (#1411): the bid attempt logger extracted from the closure in
 * partner-bid.ts, so the buyer_select node's live attempts write their
 * lead_sighting_bids row through the same code. Behaviour is the closure's,
 * exactly: no sighting id means no row, the fixed fields come from the context,
 * the caller's fields win, and the write is registered on the context so the
 * sighting finalize can await it before its winner update (#88).
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext } from '../../types'

vi.mock('../lead-sightings', () => ({ recordBidAttempt: vi.fn(() => Promise.resolve()) }))

import { recordBidAttempt } from '../lead-sightings'
import { makeBidLogger } from '../bid-logger'

const supabase = {} as SupabaseClient
const AT = new Date('2027-09-20T15:30:00.000Z')

function ctx(sightingId: string | undefined): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'engine', workflow_id: 'wf', trace_id: 'trace-1', org_id: 'org', execution_id: 'exec-1', sighting_id: sightingId },
    steps: {},
    env: {},
  }
}

describe('makeBidLogger', () => {
  it('writes nothing when the run has no sighting id, exactly as the closure did', () => {
    vi.mocked(recordBidAttempt).mockClear()
    const c = ctx(undefined)
    makeBidLogger(supabase, c, 'api')({ partner_slug: 'tripoint', attempted_at_utc: AT, skip_reason: 'cap_exceeded' })
    expect(recordBidAttempt).not.toHaveBeenCalled()
    expect(c.pendingBidWrites).toBeUndefined()
  })

  it('fills the fixed fields from the context, lets the caller\'s fields win, and registers the write', () => {
    vi.mocked(recordBidAttempt).mockClear()
    const c = ctx('sighting-1')
    const log = makeBidLogger(supabase, c, 'matrix')
    log({ partner_slug: 'tripoint', attempted_at_utc: AT, http_status: 200, classification: 'accept', bid_cents: null })
    expect(recordBidAttempt).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordBidAttempt).mock.calls[0][1]).toEqual({
      sighting_id: 'sighting-1',
      trace_id: 'trace-1',
      execution_id: 'exec-1',
      partner_slug: 'tripoint',
      attempted_at_utc: AT,
      attempted_at_et: AT,
      responded_at_utc: null,
      responded_at_et: null,
      http_status: 200,
      bid_cents: null,
      classification: 'accept',
      decline_reason: null,
      resolver_type: 'matrix',
      skip_reason: null,
      is_test: false,
    })
    expect(c.pendingBidWrites).toHaveLength(1)
  })

  it('a missing execution id is written as an empty string, as before, never undefined', () => {
    vi.mocked(recordBidAttempt).mockClear()
    const c = ctx('sighting-1')
    c.trigger.execution_id = undefined
    makeBidLogger(supabase, c, null)({ partner_slug: 'liberty', attempted_at_utc: AT })
    expect(vi.mocked(recordBidAttempt).mock.calls[0][1]).toMatchObject({ execution_id: '', resolver_type: null })
  })
})
