/**
 * #352: the Degraded filter tab filters by status (degraded is a status, not an
 * outcome), while the outcome tabs filter by outcome. 'all' applies no filter.
 */
import { describe, it, expect } from 'vitest'
import { listParamsForFilter } from '../ExecutionListPanel'

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
