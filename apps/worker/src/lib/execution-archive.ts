/**
 * The hourly execution archive job (#871, Phase A3).
 *
 * Ties the pieces together and owns what the pure logic deliberately does not
 * know about: the KV run lock, the budgets, reading and writing the watermark,
 * and turning a run's outcome into alerts.
 *
 * SHADOW PHASE. This writes to Snowflake and to its own bookkeeping tables. It
 * does NOT change what anything deletes: both destructive jobs are untouched
 * until A5 (#873), and the deletion gate that would authorise them does not
 * exist until A4 (#872).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure } from './export-alerts'
import { alertsFor } from '../archive/alerts'
import { dispositionFor } from '../archive/disposition'
import { archiveDay } from '../archive/clock'
import { encodeBundle } from '../archive/bundle'
import { fetchHour } from '../archive/hour-fetch'
import { runArchive, type RunResult, type EncodedForSend } from '../archive/run-loop'
import type { Env } from '../index'

/** One row, one stream. A second stream (a backfill, a replay) gets its own id. */
export const ARCHIVE_STREAM = 'executions'

/**
 * Hours a single run may archive.
 *
 * Derived from the CPU ceiling in wrangler.toml rather than picked: A0 measured
 * 0.8 ms of CPU per bundle, so an hour of roughly 4,375 executions is about
 * 3.5 s, and four hours is 14 s against a 30,000 ms ceiling shared with
 * everything else the invocation does. A8 (#876) measures this for real; until
 * then the cap stays inside half the ceiling, and a test asserts that rather
 * than leaving the margin as a claim in this comment.
 *
 * At four hours per hourly run the archive gains three hours of ground per hour
 * of real time, so a three day backlog drains in roughly a day.
 */
export const MAX_HOURS_PER_RUN = 4

/** Wall-clock budget for one run, inside the platform's cron limit. */
export const WALL_TIME_BUDGET_MS = 10 * 60 * 1000

/**
 * Two overlapping invocations would both drain and both send, doubling the
 * bundles. The lock is an OPTIMISATION, not the correctness story: the watermark
 * and the gate's COUNT(DISTINCT) are what make a duplicate harmless.
 */
export const RUN_LOCK_KEY = 'execution-archive:run-lock'
const RUN_LOCK_TTL_SECONDS = 15 * 60

/** A row on its way to Snowflake, with the scalars the gate reads without decompressing. */
export interface ArchiveRow {
  executionId: string
  archiveDay: string
  wire: string
  incomplete: boolean
  /** From the encoded bundle, never recomputed here. See EncodedForSend. */
  stepCount: number
}

export interface ArchiveDeps {
  sendBatch: (rows: ArchiveRow[]) => Promise<void>
  now?: () => Date
}

export interface ArchiveRunSummary extends RunResult {
  skipped?: 'locked'
}

/** Where a fresh watermark starts when no row exists yet. */
export function initialWatermark(now: Date): string {
  // The hour before the one that just closed, so a first run archives one hour
  // rather than attempting the entire retained window in a single invocation.
  const ms = Math.floor(now.getTime() / 3_600_000) * 3_600_000 - 3_600_000
  return new Date(ms).toISOString()
}

