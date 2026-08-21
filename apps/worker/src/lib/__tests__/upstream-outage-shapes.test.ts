/**
 * Carrying the specific error into the aggregated upstream alert (#834).
 *
 * The alert said "Salesforce appears degraded. 31 leads failed sharing this
 * cause" and told the reader to check the Salesforce status page. Every one of
 * those runs carried a far more specific error, one click away in the executions
 * list:
 *
 *   Salesforce API error (403): [{"message":"ConcurrentPerOrgLongTxn Limit
 *   exceeded.","errorCode":"REQUEST_LIMIT_EXCEEDED"}]
 *
 * That is not a vendor outage. It is our own call pattern hitting Salesforce's
 * concurrency governor, so the canned advice steered the diagnosis away from the
 * cause (L36). The message was already in memory when the payload was built and
 * was simply thrown away.
 *
 * The normalizer is calibrated against real prod messages, not invented ones: a
 * 60-row sample on 2026-08-21 held 6 distinct raw strings for 4 real causes,
 * because three `Code returned error response` failures differed only by the
 * lead's UUID. Grouping on the raw string would have reported them as three
 * separate shapes, which is exactly the fragmentation the issue warned about.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeErrorShape,
  topErrorShapes,
  describeHowToCheck,
  groupOutages,
  UPSTREAM_OUTAGE_CAUSES,
  MAX_ERROR_SHAPES,
  MAX_SHAPE_SAMPLE_CHARS,
} from '../upstream-outage'

// Measured from prod on 2026-08-21, copied rather than composed. The UUIDs are
// the whole point of the third group, so they are real in shape and arbitrary in
// value.
const SF_GOVERNOR =
  'Salesforce API error (403): [{"message":"ConcurrentPerOrgLongTxn Limit exceeded.","errorCode":"REQUEST_LIMIT_EXCEEDED"}]'
// The dash is written as an escape rather than the literal character: the style
// gate cannot tell a line quoting a production string from a line written in
// prose, and this fixture has to stay byte-identical to what the engine emits.
const CODE_500 = (id: string) =>
  `Code returned error response: HTTP 500 \u2014 {"lead_id":"${id}","status":"error","reason":"internal server error"}`
const TIMEOUT = 'Step timed out after 30000ms (in-flight upstream call canceled via abort signal)'
const SF_5XX = 'Salesforce API error (503): Service Unavailable'

describe('normalizeErrorShape', () => {
  it('collapses messages that differ only by a lead id', () => {
    const a = normalizeErrorShape(CODE_500('1d1926c6-5cb1-420f-8bd2-d7992d320372'))
    const b = normalizeErrorShape(CODE_500('372d6abc-586f-4759-9206-49b78ba58526'))
    const c = normalizeErrorShape(CODE_500('adf7d369-a1db-4edc-978a-b69813bcd026'))

    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  // 18 characters, which is the real length of a Salesforce id. A shorter or
  // longer token is not id-shaped and must be left alone, which is what keeps
  // ConcurrentPerOrgLongTxn intact in the test below.
  it('collapses a Salesforce record id', () => {
    expect(normalizeErrorShape('Could not update prospect 0035f00000AbCdEfGH')).toBe(
      normalizeErrorShape('Could not update prospect 0035f00000ZzYyXxWw'),
    )
  })

  it('collapses a varying duration so one timeout is one shape', () => {
    expect(normalizeErrorShape('Step timed out after 30000ms')).toBe(
      normalizeErrorShape('Step timed out after 12000ms'),
    )
  })

  // The other half of the contract, and the half an over-eager normalizer breaks:
  // it must not erase what distinguishes two genuinely different causes (L104).
  it('keeps genuinely different messages apart', () => {
    const shapes = new Set([SF_GOVERNOR, TIMEOUT, SF_5XX, CODE_500('x')].map(normalizeErrorShape))
    expect(shapes.size).toBe(4)
  })

  it('preserves the words that name the cause', () => {
    const shape = normalizeErrorShape(SF_GOVERNOR)
    expect(shape).toMatch(/ConcurrentPerOrgLongTxn/)
    expect(shape).toMatch(/REQUEST_LIMIT_EXCEEDED/)
  })

  // A digit-bearing status code is part of the identity of the error, not noise.
  // Erasing it would merge a 403 governor rejection with a 503 outage, which are
  // different diagnoses with different remedies.
  it('does not merge two Salesforce errors that differ by status code', () => {
    expect(normalizeErrorShape('Salesforce API error (403): x')).not.toBe(
      normalizeErrorShape('Salesforce API error (503): x'),
    )
  })

  it('handles a null, empty or whitespace message without throwing', () => {
    for (const bad of [null, undefined, '', '   ']) {
      expect(() => normalizeErrorShape(bad)).not.toThrow()
      expect(normalizeErrorShape(bad)).toBe('')
    }
  })
})

describe('topErrorShapes', () => {
  it('ranks by count and keeps a readable sample of the raw message', () => {
    const { shapes, otherShapeCount } = topErrorShapes([SF_GOVERNOR, SF_GOVERNOR, SF_5XX])

    expect(shapes[0].count).toBe(2)
    expect(shapes[0].sample).toContain('ConcurrentPerOrgLongTxn')
    expect(shapes[1].count).toBe(1)
    expect(otherShapeCount).toBe(0)
  })

  // Keeping the aggregate honest: the reader must be able to tell "this is the
  // whole story" from "this is the top of a longer list" (L11).
  it('reports how many distinct shapes it did not show', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => `Distinct failure ${s} occurred`)
    const { shapes, otherShapeCount } = topErrorShapes(many)

    expect(shapes.length).toBe(MAX_ERROR_SHAPES)
    expect(otherShapeCount).toBe(6 - MAX_ERROR_SHAPES)
  })

  it('truncates a long sample so the Slack block stays under its cap', () => {
    const huge = `Salesforce API error (403): ${'x'.repeat(5000)}`
    const { shapes } = topErrorShapes([huge])

    expect(shapes[0].sample.length).toBeLessThanOrEqual(MAX_SHAPE_SAMPLE_CHARS)
    // Truncation is visible rather than silent, so nobody reads a cut string as
    // the whole message.
    expect(shapes[0].sample.endsWith('...')).toBe(true)
  })

  // The failure path the issue asks for by name: a group whose rows carry no
  // usable message must still produce an alert, never throw and lose the page.
  it('returns nothing rather than throwing when every message is empty', () => {
    const { shapes, otherShapeCount } = topErrorShapes([null, undefined, '', '  '])

    expect(shapes).toEqual([])
    expect(otherShapeCount).toBe(0)
  })
})

describe('describeHowToCheck', () => {
  // The actual complaint. A limit or governor rejection is about our own call
  // pattern, so pointing at the vendor's status page sends the reader the wrong
  // way for the case that actually happened.
  it('points at our call pattern when the dominant error is a limit or governor rejection', () => {
    const { shapes } = topErrorShapes([SF_GOVERNOR, SF_GOVERNOR, SF_GOVERNOR])
    const advice = describeHowToCheck('Salesforce', shapes)

    expect(advice).toMatch(/concurrent|call pattern|volume/i)
    expect(advice).not.toMatch(/status page/i)
  })

  it('points at vendor health when the dominant error is a 5xx', () => {
    const { shapes } = topErrorShapes([SF_5XX, SF_5XX])
    expect(describeHowToCheck('Salesforce', shapes)).toMatch(/status page|health/i)
  })

  // When there is nothing to go on, it must not assert a cause (L36, and the
  // same complaint as #746). Naming no cause is better than naming the wrong one.
  it('asserts no cause when there are no shapes to judge', () => {
    const advice = describeHowToCheck('Salesforce', [])

    expect(advice).not.toMatch(/status page/i)
    expect(advice).not.toMatch(/concurrent/i)
    expect(advice).toMatch(/review/i)
  })

  it('names the dominant shape only, not a mixture, when shapes disagree', () => {
    // One governor rejection and three timeouts: the timeout wins, so the advice
    // must not claim a concurrency problem on the strength of the minority.
    const { shapes } = topErrorShapes([SF_GOVERNOR, TIMEOUT, TIMEOUT, TIMEOUT])
    expect(shapes[0].sample).toContain('timed out')
    expect(describeHowToCheck('Salesforce', shapes)).not.toMatch(/concurrent/i)
  })
})

describe('groupOutages carries the shapes through', () => {
  const names = new Map([['wf-1', 'Main Flow']])
  const row = (error_message: string) => ({
    workflow_id: 'wf-1',
    error_message,
    completed_at: '2026-08-21T12:00:30.000Z',
    failed_step_type: 'salesforce',
  })
  const windowStart = Date.parse('2026-08-21T12:00:00.000Z')

  it('reports the specific error alongside the coarse cause label', () => {
    const groups = groupOutages([row(SF_GOVERNOR), row(SF_GOVERNOR), row(SF_5XX)], names, windowStart)

    expect(groups.length).toBe(1)
    expect(groups[0].cause.key).toBe('salesforce')
    expect(groups[0].count).toBe(3)
    expect(groups[0].shapes[0].count).toBe(2)
    expect(groups[0].shapes[0].sample).toContain('ConcurrentPerOrgLongTxn')
  })

  it('keeps the existing count and workflow behaviour intact', () => {
    const groups = groupOutages([row(SF_GOVERNOR), row(SF_GOVERNOR)], names, windowStart)

    expect(groups[0].workflowNames).toEqual(['Main Flow'])
    expect(groups[0].otherShapeCount).toBe(0)
  })

  it('excludes rows outside the window from the shapes as well as the count', () => {
    const stale = { ...row(SF_5XX), completed_at: '2026-08-21T11:00:00.000Z' }
    const groups = groupOutages([row(SF_GOVERNOR), stale], names, windowStart)

    expect(groups[0].count).toBe(1)
    expect(groups[0].shapes.length).toBe(1)
    expect(groups[0].shapes[0].sample).toContain('ConcurrentPerOrgLongTxn')
  })

  it('is unaffected by a cause list with no matching rows', () => {
    expect(groupOutages([row('some unrecognised failure')], names, windowStart, UPSTREAM_OUTAGE_CAUSES)).toEqual([])
  })
})
