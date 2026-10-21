/**
 * The backlog alert on outcome_writeback_deadletters (#468, step 2 of the plan
 * Dan approved on 2026-10-15).
 *
 * A post-answer Salesforce write that failed with an answer (a 5xx, a 429, a
 * retryable 4xx, a refused login or permission) is stored there `pending`
 * (#1993). The capture runs outside the post-answer dead letter's gates on
 * purpose, because a classified Salesforce outage is exactly when these writes
 * fail, so a row can arrive with no page of its own. Nothing moves a row out of
 * pending except a person through the held writes routes (#471) until the drain
 * (#468 step 3) ships. Without this check a pending row waits for ever and is
 * found only by reading the table (L13).
 *
 * WHAT PAGES, per organization, since a row belongs to one organization and only
 * that organization's routes can replay it:
 *  - AGED: its oldest pending row is older than WRITEBACK_BACKLOG_MAX_AGE_MS.
 *  - GROWING: it had pending rows at the last check and has more now, so writes
 *    arrive faster than anything resends them. A first arrival is not growth
 *    (the age covers a single row); the next check that finds more is.
 * The incident ends, with an all-clear, only when the organization has no
 * pending row at all. A backlog still standing but young again keeps it open:
 * the brief is "all clear when the backlog is gone", and an empty set is a
 * measured fact, not the absence of a rate, so there is no re-arm wait either.
 *
 * WHY 30 MINUTES. A pending row can be acted on the moment it is stored: the
 * manual replay has no minimum age, and the drain will take it on its next tick.
 * So the age measures how long a write has gone unhandled, not a settling time,
 * and the threshold is set by what else is already saying something. Rows are
 * stored when Salesforce is answering badly, which the upstream outage alert
 * pages on its own; 30 minutes is RECOVERY_REARM_MINUTES, the span this codebase
 * uses to tell a blip from a condition, so a short Salesforce blip whose writes
 * are resent promptly pages once (as an outage) rather than twice. The drain in
 * step 3 must finish both of its attempts well inside this, or this has to rise.
 *
 * A FAILED READ is never an all-clear (L10, L11): it pages as a failed read
 * through the shared scheduled check alerter (export-alerts.ts, which holds a
 * first transient failure one run, as it does for every check), keeps every open
 * incident's marker alive, and leaves the growth baseline at the last reading
 * that happened.
 *
 * ITS OWN LIVENESS is the cron heartbeat's (CRON_JOBS 'writeback-backlog'), run
 * by a different minute job that reads only KV, so this check failing or hanging
 * cannot silence the alarm about it (L71).
 *
 * COPY names counts, objects and ages only. The rows hold lead data (encrypted)
 * and identifying record ids; neither is read here, let alone sent.
 *
 * The table has never held a row in production (0 inserts at 2026-10-16), so
 * every behaviour here is proven by tests on built readings, never a real row.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  announceRecovery,
  markAlerted,
  markSpikeSeen,
  recordPaged,
  recoveryKey,
  refreshAlerted,
  RECOVERY_REARM_MINUTES,
  type IncidentContext,
  type RecoveryKv,
} from './alert-recovery'
import { backoffCooldownKey, clearCondition, describeRepeat, fingerprintAlert, inCooldown, nextFingerprint, readCondition, recordAlert, recurrenceOf } from './alert-backoff'
import { reportRecordError } from './incident-outbox'
import { raceDeadline } from './alert-claim'
import { formatErr } from './format-error'
import { notifyExportFailure, notifyExportRecovery } from './export-alerts'
import { sendWritebackBacklogAlert, sendWritebackBacklogRecoveryAlert, WRITEBACK_BACKLOG_RECOVERY_SUBJECT, type WritebackBacklogAlert } from './slack'

export const WRITEBACK_BACKLOG_JOB = 'writeback-backlog'
/** The incident record's signal for this check (incident-signals.ts). */
export const WRITEBACK_BACKLOG_SIGNAL = 'writeback-backlog'

/** A pending write older than this pages. See the header for why it is RECOVERY_REARM_MINUTES. */
export const WRITEBACK_BACKLOG_MAX_AGE_MS = RECOVERY_REARM_MINUTES * 60_000

/**
 * Pending rows one read takes, oldest first. PostgREST caps a response at 1000,
 * and the table has never held one row; past this the counts are "at least".
 */
export const WRITEBACK_BACKLOG_READ_LIMIT = 1000

/** How long the read may take before it counts as failed, well inside the job's two minute allowance. */
export const WRITEBACK_BACKLOG_READ_DEADLINE_MS = 20_000

/** The last reading: each organization's pending count, and which still have an incident open. */
export const BACKLOG_STATE_KEY = 'writeback-backlog:state'

