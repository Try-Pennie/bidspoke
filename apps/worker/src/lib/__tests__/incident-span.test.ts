import { describe, expect, it } from 'vitest'
import { describeDuration, incidentDurationText, incidentSoFarText, measureIncidentSpan } from '../incident-span'

/**
 * The one span rule (#2101): how long an incident lasted, as the Slack all-clear
 * and the dashboard's incident record both say it. It lives in one module so the
 * two cannot disagree; these tests hold the rule itself, and the Slack and route
 * tests hold each caller to it.
 */
const START = '2026-10-14T10:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000).toISOString()
const NOW = Date.parse(at(600))

describe('measureIncidentSpan', () => {
  it('measures from the start to the recorded end', () => {
    expect(measureIncidentSpan(START, at(92), null, NOW)).toEqual({ kind: 'measured', ms: 92 * 60_000, clearedAt: Date.parse(at(92)) })
  })

  it('measures to now when no end was recorded, and claims no clearing time', () => {
    expect(measureIncidentSpan(START, null, null, NOW)).toEqual({ kind: 'measured', ms: 600 * 60_000, clearedAt: null })
  })

  it('reports the window instead of a span shorter than the window the check judges', () => {
    expect(measureIncidentSpan(START, at(0), 60, NOW)).toEqual({ kind: 'within_window', windowMs: 60 * 60_000 })
    expect(measureIncidentSpan(START, at(59), 60, NOW)).toEqual({ kind: 'within_window', windowMs: 60 * 60_000 })
  })

  it('measures a span of at least one window', () => {
    expect(measureIncidentSpan(START, at(60), 60, NOW)).toEqual({ kind: 'measured', ms: 60 * 60_000, clearedAt: Date.parse(at(60)) })
  })

  it('says nothing about an unreadable start', () => {
    expect(measureIncidentSpan('not a time', at(5), 60, NOW)).toEqual({ kind: 'unknown' })
  })

  it('treats a missing or zero window as a state check with no window', () => {
    expect(measureIncidentSpan(START, at(1), 0, NOW).kind).toBe('measured')
    expect(measureIncidentSpan(START, at(1), undefined, NOW).kind).toBe('measured')
  })
})

/**
 * A real db-unreachable row recorded before #2115 gave every incident record one
 * clock reading per pass: its end, the last sighting, was read 36 seconds before
 * its start. New rows cannot do this, but that row stays for 90 days, so an end
 * before the start is read as a zero length span, never a negative one.
 */
describe('an end recorded before the start', () => {
  const STARTED = '2026-10-14T21:48:37.000Z'
  const ENDED = '2026-10-14T21:48:01.000Z'

  it('is a zero length span ending at the start', () => {
    expect(measureIncidentSpan(STARTED, ENDED, null, NOW)).toEqual({ kind: 'measured', ms: 0, clearedAt: Date.parse(STARTED) })
    expect(incidentDurationText(measureIncidentSpan(STARTED, ENDED, null, NOW))).toBe('under a minute')
  })

  it('reads as inside the window for a signal with one', () => {
    expect(incidentDurationText(measureIncidentSpan(STARTED, ENDED, 4, NOW))).toBe('Within one 4 minute window')
  })
})

describe('incidentDurationText', () => {
  it('words a measured span the way the all-clear does', () => {
    expect(incidentDurationText(measureIncidentSpan(START, at(92), null, NOW))).toBe('1 hour 32 minutes')
  })

  it('names the window for a span inside one window', () => {
    expect(incidentDurationText(measureIncidentSpan(START, at(0), 5, NOW))).toBe('Within one 5 minute window')
    expect(incidentDurationText(measureIncidentSpan(START, at(30), 60, NOW))).toBe('Within one 60 minute window')
    expect(incidentDurationText(measureIncidentSpan(START, at(30), 7 * 1440, NOW))).toBe('Within one 7 day window')
  })

  it('has no text for an unreadable start', () => {
    expect(incidentDurationText(measureIncidentSpan('nope', at(1), null, NOW))).toBeNull()
  })
})

describe('incidentSoFarText', () => {
  it('words how long an open incident has run, measured to now', () => {
    expect(incidentSoFarText(measureIncidentSpan(START, null, null, Date.parse(at(80))))).toBe('1 hour 20 minutes so far')
  })

  it('names the window while an open incident is still inside its first one', () => {
    expect(incidentSoFarText(measureIncidentSpan(START, null, 5, Date.parse(at(2))))).toBe('within its first 5 minute window')
  })

  it('has no text for an unreadable start, and reads a start after now as just begun', () => {
    expect(incidentSoFarText(measureIncidentSpan('nope', null, null, NOW))).toBeNull()
    expect(incidentSoFarText(measureIncidentSpan(at(700), null, null, NOW))).toBe('under a minute so far')
  })
})

describe('describeDuration', () => {
  it('rounds to minutes and hours', () => {
    expect(describeDuration(20_000)).toBe('under a minute')
    expect(describeDuration(60_000)).toBe('1 minute')
    expect(describeDuration(60 * 60_000)).toBe('1 hour')
    expect(describeDuration(-1)).toBeNull()
  })
})
