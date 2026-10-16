/**
 * The Pipedream timer converter (#1952) over every timer trigger in the
 * 2026-09-30 export (fixtures/pipedream-timers.json, from
 * scripts/porting/timer-fixture.ts), plus the shapes the export does not hold.
 *
 * The weekday check is not the converter agreeing with itself (L34 audit on
 * #1698): the expected days come from a separate reading of each numeric field
 * with the measured numbering (0 and 7 Sunday, 1 Monday to 6 Saturday), and the
 * converted, NAMED cron is then fired for three weeks and the weekday of each
 * fire read back through the shared clock.
 */
import { describe, expect, it } from 'vitest'
import { zonedParts } from '@bidspoke/buyer-profile'
import fixture from '../fixtures/pipedream-timers.json'
import { firesBetween } from '../fires'
import { convertPipedreamTimer, type ConvertResult } from '../pipedream-timer'
import { scheduleTiming, validateSchedule, type ScheduleConfig } from '../schedule'

interface Rec { hashid: string; trigger_index: number; workflow_state: string; disabled: boolean; props: Record<string, unknown> }
const timers = (fixture as { timers: Rec[] }).timers
const asTrigger = (r: Rec) => ({ type: 'timer', ...(r.disabled ? { disabled: true } : {}), props: r.props })

const converted = (r: ConvertResult): ScheduleConfig => {
  if (!r.ok) throw new Error(`expected a conversion, got ${r.problem.reason}: ${r.problem.message}`)
  return r.schedule
}
const refusal = (r: ConvertResult) => (r.ok ? 'converted' : r.problem.reason)

/** A deliberately separate reading of the numeric weekday forms the export holds. */
function expectedDays(field: string): Set<number> {
  const out = new Set<number>()
  for (const item of field.split(',')) {
    const [a, b] = item.split('-').map(Number)
    for (let d = a; d <= (b ?? a); d++) out.add(d % 7)
  }
  return out
}

describe('the fixture is the measured export', () => {
  it('holds every timer of the 2026-09-30 export: 77, of which 67 crons, 10 intervals, 4 disabled', () => {
    expect(timers).toHaveLength(77)
    expect(timers.filter((t) => 'cron' in t.props)).toHaveLength(67)
    expect(timers.filter((t) => 'interval_seconds' in t.props)).toHaveLength(10)
    expect(timers.filter((t) => t.disabled)).toHaveLength(4)
  })

  it('holds the three shapes the Trigger.dev review named: weekday range 1-7, the 0/30 minute, and New York', () => {
    const crons = timers.map((t) => t.props.cron).filter((c): c is string => typeof c === 'string')
    expect(crons).toContain('*/5 8-20 * * 1-7')
    expect(crons).toContain('0/30 9-21 * * *')
    expect(timers.filter((t) => t.props.timezone === 'America/New_York').length).toBeGreaterThan(50)
  })

  it('names only zones the converter reads', () => {
    expect([...new Set(timers.map((t) => t.props.timezone))].sort()).toEqual(['America/New_York', 'Etc/UTC', 'UTC'])
  })
})

