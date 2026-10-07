import type { SupabaseClient } from '@supabase/supabase-js'
import type { LoadedWorkflow, WorkflowDefinition } from '../types'
import { isNotFoundError } from '../lib/api-error'
import { formatErr } from '../lib/format-error'
import { stripUrlQueriesInText } from '../lib/url-redact'
import { isWorkflowLane } from '@bidspoke/node-types'
import { leadRead } from '../lib/lead-read-budget'
import { STORED_COPY_RECONFIRM_AFTER_MS, judgeCopyAge, refuseStoredCopy } from '../lib/stored-copy-age'

// Thrown when the requested workflow doesn't exist, is deleted, or is inactive.
// A typed error so routes can map it to 404 by instanceof rather than matching
// substrings in a message (which mis-maps any internal error containing "not
// found"/"inactive"), and so the external response can stay generic (#107).
export class WorkflowNotFoundError extends Error {
  constructor(workflowId: string, inactive: boolean) {
    super(`Workflow ${workflowId} ${inactive ? 'not found or inactive' : 'not found'}`)
    this.name = 'WorkflowNotFoundError'
  }
}

const CACHE_TTL_SECONDS = 300
const cacheKey = (workflowId: string) => `workflow-def-${workflowId}`

/**
 * The last-good copy of a live workflow (#1845, plan A2 on #1675). Held with no
 * expiry and read ONLY when the database read fails, so a database outage does
 * not fail every live lead once the 300 s cache above has run out. A distinct
 * key from the cache, so dropping the cache on a save never drops the copy.
 */
export const workflowCopyKey = (workflowId: string) => `workflow-def-lastgood:${workflowId}`

/**
 * A held copy whose order key is unchanged is rewritten only once it is
 * STORED_COPY_RECONFIRM_AFTER_MS old, so its `written_at`, which is when it was
 * last confirmed, stays fresh while the database is healthy without a KV write
 * on every cache miss. The per minute prewarm misses the 300 s cache about every
 * five minutes, so a healthy copy is never much more than eleven minutes old
 * (stored-copy-freshness.test.ts measures it), and one older than
 * STORED_COPY_MAX_AGE_MS is refused (#1847).
 */

/**
 * What the last-good copy holds. A copy of a workflow that was switched off or
 * deleted is kept as a tombstone (`is_active: false`, no workflow) rather than
 * deleted, because the tombstone carries the stamp that stops a slower writer
 * holding the older, live row from writing it back.
 */
export interface WorkflowDefinitionCopy {
  is_active: boolean
  /** The lane the row was stored under, as read. */
  lane: string
  workflow_version_id: string | null
  version_number: number | null
  /**
   * `workflows.updated_at` of the row this copy was made from. A trigger moves it
   * on every update of the row, so with `version_number` it is the order no
   * write may go back on: a save, a switch off and a delete all move it.
   */
  row_updated_at: string
  /**
   * When this copy was written (ISO), which is when it was last confirmed
   * against the row: an unchanged row rewrites it once it has aged. A copy older
   * than STORED_COPY_MAX_AGE_MS, or with no readable time, is refused (#1847).
   */
  written_at: string
  /** What the engine runs; null on a tombstone. */
  workflow: LoadedWorkflow | null
  /**
   * Set when a route changed the workflow and the row could not then be read
   * back, or read back as one the engine would refuse: the state is unknown, so
   * the copy refuses as no usable copy (a retryable failure), never as not found.
   */
  unverified?: boolean
}

// The one select both reads use: the live load (filtered to active, not
// deleted) and the read back after a route's write (unfiltered).
const WORKFLOW_SELECT = `
  id,
  name,
  organization_id,
  slack_channel,
  definition,
  is_active,
  lane,
  updated_at,
  deleted_at,
  workflow_versions (id, version_number)
`

interface WorkflowRow {
  name: unknown
  organization_id: unknown
  slack_channel: unknown
  definition: unknown
  is_active: unknown
  lane: unknown
  updated_at: unknown
  deleted_at: unknown
  workflow_versions: unknown
}

function latestVersion(row: WorkflowRow): { id: string; version_number: number } | undefined {
  return (row.workflow_versions as { id: string; version_number: number }[] | null)?.[0]
}

