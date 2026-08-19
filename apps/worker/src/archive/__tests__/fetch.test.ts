import { describe, it, expect } from 'vitest'
import { assessBatch, groupStepsByExecution, POSTGREST_ROW_CAP } from '../fetch'

describe('assessBatch', () => {
  it('reports agreement when the batched fetch returned every row', () => {
    const result = assessBatch({ rowsExpected: 716, rowsReturned: 716 })

    expect(result.truncated).toBe(false)
    expect(result.agree).toBe(true)
    expect(result.usable).toBe(true)
  })

  it('refuses a batch that hit the row cap, because truncation looks like speed', () => {
    // Measured on prod: a 150-execution batch returned 1,000 rows where the
    // per-execution shape returned 1,690, and the truncated run reported a
    // BETTER speedup than the correct one, because it fetched less. Silent
    // truncation presents as a performance win.
    const result = assessBatch({ rowsExpected: 1690, rowsReturned: POSTGREST_ROW_CAP })

    expect(result.truncated).toBe(true)
    expect(result.agree).toBe(false)
    expect(result.usable).toBe(false)
    expect(result.reason).toMatch(/cap/i)
  })

  it('refuses a short batch even when the cap was not reached', () => {
    // Losing rows for any other reason is still losing rows. The archive would
    // be short and the deletion gate would compare against a count nobody can
    // reconcile.
    const result = assessBatch({ rowsExpected: 500, rowsReturned: 499 })

    expect(result.truncated).toBe(false)
    expect(result.agree).toBe(false)
    expect(result.usable).toBe(false)
    expect(result.reason).toMatch(/fewer/i)
  })
})

describe('groupStepsByExecution', () => {
  it('groups steps under their execution and leaves an execution with none empty', () => {
    const steps = [
      { execution_id: 'a', step_order: 1 },
      { execution_id: 'b', step_order: 1 },
      { execution_id: 'a', step_order: 2 },
    ]

    const grouped = groupStepsByExecution(steps)

    expect(grouped.get('a')).toHaveLength(2)
    expect(grouped.get('b')).toHaveLength(1)
    expect(grouped.get('never-ran')).toBeUndefined()
  })

  it('throws on a step with no execution id rather than silently dropping it', () => {
    // A dropped step is a short bundle, and a short bundle is the one failure
    // the deletion gate cannot see.
    expect(() => groupStepsByExecution([{ step_order: 1 }])).toThrow(/execution_id/)
  })
})
