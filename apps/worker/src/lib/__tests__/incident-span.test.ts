import { describe, expect, it } from 'vitest'
import { describeDuration, incidentDurationText, measureIncidentSpan } from '../incident-span'

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

describe('incidentDurationText', () => {
  it('words a measured span the way the all-clear does', () => {
    expect(incidentDurationText(measureIncidentSpan(START, at(92), null, NOW))).toBe('1 hour 32 minutes')
  })

  it('names the window for a span inside one window', () => {
    expect(incidentDurationText(measureIncidentSpan(START, at(0), 5, NOW))).toBe('Within one 5 minute window')
    expect(incidentDurationText(measureIncidentSpan(START, at(30), 60, NOW))).toBe('Within one 60 minute window')
    expect(incidentDurationText(measureIncidentSpan(START, at(30), 7 * 1440, NOW))).toBe('Within one 7 day window')
  })

  it('has no text for an unreadable start or an end before the start', () => {
    expect(incidentDurationText(measureIncidentSpan('nope', at(1), null, NOW))).toBeNull()
    expect(incidentDurationText(measureIncidentSpan(START, at(-5), null, NOW))).toBeNull()
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
