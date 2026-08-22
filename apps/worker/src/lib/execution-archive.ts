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
import { dispositionFor, type WorkflowOrganization } from '../archive/disposition'
import { scalarsFor, type ArchiveScalars } from '../archive/scalars'
import { archiveDay, SETTLE_WINDOW_MS } from '../archive/clock'
import { encodeBundle } from '../archive/bundle'
import { extractPersonFields } from '../engine/lead-sightings'
import { hashSsn } from '../engine/persons-crypto'
import { fetchHour } from '../archive/hour-fetch'
import { runArchive, type RunResult, type EncodedForSend } from '../archive/run-loop'
import type { Env } from '../index'

const HOUR_MS = 60 * 60 * 1000

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
  /** Copied off the execution row, so later phases need not decompress. */
  scalars: ArchiveScalars
}

export interface ArchiveDeps {
  sendBatch: (rows: ArchiveRow[]) => Promise<void>
  now?: () => Date
}

export interface ArchiveRunSummary extends RunResult {
  skipped?: 'locked'
}

/**
 * Where a fresh watermark starts when no row exists yet.
 *
 * Derived from the settle window rather than picked, because picking it is what
 * broke. This used to return the hour before the current one, which reads as
 * "one hour back, so a first run archives one hour". Composed with
 * `nextHourToArchive` it meant the next hour to archive was the CURRENT hour,
 * which has not closed, so the run archived nothing, never advanced the
 * watermark, and the next run recomputed the same too-recent watermark from the
 * new clock. A permanent standstill by construction: the job ran hourly for 19
 * hours on prod and its three bookkeeping tables stayed empty.
 *
 * The selector archives the hour AFTER the watermark, and only once that hour
 * has closed and cleared the settle window. So the newest usable watermark is:
 *
 *   hourEnd   <= now - SETTLE          (fully settled)
 *   hourStart  = watermark + 1 hour
 *   hourEnd    = watermark + 2 hours
 *   watermark <= now - SETTLE - 2 hours
 *
 * Flooring `now` to the hour keeps it on the grid the selector requires, and
 * makes the boundary case (exactly on the hour) land on `>= SETTLE`, which the
 * selector accepts.
 *
 * Newest rather than oldest on purpose: starting further back would make a
 * first run crawl the retained window an hour at a time for no reason. The
 * hours before it are not lost, they are simply never claimed by a fresh
 * stream, which is what a first run should do.
 */
export function initialWatermark(now: Date): string {
  const flooredMs = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS
  return new Date(flooredMs - SETTLE_WINDOW_MS - 2 * HOUR_MS).toISOString()
}

/**
 * A run that did no work, as the shared base for every early return.
 *
 * Written once so an early return cannot quietly omit a field and report, say,
 * zero hours behind when nobody measured. `stop` and `detail` are always
 * overridden by the caller, because an early return that kept the healthy
 * steady state wording would read as a successful catch-up.
 */
const EMPTY_RUN: ArchiveRunSummary = {
  stop: 'caught-up',
  failed: false,
  hoursArchived: 0,
  hoursEmpty: 0,
  executionsArchived: 0,
  executionsRefused: 0,
  hoursBehind: 0,
  detail: '',
}

