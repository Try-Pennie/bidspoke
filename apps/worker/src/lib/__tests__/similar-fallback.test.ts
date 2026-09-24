/**
 * The similar workflow fallback for timeout suggestions places EVERY node type
 * (#1411, L233): stable across workflows, stable per subtype, or excluded with a
 * written reason. A type in none of the three used to fall silently to "does
 * not qualify", which read as a decision nobody had made.
 */
import { describe, expect, it } from 'vitest'
import { NODE_TYPES } from '@bidspoke/node-types'
import { SIMILAR_FALLBACK_BY_SUBTYPE, SIMILAR_FALLBACK_EXCLUDED, SIMILAR_FALLBACK_STABLE, qualifiesForSimilarFallback } from '../similar-fallback'

describe('similar fallback placement', () => {
  it('places every node type in exactly one of stable, by subtype, or excluded with a reason', () => {
    const placements = NODE_TYPES.map((t) => ({
      type: t,
      count: [SIMILAR_FALLBACK_STABLE.has(t), SIMILAR_FALLBACK_BY_SUBTYPE.has(t), t in SIMILAR_FALLBACK_EXCLUDED].filter(Boolean).length,
    }))
    expect(placements.filter((p) => p.count !== 1)).toEqual([])
    for (const reason of Object.values(SIMILAR_FALLBACK_EXCLUDED)) expect(reason.length).toBeGreaterThan(20)
  })

  it('keeps the placements the suggester shipped with', () => {
    expect([...SIMILAR_FALLBACK_STABLE].sort()).toEqual(['branch', 'constants', 'exit', 'filter', 'parallel', 'parallel_end', 'response', 'transform'])
    expect([...SIMILAR_FALLBACK_BY_SUBTYPE]).toEqual(['salesforce'])
    expect(Object.keys(SIMILAR_FALLBACK_EXCLUDED).sort()).toEqual(['achieve_offers', 'bid_group', 'branch_end', 'buyer_click_send', 'buyer_select', 'code', 'data_store', 'latency_gate', 'partner_bid', 'webhook'])
  })

  it('qualifies a stable type, a subtyped type only with its subtype, and nothing excluded or unknown', () => {
    expect(qualifiesForSimilarFallback('filter')).toBe(true)
    expect(qualifiesForSimilarFallback('salesforce', 'update')).toBe(true)
    expect(qualifiesForSimilarFallback('salesforce')).toBe(false)
    expect(qualifiesForSimilarFallback('code')).toBe(false)
    expect(qualifiesForSimilarFallback('trigger')).toBe(false)
    expect(qualifiesForSimilarFallback('')).toBe(false)
  })
})
