import { describe, it, expect } from 'vitest'
import { NODE_TYPES as SAVED_NODE_TYPES, NODE_TRAITS } from '@bidspoke/node-types'
import { timeoutFloorMs, timeoutFloorReason } from '../timeout-floor'
// The worker is the source of truth; the web copy is a hand-kept mirror. This
// test reaches across the workspace and fails CI the moment the floors diverge.
// The worker module has no worker only dependency, so it imports cleanly into
// the web (node) test environment.
import { suggestionFloorMs, suggestionFloorReason } from '../../../../worker/src/lib/timeout-floor'

// Every saved node type, derived from the shared list rather than kept by hand
// (#1411), plus the canvas only names and a couple of unknowns to pin the
// default. `integration` is here as an UNKNOWN: no live definition carries it,
// and both copies now give it the in memory floor.
const NODE_TYPES = [...SAVED_NODE_TYPES, 'trigger', 'region', 'integration', 'something_unknown', '']

describe('timeout floor traits (#1411)', () => {
  it('every network node type gets the network floor and every dispatch type the dispatch floor, in both copies', () => {
    for (const t of SAVED_NODE_TYPES) {
      const expected = NODE_TRAITS[t].dispatchOrDb ? 150 : NODE_TRAITS[t].network ? 50 : 10
      expect(timeoutFloorMs(t), `web floor for ${t}`).toBe(expected)
      expect(suggestionFloorMs(t), `worker floor for ${t}`).toBe(expected)
    }
  })

  it('a spelling no live definition carries is not a network node any more', () => {
    expect(timeoutFloorMs('integration')).toBe(10)
    expect(suggestionFloorMs('integration')).toBe(10)
  })
})

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
