import { describe, it, expect } from 'vitest'
import { hasTimeoutWarning } from '../timeout-suggestion'

// Presence predicate shared by the corner badge and the node warning glow, so
// the two can never disagree about whether a node needs attention. Mirrors the
// badge's own early-return conditions in TimeoutWarningBadge.

describe('hasTimeoutWarning', () => {
  it('is true when the configured timeout is below the node-type floor', () => {
    // code floor is 150ms; 100ms is sub-floor regardless of history.
    expect(hasTimeoutWarning('code', { timeout_ms: 100 }, null)).toBe(true)
  })

  it('is false when there is no timeout config and no suggestion', () => {
    expect(hasTimeoutWarning('code', {}, null)).toBe(false)
  })

  it('is true when the configured timeout is below the history-based suggestion', () => {
    // suggestedMs = roundUpSmart(max(p99*1.5, floor)) = 15000; 5000 < 15000.
    expect(hasTimeoutWarning('code', { timeout_ms: 5000, retries: 2 }, { p99: 10000, max_ms: 12000 })).toBe(true)
  })

  it('is false when the configured timeout clears the suggestion', () => {
    expect(hasTimeoutWarning('code', { timeout_ms: 20000, retries: 2 }, { p99: 10000, max_ms: 12000 })).toBe(false)
  })

  it('treats an unset timeout as the engine default (30s) against the suggestion', () => {
    // No timeout_ms: effective 30000; suggestedMs = roundUpSmart(45000)=45000 > 30000.
    expect(hasTimeoutWarning('code', {}, { p99: 30000, max_ms: 32000 })).toBe(true)
  })
})
