import { describe, it, expect, vi } from 'vitest'
import { onBeforeNodeDelete } from '../delete-routing'

describe('onBeforeNodeDelete (issue #61)', () => {
  it('reroutes a node deletion through the curated handler and cancels RF', () => {
    const route = vi.fn()
    const proceed = onBeforeNodeDelete([{ id: 'a' }, { id: 'b' }], route)
    expect(proceed).toBe(false) // RF's raw delete is cancelled
    expect(route).toHaveBeenCalledWith(['a', 'b'])
  })

  it('passes the trigger through to the handler (which protects it itself)', () => {
    const route = vi.fn()
    const proceed = onBeforeNodeDelete([{ id: 'trigger' }], route)
    expect(proceed).toBe(false)
    expect(route).toHaveBeenCalledWith(['trigger'])
  })

  it('lets an edge-only deletion proceed in React Flow (no nodes targeted)', () => {
    const route = vi.fn()
    const proceed = onBeforeNodeDelete([], route)
    expect(proceed).toBe(true)
    expect(route).not.toHaveBeenCalled()
  })
})
