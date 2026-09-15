/**
 * When a killed archive run is worth telling somebody about (#1211).
 *
 * The takeover alert fired on EVERY kill, and every kill so far has been a
 * harmless self recovery: the replacement invocation takes the dead one's lock,
 * archives the hour its predecessor did not reach, and reports caught up. The
 * message said so itself, in the words "No action for a single occurrence". An
 * alert whose own text says no action is what teaches a reader to skim the
 * channel that also carries real outages (L36, L112).
 *
 * Dan put it plainly on 2026-09-15, holding the 00:23 UTC takeover notice: "I
 * don't need an alert that the run was picked up if I didn't know it was down in
 * the first place because there was no failure alert." He is describing a notice
 * written as the closing half of an incident whose opening half is never sent,
 * because the recovery lands well inside the 50 minute allowance that the
 * vanished-run check waits for.
 *
 * THE THRESHOLDS ARE MEASURED, NOT CHOSEN (L172). Counted from `job_runs` on
 * 2026-09-15, over every kill recorded since the table shipped:
 *
 *   per day    10 (2026-08-23, the exceededMemory outage), 2 (08-24, its tail),
 *              then exactly 1 on each of 08-25, 08-26, 09-01, 09-05, 09-08,
 *              09-10, 09-11, 09-15
 *   per week   4, 2, 3 on the three full weeks after that outage
 *
 * So an ordinary day carries exactly one kill and the one real incident carried
 * ten. Three in a day sits above every healthy day ever recorded, including the
 * two on the outage's tail, and is a third of the way to the incident itself.
 * Seven in a week sits above the worst healthy week (4) while a sustained two a
 * day, which never trips the daily rule, reaches it in four days.
 */
import { describe, it, expect } from 'vitest'
import {
  decideKillNotice,
  KILLS_IN_DAY_THAT_SPEAK,
  KILLS_IN_WEEK_THAT_SPEAK,
} from '../kill-rate'

describe('decideKillNotice', () => {
  it('stays silent on the single kill that an ordinary day carries', () => {
    const d = decideKillNotice({ kind: 'counted', day: 1, week: 1 })
    expect(d.speak).toBe(false)
    expect(d.rate).toBeNull()
  })

  it('stays silent at two in a day, the highest a day has reached without an incident', () => {
    expect(decideKillNotice({ kind: 'counted', day: 2, week: 4 }).speak).toBe(false)
  })

  it('speaks at three in a day, which no healthy day has reached', () => {
    const d = decideKillNotice({ kind: 'counted', day: KILLS_IN_DAY_THAT_SPEAK, week: 3 })
    expect(d.speak).toBe(true)
  })

  it('speaks on a week that is elevated even while today looks ordinary', () => {
    // The slow degradation the daily rule cannot see: two a day never reaches
    // three in a day, and reaches the weekly threshold in four days.
    const d = decideKillNotice({ kind: 'counted', day: 2, week: KILLS_IN_WEEK_THAT_SPEAK })
    expect(d.speak).toBe(true)
  })

  it('stays silent on the worst week ever recorded without an incident', () => {
    expect(decideKillNotice({ kind: 'counted', day: 1, week: 4 }).speak).toBe(false)
  })

  it('names the rate rather than the single occurrence when it speaks', () => {
    const d = decideKillNotice({ kind: 'counted', day: 4, week: 9 })
    expect(d.speak).toBe(true)
    expect(d.rate).toContain('4')
    expect(d.rate).toContain('9')
    // The reader has to be able to tell this is an unusual rate, not one event.
    expect(d.rate).toMatch(/24 hours/)
    expect(d.rate).toMatch(/7 days/)
  })

  it('does not call the takeover a failure or an error in either direction', () => {
    // The recovery worked. Saying otherwise under the same headline that carries
    // genuine outages is what teaches a reader to discount all of them (#1210).
    for (const counts of [
      { kind: 'counted' as const, day: 1, week: 1 },
      { kind: 'counted' as const, day: 5, week: 9 },
    ]) {
      const d = decideKillNotice(counts)
      const text = `${d.rate ?? ''} ${d.reason}`
      expect(text).not.toMatch(/\bfailed\b/i)
      expect(text).not.toMatch(/\berrors?\b/i)
    }
  })

  it('counts in grammatical English, because a person reads this', () => {
    // "killed 1 times" is the tell of a sentence assembled rather than written,
    // and it lands in Slack beside the numbers it is meant to make readable.
    const one = decideKillNotice({ kind: 'counted', day: 1, week: 8 })
    expect(one.rate).toContain('1 time in')
    expect(one.rate).not.toContain('1 times')
    const many = decideKillNotice({ kind: 'counted', day: 4, week: 9 })
    expect(many.rate).toContain('4 times in')
  })

  it('speaks when the count cannot be read, rather than falling silent', () => {
    // A rate gate that goes quiet when its own source fails has switched the
    // detection off at exactly the moment something is wrong (L215, L345).
    const d = decideKillNotice({ kind: 'unreadable', detail: 'statement timeout' })
    expect(d.speak).toBe(true)
    expect(d.rate).toContain('statement timeout')
  })

  it('always explains itself, so a silent decision is still visible in the log', () => {
    for (const counts of [
      { kind: 'counted' as const, day: 1, week: 1 },
      { kind: 'counted' as const, day: 9, week: 9 },
      { kind: 'unreadable' as const, detail: 'boom' },
    ]) {
      expect(decideKillNotice(counts).reason.length).toBeGreaterThan(0)
    }
  })
})
