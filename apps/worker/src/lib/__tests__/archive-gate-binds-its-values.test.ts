/**
 * The gate's Snowflake statements bind their values (#1006).
 *
 * Both of them are built per day, one of them from a list of execution ids, and
 * both used to be assembled by concatenation and defended with
 * `escapeSqlLiteral`. That was correct, and its correctness rested on every
 * future edit remembering to call it. Binding removes the class rather than
 * defending against it, which is the same move the erasure path already made.
 *
 * The values here come from our own records rather than from a URL, so this is
 * not a live injection hole. It is the last archive path where one edit could
 * open one.
 */
import { describe, it, expect } from 'vitest'
import { countsStatement, bundlesStatement } from '../archive-gate'

const DAY = '2026-09-01'

describe('countsStatement', () => {
  const { statement, bindings } = countsStatement(DAY)

  it('carries the day as a binding, not inside the SQL', () => {
    expect(statement).not.toContain(DAY)
    expect(statement).toContain('?::DATE')
    expect(bindings).toEqual([DAY])
  })

  it('still asks the question it asked before', () => {
    // The shape the #871 fix turns on: the newest copy decides incompleteness,
    // the best copy decides the step count.
    expect(statement).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY execution_id ORDER BY archived_at_utc DESC\)/)
    expect(statement).toMatch(/MAX\(CASE WHEN rn = 1 AND archived_incomplete THEN 1 ELSE 0 END\)/)
    expect(statement).toMatch(/MAX\(step_count\) AS step_count/)
    expect(statement).toContain('GROUP BY execution_id')
  })
})

describe('bundlesStatement', () => {
  const IDS = ['01a05cd7-2a00-7000-8000-000000000001', '01a05cd7-2a00-7000-8000-000000000002']
  const { statement, bindings } = bundlesStatement(DAY, IDS)

  it('binds the day and every id, in the order the placeholders appear', () => {
    expect(statement).not.toContain(DAY)
    for (const id of IDS) expect(statement).not.toContain(id)
    expect(bindings).toEqual([DAY, ...IDS])
  })

  it('writes one placeholder per id, so the list cannot silently shorten', () => {
    // A mismatch between placeholders and bindings is a statement error rather
    // than a wrong answer, which is the safe direction, but only if the count
    // is derived from the list rather than written out.
    const placeholders = statement.slice(statement.indexOf('IN (')).match(/\?/g) ?? []
    expect(placeholders).toHaveLength(IDS.length)
  })

  it('takes only the newest copy of each execution', () => {
    expect(statement).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY execution_id ORDER BY archived_at_utc DESC\)/)
    expect(statement).toContain('WHERE rn = 1')
  })

  it('asks for nothing when given no ids, rather than every row of the day', () => {
    // An empty IN list is a syntax error in Snowflake, and the shapes that
    // "helpfully" drop the clause instead return the whole day (L320).
    const empty = bundlesStatement(DAY, [])
    expect(empty.statement).toContain('WHERE FALSE')
    expect(empty.bindings).toEqual([])
  })
})