const conditionKey = (orgId: string) => `writeback-backlog:${orgId}`

export interface OrgBacklog {
  count: number
  oldestAt: string
  /** Pending rows per Salesforce object name. */
  objects: Record<string, number>
}

export type BacklogReading =
  | { ok: true; partial: boolean; byOrg: Map<string, OrgBacklog> }
  | { ok: false; error: string }

export interface BacklogVerdict {
  aged: boolean
  growing: boolean
  /** The oldest row's age, or null when its time could not be read. */
  ageMs: number | null
}

/**
 * The two predicates. `previousCount` is the organization's count at the last
 * check, or null when there was no last reading to compare with (then nothing
 * is claimed about growth). An oldest time that does not parse is aged, the
 * side that pages (L50).
 */
export function judgeBacklog(backlog: Pick<OrgBacklog, 'count' | 'oldestAt'>, previousCount: number | null, nowMs: number): BacklogVerdict {
  const oldestMs = Date.parse(backlog.oldestAt)
  const ageMs = Number.isFinite(oldestMs) ? nowMs - oldestMs : null
  return {
    aged: ageMs === null || ageMs > WRITEBACK_BACKLOG_MAX_AGE_MS,
    growing: previousCount !== null && previousCount > 0 && backlog.count > previousCount,
    ageMs,
  }
}

interface BacklogState {
  at: string
  counts: Record<string, number>
  /** Organizations whose incident was still open after the check, so an owed all-clear is not forgotten. */
  open: string[]
}

function parseState(raw: string | null): BacklogState | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<BacklogState>
    if (typeof v.at !== 'string' || !v.counts || typeof v.counts !== 'object') return null
    const counts: Record<string, number> = {}
    for (const [k, n] of Object.entries(v.counts)) if (typeof n === 'number' && Number.isFinite(n)) counts[k] = n
    return { at: v.at, counts, open: Array.isArray(v.open) ? v.open.filter((x): x is string => typeof x === 'string') : [] }
  } catch {
    return null
  }
}

export interface BacklogDeps {
  kv: RecoveryKv
  read: () => Promise<BacklogReading>
  /** Pages one organization. Returns whether it reached Slack. */
  sendAlert: (orgId: string, alert: WritebackBacklogAlert) => Promise<boolean>
  /** The all-clear for one organization. Returns whether it reached Slack. */
  sendRecovery: (orgId: string, recovery: { alertedAt: string; endedAt: string | null; firstHealthyAt: string | null }) => Promise<boolean>
  /** Pages that the table could not be read. */
  notifyReadFailure: (errors: string[]) => Promise<void>
  /** A clean read: stands a read failure page down. */
  notifyReadRecovered: () => Promise<void>
  now?: () => number
}

export interface BacklogSummary {
  read: 'ok' | 'failed'
  error?: string
  /** Pending writes across every organization (a lower bound when partial). */
  pending: number
  partial: boolean
  paged: string[]
  allClear: string[]
  /** Faults in the check's own bookkeeping, reported rather than thrown. */
  errors: string[]
}

const incidentFor = (orgId: string, errors: string[]): IncidentContext => ({
  scope: { kind: 'org', organizationId: orgId },
  subjectLabel: WRITEBACK_BACKLOG_RECOVERY_SUBJECT,
  onRecordError: (message) => errors.push(message),
})