export async function runExecutionArchive(
  env: Env,
  supabase: SupabaseClient,
  deps: ArchiveDeps,
): Promise<ArchiveRunSummary> {
  const now = deps.now ?? ((): Date => new Date())

  // Checked before anything is read or locked. A missing pepper is not a per
  // execution problem: it would write a null resolver for EVERY row of the
  // hour, and after A5 (#873) removes the Postgres source those rows can never
  // be given one. Archiving the hour and reporting success would therefore lose
  // something permanently while looking healthy, so the run refuses instead and
  // the hour stays unarchived until the secret is set (#927).
  const pepper = env.SSN_HASH_PEPPER
  if (typeof pepper !== 'string' || pepper.length === 0) {
    const detail = 'SSN_HASH_PEPPER is not set, so the archive cannot write the person resolver'
    for (const alert of alertsFor({ ...EMPTY_RUN, stop: 'misconfigured', failed: true, detail })) {
      await notifyExportFailure(supabase, alert.jobName, alert.errors, env.IDEMPOTENCY)
    }
    return { ...EMPTY_RUN, stop: 'misconfigured', failed: true, detail }
  }

  const held = await env.IDEMPOTENCY.get(RUN_LOCK_KEY)
  if (held) {
    console.log('[execution-archive] another run holds the lock, skipping')
    return {
      ...EMPTY_RUN,
      skipped: 'locked',
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
    const scalarsById = new Map<string, ArchiveScalars>()

    /**
     * Refusals decided at disposition, which the run loop cannot see.
     *
     * Disposition happens inside the fetchHour callback below, so the loop's own
     * `executionsRefused` only ever rises for an encode failure or an oversized
     * bundle. Those are the rare paths. The common ones, a foreign tenant and a
     * row missing a required column, incremented nothing, so a run that refused
     * EVERY execution reported zero refusals and the alert written for exactly
     * that case could not speak: #949 measured 5,617 of 5,617 refused for a
     * tenancy mismatch and nothing said so (#957, L90).
     */
    let refusedAtDisposition = 0

    /**
     * Executions archived with no person resolver.
     *
     * Counted rather than ignored because the absence is legitimate at a
     * measured 3.5% and catastrophic at 100%, and those two arrive on the same
     * path and read identically unless something knows the rate (L77). Logged
     * with the run so a payload shape change that silences extraction is
     * visible as a number rather than discovered by an erasure that finds
     * nothing months later.
     */
    let executionsWithNoSsn = 0

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
            refusedAtDisposition++
            continue
          }
          // The archive table requires an organization, a workflow and a start.
          // A row missing any of them is refused BY ID here, where a refusal is
          // already an outcome the loop records, rather than at the send, where
          // it would fail a whole batch and stall the watermark on an hour that
          // could never pass.
          const workflowId = bundle.execution.workflow_id
          const ssnHash = await ssnHashFor(bundle.execution, pepper)
          if (ssnHash === null) executionsWithNoSsn++
          const scalars = scalarsFor(
            bundle.execution,
            typeof workflowId === 'string' ? organizationOf.get(workflowId)?.id : undefined,
            ssnHash,
          )
          if (!scalars.ok) {
            await upsertRefusal(supabase, bundle.executionId, day, scalars.reason, now())
            refusedAtDisposition++
            continue
          }
          dayById.set(bundle.executionId, day)
          incompleteById.set(bundle.executionId, d.incomplete)
          scalarsById.set(bundle.executionId, scalars.scalars)
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
        await deps.sendBatch(batch.map((b) => toRow(b, dayById, incompleteById, scalarsById)))
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

    // Folded in BEFORE the alerts are computed, so the refusal alert and the
    // "refused every execution it read" wording judge the same number the ledger
    // holds. Added after, the alert would go on reading zero.
    result.executionsRefused += refusedAtDisposition

    // Each condition under its own name, and nothing at all for a healthy run:
    // notifyExportFailure clears its grace marker when called with no errors.
    for (const alert of alertsFor(result)) {
      await notifyExportFailure(supabase, alert.jobName, alert.errors, env.IDEMPOTENCY)
    }

    console.log(
      `[execution-archive] stop=${result.stop} hours=${result.hoursArchived} empty=${result.hoursEmpty} ` +
        `archived=${result.executionsArchived} refused=${result.executionsRefused} ` +
        `no_ssn=${executionsWithNoSsn} behind=${result.hoursBehind}`,
    )
    return result
  } finally {
    await env.IDEMPOTENCY.delete(RUN_LOCK_KEY)
  }
}

/**
 * The archive's secondary erasure resolver, from the execution's own payload.
 *
 * The field path is NOT re-derived here: `extractPersonFields` is the single
 * place that records where an SSN sits in a trigger payload, verified against
 * the live Engine Bidding Workflow, and it already returns null when there is
 * none. `hashSsn` normalises to digits before hashing, so an erasure request
 * arriving as 123-45-6789 and a payload carrying 123456789 meet (L185).
 *
 * Read off the payload the archiver is already holding rather than joined from
 * `lead_sightings`: that join costs an extra paged read every hour and cannot
 * tell an execution that genuinely carried no SSN from a sightings row already
 * purged, because both return nothing (#927).
 */
export async function ssnHashFor(
  execution: Record<string, unknown>,
  pepper: string,
): Promise<string | null> {
  const ssn = extractPersonFields(execution.trigger_payload)?.ssn
  if (typeof ssn !== 'string' || ssn.length === 0) return null
  return hashSsn(ssn, pepper)
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
  scalarsById: Map<string, ArchiveScalars>,
): ArchiveRow {
  const day = dayById.get(encoded.executionId)
  if (day === undefined || day === '') {
    // Refusing here rather than sending an empty day: archive_day is the column
    // every side of the deletion gate joins on, so a blank one would produce a
    // row that can never be matched to the partition it came from.
    throw new Error(`execution ${encoded.executionId} reached the send with no archive day`)
  }
  const scalars = scalarsById.get(encoded.executionId)
  if (scalars === undefined) {
    // Same refusal as the day above, for the same reason: three of these
    // columns are NOT NULL, so a row that reached the send without them cannot
    // be written and must not be sent alongside rows that can.
    throw new Error(`execution ${encoded.executionId} reached the send with no scalars`)
  }
  return {
    executionId: encoded.executionId,
    archiveDay: day,
    wire: encoded.wire,
    incomplete: incompleteById.get(encoded.executionId) === true,
    stepCount: encoded.stepCount,
    scalars,
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
export async function loadWorkflowOrganizations(supabase: SupabaseClient): Promise<Map<string, WorkflowOrganization>> {
  const { data, error } = await supabase
    .from('workflows')
    .select('id, organizations!workflows_organization_id_fkey(id, slug)')
  if (error) throw new Error(`loading workflow organizations failed: ${formatErr(error)}`)
  const map = new Map<string, WorkflowOrganization>()
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = row.id
    const org = row.organizations as { id?: string; slug?: string } | null
    // Both halves or neither. A workflow whose organization row came back
    // without an id must not be recorded as known-and-live, because the slug
    // alone would pass the tenancy check and then be refused at the scalars for
    // a reason that reads like a different problem.
    if (typeof id === 'string' && typeof org?.id === 'string' && typeof org.slug === 'string') {
      map.set(id, { id: org.id, slug: org.slug })
    }
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