/** The row as the engine runs it. Throws on a row with no version or an unknown lane. */
function loadedFromRow(workflowId: string, row: WorkflowRow): LoadedWorkflow {
  const workflow_version_id = latestVersion(row)?.id
  if (!workflow_version_id) {
    throw new Error(`Workflow ${workflowId} has no versions`)
  }

  const lane: unknown = row.lane
  if (!isWorkflowLane(lane)) {
    throw new Error(`Workflow ${workflowId} has unknown lane ${JSON.stringify(lane)}`)
  }

  return {
    definition: row.definition as WorkflowDefinition,
    workflow_version_id,
    workflow_name: row.name as string,
    org_id: row.organization_id as string,
    slack_channel: (row.slack_channel as string | null) ?? null,
    lane,
  }
}

interface LoadOptions {
  allowInactive?: boolean
  /** The clock the copy is stamped and aged by. Tests set it. */
  now?: () => number
}

export async function loadWorkflowDefinition(
  workflowId: string,
  kv: KVNamespace,
  supabase: SupabaseClient,
  options: LoadOptions = {}
): Promise<LoadedWorkflow> {
  const { allowInactive = false, now = Date.now } = options

  // Skip the cache for test runs against inactive workflows so we don't
  // pollute the cache with definitions that real webhooks shouldn't serve.
  if (!allowInactive) {
    const cached = await kv.get<LoadedWorkflow>(cacheKey(workflowId), 'json')
    // An entry cached before the lane existed (#1707) carries none: read the
    // row again rather than guess one, and the put below replaces the entry.
    if (cached && isWorkflowLane(cached.lane)) {
      return cached
    }
  }

  // Load from Supabase
  let query = supabase
    .from('workflows')
    .select(WORKFLOW_SELECT)
    .eq('id', workflowId)
    .is('deleted_at', null)
    .order('version_number', { referencedTable: 'workflow_versions', ascending: false })
    .limit(1, { referencedTable: 'workflow_versions' })

  if (!allowInactive) {
    query = query.eq('is_active', true)
  }

  // A live run's read has a copy to fall back on, so on a lead client it is
  // bounded and never retried (#1844). A test or shadow run has none, so its
  // read keeps the library's own behaviour.
  const { data, error } = allowInactive ? await query.single() : await leadRead(supabase, query.single(), 'workflow definition')

  // A transient DB error must NOT masquerade as a missing workflow: callers map
  // WorkflowNotFoundError to 404, which a lead source treats as "endpoint gone"
  // and stops retrying, dropping the lead (#303). PGRST116 is the genuine
  // no rows or inactive case (WorkflowNotFoundError); any other error is a real
  // failure. A live run falls back to the last-good copy (#1845), and a test or
  // shadow run, which never uses the copy, surfaces it as a retryable 5xx.
  if (error && !isNotFoundError(error)) {
    const failure = new Error(`Failed to load workflow ${workflowId}: ${error.message}`)
    if (allowInactive) throw failure
    return serveCopyOrThrow(workflowId, kv, failure, now)
  }
  if (!data) {
    throw new WorkflowNotFoundError(workflowId, !allowInactive)
  }

  const row = data as WorkflowRow
  const result = loadedFromRow(workflowId, row)

  // Cache for 5 minutes. KV is eventually consistent; the routes drop it on
  // save, and the scheduled pre-warm cron keeps active workflows hot (PRD 2.6).
  // Don't cache inactive defs: webhook callers must hit the active check.
  if (!allowInactive) {
    await kv.put(cacheKey(workflowId), JSON.stringify(result), {
      expirationTtl: CACHE_TTL_SECONDS,
    })
    // A failed copy write must not fail the lead the database just answered:
    // say so and carry on, and the next cache miss writes it again.
    try {
      await writeCopyForward(workflowId, kv, copyFromRow(row, result, now), now)
    } catch (err) {
      logEvent('workflow_definition_copy_write_failed', { workflow_id: workflowId, reason: formatErr(err) })
    }
  }

  return result
}

/**
 * The database read failed on a live run: serve the last-good copy, or throw
 * the failure itself when there is no copy fit to run. Never an empty
 * definition: a run with nothing to run is a refusal, not a fallback.
 */
