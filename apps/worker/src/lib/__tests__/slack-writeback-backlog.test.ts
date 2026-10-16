import { describe, expect, it } from 'vitest'
import { writebackBacklogMessage, writebackBacklogRecoveryWording, WRITEBACK_BACKLOG_RECOVERY_SUBJECT } from '../slack'

/**
 * The backlog page's words (#468 step 2): a plain title, short full sentences,
 * counts, objects and ages only, never a record id or a field value, times in
 * ET, and no dashes or emoji anywhere.
 */
const NOW = Date.parse('2026-10-15T18:00:00.000Z')
const MIN = 60_000
// Built from code points, so this file holds none of the characters it bans.
const DASH_CHARS = [0x2012, 0x2013, 0x2014, 0x2015].map((c) => String.fromCharCode(c))
const SPACED_HYPHEN = ` ${String.fromCharCode(45)} `
const hasDash = (s: string) => DASH_CHARS.some((d) => s.includes(d)) || s.includes(SPACED_HYPHEN)
const EMOJI = /\p{Extended_Pictographic}/u

const text = (m: { title: string; sections: string[] }) => [m.title, ...m.sections].join('\n')

describe('writebackBacklogMessage', () => {
  it('names the count, the objects and the oldest age in ET for an aged backlog', () => {
    const m = writebackBacklogMessage({
      count: 3,
      partial: false,
      objects: [{ object: 'Prospect__c', count: 2 }, { object: 'Lead', count: 1 }],
      oldestAt: new Date(NOW - 42 * MIN).toISOString(),
      aged: true,
      growing: null,
    }, NOW)
    expect(m.title).toBe('Salesforce writes are waiting to be resent')
    const all = text(m)
    expect(all).toContain('3 Salesforce writes failed after a lead was answered and are waiting to be resent: 2 to Prospect and 1 to Lead.')
    expect(all).toContain('The oldest has waited 42 minutes, since Oct 15, 1:18 PM EDT.')
    expect(all).toContain('*Fix:*')
    expect(all).toContain('/api/admin/held-writes?status=pending')
    expect(hasDash(all)).toBe(false)
    expect(all).not.toMatch(EMOJI)
  })

  it('says how the count grew and since when, for a growing backlog', () => {
    const m = writebackBacklogMessage({
      count: 5,
      partial: false,
      objects: [{ object: 'Submission__c', count: 5 }],
      oldestAt: new Date(NOW - 9 * MIN).toISOString(),
      aged: false,
      growing: { from: 2, lastCheckAt: new Date(NOW - 5 * MIN).toISOString() },
    }, NOW)
    const all = text(m)
    expect(all).toContain('There were 2 at the last check, at Oct 15, 1:55 PM EDT, so more are arriving than are being resent.')
    expect(all).not.toContain('The oldest has waited')
    expect(hasDash(all)).toBe(false)
  })

  it('says at least when the reading stopped short of every row', () => {
    const m = writebackBacklogMessage({
      count: 1000,
      partial: true,
      objects: [{ object: 'Lead', count: 1000 }],
      oldestAt: new Date(NOW - 90 * MIN).toISOString(),
      aged: true,
      growing: null,
    }, NOW)
    expect(text(m)).toContain('At least 1000 Salesforce writes')
  })

  it('reads one write in the singular, and an unreadable oldest time as unknown rather than invented', () => {
    const m = writebackBacklogMessage({
      count: 1,
      partial: false,
      objects: [{ object: 'Lead', count: 1 }],
      oldestAt: null,
      aged: true,
      growing: null,
    }, NOW)
    const all = text(m)
    expect(all).toContain('1 Salesforce write failed after a lead was answered and is waiting to be resent: 1 to Lead.')
    expect(all).toContain('The oldest has a creation time that could not be read.')
  })

  it('escapes an object name that would be markup in Slack', () => {
    const m = writebackBacklogMessage({
      count: 1,
      partial: false,
      objects: [{ object: 'A<b>', count: 1 }],
      oldestAt: new Date(NOW - 40 * MIN).toISOString(),
      aged: true,
      growing: null,
    }, NOW)
    expect(text(m)).not.toContain('<b>')
  })
})

describe('the all-clear words', () => {
  it('names the signal the incident record labels it with', () => {
    expect(WRITEBACK_BACKLOG_RECOVERY_SUBJECT).toBe('Failed Salesforce writes')
    expect(writebackBacklogRecoveryWording.recoveredPhrase).toBe('are all handled, and none is waiting to be resent')
    expect(writebackBacklogRecoveryWording.signal).toBe('failed Salesforce writes')
  })
})
