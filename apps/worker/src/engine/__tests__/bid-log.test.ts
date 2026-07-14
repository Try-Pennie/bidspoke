/**
 * #349: the live Engine Bidding Workflow bids via the `tripoint_ping` code node,
 * so recordBidAttempt (only reachable from partner_bid/bid_group nodes) never
 * fires and lead_sighting_bids stays empty. deriveCodeNodeBidAttempts
 * reconstructs the bid ATTEMPT + classification from the existing node output
 * with no canvas changes. Tripoint's response carries no bid amount, so
 * bid_cents stays null (attempt-only recording).
 */
import { describe, it, expect } from 'vitest'
import type { NodeDefinition, StepOutput } from '../../types'
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

describe('projectionOf(#366 Phase 2b)', () => {
  it('produces slim per-attempt rows (no ids/timestamps) for the strand projection', () => {
    const out = projectionOf(steps({ tripoint_ping: { skipped: false, qualified: true, resultCode: 1001, createLead: { bidValue: null } } }))
    expect(out).toEqual([
      { partner_slug: 'tripoint', classification: 'accept', decline_reason: null, skip_reason: null, resolver_type: 'api', bid_cents: null, http_status: null },
    ])
  })

  it('carries the decline classification + reason for a rejected ping', () => {
    const out = projectionOf(steps({ tripoint_ping: { skipped: false, qualified: false, resultCode: 1009 } }))
    expect(out).toEqual([
      { partner_slug: 'tripoint', classification: 'decline', decline_reason: 'result_code_1009', skip_reason: 'rejected', resolver_type: 'api', bid_cents: null, http_status: null },
    ])
  })

  it('returns [] when there are no code-node bid outputs', () => {
    expect(projectionOf(steps({ validate: { ok: true } }))).toEqual([])
  })
})

describe('deriveCodeNodeBidAttempts — Tripoint (#349)', () => {
  it('derives an accepted attempt from an approved ping (resultCode 1001)', () => {
    const rows = attemptsOf(steps({ tripoint_ping: { skipped: false, qualified: true, resultCode: 1001, createLead: { bidValue: null } } }))
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
    const rows = attemptsOf(steps({ tripoint_ping: { skipped: false, qualified: false, resultCode: 1004 } }))
    expect(rows[0]).toMatchObject({ classification: 'decline', skip_reason: 'duplicate', decline_reason: 'result_code_1004' })
  })

  it('derives a rejection for a non-approved, non-duplicate code (1009)', () => {
    const rows = attemptsOf(steps({ tripoint_ping: { skipped: false, qualified: false, resultCode: 1009 } }))
    expect(rows[0]).toMatchObject({ classification: 'decline', skip_reason: 'rejected', decline_reason: 'result_code_1009' })
  })

  it('derives a skip when the ping was skipped', () => {
    const rows = attemptsOf(steps({ tripoint_ping: { skipped: true, qualified: null, resultCode: null } }))
    expect(rows[0]).toMatchObject({ partner_slug: 'tripoint', skip_reason: 'skipped', classification: null })
  })

  it('ignores non-Tripoint step outputs', () => {
    const rows = attemptsOf(steps({ equifax: { score: 700 }, prospect_body: { id: 'p1' }, validate: { ok: true } }))
    expect(rows).toEqual([])
  })

  it('carries the sighting/trace/execution meta and is_test onto each row', () => {
    const s = steps({ tripoint_ping: { skipped: false, qualified: true, resultCode: 1001 } })
    const rows = deriveCodeNodeBidAttempts(s, { ...meta, is_test: true }, allCode(s))
    expect(rows[0]).toMatchObject({ trace_id: 'trace-1', attempted_at_utc: meta.attempted_at_utc, is_test: true })
  })
})

describe('deriveCodeNodeBidSummary — winner from Tripoint (#349)', () => {
  it('names tripoint the winner on an approved ping (resultCode 1001)', () => {
    const s = summaryOf(steps({ tripoint_ping: { skipped: false, qualified: true, resultCode: 1001 } }))
    expect(s).toEqual({ winner_slug: 'tripoint', winner_bid_cents: null, attempted: 1, responded: 1 })
  })

  it('has no winner for a duplicate (1004) but still counts the attempt', () => {
    const s = summaryOf(steps({ tripoint_ping: { skipped: false, qualified: false, resultCode: 1004 } }))
    expect(s).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: 1, responded: 1 })
  })

  it('has no winner and no attempt for a skipped ping', () => {
    const s = summaryOf(steps({ tripoint_ping: { skipped: true, qualified: null, resultCode: null } }))
    expect(s).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: null, responded: null })
  })

  it('returns all-null when there is no Tripoint bid (e.g. a bid_group flow)', () => {
    const s = summaryOf(steps({ equifax: { score: 700 }, some_bid_group: { winner: { partner: 'm1' }, all_bids: [] } }))
    expect(s).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: null, responded: null })
  })
})