async function serveCopyOrThrow(workflowId: string, kv: KVNamespace, failure: Error, now: () => number): Promise<LoadedWorkflow> {
  let held: WorkflowDefinitionCopy | null
  try {
    held = await kv.get<WorkflowDefinitionCopy>(workflowCopyKey(workflowId), 'json')
  } catch (err) {
    logEvent('workflow_definition_copy_refused', { workflow_id: workflowId, reason: 'copy_read_failed', detail: formatErr(err), db_error: failure.message })
    throw failure
  }
  if (!held) {
    logEvent('workflow_definition_copy_refused', { workflow_id: workflowId, reason: 'no_copy', db_error: failure.message })
    throw failure
  }
  // A route changed the workflow and its new state could not be confirmed.
  if (held.unverified === true) {
    logEvent('workflow_definition_copy_refused', { workflow_id: workflowId, reason: 'unverified', db_error: failure.message })
    throw failure
  }
  // Judged before anything the copy claims, a tombstone's not found included:
  // a claim nobody has confirmed for longer than the maximum age is refused as
  // a retryable failure, never answered (#1847).
  const age = judgeCopyAge(held.written_at, now())
  if (!age.usable) {
    throw refuseStoredCopy({ copy: 'workflow_definition', subject: workflowId, reason: age.reason, ageMs: age.ageMs, dbError: failure.message })
  }
  // The copy says the workflow was switched off or deleted: the same answer
  // the database gives for that row when it is up.
  if (held.is_active !== true) {
    logEvent('workflow_definition_copy_refused', { workflow_id: workflowId, reason: 'inactive', db_error: failure.message })
    throw new WorkflowNotFoundError(workflowId, true)
  }
  const workflow = held.workflow
  if (!isServableWorkflow(workflow)) {
    logEvent('workflow_definition_copy_refused', { workflow_id: workflowId, reason: 'unreadable', db_error: failure.message })
    throw failure
  }

  logEvent('workflow_definition_served_from_copy', {
    workflow_id: workflowId,
    workflow_version_id: workflow.workflow_version_id,
    copy_written_at: held.written_at,
    copy_age_ms: age.ageMs,
    db_error: failure.message,
  })
  // Only the fields the engine runs, never the copy's own bookkeeping.
  return {
    definition: workflow.definition,
    workflow_version_id: workflow.workflow_version_id,
    workflow_name: workflow.workflow_name,
    org_id: workflow.org_id,
    slack_channel: workflow.slack_channel ?? null,
    lane: workflow.lane,
  }
}

function isServableWorkflow(w: LoadedWorkflow | null | undefined): w is LoadedWorkflow {
  return (
    !!w &&
    typeof w === 'object' &&
    !!w.definition &&
    typeof w.definition === 'object' &&
    typeof w.workflow_version_id === 'string' &&
    w.workflow_version_id.length > 0 &&
    typeof w.org_id === 'string' &&
    isWorkflowLane(w.lane)
  )
}

function copyFromRow(row: WorkflowRow, loaded: LoadedWorkflow | null, now: () => number): WorkflowDefinitionCopy {
  const version = latestVersion(row)
  return {
    is_active: loaded !== null,
    lane: String(row.lane),
    workflow_version_id: version?.id ?? null,
    version_number: typeof version?.version_number === 'number' ? version.version_number : null,
    row_updated_at: String(row.updated_at),
    written_at: new Date(now()).toISOString(),
    workflow: loaded,
  }
}

/**
 * A Postgres timestamp as microseconds since the epoch. PostgREST returns six
 * fractional digits (trailing zeros trimmed), and Date.parse keeps three, so two
 * writes in one millisecond would otherwise compare equal. NaN when unreadable.
 */
export function postgresTimeMicros(value: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value)
  if (!m) return Number.NaN
  const [, date, time, fraction = '', zone = 'Z'] = m
  let offset = zone
  if (/^[+-]\d{2}$/.test(zone)) offset = `${zone}:00`
  else if (/^[+-]\d{4}$/.test(zone)) offset = `${zone.slice(0, 3)}:${zone.slice(3)}`
  const millis = Date.parse(`${date}T${time}${offset}`)
  if (!Number.isFinite(millis)) return Number.NaN
  return millis * 1000 + Number(fraction.padEnd(6, '0').slice(0, 6))
}

