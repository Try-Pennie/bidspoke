import { describe, it, expect } from 'vitest'
import { measureSettle } from '../settle'

describe('measureSettle', () => {
  it('refuses to report a window when it sampled nothing, rather than reporting zero', () => {
    // A measurement of nothing and a measurement of zero are different answers.
    // The first version of this script reported `measured: 0` after its query
    // errored, which read exactly like "the cost lands instantly" (L98, L11).
    const result = measureSettle([])

    expect(result.sampled).toBe(0)
    expect(result.settledFromMinute).toBeNull()
    expect(result.reason).toMatch(/no executions/i)
  })

  it('reports the age beyond which every sampled execution has its cost', () => {
    const rows = [
      { ageMinutes: 1, hasCost: false },
      { ageMinutes: 3, hasCost: false },
      { ageMinutes: 6, hasCost: true },
      { ageMinutes: 20, hasCost: true },
    ]

    const result = measureSettle(rows)

    expect(result.sampled).toBe(4)
    expect(result.settledFromMinute).toBe(6)
    expect(result.oldestUnsettledMinutes).toBe(3)
  })

  it('pushes the window out to the oldest execution still missing its cost', () => {
    const rows = [
      { ageMinutes: 2, hasCost: true },
      { ageMinutes: 45, hasCost: false },
      { ageMinutes: 50, hasCost: true },
    ]

    const result = measureSettle(rows)

    expect(result.oldestUnsettledMinutes).toBe(45)
    expect(result.settledFromMinute).toBe(50)
  })

  it('reports no settled point when every sampled execution is still missing its cost', () => {
    const result = measureSettle([{ ageMinutes: 5, hasCost: false }])

    expect(result.settledFromMinute).toBeNull()
    expect(result.reason).toMatch(/never settled/i)
  })
})
