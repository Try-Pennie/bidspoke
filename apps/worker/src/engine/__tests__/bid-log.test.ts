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

// ── buyer_select beside tripoint_ping (#1411, L467) ───────────────────────────
//
// The node records its own live attempts during the run through makeBidLogger,
// exactly as partner_bid does, so this derivation must NOT also produce a row
// for it: the parent output is not a code node's, and its synthesized child
// namespaces are absent from the definition. Across every arm of the cutover the
// two writers together yield exactly ONE Tripoint row per execution.
describe('deriveCodeNodeBidAttempts leaves buyer_select to its own logger (#1411)', () => {
  const engineNodes: NodeDefinition[] = [
    { id: 'n1', namespace: 'tripoint_ping', type: 'code', config: {} },
    { id: 'n2', namespace: 'sell_off', type: 'buyer_select', config: {} },
  ]
  const nodeOutput = (route: string, mode: string) => ({
    _route: route, reason: route, mode_effective: mode, population: 'engine', lead_key: 'lead-1',
    sale: { skipped: route !== 'sold', accepted: route === 'sold', buyer_reference: route === 'sold' ? 'L-1' : null, result_code: route === 'sold' ? '1000' : null, partner_slug: route === 'sold' ? 'tripoint' : null },
    considered: [{ partner: 'tripoint', priority: 1, payout_cents: 2190, outcome: route === 'sold' ? 'sold' : 'declined_by_buyer' }],
    live_percent_in_force: 100, caps_in_force: [], duration_ms: 5,
  })
  // What the node's own logger wrote during the run, per arm.
  const nodeRows = (route: string, mode: string): number => (route !== '' && mode === 'live' && route !== 'not_applicable' ? 1 : 0)

  const arms: Array<[string, Record<string, unknown>, string, string]> = [
    ['legacy skipped, node not applicable', { skipped: true, qualified: null, resultCode: null }, 'not_applicable', 'live'],
    ['legacy sold, node not present', { skipped: false, qualified: true, resultCode: 1001, createLead: { id: 'L-9' } }, '', 'live'],
    ['node sold, legacy not reached', {}, 'sold', 'live'],
    ['node no sale, legacy not reached', {}, 'no_sale', 'live'],
    ['decide_only beside a legacy sale', { skipped: false, qualified: true, resultCode: 1001, createLead: { id: 'L-9' } }, 'deferred', 'decide_only'],
  ]

  it.each(arms)('%s: exactly one Tripoint row per execution', (_label, ping, route, mode) => {
    const s: Record<string, StepOutput> = {}
    if (Object.keys(ping).length > 0) s.tripoint_ping = { output: ping, status: 'completed' }
    if (route) {
      s.sell_off = { output: nodeOutput(route, mode), status: 'completed' }
      // The synthesized child the walker records under the node namespace.
      if (nodeRows(route, mode) > 0) s['sell_off.tripoint'] = { output: { outcome: route === 'sold' ? 'accepted' : 'declined_by_buyer', partner_slug: 'tripoint' }, status: 'completed' }
    }
    const derived = deriveCodeNodeBidAttempts(s, meta, engineNodes).filter((r) => r.partner_slug === 'tripoint')
    expect(derived.length + nodeRows(route, mode)).toBe(1)
  })

  it('the parent output and the child step are both invisible to the projection', () => {
    const s: Record<string, StepOutput> = {
      sell_off: { output: nodeOutput('sold', 'live'), status: 'completed' },
      'sell_off.tripoint': { output: { outcome: 'accepted', partner_slug: 'tripoint', http_status: 200 }, status: 'completed' },
    }
    expect(bidAttemptsForProjection(s, engineNodes)).toEqual([])
  })
})

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

// #1157: Lead Economy's producer is `return_response`, a code node, and it does
// NOT return Tripoint's response at the top level: it wraps it under
// `tripointResult` beside the body it quotes back to the source. So the flow
// passed the node-type gate and still recorded nothing, because both
// recognizers read only the outer level of a node's output.
//
// Shape measured on prod 2026-09-04 (396 of 2,901 runs in 4 hours reach a
// Tripoint result; exactly one step per run carries it, always return_response;
// zero steps carry a top-level resultCode).
const leadEconomy = (tripointResult: Record<string, unknown>, body: Record<string, unknown> = {}) =>
  steps({
    return_response: {
      continueExecution: false,
      isRejected: false,
      response: { status: 200, body },
      tripointResult,
    },
  })

