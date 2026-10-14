/**
 * Speaking when the archive is running out of room (#1294).
 *
 * The headroom reading lives in `archive/headroom.ts` and is published in the
 * archive health report. A number on a report is not a detector, because
 * detection requires something that speaks on its own when the number is wrong
 * (L357), and the issue's own argument was that none of the ways to raise the
 * ceiling help if nobody notices the day the headroom is gone.
 *
 * WHAT IT IS WATCHING FOR. The run loop reserves room for the hour it is about
 * to start, sized from the slowest hour it has already completed. Once the
 * busiest hour no longer fits, the run archives ZERO hours, completes cleanly
 * and writes a normal run record, which is indistinguishable from a run with
 * nothing to do (L98). The standstill detector catches it three cadences later
 * and reports a stall, which is true and is not the finding: the finding is that
 * the archive has outgrown one invocation, and the fixes for a stall and for
 * that are different.
 *
 * WHY IT FIRES BEFORE THE RATIO REACHES 1. At 1.0 the archive has already
 * stopped advancing at peak. The threshold is the same 1.25 the CI test uses, so
 * the repo and production are watching for one number rather than two that drift
 * (L70), and 25 percent of growth is weeks of warning rather than an incident.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { headroomFrom, type HeadroomReading, type HourRun } from '../archive/headroom'
import { CRON_RUN_BUDGET } from '../archive/deadline'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import type { Env } from '../index'

export const ARCHIVE_HEADROOM_JOB = 'execution-archive-headroom'

/**
 * The ratio below which this speaks.
 *
 * The same figure `execution-archive.test.ts` fails at, deliberately: one number
 * watched from two directions, rather than two numbers that can drift apart.
 * That test catches a change to our constants; this catches the traffic growing,
 * which touches no file and turns nothing red.
 */
export const ARCHIVE_HEADROOM_FLOOR = 1.25

export const ARCHIVE_HEADROOM_REMEDY: AlertRemedy = {
  consequence:
    'The execution archive is running out of room to finish its busiest hour inside one run. Nothing is ' +
    'broken and nothing is missing yet. What happens at the limit is the problem: a run that cannot fit ' +
    'its busiest hour archives no hours at all, completes cleanly, and looks exactly like a run with ' +
    'nothing to do, so the first visible symptom would be the archive stalling hours later:',
  fixHint:
    'Re-take the figures with supabase/tests/measure-archive-hour-cost.sql (query 3 prints the ratio). ' +
    'The options, in order of how much they buy: make an hour cheaper, which is dominated by the ' +
    'Snowflake send rather than local work, so larger slices or more concurrency; or make an hour ' +
    'resumable in parts, so no single unit has to fit in one run. Raising the wall budget buys about ' +
    '10 percent and spends the margin that keeps a killed run from leaving no record.',
  headlineVerb: 'is running out of room',
  itemNoun: { one: 'measurement', many: 'measurements' },
}

/**
 * Below a ratio of 1.0 the busiest hour, by this measurement, no longer fits in
 * one run, so "nothing is broken yet" is no longer true (#835).
 */
export const ARCHIVE_HEADROOM_EXHAUSTED_REMEDY: AlertRemedy = {
  ...ARCHIVE_HEADROOM_REMEDY,
  consequence:
    'By this measurement the busiest hour no longer fits inside one run of the execution archive. A run ' +
    'that reaches an hour that size archives no hours at all and completes cleanly, so at peak the archive ' +
    'stops advancing and the first visible symptom is the archive stalling hours later:',
  headlineVerb: 'has run out of room for its busiest hour',
}

export interface HeadroomCheckDeps {
  readRuns?: (supabase: SupabaseClient, now: Date) => Promise<HourRun[]>
  notify?: typeof notifyExportFailure
  now?: () => Date
}

export interface HeadroomCheckResult {
  reading: HeadroomReading
  alerted: boolean
}

/**
 * Read the headroom and alert when it is below the floor.
 *
 * A reading it cannot take is NOT an alert. Too few runs means the archive has
 * barely run, which is either a new deployment or a separate problem that the
 * cron heartbeat and the standstill detector both already report. Alerting here
 * as well would be a second name for a condition that already has one (L11), and
 * it would fire on every fresh environment.
 */
export async function checkArchiveHeadroom(
  env: Env,
  supabase: SupabaseClient,
  deps: HeadroomCheckDeps = {},
): Promise<HeadroomCheckResult> {
  const notify = deps.notify ?? notifyExportFailure
  const now = (deps.now ?? (() => new Date()))()
  const readRuns = deps.readRuns ?? (await import('./archive-health')).recentHourRuns

  const reading = headroomFrom(await readRuns(supabase, now), CRON_RUN_BUDGET.wallMs)

  if (reading.kind !== 'measured' || reading.ratio >= ARCHIVE_HEADROOM_FLOOR) {
    // Clears the alert state, so a recovered headroom stops re-announcing and
    // a later dip is announced again rather than suppressed by the old one.
    await notify(supabase, ARCHIVE_HEADROOM_JOB, [], env.IDEMPOTENCY, ARCHIVE_HEADROOM_REMEDY)
    return { reading, alerted: false }
  }

  await notify(
    supabase,
    ARCHIVE_HEADROOM_JOB,
    [
      `the busiest hour of the last week held ${reading.busiestHourExecutions.toLocaleString('en-US')} executions, ` +
        `which at the p95 rate of ${reading.p95MsPerExecution}ms each costs about ` +
        `${Math.round(reading.busiestHourCostMs / 1000)}s against a ${Math.round(reading.wallBudgetMs / 1000)}s wall ` +
        `budget. That is a ratio of ${reading.ratio}, under the ${ARCHIVE_HEADROOM_FLOOR} this speaks at, measured ` +
        `over ${reading.runsMeasured} single-hour runs. At 1.0 the archive can no longer advance at peak.`,
    ],
    env.IDEMPOTENCY,
    reading.ratio < 1 ? ARCHIVE_HEADROOM_EXHAUSTED_REMEDY : ARCHIVE_HEADROOM_REMEDY,
  )
  return { reading, alerted: true }
}
