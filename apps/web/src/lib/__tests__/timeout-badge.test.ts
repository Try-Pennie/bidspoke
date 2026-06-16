import { describe, it, expect } from 'vitest'
import { NO_TIMEOUT_BADGE_TYPES, nodeTypeGetsTimeoutBadge } from '../timeout-badge'

// The timeout-warning badge is attached once to the whole nodeTypes registry, so
// the canvas behaviour is fully determined by this opt-out set: every node type
// shows the badge by default, only these three are excluded. If someone adds a
// new node type and forgets it here, it correctly gets the badge automatically —
// these tests guard the inverse: that the exclusion set does not silently grow.

describe('nodeTypeGetsTimeoutBadge', () => {
  it('excludes exactly the trigger and the two passive join markers', () => {
    expect([...NO_TIMEOUT_BADGE_TYPES].sort()).toEqual(['branch_end', 'parallel_end', 'trigger'])
  })

  it('returns false for every excluded type', () => {
    for (const type of NO_TIMEOUT_BADGE_TYPES) {
      expect(nodeTypeGetsTimeoutBadge(type)).toBe(false)
    }
  })

  // Every node type that runs with a per-step timeout must get the badge. This
  // mirrors the live nodeTypes registry in WorkflowCanvas minus the excluded
  // three; data_store is called out because its missing badge is what motivated
  // making this universal.
  it.each([
    'data_store',
    'code',
    'constants',
    'salesforce',
    'partner_bid',
    'bid_group',
    'bid_evaluation',
    'webhook',
    'filter',
    'branch',
    'transform',
    'response',
    'exit',
    'parallel',
    'latency_gate',
    'achieve_offers',
    'region',
  ])('returns true for %s', (type) => {
    expect(nodeTypeGetsTimeoutBadge(type)).toBe(true)
  })

  it('returns true for an unknown / future node type by default', () => {
    expect(nodeTypeGetsTimeoutBadge('some_new_node_type')).toBe(true)
  })
})
