/**
 * The order a run's step rows are listed in (#3084): by step order, with the
 * ties rows written before #3084 can hold broken the same way on every read.
 */
import { describe, expect, it } from 'vitest'
import { sortStepRows } from '../step-row-order'

const row = (id: string, step_namespace: string, step_order: number | null, started_at: string, step_type = 'code') =>
  ({ id, step_namespace, step_order, started_at, step_type })

describe('sortStepRows (#3084)', () => {
  it('lists rows by step order', () => {
    const rows = [row('c', 'third', 2, '2026-10-30T12:00:00.000Z'), row('a', 'first', 0, '2026-10-30T12:00:00.000Z'), row('b', 'second', 1, '2026-10-30T12:00:00.000Z')]
    expect(sortStepRows(rows).map((r) => r.step_namespace)).toEqual(['first', 'second', 'third'])
  })

  it('a run written before #3084: a slot step tied with parallel_end comes before it', () => {
    // parallel_end's row starts when the block does, before the slot's later step.
    const rows = [
      row('z', 'collections_apex', 6, '2026-10-30T12:00:00.300Z', 'salesforce'),
      row('a', 'parallel_end_1', 6, '2026-10-30T12:00:00.000Z', 'parallel_end'),
    ]
    expect(sortStepRows(rows).map((r) => r.step_namespace)).toEqual(['collections_apex', 'parallel_end_1'])
  })

  it('a run written before #3084: two slot steps sharing an order are listed by which started first, on every read', () => {
    const later = row('a', 'trades_request', 4, '2026-10-30T12:00:00.200Z', 'salesforce')
    const earlier = row('b', 'send_salesforce_inquiry', 4, '2026-10-30T12:00:00.001Z', 'webhook')
    expect(sortStepRows([later, earlier]).map((r) => r.step_namespace)).toEqual(['send_salesforce_inquiry', 'trades_request'])
    expect(sortStepRows([earlier, later]).map((r) => r.step_namespace)).toEqual(['send_salesforce_inquiry', 'trades_request'])
  })

  it('rows sharing an order and a start are listed by id, so the order is stable', () => {
    const rows = [row('b', 'two', 3, '2026-10-30T12:00:00.000Z'), row('a', 'one', 3, '2026-10-30T12:00:00.000Z')]
    expect(sortStepRows(rows).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('an archived bundle, held in id order, is listed by step order', () => {
    const rows = [row('0f', 'exit', 3, '2026-10-30T12:00:00.300Z'), row('1a', 'validate', 0, '2026-10-30T12:00:00.000Z'), row('9c', 'score', 1, '2026-10-30T12:00:00.100Z'), row('a3', 'bid', 2, '2026-10-30T12:00:00.200Z')]
    expect(sortStepRows(rows).map((r) => r.step_namespace)).toEqual(['validate', 'score', 'bid', 'exit'])
  })

  it('an order read as text sorts as a number', () => {
    const rows = [{ id: 'a', step_order: '10' }, { id: 'b', step_order: '9' }]
    expect(sortStepRows(rows).map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('a row with no order goes last, keeping its place among the others with none', () => {
    const rows = [row('n1', 'none_first', null, ''), row('x', 'ordered', 5, ''), row('n2', 'none_second', null, '')]
    expect(sortStepRows(rows).map((r) => r.step_namespace)).toEqual(['ordered', 'none_first', 'none_second'])
  })

  it('returns a copy, leaving the rows it was given as they were', () => {
    const rows = [row('b', 'second', 1, ''), row('a', 'first', 0, '')]
    sortStepRows(rows)
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })
})
