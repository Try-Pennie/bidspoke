import { describe, it, expect } from 'vitest'
import { matchTradesToEvaluations, ACHIEVE_COLS } from '../achieve-export'
import { buildMergeSql, formatValue } from '../sightings-export'

describe('matchTradesToEvaluations', () => {
  it('pairs evaluations with their execution trades output', () => {
    const out = matchTradesToEvaluations(
      [
        { id: 'a', execution_id: 'exec-1' },
        { id: 'b', execution_id: 'exec-2' },
      ],
      [{ execution_id: 'exec-1', output: { status: 200, body: { trades: [1, 2] } } }]
    )
    expect(out).toEqual([{ id: 'a', trades: { status: 200, body: { trades: [1, 2] } } }])
  })

  it('returns empty when no steps match', () => {
    expect(matchTradesToEvaluations([{ id: 'a', execution_id: 'x' }], [])).toEqual([])
  })
})

describe('variant column merge SQL', () => {
  it('formats variant values as escaped JSON strings', () => {
    expect(formatValue({ a: 1, note: "it's nested" }, 'variant')).toBe(
      `'{"a":1,"note":"it''s nested"}'`
    )
    expect(formatValue(null, 'variant')).toBe('NULL')
  })

  it('survives a Snowflake-literal round trip for backslashes and quotes', () => {
    // Snowflake single-quoted literals treat '' as one quote and \\ as one
    // backslash. Undo both and the payload must JSON.parse back to the input.
    const input = { path: 'a\\b', quote: `say "hi" and 'bye'`, nested: { arr: [1, 'two'] } }
    const literal = formatValue(input, 'variant')
    expect(literal.startsWith("'") && literal.endsWith("'")).toBe(true)
    const unescaped = literal.slice(1, -1).replace(/''/g, "'").replace(/\\\\/g, '\\')
    expect(JSON.parse(unescaped)).toEqual(input)
  })

  it('wraps variant columns in PARSE_JSON in the USING projection', () => {
    const sql = buildMergeSql(
      'achieve_evaluations',
      ACHIEVE_COLS,
      [{
        id: 'row-1',
        trace_id: 't',
        execution_id: 'e',
        workflow_id: 'w',
        node_namespace: 'achieve',
        submission_id: null,
        requested_at_utc: '2026-06-11T00:00:00',
        duration_ms: 1200,
        http_status: 200,
        response_status: 'accepted',
        response_reason: null,
        offer_count: 2,
        request_payload: { loan: 1 },
        response_body: { offers: [] },
        offers: [],
        trades: { status: 200 },
      }]
    )
    expect(sql).toContain('PARSE_JSON(request_payload) AS request_payload')
    expect(sql).toContain('PARSE_JSON(trades) AS trades')
    // Non-variant columns stay bare in the projection
    expect(sql).not.toContain('PARSE_JSON(trace_id)')
    expect(sql).toContain('MERGE INTO achieve_evaluations t')
    expect(sql).toContain('ON t.id = s.id')
  })
})