/** The order a copy may only move forward along: the row's stamp, then the version. */
function copyOrder(copy: WorkflowDefinitionCopy): [number, number] | null {
  const stamp = typeof copy.row_updated_at === 'string' ? postgresTimeMicros(copy.row_updated_at) : Number.NaN
  if (!Number.isFinite(stamp)) return null
  return [stamp, typeof copy.version_number === 'number' ? copy.version_number : -1]
}

function compareOrder(a: [number, number], b: [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]
}

/**
 * Write the copy only if it is not older than the one held, so a writer whose
 * database read began before a save, a switch off or a delete cannot put the
 * older row back when it lands afterwards. KV has no compare and swap and its
 * reads can be served from an edge cache, so this narrows that race to the gap
 * between the read here and the put rather than closing it; the next write from
 * a newer row replaces anything that slips through, and the maximum age (#1847)
 * bounds how long it can be served if none comes.
 */
async function writeCopyForward(workflowId: string, kv: KVNamespace, incoming: WorkflowDefinitionCopy, now: () => number): Promise<void> {
  const incomingOrder = copyOrder(incoming)
  if (!incomingOrder) {
    logEvent('workflow_definition_copy_write_failed', { workflow_id: workflowId, reason: `the row stamp ${JSON.stringify(incoming.row_updated_at)} is not a time, so the copy cannot be ordered` })
    return
  }
  const held = await kv.get<WorkflowDefinitionCopy>(workflowCopyKey(workflowId), 'json')
  const heldOrder = held ? copyOrder(held) : null
  if (held && !heldOrder) {
    // Only this module writes the copy, so one that cannot be ordered is damage:
    // say so and replace it rather than let it block every write for ever.
    logEvent('workflow_definition_copy_unreadable', { workflow_id: workflowId, reason: 'the held copy has no readable row stamp; replacing it' })
  }
  if (held && heldOrder) {
    const order = compareOrder(incomingOrder, heldOrder)
    if (order < 0) {
      logEvent('workflow_definition_copy_write_skipped', {
        workflow_id: workflowId,
        reason: 'a newer copy is already held',
        held_row_updated_at: held.row_updated_at,
        held_version_number: held.version_number,
        incoming_row_updated_at: incoming.row_updated_at,
        incoming_version_number: incoming.version_number,
      })
      return
    }
    const heldWrittenAt = Date.parse(held.written_at)
    const sameState = order === 0 && held.is_active === incoming.is_active
    if (sameState && Number.isFinite(heldWrittenAt) && now() - heldWrittenAt < STORED_COPY_RECONFIRM_AFTER_MS) return
  }
  await kv.put(workflowCopyKey(workflowId), JSON.stringify(incoming))
}

/**
 * Called by every route that saves, switches off, deletes or restores a
 * workflow, in the same request and after its write (#1845). Drops the 300 s
 * cache, then reads the row back and brings the last-good copy to match it: a
 * live row is written as the copy, a switched off or deleted row as a tombstone
 * that refuses as not found.
 *
 * When the row cannot be read back, the change it made is unknown, so the copy
 * becomes one that refuses as no usable copy (a live run then fails retryably,
 * exactly as with none). It is stamped one microsecond past the copy it
 * replaces rather than deleted: a deleted key carries no stamp, so a loader
 * still holding the row from before the change could write it back, while the
 * next successful load, whose row carries the change's own newer stamp, still
 * replaces it.
 *
 * A failed KV call throws after the rest has been attempted: a failed cache
 * drop still lets the copy be brought up to the row, and a failed copy write
 * deletes the held copy so a copy from before the change is not left to serve.
 */
