/**
 * The cron grammar a schedule may use (#1952), parsed into the sets of minutes,
 * hours, days, months and weekdays it names. Written here rather than taken
 * from a cron library so that a cron's wall times are read by the one shared
 * clock (@bidspoke/buyer-profile, L655) and so that everything outside the
 * grammar is REFUSED by name: a library that accepts a wider syntax would let a
 * shape nobody measured reach a live schedule (L34).
 *
 * The grammar is the one the 2026-09-30 Pipedream export uses, five fields:
 * `*`, a number, `a-b`, any of those with `/step` (`n/step` runs from n to the
 * field's end, so the export's `0/30` is 0 and 30), and comma lists. Refused:
 * macros (`@daily`), a sixth seconds field, Quartz's `? L W #`, month names, and
 * a day of the month together with a weekday, whose OR rule in Vixie cron is
 * exactly the kind of thing that differs between implementations; Pipedream's
 * is unmeasured and no exported cron uses it.
 *
 * Two dialects differ only in the weekday field:
 * - 'bidspoke', the stored form: weekdays are NAMES (SUN to SAT, upper case,
 *   ranges that do not wrap), or `*`. A number is refused (L733): it is the
 *   ambiguity between 0 based, 1 based and Monday first numberings.
 * - 'pipedream', the converter's input: numbers 0 to 7 with 0 and 7 Sunday, or
 *   names in either case, with ranges and steps. The numbering is measured from
 *   the export, see pipedream-timer.ts.
 */
import { problem, type ScheduleProblem } from './problems'

export const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const
export type WeekdayName = (typeof WEEKDAY_NAMES)[number]

export type CronDialect = 'bidspoke' | 'pipedream'

export interface CronSpec {
  /** Ascending, 0 to 59. */
  minutes: readonly number[]
  /** Ascending, 0 to 23. */
  hours: readonly number[]
  daysOfMonth: ReadonlySet<number>
  months: ReadonlySet<number>
  /** 0 is Sunday, as zonedParts reads it. */
  weekdays: ReadonlySet<number>
}

export type CronParse =
  | { ok: true; spec: CronSpec; fields: readonly [string, string, string, string, string] }
  | { ok: false; problem: ScheduleProblem }

interface FieldRule { name: string; min: number; max: number }
const MINUTE: FieldRule = { name: 'minute', min: 0, max: 59 }
const HOUR: FieldRule = { name: 'hour', min: 0, max: 23 }
const DAY_OF_MONTH: FieldRule = { name: 'day of the month', min: 1, max: 31 }
const MONTH: FieldRule = { name: 'month', min: 1, max: 12 }
const PIPEDREAM_WEEKDAY: FieldRule = { name: 'weekday', min: 0, max: 7 }

/** The longest each month can be, February in a leap year included. */
const MONTH_MAX_DAY = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const DIGITS = /^\d+$/
const RANGE = /^(\d+)-(\d+)$/

class Refused extends Error {
  constructor(readonly problem: ScheduleProblem) {
    super(problem.message)
  }
}