export async function runWritebackBacklogCheck(deps: BacklogDeps): Promise<BacklogSummary> {
  const nowMs = (deps.now ?? Date.now)()
  const errors: string[] = []
  const previous = parseState(await deps.kv.get(BACKLOG_STATE_KEY))

  let reading: BacklogReading
  try {
    reading = await deps.read()
  } catch (e) {
    reading = { ok: false, error: formatErr(e) }
  }

  if (!reading.ok) {
    // Not an empty backlog: a backlog nobody could see (L10). Page that, keep
    // every open incident open, and keep the last real reading as the baseline.
    await deps.notifyReadFailure([`The waiting Salesforce writes could not be read: ${reading.error}.`])
    for (const orgId of new Set([...Object.keys(previous?.counts ?? {}), ...(previous?.open ?? [])])) {
      try {
        await refreshAlerted(deps.kv, WRITEBACK_BACKLOG_SIGNAL, orgId)
      } catch (e) {
        errors.push(`${orgId}: the open incident could not be kept: ${formatErr(e)}`)
      }
    }
    return { read: 'failed', error: reading.error, pending: 0, partial: false, paged: [], allClear: [], errors }
  }

  await deps.notifyReadRecovered()

  const orgs = new Set([...reading.byOrg.keys(), ...Object.keys(previous?.counts ?? {}), ...(previous?.open ?? [])])
  const summary: BacklogSummary = { read: 'ok', pending: 0, partial: reading.partial, paged: [], allClear: [], errors }
  const next: BacklogState = { at: new Date(nowMs).toISOString(), counts: {}, open: [] }

  for (const orgId of orgs) {
    const backlog = reading.byOrg.get(orgId) ?? null
    if (!backlog && reading.partial) {
      // The read stopped at its limit before reaching this organization, so its
      // rows (if any) are past it: unknown, not empty. Hold its incident and its
      // baseline exactly as a failed read does, and never send its all-clear.
      const prior = previous?.counts[orgId]
      if (prior !== undefined) next.counts[orgId] = prior
      try {
        if ((await deps.kv.get(recoveryKey(WRITEBACK_BACKLOG_SIGNAL, orgId))) !== null) {
          await refreshAlerted(deps.kv, WRITEBACK_BACKLOG_SIGNAL, orgId)
          next.open.push(orgId)
        }
      } catch (e) {
        errors.push(`${orgId}: the open incident could not be kept: ${formatErr(e)}`)
        next.open.push(orgId)
      }
      continue
    }
    // One organization's fault never leaves the next unchecked.
    try {
      const open = await checkOrg(deps, orgId, backlog, previous, reading.partial, nowMs, summary)
      if (open) next.open.push(orgId)
    } catch (e) {
      errors.push(`${orgId}: ${formatErr(e)}`)
      next.open.push(orgId)
    }
    if (backlog) {
      next.counts[orgId] = backlog.count
      summary.pending += backlog.count
    }
  }

  try {
    await deps.kv.put(BACKLOG_STATE_KEY, JSON.stringify(next))
  } catch (e) {
    // The next check then has no baseline, so it claims no growth: the quiet
    // side for growth only, since the age still pages.
    errors.push(`the reading could not be kept for the next check: ${formatErr(e)}`)
  }
  return summary
}

/** Judges one organization and acts. Returns whether its incident is open afterwards. */
async function checkOrg(
  deps: BacklogDeps,
  orgId: string,
  backlog: OrgBacklog | null,
  previous: BacklogState | null,
  partial: boolean,
  nowMs: number,
  summary: BacklogSummary,
): Promise<boolean> {
  const { kv } = deps
  const incident = incidentFor(orgId, summary.errors)
  const key = conditionKey(orgId)
  const marker = await kv.get(recoveryKey(WRITEBACK_BACKLOG_SIGNAL, orgId))

  if (!backlog || backlog.count === 0) {
    if (marker === null) {
      if (await readCondition(kv, key)) await clearCondition(kv, key)
      return false
    }
    const delivered = await announceRecovery(
      kv,
      WRITEBACK_BACKLOG_SIGNAL,
      orgId,
      backoffCooldownKey(key),
      incident,
      (alertedAt, endedAt, firstHealthyAt) => deps.sendRecovery(orgId, { alertedAt, endedAt, firstHealthyAt }),
      { now: nowMs, rearmMinutes: 0 },
    )
    if (!delivered) return true
    await clearCondition(kv, key)
    summary.allClear.push(orgId)
    return false
  }

  const previousCount = previous ? (previous.counts[orgId] ?? 0) : null
  const verdict = judgeBacklog(backlog, previousCount, nowMs)

  if (!verdict.aged && !verdict.growing) {
    // Young and not growing. With an incident open the backlog it paged about
    // still stands, so the incident stays open and its running end moves.
    if (marker === null) return false
    await markSpikeSeen(kv, WRITEBACK_BACKLOG_SIGNAL, orgId, nowMs)
    await refreshAlerted(kv, WRITEBACK_BACKLOG_SIGNAL, orgId)
    return true
  }

  await markSpikeSeen(kv, WRITEBACK_BACKLOG_SIGNAL, orgId, nowMs)
  const kinds = [...(verdict.aged ? ['aged'] : []), ...(verdict.growing ? ['growing'] : [])]
  const standing = await readCondition(kv, key)
  const print = await fingerprintAlert({ title: WRITEBACK_BACKLOG_SIGNAL, findings: kinds, keys: kinds })
  const recurrence = recurrenceOf(standing, print)
  const different = recurrence.kind === 'new' && standing !== null
  if (!different && (await inCooldown(kv, key))) {
    if (marker !== null) await refreshAlerted(kv, WRITEBACK_BACKLOG_SIGNAL, orgId)
    return marker !== null
  }

  const reminderOf = recurrence.kind === 'reminder' ? recurrence.standing : null
  const alert: WritebackBacklogAlert = {
    count: backlog.count,
    partial,
    objects: Object.entries(backlog.objects)
      .map(([object, count]) => ({ object, count }))
      .sort((a, b) => b.count - a.count || a.object.localeCompare(b.object)),
    oldestAt: verdict.ageMs === null ? null : backlog.oldestAt,
    aged: verdict.aged,
    growing: verdict.growing && previous && previousCount !== null ? { from: previousCount, lastCheckAt: previous.at } : null,
    ...(reminderOf ? { repeat: describeRepeat(reminderOf, nowMs, recurrence.kind === 'reminder' && recurrence.unchanged) ?? undefined } : {}),
  }
  let delivered = false
  try {
    delivered = await deps.sendAlert(orgId, alert)
  } catch (e) {
    summary.errors.push(`${orgId}: the page failed: ${formatErr(e)}`)
  }
  // Armed only on delivery, so a Slack outage does not buy silence about a
  // backlog nobody was told of, and an all-clear never follows an unseen page.
  if (!delivered) {
    if (marker !== null) await refreshAlerted(kv, WRITEBACK_BACKLOG_SIGNAL, orgId)
    return marker !== null
  }
  await recordAlert(kv, key, reminderOf, nowMs, { fingerprint: nextFingerprint(standing, print) })
  try {
    await markAlerted(kv, WRITEBACK_BACKLOG_SIGNAL, orgId, incident, nowMs)
    await recordPaged(kv, WRITEBACK_BACKLOG_SIGNAL, orgId, incident, nowMs)
  } catch (e) {
    reportRecordError(incident, `paged ${WRITEBACK_BACKLOG_SIGNAL} ${orgId} not recorded: ${formatErr(e)}`)
  }
  summary.paged.push(orgId)
  return true
}

