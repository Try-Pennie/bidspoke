import { describe, it, expect } from 'vitest'
import { timeoutFloorMs, timeoutFloorReason } from '../timeout-floor'
// The worker is the source of truth; the web copy is a hand-kept mirror. The two
// apps share no package, so this test reaches across the workspace and fails CI
// the moment the floors diverge. The worker module is dependency-free, so it
// imports cleanly into the web (node) test environment.
import { suggestionFloorMs, suggestionFloorReason } from '../../../../worker/src/lib/timeout-floor'

// Every node type either app knows about, plus a couple of unknowns to pin the
// default. If a new node type with a non-default floor is added, list it here.
const NODE_TYPES = [
  'code',
  'constants',
  'partner_bid',
  'integration',
  'salesforce',
  'webhook',
  'bid_group',
  'filter',
  'branch',
  'branch_end',
  'transform',
  'parallel',
  'parallel_end',
  'response',
  'exit',
  'trigger',
  'latency_gate',
  'data_store',
  'region',
  'something_unknown',
  '',
]

describe('timeout floor web↔worker sync', () => {
  it('web mirror matches the worker source of truth for every node type', () => {
    for (const t of NODE_TYPES) {
      expect(timeoutFloorMs(t), `floor mismatch for "${t}"`).toBe(suggestionFloorMs(t))
    }
  })

  it('agrees on the undefined case', () => {
    expect(timeoutFloorMs(undefined)).toBe(suggestionFloorMs(undefined))
  })

  it('floor reason copy matches the worker for every node type', () => {
    for (const t of NODE_TYPES) {
      expect(timeoutFloorReason(t), `reason mismatch for "${t}"`).toBe(suggestionFloorReason(t))
    }
    expect(timeoutFloorReason(undefined)).toBe(suggestionFloorReason(undefined))
  })
})