function parseField(text: string, rule: FieldRule): number[] {
  if (/[?LW#]/i.test(text)) {
    throw new Refused(problem('cron_field_invalid', `the ${rule.name} field "${text}" uses Quartz syntax (? L W #), which no exported Pipedream cron uses and this parser does not read`))
  }
  const out = new Set<number>()
  for (const item of text.split(',')) {
    const parts = item.split('/')
    if (item === '' || parts.length > 2) throw new Refused(problem('cron_field_invalid', `the ${rule.name} field "${text}" has an empty or malformed item`))
    const [base, stepText] = parts
    let step = 1
    if (stepText !== undefined) {
      if (!DIGITS.test(stepText) || Number(stepText) < 1) throw new Refused(problem('cron_field_invalid', `the ${rule.name} field "${text}" has a step that is not a whole number of at least 1`))
      step = Number(stepText)
    }
    let lo: number
    let hi: number
    const range = RANGE.exec(base)
    if (base === '*') {
      lo = rule.min
      hi = rule.max
    } else if (DIGITS.test(base)) {
      lo = Number(base)
      hi = stepText === undefined ? lo : rule.max
    } else if (range) {
      lo = Number(range[1])
      hi = Number(range[2])
      if (lo > hi) throw new Refused(problem('cron_field_invalid', `the ${rule.name} range "${base}" runs backwards`))
    } else {
      throw new Refused(problem('cron_field_invalid', `the ${rule.name} field "${text}" is not a number, a range, a star or a step`))
    }
    if (lo < rule.min || hi > rule.max) {
      throw new Refused(problem('cron_value_out_of_range', `the ${rule.name} field "${text}" goes outside ${rule.min} to ${rule.max}`))
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

const NAME_ITEM = /^(SUN|MON|TUE|WED|THU|FRI|SAT)(?:-(SUN|MON|TUE|WED|THU|FRI|SAT))?$/
const indexOfName = (n: string): number => (WEEKDAY_NAMES as readonly string[]).indexOf(n)

function parseNamedWeekdays(text: string): number[] {
  if (text === '*') return [0, 1, 2, 3, 4, 5, 6]
  const out = new Set<number>()
  for (const item of text.split(',')) {
    const m = NAME_ITEM.exec(item)
    if (!m) {
      throw new Refused(problem('cron_weekday_not_named', `the weekday field "${text}" must name its days (SUN to SAT, upper case), because a number reads differently in different crons`))
    }
    const lo = indexOfName(m[1])
    const hi = m[2] === undefined ? lo : indexOfName(m[2])
    if (lo > hi) throw new Refused(problem('cron_weekday_range_wraps', `the weekday range "${item}" wraps past Saturday; write it as two ranges`))
    for (let d = lo; d <= hi; d++) out.add(d)
  }
  return [...out].sort((a, b) => a - b)
}

function parsePipedreamWeekdays(text: string): number[] {
  const numeric = text.replace(/[a-z]{3}/gi, (name) => {
    const i = indexOfName(name.toUpperCase())
    if (i < 0) throw new Refused(problem('cron_field_invalid', `the weekday field "${text}" names "${name}", which is not a day`))
    return String(i)
  })
  return [...new Set(parseField(numeric, PIPEDREAM_WEEKDAY).map((d) => d % 7))].sort((a, b) => a - b)
}

/** True when the day of the month and month sets share some date that exists. */
function someDateExists(days: ReadonlySet<number>, months: ReadonlySet<number>): boolean {
  for (const m of months) for (const d of days) if (d <= MONTH_MAX_DAY[m]) return true
  return false
}

export function parseCron(expr: string, dialect: CronDialect): CronParse {
  const text = typeof expr === 'string' ? expr.trim() : ''
  if (text.startsWith('@')) {
    return { ok: false, problem: problem('cron_macro_unsupported', `"${text}" is a macro; write the five fields it stands for`) }
  }
  const fields = text === '' ? [] : text.split(/\s+/)
  if (fields.length !== 5) {
    return { ok: false, problem: problem('cron_not_five_fields', `"${text}" has ${fields.length} fields; a cron here has exactly five (minute, hour, day of the month, month, weekday)`) }
  }
  const [min, hour, dom, month, dow] = fields
  try {
    const spec: CronSpec = {
      minutes: parseField(min, MINUTE),
      hours: parseField(hour, HOUR),
      daysOfMonth: new Set(parseField(dom, DAY_OF_MONTH)),
      months: new Set(parseField(month, MONTH)),
      weekdays: new Set(dialect === 'bidspoke' ? parseNamedWeekdays(dow) : parsePipedreamWeekdays(dow)),
    }
    if (dom !== '*' && dow !== '*') {
      return { ok: false, problem: problem('cron_day_of_month_and_weekday', `"${text}" limits both the day of the month and the weekday; crons disagree on whether that means either or both, so it is refused`) }
    }
    if (!someDateExists(spec.daysOfMonth, spec.months)) {
      return { ok: false, problem: problem('cron_never_fires', `"${text}" names no date that exists, so it would never fire`) }
    }
    return { ok: true, spec, fields: [min, hour, dom, month, dow] }
  } catch (err) {
    if (err instanceof Refused) return { ok: false, problem: err.problem }
    throw err
  }
}

/**
 * The weekday field for a set of days, in the stored dialect: `*` is never
 * written for a restricted field, so a field that was restricted stays one.
 * Runs of three or more days become a range, shorter runs a list.
 */
export function namedWeekdayField(days: ReadonlySet<number>): string {
  const sorted = [...days].sort((a, b) => a - b)
  const items: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    if (j - i >= 2) items.push(`${WEEKDAY_NAMES[sorted[i]]}-${WEEKDAY_NAMES[sorted[j]]}`)
    else for (let k = i; k <= j; k++) items.push(WEEKDAY_NAMES[sorted[k]])
    i = j + 1
  }
  return items.join(',')
}
