import { describe, it, expect } from 'vitest'
import { baseNodeTypes, nodeTypes } from '../registry'
import { GenericNode } from '../GenericNode'
import { NODE_TYPES } from '@/types/workflow'

/**
 * The canvas must be able to render EVERY node type the definition format allows.
 * A type with no entry here renders as a broken/blank node, which is how a stray
 * or legacy definition takes the whole canvas down.
 *
 * partner_bid is the retired case (#645): Bid Group superseded it, it was hidden
 * from the palette in 2931b59, and no workflow or workflow_version in the database
 * contains one. Its bespoke card is gone, but the type still resolves, so a
 * definition that somehow carries one still draws instead of breaking.
 */
describe('canvas node registry', () => {
  it('renders every node type the definition format allows', () => {
    const missing = NODE_TYPES.filter((t) => !(t in baseNodeTypes))
    expect(missing).toEqual([])
  })

  it('wraps every card in the badge HOC, so badges are never per-card wiring', () => {
    expect(Object.keys(nodeTypes).sort()).toEqual(Object.keys(baseNodeTypes).sort())
  })

  it('falls back to the generic card for the retired partner_bid type', () => {
    expect(baseNodeTypes.partner_bid).toBe(GenericNode)
  })

  it('still gives bid_group, which replaced it, its own card', () => {
    expect(baseNodeTypes.bid_group).not.toBe(GenericNode)
  })
})