describe('deriveCodeNodeBidAttempts: Lead Economy nests the payload (#1157)', () => {
  it('derives an accepted attempt from a payload wrapped in tripointResult', () => {
    const rows = attemptsOf(leadEconomy({ createLead: { leadId: 'tp-1' }, qualified: true, resultCode: 1001 }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      partner_slug: 'tripoint',
      classification: 'accept',
      skip_reason: null,
      decline_reason: null,
      bid_cents: null,
    })
  })

  it('derives a rejection from a wrapped non-approved code', () => {
    const rows = attemptsOf(leadEconomy({ createLead: { leadId: null }, qualified: false, resultCode: 1009 }))
    expect(rows[0]).toMatchObject({ classification: 'decline', skip_reason: 'rejected', decline_reason: 'result_code_1009' })
  })

  it('derives a duplicate from a wrapped duplicate code', () => {
    const rows = attemptsOf(leadEconomy({ createLead: {}, qualified: false, resultCode: 1020 }))
    expect(rows[0]).toMatchObject({ classification: 'decline', skip_reason: 'duplicate', decline_reason: 'result_code_1020' })
  })

  it('records ONE attempt when a node carries the payload at both depths', () => {
    // Reading a second depth must not double count a node that satisfies the
    // recognizer twice: that would report two bids for one Tripoint call, which
    // is the failure #640 fixed for pass-through nodes. The differing codes
    // exist only to prove which depth was read.
    const rows = attemptsOf(steps({
      return_response: {
        qualified: true,
        resultCode: 1001,
        createLead: {},
        tripointResult: { qualified: false, resultCode: 1009, createLead: {} },
      },
    }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ classification: 'accept' })
  })

  it('still ignores a node whose output has neither depth', () => {
    expect(attemptsOf(steps({ return_response: { continueExecution: true, response: { status: 204 } } }))).toEqual([])
  })
})

describe('deriveCodeNodeBidSummary: Lead Economy nests the payload (#1157)', () => {
  it('names tripoint the winner from a wrapped approved code', () => {
    expect(summaryOf(leadEconomy({ createLead: {}, qualified: true, resultCode: 1014 })))
      .toEqual({ winner_slug: 'tripoint', winner_bid_cents: null, attempted: 1, responded: 1 })
  })

  it('counts the attempt but names no winner from a wrapped rejection', () => {
    expect(summaryOf(leadEconomy({ createLead: {}, qualified: false, resultCode: 1009 })))
      .toEqual({ winner_slug: null, winner_bid_cents: null, attempted: 1, responded: 1 })
  })

  it('counts a wrapped payload once, not once per depth', () => {
    const s = summaryOf(steps({
      return_response: {
        qualified: true, resultCode: 1001, createLead: {},
        tripointResult: { qualified: true, resultCode: 1001, createLead: {} },
      },
    }))
    expect(s).toEqual({ winner_slug: 'tripoint', winner_bid_cents: null, attempted: 1, responded: 1 })
  })
})

describe('bidAttemptsForProjection: Lead Economy (#1157)', () => {
  it('projects the wrapped attempt so a stranded Lead Economy lead keeps its bid', () => {
    expect(projectionOf(leadEconomy({ createLead: {}, qualified: true, resultCode: 1001 }))).toEqual([
      { partner_slug: 'tripoint', classification: 'accept', decline_reason: null, skip_reason: null, resolver_type: 'api', bid_cents: null, http_status: null },
    ])
  })
})

/**
 * #1540: tripoint_ping names what Tripoint answered. An answer nobody could read
 * (a timeout, a proxy 5xx, a firewall page, a 200 with no result code) is not a
 * decline: recording it as one (Number(null) is 0, so it became result_code_0)
 * would tell every reader of lead_sighting_bids that Tripoint said no to a lead
 * it may have bought. It is its own class, `unknown`, with no decline reason.
 * The two known 502 answers carry no result code either, so they are named too.
 */
