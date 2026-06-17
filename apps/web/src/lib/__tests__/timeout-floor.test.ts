import { describe, it, expect } from 'vitest'
import { timeoutFloorMs, timeoutBelowFloor } from '../timeout-floor'

describe('timeoutFloorMs', () => {
  it('uses the dispatch/DB floor for code, constants, and data_store', () => {
    expect(timeoutFloorMs('code')).toBe(150)
    expect(timeoutFloorMs('constants')).toBe(150)
    // data_store is a Cloudflare KV round-trip, not in-memory (#172).
    expect(timeoutFloorMs('data_store')).toBe(150)
  })

  it('uses the network floor for outbound nodes', () => {
    for (const t of ['partner_bid', 'integration', 'salesforce', 'webhook', 'bid_group']) {
      expect(timeoutFloorMs(t)).toBe(50)
    }
  })

  it('uses the in-memory floor for everything else', () => {
    for (const t of ['filter', 'branch', 'transform', 'response', 'exit']) {
      expect(timeoutFloorMs(t)).toBe(10)
    }
    expect(timeoutFloorMs(undefined)).toBe(10)
    expect(timeoutFloorMs('something_new')).toBe(10)
  })
})

describe('timeoutBelowFloor', () => {
  it('returns the floor when the configured timeout is below it', () => {
    expect(timeoutBelowFloor('code', { timeout_ms: 50 })).toBe(150)
    expect(timeoutBelowFloor('salesforce', { timeout_ms: 25 })).toBe(50)
  })

  it('returns null when the timeout clears the floor', () => {
    expect(timeoutBelowFloor('code', { timeout_ms: 150 })).toBeNull()
    expect(timeoutBelowFloor('code', { timeout_ms: 1000 })).toBeNull()
  })

  it('returns null when the timeout is unset or not a number', () => {
    expect(timeoutBelowFloor('code', {})).toBeNull()
    expect(timeoutBelowFloor('code', undefined)).toBeNull()
    expect(timeoutBelowFloor('code', { timeout_ms: '50' as unknown as number })).toBeNull()
  })
})
