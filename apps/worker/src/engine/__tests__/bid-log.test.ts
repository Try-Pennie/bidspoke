/**
 * #349: the live Engine Bidding Workflow bids via the `tripoint_ping` code node,
 * so recordBidAttempt (only reachable from partner_bid/bid_group nodes) never
 * fires and lead_sighting_bids stays empty. deriveCodeNodeBidAttempts
 * reconstructs the bid ATTEMPT + classification from the existing node output
 * with no canvas changes. Tripoint's response carries no bid amount, so
 * bid_cents stays null (attempt-only recording).
 */
import { describe, it, expect } from 'vitest'
import type { StepOutput } from '../../types'
import { deriveCodeNodeBidAttempts, deriveCodeNodeBidSummary, pickBidSummary, bidAttemptsForProjection, type BidSummary } from '../bid-log'

const meta = {
  sighting_id: 'sight-1',
  trace_id: 'trace-1',
  execution_id: 'exec-1',
  attempted_at_utc: new Date('2026-06-24T16:00:00Z'),
  is_test: false,
}

function steps(outputs: Record<string, unknown>): Record<string, StepOutput> {
  const out: Record<string, StepOutput> = {}
  for (const [ns, output] of Object.entries(outputs)) {
    out[ns] = { output, status: 'completed' }
  }
  return out
}

describe('bidAttemptsForProjection (#366 Phase 2b)', () => {
  it('produces slim per-attempt rows (no ids/timestamps) for the strand projection', () => {
    const out = bidAttemptsForProjection(
      steps({ tripoint_ping: { skipped: false, qualified: true, resultCode: 1001, createLead: { bidValue: null } } }),
    )
    expect(out).toEqual([
      { partner_slug: 'tripoint', classification: 'accept', decline_reason: null, skip_reason: null, resolver_type: 'api', bid_cents: null, http_status: null },
    ])
  })

  it('carries the decline classification + reason for a rejected ping', () => {
    const out = bidAttemptsForProjection(steps({ tripoint_ping: { skipped: false, qualified: false, resultCode: 1009 } }))
    expect(out).toEqual([
      { partner_slug: 'tripoint', classification: 'decline', decline_reason: 'result_code_1009', skip_reason: 'rejected', resolver_type: 'api', bid_cents: null, http_status: null },
    ])
  })

  it('returns [] when there are no code-node bid outputs', () => {
    expect(bidAttemptsForProjection(steps({ validate: { ok: true } }))).toEqual([])
  })
})

describe('deriveCodeNodeBidAttempts — Tripoint (#349)', () => {
  it('derives an accepted attempt from an approved ping (resultCode 1001)', () => {
    const rows = deriveCodeNodeBidAttempts(
      steps({ tripoint_ping: { skipped: false, qualified: true, resultCode: 1001, createLead: { bidValue: null } } }),
      meta,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sighting_id: 'sight-1',
      execution_id: 'exec-1',
      partner_slug: 'tripoint',
      classification: 'accept',
      skip_reason: null,
      bid_cents: null,
    })
  })

  it('derives a duplicate decline (resultCode 1004)', () => {
    const rows = deriveCodeNodeBidAttempts(
      steps({ tripoint_ping: { skipped: false, qualified: false, resultCode: 1004 } }),
      meta,
    )
    expect(rows[0]).toMatchObject({ classification: 'decline', skip_reason: 'duplicate', decline_reason: 'result_code_1004' })
  })

  it('derives a rejection for a non-approved, non-duplicate code (1009)', () => {
    const rows = deriveCodeNodeBidAttempts(
      steps({ tripoint_ping: { skipped: false, qualified: false, resultCode: 1009 } }),
      meta,
    )
    expect(rows[0]).toMatchObject({ classification: 'decline', skip_reason: 'rejected', decline_reason: 'result_code_1009' })
  })

  it('derives a skip when the ping was skipped', () => {
    const rows = deriveCodeNodeBidAttempts(
      steps({ tripoint_ping: { skipped: true, qualified: null, resultCode: null } }),
      meta,
    )
    expect(rows[0]).toMatchObject({ partner_slug: 'tripoint', skip_reason: 'skipped', classification: null })
  })

  it('ignores non-Tripoint step outputs', () => {
    const rows = deriveCodeNodeBidAttempts(
      steps({ equifax: { score: 700 }, prospect_body: { id: 'p1' }, validate: { ok: true } }),
      meta,
    )
    expect(rows).toEqual([])
  })

  it('carries the sighting/trace/execution meta and is_test onto each row', () => {
    const rows = deriveCodeNodeBidAttempts(
      steps({ tripoint_ping: { skipped: false, qualified: true, resultCode: 1001 } }),
      { ...meta, is_test: true },
    )
    expect(rows[0]).toMatchObject({ trace_id: 'trace-1', attempted_at_utc: meta.attempted_at_utc, is_test: true })
  })
})

describe('deriveCodeNodeBidSummary — winner from Tripoint (#349)', () => {
  it('names tripoint the winner on an approved ping (resultCode 1001)', () => {
    const s = deriveCodeNodeBidSummary(steps({ tripoint_ping: { skipped: false, qualified: true, resultCode: 1001 } }))
    expect(s).toEqual({ winner_slug: 'tripoint', winner_bid_cents: null, attempted: 1, responded: 1 })
  })

  it('has no winner for a duplicate (1004) but still counts the attempt', () => {
    const s = deriveCodeNodeBidSummary(steps({ tripoint_ping: { skipped: false, qualified: false, resultCode: 1004 } }))
    expect(s).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: 1, responded: 1 })
  })

  it('has no winner and no attempt for a skipped ping', () => {
    const s = deriveCodeNodeBidSummary(steps({ tripoint_ping: { skipped: true, qualified: null, resultCode: null } }))
    expect(s).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: null, responded: null })
  })

  it('returns all-null when there is no Tripoint bid (e.g. a bid_group flow)', () => {
    const s = deriveCodeNodeBidSummary(steps({ equifax: { score: 700 }, some_bid_group: { winner: { partner: 'm1' }, all_bids: [] } }))
    expect(s).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: null, responded: null })
  })
})

describe('pickBidSummary — bid_group preferred, code-node fallback (#349)', () => {
  const codeNode: BidSummary = { winner_slug: 'tripoint', winner_bid_cents: null, attempted: 1, responded: 1 }
  const empty: BidSummary = { winner_slug: null, winner_bid_cents: null, attempted: null, responded: null }

  it('uses the bid_group summary when it has a winner', () => {
    const bg: BidSummary = { winner_slug: 'm1', winner_bid_cents: 5000, attempted: 2, responded: 2 }
    expect(pickBidSummary(bg, codeNode)).toBe(bg)
  })

  it('uses the bid_group summary when it counted attempts but had no winner', () => {
    const bg: BidSummary = { winner_slug: null, winner_bid_cents: null, attempted: 3, responded: 1 }
    expect(pickBidSummary(bg, codeNode)).toBe(bg)
  })

  it('falls back to the code-node summary when bid_group found nothing', () => {
    expect(pickBidSummary(empty, codeNode)).toBe(codeNode)
  })
})