describe('deriveCodeNodeBidAttempts: the Tripoint answer (#1540)', () => {
  const tp = (over: Record<string, unknown>) => steps({ tripoint_ping: { skipped: false, qualified: false, createLead: null, resultCode: null, ...over } })

  it('records an unknown answer as its own class, never a decline, with no decline reason', () => {
    for (const reason of ['http_504', 'timeout', 'http_403', 'unparseable_body', 'network_error']) {
      const rows = attemptsOf(tp({ tripoint_answer: 'unknown', unknown_reason: reason }))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ partner_slug: 'tripoint', classification: 'unknown', decline_reason: null, skip_reason: null })
    }
  })

  it('an unknown answer that still carries a parsed code is unknown, not a decline by that code', () => {
    const rows = attemptsOf(tp({ tripoint_answer: 'unknown', unknown_reason: 'http_409', resultCode: 1003 }))
    expect(rows[0]).toMatchObject({ classification: 'unknown', decline_reason: null, skip_reason: null })
  })

  it('an output from an older script with no code and no fault flag is unknown, never result_code_0', () => {
    const rows = attemptsOf(tp({}))
    expect(rows[0]).toMatchObject({ classification: 'unknown', decline_reason: null, skip_reason: null })
  })

  it('the known 502 refusal of bad lead data is a decline for invalid data', () => {
    expect(attemptsOf(tp({ tripoint_answer: 'invalid_data', tripointLeadRejected: true }))[0])
      .toMatchObject({ classification: 'decline', decline_reason: 'invalid_data', skip_reason: 'rejected' })
    // The older script says the same thing through its flag.
    expect(attemptsOf(tp({ tripointLeadRejected: true }))[0])
      .toMatchObject({ classification: 'decline', decline_reason: 'invalid_data', skip_reason: 'rejected' })
  })

  it('the known 502 null id glitch is transient, named, and not a decline', () => {
    expect(attemptsOf(tp({ tripoint_answer: 'null_id_fault', tripointTransientFault: true }))[0])
      .toMatchObject({ classification: 'transient', decline_reason: 'null_id_fault', skip_reason: null })
    expect(attemptsOf(tp({ tripointTransientFault: true }))[0])
      .toMatchObject({ classification: 'transient', decline_reason: 'null_id_fault', skip_reason: null })
  })

  it('leaves every answer that carries a code exactly as it was recorded before', () => {
    expect(attemptsOf(tp({ tripoint_answer: 'accepted', qualified: true, resultCode: 1001 }))[0]).toMatchObject({ classification: 'accept', decline_reason: null, skip_reason: null })
    expect(attemptsOf(tp({ tripoint_answer: 'declined', resultCode: 1003 }))[0]).toMatchObject({ classification: 'decline', decline_reason: 'result_code_1003', skip_reason: 'duplicate' })
    expect(attemptsOf(tp({ tripoint_answer: 'in_progress', resultCode: 1009 }))[0]).toMatchObject({ classification: 'decline', decline_reason: 'result_code_1009', skip_reason: 'rejected' })
    expect(attemptsOf(steps({ tripoint_ping: { skipped: true, qualified: null, resultCode: null, tripoint_answer: 'skipped' } }))[0]).toMatchObject({ skip_reason: 'skipped', classification: null })
  })

  it('projects the unknown class onto the strand projection unchanged', () => {
    expect(projectionOf(tp({ tripoint_answer: 'unknown', unknown_reason: 'timeout' }))).toEqual([
      { partner_slug: 'tripoint', classification: 'unknown', decline_reason: null, skip_reason: null, resolver_type: 'api', bid_cents: null, http_status: null },
    ])
  })

  it('counts an unknown answer as attempted but not responded, and never as a winner', () => {
    expect(summaryOf(tp({ tripoint_answer: 'unknown', unknown_reason: 'timeout' }))).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: 1, responded: null })
    expect(summaryOf(tp({ tripoint_answer: 'declined', resultCode: 1003 }))).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: 1, responded: 1 })
  })
})
