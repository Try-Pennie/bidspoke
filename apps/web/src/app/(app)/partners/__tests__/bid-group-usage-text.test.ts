/** The Bid Group tab's Bids in row (#2137), worded as the settled design words it. */
import { describe, expect, it } from 'vitest'
import type { PartnerUsage } from '@/lib/api'
import { bidsInSentences, joinNames } from '../bid-group-usage-text'

const names = new Map([['t', 'Tripoint'], ['a', 'AmOne'], ['g', 'GigFi']])
const bg = (name: string, is_active: boolean, mode: 'highest_bid' | 'cascade' | 'tiered', partner_ids: string[], fallback_partner_id: string | null = null) => ({ workflow_id: name, workflow_name: name, is_active, node_id: 'n', mode, partner_ids, fallback_partner_id })
const usage = (u: Partial<PartnerUsage>): PartnerUsage => ({ bid_group: [], partner_bid: [], latency_gate: [], ...u })

describe('bidsInSentences', () => {
  it('names Main Flow and its switched off copy together, then who is asked and which bid wins (the measured production case)', () => {
    expect(bidsInSentences(usage({ bid_group: [bg('Main Flow', true, 'highest_bid', ['t', 'a']), bg('Main Flow (v2)', false, 'highest_bid', ['t', 'a'])] }), names)).toEqual([
      'Main Flow and Main Flow (v2) (switched off). On each lead, Tripoint and AmOne are both asked for a bid, and the higher bid wins.',
    ])
  })

  it('words three partners, one partner, a cascade and a tiered group', () => {
    expect(bidsInSentences(usage({ bid_group: [bg('W', true, 'highest_bid', ['t', 'a', 'g'])] }), names)).toEqual(['W. On each lead, Tripoint, AmOne and GigFi are all asked for a bid, and the highest bid wins.'])
    expect(bidsInSentences(usage({ bid_group: [bg('W', true, 'highest_bid', ['t'])] }), names)).toEqual(['W. On each lead, Tripoint is asked for a bid.'])
    expect(bidsInSentences(usage({ bid_group: [bg('W', true, 'cascade', ['t', 'a'])] }), names)).toEqual(['W. On each lead, Tripoint, then AmOne are asked in turn, and the first bid wins.'])
    expect(bidsInSentences(usage({ bid_group: [bg('W', true, 'tiered', ['t', 'a'])] }), names)).toEqual(['W. On each lead, its tiers are asked in turn until one has a winner; Tripoint and AmOne are in them.'])
  })

  it('says a partner missing from the list rather than showing its id, and lists Partner Bid steps after', () => {
    expect(bidsInSentences(usage({ bid_group: [bg('W', true, 'highest_bid', ['t', 'zz'])], partner_bid: [{ workflow_id: 'le', workflow_name: 'Lead Economy', is_active: true, node_id: 'n' }] }), names)).toEqual([
      'W. On each lead, Tripoint and a partner not on this list are both asked for a bid, and the higher bid wins.',
      'Lead Economy, in a Partner Bid step.',
    ])
  })

  it('says a fallback is asked only once nobody wins, never as if it bid on every lead', () => {
    expect(bidsInSentences(usage({ bid_group: [bg('W', true, 'highest_bid', ['t', 'a'], 'g')] }), names)).toEqual(['W. On each lead, Tripoint and AmOne are both asked for a bid, and the higher bid wins. If nobody wins, GigFi is asked last.'])
    expect(bidsInSentences(usage({ bid_group: [bg('W', true, 'highest_bid', [], 'g')] }), names)).toEqual(['W. If nobody wins, GigFi is asked last.'])
  })

  it('says nothing for no steps', () => {
    expect(bidsInSentences(usage({}), names)).toEqual([])
    expect(joinNames([])).toBe('')
  })
})
