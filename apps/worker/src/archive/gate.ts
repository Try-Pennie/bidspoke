/**
 * Reading a day's archive measurements (#872, Phase A4).
 *
 * `execution_archive_days` holds NUMBERS, never a verdict. This is the reader
 * that turns those numbers into refusals.
 *
 * The shape is inverted on purpose, because of what it replaces.
 * `app_config.logpush_active` was a hand-set boolean asserting that a Logpush
 * archive existed; nothing ever checked it against one, and it gated a 90 day
 * purge for months while the underlying job could not be verified to exist. So
 * nothing here declares a day safe. A day is deletable only when every
 * measurement is present, fresh and equal, and every way of failing to
 * establish that is a refusal carrying its own wording.
 *
 * It decides, it does not act: no Postgres, no Snowflake, no deletion.
 */

/**
 * How old a measurement may be before the day refuses on age alone.
 *
 * The measuring job is daily, so this has to clear a full cadence or every day
 * would refuse whenever a run landed late. 30 hours is one cadence plus six
 * hours of slack: a single late run passes, two consecutive missed runs do not.
 */
export const MEASUREMENT_MAX_AGE_MS = 30 * 60 * 60 * 1000

/** Hours the archiver must have recorded before a day is counted in full. */
export const HOURS_IN_A_DAY = 24

export interface DayMeasurement {
  archiveDay: string
  pgExecutionCount: number
  sfExecutionCount: number
  pgStepCount: number
  sfStepCount: number
  /**
   * Executions Postgres holds for this day that the archiver never claimed and
   * nobody erased. EXACT: this is the unit the refusal is really about.
   */
  orphanExecutionCount: number
  /**
   * Step rows belonging to a BOUNDED SAMPLE of those orphan executions. A lower
   * bound, never a total. Measured against production 2026-08-22: counting
   * every orphan step took 30 s and timed out on the worst day, which is the
   * day the measurement exists to report, so the count is capped and the
   * message says so.
   */
  orphanStepCountSeen: number
  orphanSampleSize: number
  /**
   * Hours of this day the archiver recorded a reconciled count for. A day is
   * 24, so anything less is an hour that was never archived.
   */
  hoursRecorded: number
  /**
   * The archiver's own per-hour execution counts, summed. Compared against
   * pgExecutionCount: both count executions whose started_at falls in this day,
   * so they can only differ if executions were written AFTER their hour was
   * archived, which is the one way a day goes short while every hour reconciled
   * at the time.
   */
  hoursExecutionCount: number
  erasedExecutionCount: number
  incompleteCount: number
  /**
   * Incomplete rows the amend pass has WRITTEN OFF as never able to finalise
   * (`archive/amend.ts`): their execution is gone from Postgres, or it was still
   * non-terminal three days after archiving.
   *
   * Subtracted from `incompleteCount` for the same reason an erasure is
   * subtracted from the execution count: the count is measured from the archive,
   * the decision is recorded locally, and the two must be reconciled before the
   * comparison. Without it the wedge only moves, because a row that can never
   * finalise would refuse its day forever while the alert named a remedy that had
   * already been tried and abandoned.
   *
   * It gets its own number and its own sentence rather than silently lowering the
   * count, because a written-off row is a real loss of fidelity in the archive and
   * a day carrying one must not read like a clean day (L11).
   */
  abandonedExecutionCount: number
  probeSampled: number
  probeOk: boolean
  probeFailureReason: string | null
  measuredAt: string | null
  firstMeasuredAt: string | null
}

export interface DayRefusal {
  /** Stable name for the condition, so alerting and tests do not match on prose. */
  code: string
  message: string
}

export interface GateContext {
  archiveDay: string
  now: Date
}

/** Thousands separators, because these numbers are read by people. */
function n(value: number): string {
  return value.toLocaleString('en-US')
}

function hours(ms: number): string {
  return String(Math.round(ms / (60 * 60 * 1000)))
}

/**
 * Every reason this day may not be deleted, each under its own name.
 *
 * Deliberately a LIST rather than a first-failure. Several of these arrive
 * together when something systematic goes wrong, and reporting only the first
 * would make each fix reveal the next one a day later.
 */
