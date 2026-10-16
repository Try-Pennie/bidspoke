/**
 * The cron parser (#1952). Two dialects share one field grammar and differ
 * only in the weekday field: a stored Bidspoke cron names its weekdays (L733),
 * and a Pipedream cron is read with Pipedream's numbering, measured from the
 * 2026-09-30 export (see pipedream-timer.ts). Everything outside the grammar is
 * refused by name, never dropped or guessed.
 */
import { describe, expect, it } from 'vitest'
import { parseCron, type CronParse } from '../cron'

const ok = (r: CronParse) => {
  if (!r.ok) throw new Error(`expected a parse, got ${r.problem.reason}: ${r.problem.message}`)
  return r.spec
}
const reason = (r: CronParse) => (r.ok ? 'parsed' : r.problem.reason)
const range = (a: number, b: number, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step)

describe('parseCron: the field grammar both dialects share', () => {
  it('reads stars, numbers, lists, ranges and steps', () => {
    const s = ok(parseCron('*/15 7-20 * * *', 'bidspoke'))
    expect(s.minutes).toEqual([0, 15, 30, 45])
    expect(s.hours).toEqual(range(7, 20))
    expect([...s.daysOfMonth]).toEqual(range(1, 31))
    expect([...s.months]).toEqual(range(1, 12))
    expect([...s.weekdays]).toEqual(range(0, 6))
  })

  it('reads the export\'s `0/30` as from 0 every 30, so 0 and 30', () => {
    expect(ok(parseCron('0/30 9-21 * * *', 'pipedream')).minutes).toEqual([0, 30])
    expect(ok(parseCron('5/20 * * * *', 'bidspoke')).minutes).toEqual([5, 25, 45])
  })

  it('reads a range with a step, and sorts and dedupes an unsorted hour list', () => {
    expect(ok(parseCron('0 8-20/4 * * *', 'bidspoke')).hours).toEqual([8, 12, 16, 20])
    expect(ok(parseCron('0 21,23,1,3,5,1 * * *', 'pipedream')).hours).toEqual([1, 3, 5, 21, 23])
  })

  it('refuses anything that is not five fields', () => {
    expect(reason(parseCron('0 5 * *', 'bidspoke'))).toBe('cron_not_five_fields')
    expect(reason(parseCron('0 0 5 * * *', 'bidspoke'))).toBe('cron_not_five_fields')
    expect(reason(parseCron('', 'bidspoke'))).toBe('cron_not_five_fields')
  })

  it('refuses a macro rather than guessing which time it means', () => {
    expect(reason(parseCron('@daily', 'pipedream'))).toBe('cron_macro_unsupported')
  })

  it('refuses Quartz only syntax by name', () => {
    for (const expr of ['0 0 L * *', '0 0 15W * *', '0 0 ? * MON', '0 0 * * 5#3', '0 0 * JAN *']) {
      expect(reason(parseCron(expr, 'pipedream')), expr).toBe('cron_field_invalid')
    }
  })

  it('refuses malformed fields', () => {
    for (const expr of ['0,,5 * * * *', '*/0 * * * *', '5-1 * * * *', '1/2/3 * * * *', 'a * * * *', '-1 * * * *', '1.5 * * * *']) {
      expect(reason(parseCron(expr, 'bidspoke')), expr).toBe('cron_field_invalid')
    }
  })

  it('refuses a value outside its field', () => {
    for (const expr of ['60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 32 * *', '0 0 * 13 *', '0 0 * 0 *']) {
      expect(reason(parseCron(expr, 'bidspoke')), expr).toBe('cron_value_out_of_range')
    }
  })

  it('refuses a day of month and a weekday together: Pipedream\'s rule for the pair is unmeasured and no exported cron uses it', () => {
    expect(reason(parseCron('0 6 1 * MON', 'bidspoke'))).toBe('cron_day_of_month_and_weekday')
    expect(reason(parseCron('0 6 1 * 1', 'pipedream'))).toBe('cron_day_of_month_and_weekday')
  })

  it('refuses a cron that can never fire', () => {
    expect(reason(parseCron('0 0 30 2 *', 'bidspoke'))).toBe('cron_never_fires')
    expect(reason(parseCron('0 0 31 4,6,9,11 *', 'bidspoke'))).toBe('cron_never_fires')
    // The 29th of February fires in a leap year, so it is not refused.
    expect(reason(parseCron('0 0 29 2 *', 'bidspoke'))).toBe('parsed')
  })
})

describe('parseCron: weekdays in a stored Bidspoke cron are names (L733)', () => {
  it('reads names, ranges of names and lists, with 0 as Sunday inside the spec', () => {
    expect([...ok(parseCron('0 8 * * MON-FRI', 'bidspoke')).weekdays]).toEqual([1, 2, 3, 4, 5])
    expect([...ok(parseCron('0 8 * * SUN,SAT', 'bidspoke')).weekdays]).toEqual([0, 6])
    expect([...ok(parseCron('0 8 * * SUN-SAT', 'bidspoke')).weekdays]).toEqual(range(0, 6))
    expect([...ok(parseCron('0 8 * * MON,WED-FRI', 'bidspoke')).weekdays]).toEqual([1, 3, 4, 5])
  })

  it('refuses a numeric weekday, which is the ambiguity names exist to remove', () => {
    for (const expr of ['0 8 * * 1-5', '0 8 * * 0', '0 8 * * 7', '0 8 * * */2', '0 8 * * MON,2']) {
      expect(reason(parseCron(expr, 'bidspoke')), expr).toBe('cron_weekday_not_named')
    }
  })

  it('refuses lower case and a range that wraps past Saturday', () => {
    expect(reason(parseCron('0 8 * * mon', 'bidspoke'))).toBe('cron_weekday_not_named')
    expect(reason(parseCron('0 8 * * FRI-MON', 'bidspoke'))).toBe('cron_weekday_range_wraps')
  })
})

describe('parseCron: weekdays in a Pipedream cron use the measured numbering', () => {
  it('reads 0 and 7 as Sunday, so `1-7` is every day and `0` is Sunday', () => {
    expect([...ok(parseCron('*/5 8-20 * * 1-7', 'pipedream')).weekdays]).toEqual(range(0, 6))
    expect([...ok(parseCron('30 11 * * 0', 'pipedream')).weekdays]).toEqual([0])
    expect([...ok(parseCron('30 11 * * 7', 'pipedream')).weekdays]).toEqual([0])
  })

  it('reads 1 to 6 as Monday to Saturday', () => {
    expect([...ok(parseCron('0 14 * * 1-6', 'pipedream')).weekdays]).toEqual([1, 2, 3, 4, 5, 6])
    expect([...ok(parseCron('15 10 * * 5', 'pipedream')).weekdays]).toEqual([5])
    expect([...ok(parseCron('1 11 * * 1,2', 'pipedream')).weekdays]).toEqual([1, 2])
  })

  it('also reads names, in either case, and steps', () => {
    expect([...ok(parseCron('0 8 * * mon-fri', 'pipedream')).weekdays]).toEqual([1, 2, 3, 4, 5])
    expect([...ok(parseCron('0 8 * * */2', 'pipedream')).weekdays]).toEqual([0, 2, 4, 6])
  })

  it('refuses a weekday past 7', () => {
    expect(reason(parseCron('0 8 * * 8', 'pipedream'))).toBe('cron_value_out_of_range')
  })
})
