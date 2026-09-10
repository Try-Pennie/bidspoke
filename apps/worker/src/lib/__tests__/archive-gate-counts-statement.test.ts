/**
 * The gate's day counts read the LATEST archived copy of an execution (#871,
 * #1023).
 *
 * The archive INSERTs and never MERGEs, so a re-archived day leaves more than
 * one row per execution on purpose. Every aggregate over it therefore has to
 * say which copy it means, and the two in this statement mean different things:
 *
 *  - `step_count` takes MAX across the copies, which picks the good copy when a
 *    truncated one sits beside it.
 *  - `archived_incomplete` must take the NEWEST copy. Taking MAX would pick the
 *    worst one, so re-archiving a day to fix an incomplete row would leave the
 *    old incomplete row beside the new complete one and the day would refuse
 *    for ever, on the one refusal nothing else resolves.
 *
 * WHAT A TEST HERE CAN AND CANNOT DO. The statement runs against Snowflake, so
 * this asserts its SHAPE. The semantics were verified separately by running
 * both expressions against Postgres over a fixed row set on 2026-09-10: one
 * execution archived incomplete then re-archived complete, plus one genuinely
 * still incomplete. The old expression counted 2, the new one counts 1, and the
 * step total was unchanged at 12. That is recorded here because a shape
 * assertion alone would pass for a statement that is subtly wrong.
 */
import { describe, it, expect } from 'vitest'
import { countsStatement } from '../archive-gate'

const DAY = '2026-09-01'

describe('countsStatement', () => {
  const sql = countsStatement(DAY)

  it('ranks the copies of an execution newest first', () => {
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY execution_id ORDER BY archived_at_utc DESC\)/)
  })

  it('counts incompleteness only from the newest copy', () => {
    // The `rn = 1` is the whole fix. Without it this reads the worst copy and a
    // re-archive can never clear the day.
    expect(sql).toMatch(/MAX\(CASE WHEN rn = 1 AND archived_incomplete THEN 1 ELSE 0 END\)/)
    expect(sql).not.toMatch(/MAX\(CASE WHEN archived_incomplete THEN 1 ELSE 0 END\)/)
  })

  it('still takes the best copy for the step count, which is a different question', () => {
    // Not the newest: a truncated newest copy beside a good older one should
    // report the good one's steps.
    expect(sql).toMatch(/MAX\(step_count\) AS step_count/)
  })

  it('scopes to the day it was asked about', () => {
    expect(sql).toContain(`'${DAY}'::DATE`)
  })

  it('groups by execution, so duplicates cannot inflate the day', () => {
    expect(sql).toContain('GROUP BY execution_id')
  })
})