describe('convertPipedreamTimer over every exported timer', () => {
  it('converts every enabled timer to a schedule the validator accepts, and refuses every disabled one by name', () => {
    for (const t of timers) {
      const r = convertPipedreamTimer(asTrigger(t))
      if (t.disabled) {
        expect(refusal(r), t.hashid).toBe('timer_disabled')
        continue
      }
      const s = converted(r)
      expect(validateSchedule(s), `${t.hashid} ${JSON.stringify(t.props)}`).toEqual([])
    }
  })

  it('translates every numeric weekday field to names, and the named cron fires on exactly the measured days', () => {
    let checked = 0
    for (const t of timers) {
      const cron = t.props.cron
      if (t.disabled || typeof cron !== 'string' || cron.split(' ')[4] === '*') continue
      const s = converted(convertPipedreamTimer(asTrigger(t)))
      expect(s.cron!.split(' ')[4], cron).toMatch(/^[A-Z]{3}([-,][A-Z]{3})*$/)
      const fired = new Set(firesBetween(scheduleTiming(s), Date.UTC(2027, 0, 4), Date.UTC(2027, 0, 25), 5000).map((f) => zonedParts(f, s.timezone).dayOfWeek))
      expect([...fired].sort(), `${t.hashid} ${cron} -> ${s.cron}`).toEqual([...expectedDays(cron.split(' ')[4])].sort())
      checked++
    }
    // The 14 enabled crons with a weekday field, so the loop cannot pass by skipping them all.
    expect(checked).toBe(14)
  })

  it('writes the weekday names a person would', () => {
    const conv = (cron: string, timezone = 'America/New_York') => converted(convertPipedreamTimer({ type: 'timer', props: { cron, timezone } })).cron
    expect(conv('0 8 * * 1-5')).toBe('0 8 * * MON-FRI')
    expect(conv('0 14 * * 1-6')).toBe('0 14 * * MON-SAT')
    expect(conv('*/5 8-20 * * 1-7')).toBe('*/5 8-20 * * SUN-SAT')
    expect(conv('1 11 * * 1,2', 'UTC')).toBe('1 11 * * MON,TUE')
    expect(conv('15 10 * * 5')).toBe('15 10 * * FRI')
    expect(conv('30 11 * * 0')).toBe('30 11 * * SUN')
    expect(conv('0 6 * * 1')).toBe('0 6 * * MON')
    expect(conv('0 0 * * 0,6')).toBe('0 0 * * SUN,SAT')
    expect(conv('0 0 * * 5-7')).toBe('0 0 * * SUN,FRI,SAT')
  })

  it('keeps the other four fields as written, the 0/30 minute included', () => {
    expect(converted(convertPipedreamTimer({ type: 'timer', props: { cron: '0/30 9-21 * * *', timezone: 'America/New_York' } })).cron).toBe('0/30 9-21 * * *')
    expect(converted(convertPipedreamTimer({ type: 'timer', props: { cron: '0 21,23,1,3,5 * * *', timezone: 'America/New_York' } })).cron).toBe('0 21,23,1,3,5 * * *')
  })

  it('reads Etc/UTC as UTC and says so', () => {
    const r = convertPipedreamTimer({ type: 'timer', props: { cron: '15 15 * * 1', timezone: 'Etc/UTC' } })
    expect(converted(r).timezone).toBe('UTC')
    expect(r.ok && r.notes.map((n) => n.code)).toEqual(['timezone_read_as_utc', 'weekdays_named'])
  })

  it('flags a cron whose wall time a New York daylight saving change skips or repeats', () => {
    for (const cron of ['4 2 * * *', '0 21,23,1,3,5 * * *']) {
      const r = convertPipedreamTimer({ type: 'timer', props: { cron, timezone: 'America/New_York' } })
      expect(r.ok && r.notes.map((n) => n.code), cron).toEqual(['daylight_saving_wall_time'])
    }
    const utc = convertPipedreamTimer({ type: 'timer', props: { cron: '4 2 * * *', timezone: 'UTC' } })
    expect(utc.ok && utc.notes).toEqual([])
  })

  it('carries the defaults by period: a weekly timer catches up, a daily one does not', () => {
    expect(converted(convertPipedreamTimer({ type: 'timer', props: { cron: '0 6 * * 1', timezone: 'America/New_York' } }))).toMatchObject({ catch_up: 'latest', catch_up_window_seconds: 72 * 3600, reattempt_after_seconds: 4 * 3600, overlap: 'skip' })
    expect(converted(convertPipedreamTimer({ type: 'timer', props: { cron: '0 8 * * *', timezone: 'America/New_York' } }))).toMatchObject({ catch_up: 'none', overlap: 'skip' })
  })

  it('converts an interval, a 45 minute one that does not divide the hour included', () => {
    expect(converted(convertPipedreamTimer({ type: 'timer', props: { interval_seconds: 2700, timezone: 'UTC' } }))).toEqual({ interval_seconds: 2700, timezone: 'UTC', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 60 })
  })

  it('gives the same schedule every run, so a rerun of the converter changes nothing', () => {
    for (const t of timers.filter((x) => !x.disabled)) expect(convertPipedreamTimer(asTrigger(t))).toEqual(convertPipedreamTimer(asTrigger(t)))
  })
})

describe('convertPipedreamTimer refuses what it cannot carry, by name', () => {
  const conv = (trigger: unknown) => refusal(convertPipedreamTimer(trigger))

  it('refuses something that is not a timer trigger', () => {
    expect(conv({ type: 'http', props: {} })).toBe('not_a_timer')
    expect(conv(null)).toBe('not_a_timer')
    expect(conv({ type: 'timer' })).toBe('not_a_timer')
  })

  it('refuses a disabled timer, so a schedule switched off on Pipedream does not start firing here', () => {
    expect(conv({ type: 'timer', disabled: true, props: { cron: '0 8 * * *', timezone: 'UTC' } })).toBe('timer_disabled')
  })

  it('refuses neither or both of a cron and an interval', () => {
    expect(conv({ type: 'timer', props: { timezone: 'UTC' } })).toBe('schedule_needs_cron_or_interval')
    expect(conv({ type: 'timer', props: { cron: '0 8 * * *', interval_seconds: 3600, timezone: 'UTC' } })).toBe('schedule_has_cron_and_interval')
  })

  it('refuses a prop it does not know, rather than dropping it', () => {
    expect(conv({ type: 'timer', props: { cron: '0 8 * * *', timezone: 'UTC', start_at: '2026-01-01' } })).toBe('timer_props_unknown')
  })

  it('refuses a zone outside the schedule zones, and a missing one', () => {
    expect(conv({ type: 'timer', props: { cron: '0 8 * * *', timezone: 'Europe/London' } })).toBe('timezone_unsupported')
    expect(conv({ type: 'timer', props: { cron: '0 8 * * *' } })).toBe('timezone_unsupported')
  })

  it('refuses an unparseable or unsupported cron with the parser\'s reason', () => {
    expect(conv({ type: 'timer', props: { cron: '0 8 * *', timezone: 'UTC' } })).toBe('cron_not_five_fields')
    expect(conv({ type: 'timer', props: { cron: '0 8 * * 8', timezone: 'UTC' } })).toBe('cron_value_out_of_range')
    expect(conv({ type: 'timer', props: { cron: '0 8 1 * 1', timezone: 'UTC' } })).toBe('cron_day_of_month_and_weekday')
    expect(conv({ type: 'timer', props: { cron: '0 8 L * *', timezone: 'UTC' } })).toBe('cron_field_invalid')
    expect(conv({ type: 'timer', props: { cron: '@weekly', timezone: 'UTC' } })).toBe('cron_macro_unsupported')
  })

  it('refuses an interval the minute tick cannot serve', () => {
    expect(conv({ type: 'timer', props: { interval_seconds: 30, timezone: 'UTC' } })).toBe('interval_invalid')
    expect(conv({ type: 'timer', props: { interval_seconds: 90, timezone: 'UTC' } })).toBe('interval_invalid')
  })
})
