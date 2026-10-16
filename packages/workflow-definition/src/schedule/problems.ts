/**
 * Every reason a schedule or a Pipedream timer is refused (#1952), in one home
 * (L83): the parser, the validator, the converter and the tick's per schedule
 * error all name a reason from this list, so a reader can switch on it and a
 * new reason cannot be spelled two ways.
 */
export const SCHEDULE_REFUSALS = [
  'cron_not_five_fields',
  'cron_macro_unsupported',
  'cron_field_invalid',
  'cron_value_out_of_range',
  'cron_weekday_not_named',
  'cron_weekday_range_wraps',
  'cron_day_of_month_and_weekday',
  'cron_never_fires',
  'schedule_needs_cron_or_interval',
  'schedule_has_cron_and_interval',
  'interval_invalid',
  'timezone_unsupported',
  'overlap_invalid',
  'catch_up_invalid',
  'catch_up_window_invalid',
  'reattempt_after_invalid',
  'jitter_invalid',
  'not_a_timer',
  'timer_disabled',
  'timer_props_unknown',
] as const

export type ScheduleRefusal = (typeof SCHEDULE_REFUSALS)[number]

export interface ScheduleProblem {
  reason: ScheduleRefusal
  /** A sentence naming what was refused and why. */
  message: string
}

/** Thrown where a schedule must be computed and cannot be: the tick catches it per schedule (#1698 1.4) and reports the reason. */
export class ScheduleConfigError extends Error {
  readonly problems: readonly ScheduleProblem[]
  constructor(problems: readonly ScheduleProblem[]) {
    super(problems.map((p) => `${p.reason}: ${p.message}`).join('; '))
    this.name = 'ScheduleConfigError'
    this.problems = problems
  }
}

export const problem = (reason: ScheduleRefusal, message: string): ScheduleProblem => ({ reason, message })