export function refusalsFor(measurement: DayMeasurement | null, ctx: GateContext): DayRefusal[] {
  if (measurement === null || measurement.measuredAt === null) {
    // The load-bearing rule. If archiving stalls, no day becomes deletable and
    // the truncate finds nothing authorised, with no code path needed to
    // notice. A row that exists but carries no measured_at was written by a run
    // that failed before measuring, which is the same thing as never measured
    // and must not read as a fresh measurement of nothing.
    return [{ code: 'never-measured', message: `${ctx.archiveDay} was never measured` }]
  }

  const ageMs = ctx.now.getTime() - Date.parse(measurement.measuredAt)
  if (!Number.isFinite(ageMs)) {
    return [
      {
        code: 'never-measured',
        message: `${ctx.archiveDay} carries a measured_at that cannot be read, so its age is unknown`,
      },
    ]
  }
  if (ageMs > MEASUREMENT_MAX_AGE_MS) {
    // Its own refusal and its own early return: everything below describes what
    // the numbers said, and those numbers are no longer known to be about the
    // day as it stands now.
    return [
      {
        code: 'stale-measurement',
        message:
          `the measurement of ${ctx.archiveDay} is ${hours(ageMs)} hours old, past the ` +
          `${hours(MEASUREMENT_MAX_AGE_MS)} hour limit`,
      },
    ]
  }

  // Its own refusal and its own early return, because pgStepCount is SUMMED
  // from these hours: with hours missing, every count below is measured over a
  // fraction of the day and would report a step shortfall of unexplained size
  // rather than the hour that is actually absent (L11).
  if (measurement.hoursRecorded < HOURS_IN_A_DAY) {
    return [
      {
        code: 'hours-missing',
        message:
          `only ${measurement.hoursRecorded} of the ${HOURS_IN_A_DAY} hours of ${ctx.archiveDay} have been ` +
          'archived, so the day is not finished and nothing about it has been counted in full',
      },
    ]
  }

  const refusals: DayRefusal[] = []

  // Two independent Postgres counts of the same population. A difference means
  // executions arrived after their hour was archived, which nothing else would
  // notice: every hour reconciled at the time it ran.
  if (measurement.hoursExecutionCount !== measurement.pgExecutionCount) {
    refusals.push({
      code: 'late-executions',
      message:
        `Postgres holds ${n(measurement.pgExecutionCount)} executions for ${ctx.archiveDay} but its hours ` +
        `were archived counting ${n(measurement.hoursExecutionCount)}, so ` +
        `${n(measurement.pgExecutionCount - measurement.hoursExecutionCount)} arrived after their hour was archived`,
    })
  }

  // Erasures are subtracted BEFORE comparing. Without this a correct erasure
  // makes Snowflake legitimately lower, the gate reports a shortfall, and the
  // refusal can never be cleared by the remedy it names: re-running the
  // archiver re-inserts nothing, because those rows were deliberately
  // destroyed. The day would be blocked forever, and while stuck there the gate
  // could no longer report a REAL shortfall, because the two read identically.
  const expectedExecutions = measurement.pgExecutionCount - measurement.erasedExecutionCount
  if (measurement.sfExecutionCount < expectedExecutions) {
    refusals.push({
      code: 'executions-disagree',
      message:
        `executions disagree for ${ctx.archiveDay} (pg ${n(measurement.pgExecutionCount)} less ` +
        `${n(measurement.erasedExecutionCount)} erased / sf ${n(measurement.sfExecutionCount)})`,
    })
  } else if (measurement.sfExecutionCount > expectedExecutions) {
    // Its own name. More archived than Postgres holds is not a missing row: it
    // is a day already truncated, or executions archived under the wrong day.
    // Reporting it as a negative shortfall would send whoever reads it looking
    // for data that is not lost.
    refusals.push({
      code: 'executions-surplus',
      message:
        `the archive holds more executions than Postgres for ${ctx.archiveDay} ` +
        `(pg ${n(measurement.pgExecutionCount)} less ${n(measurement.erasedExecutionCount)} erased / ` +
        `sf ${n(measurement.sfExecutionCount)}), so the two are not describing the same day`,
    })
  }

  // The quantity the gate actually exists to protect: roughly 1,050,000 rows and
  // 2,470 MB a day, the bulk of the data and all of the debugging value. A
  // systematic step loss could affect a large fraction of a day while the
  // execution count and a small sample both stayed green.
  if (measurement.sfStepCount !== measurement.pgStepCount) {
    const shortfall = measurement.pgStepCount - measurement.sfStepCount
    refusals.push({
      code: 'steps-disagree',
      message:
        `steps disagree for ${ctx.archiveDay} (pg ${n(measurement.pgStepCount)} / ` +
        `sf ${n(measurement.sfStepCount)}; shortfall ${n(shortfall)})`,
    })
  }

  if (measurement.orphanExecutionCount > 0) {
    // Counted in executions, because that is the number the measurement can
    // state exactly. The step figure is a lower bound from a sample and is
    // worded as one: a message may claim only what its check measured (L11).
    const sampled = Math.min(measurement.orphanSampleSize, measurement.orphanExecutionCount)
    refusals.push({
      code: 'orphan-executions',
      message:
        `${n(measurement.orphanExecutionCount)} executions on ${ctx.archiveDay} have no archived row, so ` +
        `their steps have no copy anywhere (at least ${n(measurement.orphanStepCountSeen)} step rows, ` +
        `counted across ${n(sampled)} of them)`,
    })
  }

  if (!measurement.probeOk) {
    refusals.push({
      code: 'probe-failed',
      message:
        `the payload probe failed for ${ctx.archiveDay}: ` +
        // A failed probe with no reason is a measurement bug, and reading it as
        // a pass would be the gate defending nothing.
        (measurement.probeFailureReason ?? 'no reason was recorded, which is itself unexplained'),
    })
  } else if (measurement.probeSampled === 0 && measurement.pgExecutionCount > 0) {
    // A probe that examined no rows is not a probe that passed (L98). Without
    // this, a probe step that silently selected no ids reports ok and the gate
    // approves a whole day of unexamined bundles. A genuinely empty day is
    // exempt: there is nothing to sample and its zero is honest.
    refusals.push({
      code: 'probe-sampled-nothing',
      message:
        `the payload probe for ${ctx.archiveDay} examined no bundles at all, which is not the same as ` +
        `passing, and ${n(measurement.pgExecutionCount)} executions went unchecked`,
    })
  }

  // A NON-FINITE abandoned count counts as ZERO, so the refusal still fires.
  // Not defensive noise: subtracting an absent field gives NaN, `NaN > 0` is
  // false, and the incomplete refusal therefore vanished entirely rather than
  // firing. Found by an existing test whose fixture predates this field, which is
  // the good case; in production the same shape would be a missing column reading
  // as a clean day. The safe direction is to refuse (L72).
  const abandoned = Number.isFinite(measurement.abandonedExecutionCount)
    ? measurement.abandonedExecutionCount
    : 0

  // Clamped at zero: the two numbers come from different systems read at
  // different moments, so the archive side can legitimately lag a local write,
  // and a negative here would print as a count in a message (L11).
  const outstanding = Math.max(0, measurement.incompleteCount - abandoned)

  if (outstanding > 0) {
    // A real row, but not the finished story of that lead: archived at the
    // deadline while still non-terminal, and the amend pass has not caught up.
    // Deleting the Postgres copy would freeze it that way permanently.
    const one = outstanding === 1
    refusals.push({
      code: 'incomplete-rows',
      message:
        `${n(outstanding)} execution${one ? '' : 's'} archived incomplete on ` +
        `${ctx.archiveDay}, so ${one ? 'its' : 'their'} final state is not in the archive yet`,
    })
  }


  return refusals
}

