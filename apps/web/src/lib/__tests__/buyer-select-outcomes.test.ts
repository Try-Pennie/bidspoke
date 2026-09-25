import { describe, it, expect } from 'vitest'
import { NODE_TRAITS } from '@/types/workflow'
import { buyerSelectRequiredHandles } from '../workflow-validation'
import { ROUTE_HEADLINES } from '@/app/(app)/workflows/[id]/executions/[executionId]/BuyersConsidered'

// #1582: buyer_select's exits were copied by hand into the execution view and
// into the save check, so a new outcome would show nothing on the execution
// page and go unchecked on save. Both now read the node type's own list; these
// fail if either stops covering an exit in it.
const EXITS = NODE_TRAITS.buyer_select.staticHandles ?? []

describe('buyer_select exits', () => {
  it('has a list to check against', () => {
    expect(EXITS.length).toBeGreaterThan(0)
  })

  it.each(EXITS)('the execution view says what the %s exit did', (exit) => {
    expect(ROUTE_HEADLINES[exit]).toBeTypeOf('function')
  })

  it('the save check requires every exit when the node can defer', () => {
    expect(buyerSelectRequiredHandles({ mode: 'decide_only' })).toEqual([...EXITS])
    expect(buyerSelectRequiredHandles({ mode: 'live', live_percent_env: 'SHARE' })).toEqual([...EXITS])
  })

  it('the save check requires every exit but deferred when the node cannot defer', () => {
    expect(buyerSelectRequiredHandles({ mode: 'live' })).toEqual(EXITS.filter((h) => h !== 'deferred'))
  })
})
