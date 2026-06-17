import { describe, it, expect, vi } from 'vitest'
import { onBeforeNodeDelete } from '../delete-routing'

describe('onBeforeNodeDelete (issue #61)', () => {
  it('reroutes a node deletion through the curated handler and cancels RF', () => {
    const route = vi.fn()
    const proceed = onBeforeNodeDelete([{ id: 'a' }, { id: 'b' }], [], route)
    expect(proceed).toBe(false) // RF's raw delete is cancelled
    expect(route).toHaveBeenCalledWith(['a', 'b'], [])
  })

  it('passes the trigger through to the handler (which protects it itself)', () => {
    const route = vi.fn()
    const proceed = onBeforeNodeDelete([{ id: 'trigger' }], [], route)
    expect(proceed).toBe(false)
    expect(route).toHaveBeenCalledWith(['trigger'], [])
  })

  it('lets an edge-only deletion proceed in React Flow (no nodes targeted)', () => {
    const route = vi.fn()
    const proceed = onBeforeNodeDelete([], [{ id: 'e1' }], route)
    expect(proceed).toBe(true)
    expect(route).not.toHaveBeenCalled()
  })

  it('forwards co-selected edge ids when a node is also deleted (#130)', () => {
    // A node plus an unrelated edge selected together: cancelling RF's delete
    // would otherwise drop the node but leave the edge, so the edge ids must
    // reach the curated handler to be removed alongside the node.
    const route = vi.fn()
    const proceed = onBeforeNodeDelete([{ id: 'a' }], [{ id: 'e1' }, { id: 'e2' }], route)
    expect(proceed).toBe(false)
    expect(route).toHaveBeenCalledWith(['a'], ['e1', 'e2'])
  })
})