/** Sugar over `refusalsFor`, so no caller re-derives what "no refusals" means. */
export function deletable(measurement: DayMeasurement | null, ctx: GateContext): boolean {
  return refusalsFor(measurement, ctx).length === 0
}

/**
 * What is worth SAYING about a day that is not a reason to refuse it.
 *
 * Kept out of `refusalsFor` deliberately. That function means refusals, and
 * `deletable` is defined as it returning nothing, so a non-blocking entry added
 * there would silently block every day that carried one: the opposite of what it
 * is for, and invisible because the message would read as reasonable.
 *
 * Today there is one, and it is the counterpart of the abandonment subtraction.
 * An execution written off as permanently incomplete no longer refuses its day,
 * because the amend pass has already decided it can never be corrected and
 * refusing would name a remedy that has been tried and given up. But it IS a
 * permanent loss of fidelity in the one artifact whose job is answering what
 * happened to a lead, so a day carrying one must not read like a clean day
 * (L11, L152).
 */
export function observationsFor(measurement: DayMeasurement | null, ctx: GateContext): DayRefusal[] {
  if (measurement === null || measurement.abandonedExecutionCount <= 0) return []

  const one = measurement.abandonedExecutionCount === 1
  return [
    {
      code: 'incomplete-written-off',
      message:
        `${n(measurement.abandonedExecutionCount)} execution${one ? '' : 's'} on ${ctx.archiveDay} ` +
        `${one ? 'was' : 'were'} written off as permanently incomplete, so the archive holds ` +
        `${one ? 'it' : 'them'} without ${one ? 'its' : 'their'} final state`,
    },
  ]
}
