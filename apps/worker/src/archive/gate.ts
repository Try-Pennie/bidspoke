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

  // A day with nothing in it has no hours to record and nothing to lose, so its
  // zero is honest and it is verified rather than refused. Without this every
  // quiet day refuses forever on hours it was never going to have, and once it
  // ages past the window that could re-measure it, that refusal is permanent and
  // strands the next day's step partition with it (#1249, L98).
  if (measurement.hoursRecorded === 0 && measurement.pgExecutionCount === 0) {
    // Falls through to the count comparisons below, which an empty day passes.
  } else if (measurement.hoursRecorded === 0) {
    // Its own code, its own remedy (#1016). Between 2026-08-16 and 2026-08-21 the
    // archive covered zero days while Postgres held all six, and nothing
    // reported it: the archiver was running normally on current hours the whole
    // time, so it was neither stalled nor failing, it was simply never asked
    // about the older days. Some hours missing is a re-archive of the gap; NO
    // hours is a day the walk has never reached, and the wording says what is
    // about to be lost rather than that a gate is refusing.
    return [
      {
        code: 'never-archived',
        message:
          `no hour of ${ctx.archiveDay} has been archived at all, so the ${n(measurement.pgExecutionCount)} ` +
          'executions Postgres still holds for it have no copy anywhere, and only until its partition is purged',
      },
    ]
  } else if (measurement.hoursRecorded < HOURS_IN_A_DAY) {
    // Its own refusal and its own early return, because pgStepCount is SUMMED
    // from these hours: with hours missing, every count below is measured over a
    // fraction of the day and would report a step shortfall of unexplained size
    // rather than the hour that is actually absent (L11).
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

  if (measurement.incompleteCount > 0) {
    // A real row, but not the finished story of that lead: archived at the
    // deadline while it was still non-terminal. Deleting the Postgres copy
    // would freeze it that way permanently.
    //
    // NOTHING CLEARS THIS ON ITS OWN. The comments here used to say the amend
    // pass had not caught up yet; there is no amend pass, and #932 closed the
    // question after two measurements over 1.4 million executions found
    // nothing that would trigger one. The hourly walk never revisits an hour it
    // has passed either. So the only thing that resolves this is re-archiving
    // the day, and the message says so rather than implying a wait (L11, L111).
    const one = measurement.incompleteCount === 1
    refusals.push({
      code: 'incomplete-rows',
      message:
        `${n(measurement.incompleteCount)} execution${one ? '' : 's'} archived incomplete on ` +
        `${ctx.archiveDay}, so ${one ? 'its' : 'their'} final state is not in the archive. ` +
        `Nothing resolves this on its own: re-archive ${ctx.archiveDay} to pick up the finished ` +
        `${one ? 'run' : 'runs'}`,
    })
  }

  return refusals
}

/** Sugar over `refusalsFor`, so no caller re-derives what "no refusals" means. */
export function deletable(measurement: DayMeasurement | null, ctx: GateContext): boolean {
  return refusalsFor(measurement, ctx).length === 0
}
