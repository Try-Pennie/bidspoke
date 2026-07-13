/**
 * #352: the Degraded filter tab filters by status (degraded is a status, not an
 * outcome), while the outcome tabs filter by outcome. 'all' applies no filter.
 */
import { describe, it, expect } from 'vitest'
import { listParamsForFilter, FILTER_TABS, tabClass } from '../ExecutionListPanel'

describe('filter tab layout', () => {
  // Only the active tab used to carry border-b-2. That made it 2px taller than
  // its siblings, and because the flex row stretches every button to the tallest
  // height, the inactive labels centered 1px lower. Every tab must reserve the
  // same 2px bottom border so all five labels share a baseline.
  it('reserves the bottom border on inactive tabs so all labels align', () => {
    expect(tabClass(true)).toContain('border-b-2')
    expect(tabClass(false)).toContain('border-b-2')
    expect(tabClass(false)).toContain('border-transparent')
  })

  // The panel is a fixed 288px (w-72) and shows all five tabs on one row. At
  // 12px type with padding, the labels overflowed and the last tab ('Failed')
  // was clipped. Roughly 30 characters total is the budget before it clips
  // again, so this guards against a label creeping back up in length.
  it('keeps the labels short enough to fit the 288px panel', () => {
    const totalChars = FILTER_TABS.reduce((n, tab) => n + tab.label.length, 0)
    expect(totalChars).toBeLessThanOrEqual(30)
  })
})

describe('listParamsForFilter (#352)', () => {
  it('maps the degraded tab to a status filter, not an outcome filter', () => {
    expect(listParamsForFilter('degraded')).toEqual({ status: 'degraded' })
  })

  it('maps outcome tabs to an outcome filter', () => {
    expect(listParamsForFilter('successful')).toEqual({ outcome: 'successful' })
    expect(listParamsForFilter('completed')).toEqual({ outcome: 'completed' })
    expect(listParamsForFilter('failed')).toEqual({ outcome: 'failed' })
  })

  it('applies no filter for the all tab', () => {
    expect(listParamsForFilter('all')).toEqual({})
  })
})