// ── Production wiring ───────────────────────────────────────────────────────

interface PendingRow {
  organization_id: unknown
  sf_object: unknown
  created_at: unknown
}

/**
 * Reads the pending rows, oldest first, with the exact pending count, through
 * the service role client (the table is service role only). Selects only the
 * organization, the object and the time: never a record id or an encrypted
 * column. The partial index on (organization_id, created_at) WHERE status =
 * 'pending' serves it. Never throws; a failure comes back as a failed reading.
 */
export async function readWritebackBacklog(supabase: SupabaseClient): Promise<BacklogReading> {
  const raced = await raceDeadline(
    async () =>
      supabase
        .from('outcome_writeback_deadletters')
        .select('organization_id, sf_object, created_at', { count: 'exact' })
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(WRITEBACK_BACKLOG_READ_LIMIT),
    WRITEBACK_BACKLOG_READ_DEADLINE_MS,
  )
  if (raced.kind === 'timed_out') return { ok: false, error: `the database did not answer within ${WRITEBACK_BACKLOG_READ_DEADLINE_MS / 1000} seconds` }
  if (raced.kind === 'threw') return { ok: false, error: formatErr(raced.error) }
  const { data, error, count } = raced.value
  if (error) return { ok: false, error: formatErr(error) }
  if (!Array.isArray(data) || typeof count !== 'number') return { ok: false, error: 'the answer carried no rows or no count' }
  const byOrg = new Map<string, OrgBacklog>()
  for (const row of data as PendingRow[]) {
    if (typeof row.organization_id !== 'string') return { ok: false, error: 'a pending row carried no organization' }
    const object = typeof row.sf_object === 'string' && row.sf_object ? row.sf_object : 'an unnamed object'
    const createdAt = typeof row.created_at === 'string' ? row.created_at : ''
    const b = byOrg.get(row.organization_id)
    if (!b) byOrg.set(row.organization_id, { count: 1, oldestAt: createdAt, objects: { [object]: 1 } })
    else {
      b.count += 1
      b.objects[object] = (b.objects[object] ?? 0) + 1
    }
  }
  return { ok: true, partial: count > data.length, byOrg }
}

/** The read failure page's title and remedy, in the shared scheduled check alerter's plain shape. */
const READ_FAILURE_REMEDY = {
  title: 'Waiting Salesforce writes could not be checked',
  fixHint: 'nothing is lost, because a waiting write is never deleted. If this keeps happening, check that the database is answering.',
}

export async function runWritebackBacklogCheckForEnv(supabase: SupabaseClient, kv: KVNamespace): Promise<BacklogSummary> {
  return runWritebackBacklogCheck({
    kv,
    read: () => readWritebackBacklog(supabase),
    sendAlert: (orgId, alert) => sendWritebackBacklogAlert(supabase, orgId, alert),
    sendRecovery: (orgId, recovery) => sendWritebackBacklogRecoveryAlert(supabase, orgId, recovery),
    notifyReadFailure: (errors) => notifyExportFailure(supabase, WRITEBACK_BACKLOG_JOB, errors, kv, READ_FAILURE_REMEDY),
    notifyReadRecovered: () => notifyExportRecovery(kv, WRITEBACK_BACKLOG_JOB, Date.now()),
  })
}
