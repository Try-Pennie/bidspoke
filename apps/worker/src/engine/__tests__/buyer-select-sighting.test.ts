/**
 * How a buyer_select run lands in the lead sighting (#1411): the winner the
 * finalize flips is_winner on, the terminal handle the reject reason reads, and
 * the reason itself. The terminal handle derivation used to be written twice
 * (the live finalize and the admin backfill); it is one function now, so the
 * node's handle is read the same way on both paths (L613).
 */
import { describe, expect, it } from 'vitest'
import type { NodeDefinition, StepOutput } from '../../types'
import { computeSightingFinalize, deriveRejectReason, extractBuyerSelectSummary, terminalHandleFor } from '../lead-sightings'

const done = (output: unknown): StepOutput => ({ output, status: 'completed' })

function nodeOutput(route: string, over: Record<string, unknown> = {}) {
  return {
    _route: route,
    reason: route === 'sold' ? 'sold' : 'declined_by_buyer',
    mode_effective: 'live',
    population: 'engine',
    lead_key: 'lead-1',
    sale: route === 'sold'
      ? { skipped: false, accepted: true, buyer_reference: 'L-1', result_code: '1000', partner_slug: 'tripoint' }
      : { skipped: false, accepted: false, buyer_reference: null, result_code: null, partner_slug: null },
    considered: [
      { partner: 'tripoint', priority: 1, payout_cents: 2190, outcome: route === 'sold' ? 'sold' : 'declined_by_buyer' },
      { partner: 'liberty', priority: 2, payout_cents: 1800, outcome: route === 'sold' ? 'not_reached' : 'declined_by_buyer' },
    ],
    live_percent_in_force: 100,
    caps_in_force: [],
    duration_ms: 10,
    ...over,
  }
}

describe('extractBuyerSelectSummary', () => {
  it('names the buyer a live sale went to, so the finalize flips is_winner on that partner', () => {
    const s = extractBuyerSelectSummary({ sell_off: done(nodeOutput('sold')) })
    expect(s).toEqual({ winner_slug: 'tripoint', winner_bid_cents: null, attempted: 1, responded: 1 })
  })

  it('counts every buyer that was contacted, declines included', () => {
    const s = extractBuyerSelectSummary({ sell_off: done(nodeOutput('no_sale')) })
    expect(s).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: 2, responded: 2 })
  })

  it('a rehearsal is not a sale and not an attempt: nothing was contacted', () => {
    const rehearsed = nodeOutput('deferred', {
      mode_effective: 'decide_only',
      reason: 'decide_only',
      sale: { skipped: false, accepted: true, buyer_reference: null, result_code: 'rehearsal_no_call', partner_slug: 'tripoint' },
      considered: [{ partner: 'tripoint', priority: 1, payout_cents: 2190, outcome: 'rehearsed' }],
    })
    expect(extractBuyerSelectSummary({ sell_off: done(rehearsed) })).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: null, responded: null })
  })

  it('an unknown outcome counts as attempted but not responded', () => {
    const held = nodeOutput('no_sale', { considered: [{ partner: 'tripoint', priority: 1, payout_cents: 2190, outcome: 'outcome_unknown' }] })
    expect(extractBuyerSelectSummary({ sell_off: done(held) })).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: 1, responded: null })
  })

  it('ignores a step that merely mentions a sale key: the shape is the node output, not a field name', () => {
    expect(extractBuyerSelectSummary({ other: done({ sale: 'yes', considered: 3 }) })).toEqual({ winner_slug: null, winner_bid_cents: null, attempted: null, responded: null })
  })
})

describe('terminalHandleFor', () => {
  it('reads a filter by its passed flag and a routed node by its _route', () => {
    expect(terminalHandleFor('filter', { passed: false })).toBe('exit')
    expect(terminalHandleFor('filter', { passed: true })).toBe('pass')
    expect(terminalHandleFor('bid_group', { _route: 'no_winner' })).toBe('no_winner')
    expect(terminalHandleFor('buyer_select', { _route: 'no_sale' })).toBe('no_sale')
    expect(terminalHandleFor('buyer_select', { _route: 'sold' })).toBe('sold')
  })
  it('is null for a node type that has no handles and for a missing output', () => {
    expect(terminalHandleFor('code', { _route: 'sold' })).toBeNull()
    expect(terminalHandleFor('buyer_select', undefined)).toBeNull()
    expect(terminalHandleFor(null, { passed: false })).toBeNull()
  })
})

describe('deriveRejectReason for buyer_select', () => {
  it('a no_sale is a rejection carrying the node reason', () => {
    expect(
      deriveRejectReason({ terminal_node_type: 'buyer_select', terminal_node_handle: 'no_sale', terminal_step_output: nodeOutput('no_sale') }),
    ).toBe('buyer_select:declined_by_buyer')
  })
  it('a no_sale with no readable reason is still a rejection by name', () => {
    expect(
      deriveRejectReason({ terminal_node_type: 'buyer_select', terminal_node_handle: 'no_sale', terminal_step_output: { _route: 'no_sale' } }),
    ).toBe('buyer_select:no_sale')
  })
  it('not_applicable, deferred and sold are not rejections', () => {
    for (const handle of ['not_applicable', 'deferred', 'sold']) {
      expect(deriveRejectReason({ terminal_node_type: 'buyer_select', terminal_node_handle: handle, terminal_step_output: nodeOutput(handle) }), handle).toBeNull()
    }
  })
})

describe('computeSightingFinalize with a buyer_select node', () => {
  const nodes: NodeDefinition[] = [
    { id: 'n1', namespace: 'prospect_trades', type: 'code', config: {} },
    { id: 'n2', namespace: 'sell_off', type: 'buyer_select', config: {} },
  ]
  const opts = { lastCompletedNamespace: 'sell_off', walkStatus: 200, executionStatus: 'completed', successNamespaces: [] as string[] }

  it('a live sale makes the node buyer the winning partner with one attempt', () => {
    const f = computeSightingFinalize({ prospect_trades: done({ body: {} }), sell_off: done(nodeOutput('sold')) }, nodes, opts)
    expect(f).toMatchObject({ winning_partner_slug: 'tripoint', winning_bid_cents: null, partners_attempted: 1, partners_responded: 1, reject_reason: null })
  })

  it('a no_sale ending the run is attributed to the node with its reason', () => {
    const f = computeSightingFinalize({ prospect_trades: done({ body: {} }), sell_off: done(nodeOutput('no_sale')) }, nodes, opts)
    expect(f).toMatchObject({ winning_partner_slug: null, partners_attempted: 2, reject_reason: 'buyer_select:declined_by_buyer' })
  })

  it('a rehearsal beside the legacy tripoint_ping leaves the code node summary in charge (Stage A)', () => {
    const withPing: NodeDefinition[] = [...nodes, { id: 'n3', namespace: 'tripoint_ping', type: 'code', config: {} }]
    const rehearsed = nodeOutput('deferred', { mode_effective: 'decide_only', reason: 'decide_only', considered: [{ partner: 'tripoint', priority: 1, payout_cents: 2190, outcome: 'rehearsed' }] })
    const f = computeSightingFinalize(
      { prospect_trades: done({ body: {} }), sell_off: done(rehearsed), tripoint_ping: done({ skipped: false, qualified: true, resultCode: 1001, createLead: { id: 'L-9' } }) },
      withPing,
      { ...opts, lastCompletedNamespace: 'tripoint_ping' },
    )
    expect(f).toMatchObject({ winning_partner_slug: 'tripoint', partners_attempted: 1 })
  })
})
