import { describe, it, expect } from 'vitest'
import { NODE_TYPES, NODE_TRAITS } from '@/types/workflow'
import { CARD_KIND, SLOT_GAP, outputHandles, slotColumns, fixedHandleOffsets, handleLeftFractions } from '../handle-geometry'

// The one list of a node's output handles and where they sit (#1576). Before it,
// the handle ids were written out in configuredHandleIds, again in
// handleSortIndex, again in each card, and the two layout copies disagreed about
// a branch's else arm and a parallel's named slots.
const node = (type: string, config: Record<string, unknown> = {}) => ({ type, data: { config } })

describe('outputHandles', () => {
  it('reads every static handle list from the node type traits', () => {
    for (const t of NODE_TYPES) {
      const own = NODE_TRAITS[t].staticHandles
      if (own) expect(outputHandles(node(t)), t).toEqual([...own])
    }
  })

  it('lists a branch arm per branch, and else only when the else is an output', () => {
    const branches = [{ label: 'a' }, { label: 'b' }]
    expect(outputHandles(node('branch', { branches }))).toEqual(['a', 'b', 'else'])
    expect(outputHandles(node('branch', { branches, else_behavior: 'output' }))).toEqual(['a', 'b', 'else'])
    // handleSortIndex always appended else, so an else of "none" still sorted it (merged here).
    expect(outputHandles(node('branch', { branches, else_behavior: 'none' }))).toEqual(['a', 'b'])
    expect(outputHandles(node('branch', { branches, else_behavior: 'error' }))).toEqual(['a', 'b'])
    expect(outputHandles(node('branch', { branches, use_else: false }))).toEqual(['a', 'b'])
    expect(outputHandles(node('branch', { branches: [{ label: 'only' }], else_behavior: 'none' }))).toEqual(['only'])
  })

  it('names a parallel slot by child-N for the legacy list and by the slot id otherwise (#1581)', () => {
    expect(outputHandles(node('parallel', { children: ['x', 'y'] }))).toEqual(['child-0', 'child-1'])
    expect(outputHandles(node('parallel', { children: [{ id: 'fast', label: 'Fast' }, { id: 'slow', label: 'Slow' }] }))).toEqual(['fast', 'slow'])
    expect(outputHandles(node('parallel', { children: [] }))).toEqual([])
  })

  it('gives a latency gate its two outcomes only in check mode, since mark mode passes straight through', () => {
    expect(outputHandles(node('latency_gate', { operation: 'check' }))).toEqual(['within', 'exceeded'])
    expect(outputHandles(node('latency_gate', { operation: 'mark' }))).toEqual([])
    expect(outputHandles(node('latency_gate'))).toEqual([])
  })

  it('gives the end markers no arms, because their output continues the flow', () => {
    expect(outputHandles(node('branch_end'))).toEqual([])
    expect(outputHandles(node('parallel_end'))).toEqual([])
    expect(outputHandles(node('code'))).toEqual([])
    expect(outputHandles({ type: 'trigger', data: {} })).toEqual([])
  })
})

describe('CARD_KIND', () => {
  it('never calls a type with static handles a single output card', () => {
    for (const t of NODE_TYPES) if (NODE_TRAITS[t].staticHandles) expect(CARD_KIND[t], t).not.toBe('single')
  })

  it('keeps exactly the filter and the click check at a fixed width (560e915d, Dan 2026-09-25)', () => {
    expect(NODE_TYPES.filter((t) => CARD_KIND[t] === 'fixed').sort()).toEqual(['buyer_click_check', 'filter'])
  })
})

describe('slotColumns', () => {
  it('lays columns out side by side, centred on the card', () => {
    expect(slotColumns([208])).toEqual([0])
    expect(slotColumns([208, 208])).toEqual([-(208 + SLOT_GAP) / 2, (208 + SLOT_GAP) / 2])
    const cols = slotColumns([100, 300, 200])
    expect(cols[1] - cols[0]).toBe(50 + SLOT_GAP + 150)
    expect(cols[2] - cols[1]).toBe(150 + SLOT_GAP + 100)
    expect(cols[0] - 50 + (cols[2] + 100)).toBeCloseTo(0)
  })
})

describe('fixedHandleOffsets', () => {
  const W = 208
  it('draws a lone wired handle at the centre and moves the other out of its way', () => {
    expect(fixedHandleOffsets('filter', ['pass', 'exit'], new Set(['pass']), W)).toEqual([0, 0.25 * W])
    expect(fixedHandleOffsets('filter', ['pass', 'exit'], new Set(['exit']), W)).toEqual([-0.25 * W, 0])
  })

  it('keeps the card fractions when both or neither are wired', () => {
    const at = (f: number) => (f - 0.5) * W
    expect(fixedHandleOffsets('filter', ['pass', 'exit'], new Set(['pass', 'exit']), W)).toEqual([at(0.3), at(0.7)])
    expect(fixedHandleOffsets('filter', ['pass', 'exit'], new Set(), W)).toEqual([at(0.3), at(0.7)])
    expect(fixedHandleOffsets('buyer_click_check', ['eligible', 'not_eligible'], new Set(['eligible', 'not_eligible']), W)).toEqual([at(0.25), at(0.75)])
  })
})

describe('handleLeftFractions', () => {
  it('reads the published offsets when the layout has run', () => {
    expect(handleLeftFractions('filter', ['pass', 'exit'], [0, 52], 208)).toEqual([0.5, 0.75])
  })

  it('falls back to the card fractions before the first layout', () => {
    expect(handleLeftFractions('filter', ['pass', 'exit'], undefined, 208)).toEqual([0.3, 0.7])
    expect(handleLeftFractions('branch', ['a', 'b', 'else'], undefined, 208)).toEqual([1 / 6, 0.5, 5 / 6])
  })
})
