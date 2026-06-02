import { describe, it, expect } from 'vitest'
import { suggestionFloorMs } from '../executions'

describe('suggestionFloorMs', () => {
  it('floors dispatch/DB nodes at the cold round-trip overhead (not their compute-time p99)', () => {
    // Regression: a code node whose successful runs are ~5-14ms was getting a
    // ~25ms suggestion, then timing out on cold dispatch. `constants` looks
    // in-memory but does a KV/Supabase load on a cold miss — same hazard.
    expect(suggestionFloorMs('code')).toBe(150)
    expect(suggestionFloorMs('constants')).toBe(150)
  })

  it('floors network-bound nodes at the HTTP round-trip overhead', () => {
    for (const t of ['partner_bid', 'integration', 'salesforce', 'webhook', 'bid_group']) {
      expect(suggestionFloorMs(t)).toBe(50)
    }
  })

  it('keeps in-memory nodes at the 10ms floor', () => {
    for (const t of ['filter', 'branch', 'transform', 'exit', 'response', 'parallel', 'bid_evaluation']) {
      expect(suggestionFloorMs(t)).toBe(10)
    }
  })

  it('defaults to the in-memory floor for unknown/undefined node types', () => {
    expect(suggestionFloorMs(undefined)).toBe(10)
    expect(suggestionFloorMs('something_new')).toBe(10)
  })
})
