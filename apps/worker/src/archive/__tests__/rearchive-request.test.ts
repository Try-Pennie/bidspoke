/**
 * What a re-archive request is allowed to ask for (#976).
 *
 * Every rule here is a refusal, and each is a way somebody could spend a whole
 * invocation's budget against production tables by typo, or record a count that
 * makes the deletion gate wrong in the direction of deleting.
 */
import { describe, it, expect } from 'vitest'
import { parseReArchiveRequest, MAX_HOURS_PER_REQUEST } from '../rearchive-request'

const NOW = new Date('2026-08-22T13:00:00.000Z')

describe('parseReArchiveRequest', () => {
  it('accepts one settled hour', () => {
    const r = parseReArchiveRequest({ hour: '2026-08-22T07:00:00.000Z' }, NOW)

    expect(r.ok).toBe(true)
    expect(r.ok && r.hours).toEqual(['2026-08-22T07:00:00.000Z'])
  })

  it('reports WHICH form was used, because it decides whether archived hours are skipped', () => {
    // A day is a repair of what is missing, so hours already archived are left
    // alone or the run redoes its first hours forever (#1019). A named hour is a
    // deliberate redo, which is the only way to correct an hour archived wrongly.
    const anHour = parseReArchiveRequest({ hour: '2026-08-22T07:00:00.000Z' }, NOW)
    const aDay = parseReArchiveRequest({ day: '2026-08-20' }, NOW)

    expect(anHour.ok && anHour.form).toBe('hour')
    expect(aDay.ok && aDay.form).toBe('day')
  })

  it('expands a day into its 24 hours, in order', () => {
    const r = parseReArchiveRequest({ day: '2026-08-20' }, NOW)

    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.hours).toHaveLength(24)
    expect(r.hours[0]).toBe('2026-08-20T00:00:00.000Z')
    expect(r.hours[23]).toBe('2026-08-20T23:00:00.000Z')
  })

  it('refuses an hour that is not on the hour', () => {
    // The archive addresses whole hours. A half past would silently become
    // something else, or read nothing.
    const r = parseReArchiveRequest({ hour: '2026-08-22T07:30:00.000Z' }, NOW)

    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toMatch(/not a UTC hour boundary/)
  })

  it('refuses a request with neither an hour nor a day', () => {
    // Not defaulted to anything: a missing field and a deliberate choice must
    // not produce the same work against production tables.
    const r = parseReArchiveRequest({}, NOW)

    expect(r.ok).toBe(false)
  })

  it('refuses a request with both', () => {
    const r = parseReArchiveRequest({ hour: '2026-08-22T07:00:00.000Z', day: '2026-08-20' }, NOW)

    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toMatch(/not both/)
  })

  it('refuses a day that is not a date', () => {
    expect(parseReArchiveRequest({ day: 'yesterday' }, NOW).ok).toBe(false)
    expect(parseReArchiveRequest({ day: '2026-8-2' }, NOW).ok).toBe(false)
  })

  it('refuses an hour that has not cleared the settle window', () => {
    // Archiving one early records a count that UNDERSTATES its day, which is
    // worse than the missing hour the repair was called to fix: the gate would
    // then reconcile against a number that is too small.
    const r = parseReArchiveRequest({ hour: '2026-08-22T11:00:00.000Z' }, NOW)

    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toMatch(/have not closed and cleared the settle window/)
  })

  it('refuses the WHOLE day when only some of its hours are ready, rather than trimming', () => {
    // Silently dropping the unready hours would report a day fully re-archived
    // while part of it was never attempted (L98).
    const r = parseReArchiveRequest({ day: '2026-08-22' }, NOW)

    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toMatch(/of these hours have not closed/)
  })

  it('accepts a fully settled day, so the check is not simply always refusing', () => {
    expect(parseReArchiveRequest({ day: '2026-08-21' }, NOW).ok).toBe(true)
  })

  it('caps a request at a day, so a typo cannot ask for a year', () => {
    expect(MAX_HOURS_PER_REQUEST).toBe(24)
  })

  it('ignores a non-string hour rather than coercing it', () => {
    expect(parseReArchiveRequest({ hour: 12345 as unknown as string }, NOW).ok).toBe(false)
  })
})