export async function runExecutionArchive(
  env: Env,
  supabase: SupabaseClient,
  deps: ArchiveDeps,
): Promise<ArchiveRunSummary> {
  const now = deps.now ?? ((): Date => new Date())

  const held = await env.IDEMPOTENCY.get(RUN_LOCK_KEY)
  if (held) {
    console.log('[execution-archive] another run holds the lock, skipping')
    return {
      skipped: 'locked',
      stop: 'caught-up',
      failed: false,
      hoursArchived: 0,
      hoursEmpty: 0,
      executionsArchived: 0,
      executionsRefused: 0,
      hoursBehind: 0,
      detail: 'another invocation holds the run lock',
    }
  }
  await env.IDEMPOTENCY.put(RUN_LOCK_KEY, new Date().toISOString(), { expirationTtl: RUN_LOCK_TTL_SECONDS })

  try {
    // One small read per run, cached for the run. workflow_executions carries no
    // organization_id and there are ten live workflows, so this is never joined
    // per execution.
    const organizationOf = await loadWorkflowOrganizations(supabase)

    /**
     * Per execution, keyed by id: the day it belongs to and whether it was
     * archived at the deadline while still non-terminal.
     *
     * Keyed rather than held as "the current hour" so nothing depends on shared
     * mutable state that a second run, or a batch spanning a boundary, could
     * read at the wrong moment. The day comes from each execution's own
     * started_at through the one shared helper, never from the clock.
     */
    const dayById = new Map<string, string>()
    const incompleteById = new Map<string, boolean>()

    const deadline = now().getTime() + WALL_TIME_BUDGET_MS
    let subrequests = 900

    const result = await runArchive({
      now,
      readWatermark: async () => {
        const { data, error } = await supabase
          .from('execution_archive_progress')
          .select('watermark_hour')
          .eq('stream', ARCHIVE_STREAM)
          .maybeSingle()
        if (error) throw new Error(`reading the watermark failed: ${formatErr(error)}`)
        const stored = (data as { watermark_hour?: unknown } | null)?.watermark_hour
        return typeof stored === 'string' ? stored : initialWatermark(now())
      },
      advanceWatermark: async (hourStart) => {
        const { error } = await supabase
          .from('execution_archive_progress')
          .upsert(
            { stream: ARCHIVE_STREAM, watermark_hour: hourStart, updated_at: new Date().toISOString() },
            { onConflict: 'stream' },
          )
        if (error) throw new Error(`advancing the watermark failed: ${formatErr(error)}`)
      },
      fetchHour: async (hourStart, hourEnd) => {
        const hour = await fetchHour(supabase, hourStart, hourEnd)
        // Counted by the fetch itself, not estimated here: at the measured 11.9
        // steps per execution an hour is roughly fifty pages of steps alone, so
        // a hand-picked number would sit far below reality and the clean stop
        // could never fire (L182).
        subrequests -= hour.requests
        if (!hour.usable) return hour

        // Disposition sits between reading and encoding, so a refused execution
        // never reaches the encoder or the wire.
        const keep: typeof hour.bundles = []
        for (const bundle of hour.bundles) {
          const day = dayOf(bundle.execution, hourStart)
          const d = dispositionFor(bundle.execution, { now: now(), organizationOf })
          if (d.action === 'refuse') {
            await upsertRefusal(supabase, bundle.executionId, day, d.reason ?? 'refused', now())
            continue
          }
          dayById.set(bundle.executionId, day)
          incompleteById.set(bundle.executionId, d.incomplete)
          keep.push(bundle)
        }
        return { ...hour, bundles: keep }
      },
      encode: async (bundle) => {
        const encoded = await encodeBundle({ execution: bundle.execution, steps: bundle.steps })
        return {
          executionId: bundle.executionId,
          wire: encoded.wire,
          wireBytes: encoded.wireBytes,
          stepCount: encoded.stepCount,
        }
      },
      send: async (batch: EncodedForSend[]) => {
        subrequests -= 1
        await deps.sendBatch(batch.map((b) => toRow(b, dayById, incompleteById)))
      },
      recordArchived: async (executionIds) => {
        subrequests -= 1
        const { error } = await supabase.from('execution_archive_ids').upsert(
          executionIds.map((execution_id) => ({
            execution_id,
            archive_day: dayById.get(execution_id) ?? '',
          })),
          { onConflict: 'execution_id' },
        )
        if (error) throw new Error(`recording archived ids failed: ${formatErr(error)}`)
      },
      recordRefusal: async (executionId, reason) => {
        await upsertRefusal(supabase, executionId, dayById.get(executionId) ?? '', reason, now())
      },
      budget: {
        maxHours: MAX_HOURS_PER_RUN,
        deadlineAt: deadline,
        subrequestsLeft: () => subrequests,
      },
    })

    // Each condition under its own name, and nothing at all for a healthy run:
    // notifyExportFailure clears its grace marker when called with no errors.
    for (const alert of alertsFor(result)) {
      await notifyExportFailure(supabase, alert.jobName, alert.errors, env.IDEMPOTENCY)
    }

    console.log(
      `[execution-archive] stop=${result.stop} hours=${result.hoursArchived} empty=${result.hoursEmpty} ` +
        `archived=${result.executionsArchived} refused=${result.executionsRefused} behind=${result.hoursBehind}`,
    )
    return result
  } finally {
    await env.IDEMPOTENCY.delete(RUN_LOCK_KEY)
  }
}

/**
 * The day an execution belongs to, from its own started_at through the one
 * shared helper. Falls back to the hour being processed only when the row
 * carries no readable timestamp, which cannot happen for a NOT NULL column but
 * would otherwise write an empty string into a NOT NULL archive_day.
 */
function dayOf(execution: Record<string, unknown>, hourStart: string): string {
  const startedAt = execution.started_at
  return typeof startedAt === 'string' ? archiveDay(startedAt) : archiveDay(hourStart)
}

export function toRow(
  encoded: EncodedForSend,
  dayById: Map<string, string>,
  incompleteById: Map<string, boolean>,
): ArchiveRow {
  const day = dayById.get(encoded.executionId)
  if (day === undefined || day === '') {
    // Refusing here rather than sending an empty day: archive_day is the column
    // every side of the deletion gate joins on, so a blank one would produce a
    // row that can never be matched to the partition it came from.
    throw new Error(`execution ${encoded.executionId} reached the send with no archive day`)
  }
  return {
    executionId: encoded.executionId,
    archiveDay: day,
    wire: encoded.wire,
    incomplete: incompleteById.get(encoded.executionId) === true,
    stepCount: encoded.stepCount,
  }
}

/**
 * There are TWO relationships between workflows and organizations: the direct
 * foreign key, and a many-to-many through source_workflow_assignments. PostgREST
 * refuses an ambiguous embed rather than picking one, so the constraint is named
 * explicitly. Without it every run fails on its first read, which no unit test
 * would show because the query is doubled there. Found by a dry run against the
 * real database (L52: a test whose only outside dependency is a stub you wrote
 * can only confirm your own assumption about the real interface).
 */
async function loadWorkflowOrganizations(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('workflows').select('id, organizations!workflows_organization_id_fkey(slug)')
  if (error) throw new Error(`loading workflow organizations failed: ${formatErr(error)}`)
  const map = new Map<string, string>()
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = row.id
    const org = row.organizations as { slug?: string } | null
    if (typeof id === 'string' && typeof org?.slug === 'string') map.set(id, org.slug)
  }
  return map
}

async function upsertRefusal(
  supabase: SupabaseClient,
  executionId: string,
  archiveDayValue: string,
  reason: string,
  now: Date,
): Promise<void> {
  const { error } = await supabase.from('execution_archive_refusals').upsert(
    {
      execution_id: executionId,
      archive_day: archiveDayValue,
      reason,
      refused_at: now.toISOString(),
      resolved_at: null,
    },
    { onConflict: 'execution_id' },
  )
  if (error) throw new Error(`recording a refusal failed: ${formatErr(error)}`)
}