// #381: RML (LendSwift/GigFi) bid via the ping_<slug> code node, whose output
// nests the bid under data.data. Unlike Tripoint the amount IS present
// (data.data.bid_amount); data.data.min_bid_value is a floor, not the paid amount.
// Partner identity comes from the namespace (the output doesn't self-identify).
// NOTE: treating status='ACCEPTED' as the winner assumes ACCEPTED == we won/were
// paid (pending confirmation with RML/Brian).
const rml = (slug: 'lendswift' | 'gigfi', data: Record<string, unknown>) =>
  steps({ [`ping_${slug}`]: { data: { data, status: 'success' }, statusCode: 200 } })

describe('deriveCodeNodeBidAttempts — RML (#381)', () => {
  it('records an accepted LendSwift bid with the dollar amount (data.data.bid_amount)', () => {
    const rows = attemptsOf(rml('lendswift', { status: 'ACCEPTED', bid_amount: 4.99, min_bid_value: 6.15, rejection_reason: '' }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      partner_slug: 'lendswift',
      classification: 'accept',
      skip_reason: null,
      decline_reason: null,
      bid_cents: 499,
      resolver_type: 'api',
    })
  })

  it('derives the partner_slug from the ping_<slug> namespace (gigfi)', () => {
    const rows = attemptsOf(rml('gigfi', { status: 'ACCEPTED', bid_amount: 2, min_bid_value: 2 }))
    expect(rows[0]).toMatchObject({ partner_slug: 'gigfi', classification: 'accept', bid_cents: 200 })
  })

  it('records a rejected bid as a decline with the rejection_reason and amount when present', () => {
    const rows = attemptsOf(rml('lendswift', { status: 'REJECTED', bid_amount: 1.5, min_bid_value: 6.15, rejection_reason: 'below_floor' }))
    expect(rows[0]).toMatchObject({ partner_slug: 'lendswift', classification: 'decline', skip_reason: 'rejected', decline_reason: 'below_floor', bid_cents: 150 })
  })

  it('leaves bid_cents null and decline_reason null for a rejected bid with no amount or reason', () => {
    const rows = attemptsOf(rml('gigfi', { status: 'REJECTED', min_bid_value: 6.15, rejection_reason: '' }))
    expect(rows[0]).toMatchObject({ partner_slug: 'gigfi', classification: 'decline', skip_reason: 'rejected', decline_reason: null, bid_cents: null })
  })

  it('rounds fractional dollar amounts to cents', () => {
    const rows = attemptsOf(rml('lendswift', { status: 'ACCEPTED', bid_amount: 6.155, min_bid_value: 6.15 }))
    expect(rows[0].bid_cents).toBe(616)
  })
})

describe('deriveCodeNodeBidSummary — winner from RML (#381)', () => {
  it('names the RML partner the winner on an accepted bid, with the amount', () => {
    const s = summaryOf(rml('lendswift', { status: 'ACCEPTED', bid_amount: 4.99, min_bid_value: 6.15 }))
    expect(s).toEqual({ winner_slug: 'lendswift', winner_bid_cents: 499, attempted: 1, responded: 1 })
  })

  it('has no winner for a rejected RML bid but still counts the attempt', () => {
    const s = summaryOf(rml('gigfi', { status: 'REJECTED', min_bid_value: 6.15, rejection_reason: 'x' }))
    expect(s).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: 1, responded: 1 })
  })
})

// #640 gated these on the node TYPE, so every derivation now needs the node list.
// The cases below all exercise genuine producer (code) nodes, so the wrappers mark
// every namespace in the steps map as one. The pass-through cases that need a real
// mix of types build their node list explicitly.
function allCode(s: Record<string, StepOutput>): NodeDefinition[] {
  return Object.keys(s).map((ns, i) => ({ id: `n${i}`, namespace: ns, type: 'code', config: {} })) as NodeDefinition[]
}
const attemptsOf = (s: Record<string, StepOutput>) => deriveCodeNodeBidAttempts(s, meta, allCode(s))
const summaryOf = (s: Record<string, StepOutput>) => deriveCodeNodeBidSummary(s, allCode(s))
const projectionOf = (s: Record<string, StepOutput>) => bidAttemptsForProjection(s, allCode(s))