export async function refreshWorkflowCaches(
  workflowId: string,
  kv: KVNamespace,
  supabase: SupabaseClient,
  options: { now?: () => number } = {}
): Promise<void> {
  const now = options.now ?? Date.now
  let cacheDropError: Error | null = null
  try {
    await kv.delete(cacheKey(workflowId))
  } catch (err) {
    cacheDropError = err instanceof Error ? err : new Error(formatErr(err))
    logEvent('workflow_definition_cache_drop_failed', { workflow_id: workflowId, reason: formatErr(err) })
  }
  try {
    await bringCopyUpToRow(workflowId, kv, supabase, now)
  } catch (err) {
    logEvent('workflow_definition_copy_write_failed', { workflow_id: workflowId, reason: formatErr(err), after: 'a route changed the workflow; deleting the held copy' })
    try {
      await kv.delete(workflowCopyKey(workflowId))
    } catch (deleteErr) {
      logEvent('workflow_definition_copy_write_failed', { workflow_id: workflowId, reason: `the held copy could not be deleted either: ${formatErr(deleteErr)}` })
    }
    throw err
  }
  if (cacheDropError) throw cacheDropError
}

async function bringCopyUpToRow(workflowId: string, kv: KVNamespace, supabase: SupabaseClient, now: () => number): Promise<void> {
  const { data, error } = await supabase
    .from('workflows')
    .select(WORKFLOW_SELECT)
    .eq('id', workflowId)
    .order('version_number', { referencedTable: 'workflow_versions', ascending: false })
    .limit(1, { referencedTable: 'workflow_versions' })
    .single()

  if (error && !isNotFoundError(error)) {
    await refusePastHeldCopy(workflowId, kv, now, { unverified: true, reason: `the row could not be read back: ${error.message}` })
    return
  }
  if (!data) {
    await refusePastHeldCopy(workflowId, kv, now, { unverified: false, reason: 'the row no longer exists' })
    return
  }

  const row = data as WorkflowRow
  const live = row.is_active === true && row.deleted_at === null
  let loaded: LoadedWorkflow | null = null
  if (live) {
    try {
      loaded = loadedFromRow(workflowId, row)
    } catch (err) {
      // A row the engine would refuse when the database is up must not be run
      // from a copy when it is down. Stamped with the row as read, so a loader
      // holding an older, runnable row cannot write it back.
      logEvent('workflow_definition_copy_refusing', { workflow_id: workflowId, reason: formatErr(err) })
      await writeCopyForward(workflowId, kv, { ...copyFromRow(row, null, now), unverified: true }, now)
      return
    }
  }
  await writeCopyForward(workflowId, kv, copyFromRow(row, loaded, now), now)
}

/**
 * Replaces the held copy with one that refuses, stamped one microsecond past it
 * (see refreshWorkflowCaches). `unverified` refuses as no usable copy; otherwise
 * it refuses as not found. With no held copy to stamp from there is nothing to
 * order against, so none is kept, which refuses the same way as no usable copy.
 */
async function refusePastHeldCopy(workflowId: string, kv: KVNamespace, now: () => number, why: { unverified: boolean; reason: string }): Promise<void> {
  const held = await kv.get<WorkflowDefinitionCopy>(workflowCopyKey(workflowId), 'json')
  const heldOrder = held ? copyOrder(held) : null
  if (!held || !heldOrder) {
    if (held) await kv.delete(workflowCopyKey(workflowId))
    logEvent('workflow_definition_copy_dropped', { workflow_id: workflowId, reason: `${why.reason}; no held copy to stamp a refusing copy from, so none is kept` })
    return
  }
  const refusing: WorkflowDefinitionCopy = {
    is_active: false,
    ...(why.unverified ? { unverified: true } : {}),
    lane: held.lane,
    workflow_version_id: null,
    version_number: null,
    row_updated_at: microsToPostgresTime(heldOrder[0] + 1),
    written_at: new Date(now()).toISOString(),
    workflow: null,
  }
  logEvent('workflow_definition_copy_refusing', { workflow_id: workflowId, reason: why.reason, refuses_as: why.unverified ? 'no usable copy' : 'not found', row_updated_at: refusing.row_updated_at })
  await kv.put(workflowCopyKey(workflowId), JSON.stringify(refusing))
}

/** The inverse of postgresTimeMicros, in the form PostgREST writes (UTC, six fractional digits). */
function microsToPostgresTime(micros: number): string {
  const wholeSeconds = Math.floor(micros / 1_000_000)
  const fraction = String(micros - wholeSeconds * 1_000_000).padStart(6, '0')
  return `${new Date(wholeSeconds * 1000).toISOString().slice(0, 19)}.${fraction}+00:00`
}

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.error(stripUrlQueriesInText(JSON.stringify({ event, ...fields })))
}
