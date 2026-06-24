/**
 * #309 Phase 2: the lead-sightings outcome writes route through the durability
 * seam (writeOutcome → retry + dead-letter) when the caller supplies alert deps,
 * and fall back to a bare write when they don't (tests, one-off backfills).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../durability', () => ({
  // Run the op so the function still completes; just record the routing.
  writeOutcome: vi.fn(async (_label: string, op: () => Promise<{ error: unknown }>) => op()),
}))

import { writeOutcome } from '../durability'
import { insertSighting, recordBidAttempt, finalizeSighting, type SightingInsert, type BidAttemptInsert, type FinalizeSightingInput } from '../lead-sightings'

const client = {
  from: () => ({
    insert: async () => ({ error: null }),
    upsert: async () => ({ error: null }),
    update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
  }),
} as unknown as SupabaseClient

const deps = { kv: {} as never, orgId: 'org-1', appUrl: 'https://app.test' }

function sightingInput(): SightingInsert {
  return {
    id: 'sight-1', trace_id: 't', execution_id: 'e', workflow_id: 'wf', is_test: false,
    execution_started_at_utc: new Date('2026-06-24T16:00:00Z'),
    execution_started_at_et: new Date('2026-06-24T12:00:00-04:00'),
    payload_fields: {},
  }
}
function bidInput(): BidAttemptInsert {
  return {
    sighting_id: 'sight-1', trace_id: 't', execution_id: 'e', partner_slug: 'tripoint',
    attempted_at_utc: new Date('2026-06-24T16:00:00Z'), attempted_at_et: new Date('2026-06-24T12:00:00-04:00'), is_test: false,
  }
}
function finalizeInput(): FinalizeSightingInput {
  return {
    sighting_id: 'sight-1', execution_id: 'e',
    execution_started_at_utc: new Date('2026-06-24T16:00:00Z'),
    execution_finished_at_et: new Date('2026-06-24T12:00:01-04:00'),
    execution_ended_at_utc: new Date('2026-06-24T16:00:01Z'), duration_ms: 1000,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('lead-sightings seam routing (#309)', () => {
  it('insertSighting routes through writeOutcome when deps are provided', async () => {
    await insertSighting(client, sightingInput(), deps)
    expect(writeOutcome).toHaveBeenCalledWith('lead_sightings.insert', expect.any(Function), expect.objectContaining({ orgId: 'org-1' }))
  })

  it('insertSighting falls back to a bare write when deps are omitted', async () => {
    await insertSighting(client, sightingInput())
    expect(writeOutcome).not.toHaveBeenCalled()
  })

  it('recordBidAttempt routes through writeOutcome with the bids label when deps are provided', async () => {
    await recordBidAttempt(client, bidInput(), deps)
    expect(writeOutcome).toHaveBeenCalledWith('lead_sighting_bids.insert', expect.any(Function), expect.objectContaining({ orgId: 'org-1' }))
  })

  it('finalizeSighting routes the sighting update through writeOutcome when deps are provided', async () => {
    await finalizeSighting(client, finalizeInput(), deps)
    expect(writeOutcome).toHaveBeenCalledWith('lead_sightings.finalize', expect.any(Function), expect.objectContaining({ orgId: 'org-1' }))
  })
})