describe('bidAttemptsForProjection — RML carries bid_cents (#381)', () => {
  it('projects the RML amount onto the strand projection', () => {
    const out = projectionOf(rml('lendswift', { status: 'ACCEPTED', bid_amount: 4.99, min_bid_value: 6.15 }))
    expect(out).toEqual([
      { partner_slug: 'lendswift', classification: 'accept', decline_reason: null, skip_reason: null, resolver_type: 'api', bid_cents: 499, http_status: null },
    ])
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

// ============================================================
// #640: pass-through duplication
// ============================================================
// A branch_end re-emits the output of the chain that reached it (the SAME object,
// see executeBranchEndNode), and every node's output lands in ctx.steps. So a
// derivation keyed purely on output SHAPE fires once per node the output travelled
// through, not once per bid. This is the bug 6c55259 fixed in achieve-log, where a
// single Achieve call wrote 6 rows. Here the blast radius is worse than duplication:
// the RML slug is derived from the NAMESPACE, so a pass-through would invent a
// partner named after the convergence node.
//
// The gate is the node TYPE (only a `code` node bids in these flows), never the name.
describe('pass-through duplication (#640)', () => {
  const tripointPing = { skipped: false, qualified: true, resultCode: 1001, createLead: { bidValue: null } }
  const rmlPing = { data: { data: { status: 'ACCEPTED', bid_amount: 42, min_bid_value: 10 } } }

  // The branch_end passes through the SAME object reference the ping produced.
  const withPassThrough = (ns: string, output: unknown) =>
    steps({ [ns]: output, tail_branch_end: output, sf_post: { status: 200 } })

  const nodes = (pingNs: string): NodeDefinition[] =>
    [
      { id: 'n1', namespace: pingNs, type: 'code', config: {} },
      { id: 'n2', namespace: 'tail_branch_end', type: 'branch_end', config: {} },
      { id: 'n3', namespace: 'sf_post', type: 'webhook', config: {} },
    ] as NodeDefinition[]

  it('records ONE Tripoint attempt when a branch_end re-emits the ping output', () => {
    const rows = deriveCodeNodeBidAttempts(withPassThrough('tripoint_ping', tripointPing), meta, nodes('tripoint_ping'))
    expect(rows).toHaveLength(1)
    expect(rows[0].partner_slug).toBe('tripoint')
  })

  it('counts the re-emitted ping once in the summary, not twice', () => {
    const summary = deriveCodeNodeBidSummary(withPassThrough('tripoint_ping', tripointPing), nodes('tripoint_ping'))
    expect(summary.attempted).toBe(1)
    expect(summary.responded).toBe(1)
    expect(summary.winner_slug).toBe('tripoint')
  })

  it('never invents an RML partner named after the pass-through node', () => {
    const rows = deriveCodeNodeBidAttempts(withPassThrough('ping_lendswift', rmlPing), meta, nodes('ping_lendswift'))
    expect(rows.map((r) => r.partner_slug)).toEqual(['lendswift'])
  })

  it('never makes the pass-through node the winning RML partner', () => {
    const summary = deriveCodeNodeBidSummary(withPassThrough('ping_lendswift', rmlPing), nodes('ping_lendswift'))
    expect(summary.winner_slug).toBe('lendswift')
    expect(summary.attempted).toBe(1)
  })

  it('projects one attempt, not one per node the output travelled through', () => {
    const out = bidAttemptsForProjection(withPassThrough('tripoint_ping', tripointPing), nodes('tripoint_ping'))
    expect(out).toHaveLength(1)
  })

  // The node NAME must stay free-form: the gate is the type, and only the type.
  it('still derives from a code node with an unconventional name', () => {
    const s = steps({ weird_name: tripointPing })
    const n = [{ id: 'n1', namespace: 'weird_name', type: 'code', config: {} }] as NodeDefinition[]
    expect(deriveCodeNodeBidAttempts(s, meta, n)).toHaveLength(1)
  })

  // A bid_group/partner_bid attempt records natively via recordBidAttempt. Deriving it
  // again here would double-count it, so a non-code producer must never be derived.
  it('does not derive a bid from a partner_bid node (it records itself)', () => {
    const s = steps({ bid_tripoint: tripointPing })
    const n = [{ id: 'n1', namespace: 'bid_tripoint', type: 'partner_bid', config: {} }] as NodeDefinition[]
    expect(deriveCodeNodeBidAttempts(s, meta, n)).toEqual([])
  })
})
