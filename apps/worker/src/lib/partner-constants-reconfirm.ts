/**
 * Whether the per minute prewarm is still confirming each organization's
 * partner constants copy, and a page when it is not (#2132, L357).
 *
 * The 30 day partner constants copy is rewritten from the rows only when the
 * prewarm confirms its last good copy, once that copy is
 * STORED_COPY_RECONFIRM_AFTER_MS old (keepPartnerConstantsConfirmed). That is
 * what bounds how soon bidding sees a change the page did not make, and the
 * bound the partners page states (BIDDING_PICKUP in apps/web). Before this, a
 * reconfirm that failed was discarded and a failed read of the active
 * workflows returned quietly, so a day when the bound had stopped holding
 * looked exactly like a healthy one until the stale copy alert fired at the
 * thirty minute maximum.
 *
 * Each prewarm records, in one IDEMPOTENCY key, when each organization's run of
 * failed reconfirms began, and when the read of the active workflows (which
 * picks the organizations, so its failure reconfirms none) began failing. A
 * success clears its entry. The detector pages through the shared alerter
 * (`export-alert:partner-constants-reconfirm`, muted, reminded and cleared like
 * every scheduled check) once an entry has stood for two reconfirm intervals,
 * and its first clean run is the all clear. It waits while stored copies are
 * being served, as the other stored copy signals do: the database is down and
 * the serving alert already says so (L36). For its first week it records and
 * logs what it would page without paging, so its rate is measured before it
 * can cry wolf (L36).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { STORED_COPY_RECONFIRM_AFTER_MS } from './stored-copy-age'
import { readStoredCopyLedger } from './stored-copy-ledger'
import { STORED_COPY_SERVING_WINDOW_MINUTES } from './stored-copy-signals'
import { notifyExportFailure } from './export-alerts'
import { etTime } from './slack'
import { formatErr } from './format-error'

export const PARTNER_CONSTANTS_RECONFIRM_JOB = 'partner-constants-reconfirm'
/** Each failing subject and when its failures began, as one JSON object. */
export const RECONFIRM_STATE_KEY = 'partner-constants-reconfirm:failing'
/** When the detector first ran, which starts its week of observing. No TTL. */
export const RECONFIRM_OBSERVING_SINCE_KEY = 'partner-constants-reconfirm:observing-since'
/** The subject for the read of the active workflows, which reconfirms no organization when it fails. */
export const WORKFLOWS_SUBJECT = 'workflows'
/** Two reconfirm intervals: one missed confirmation is a retry, two is a stretch. */
export const RECONFIRM_ALERT_AFTER_MS = 2 * STORED_COPY_RECONFIRM_AFTER_MS
/** How long the detector records without paging (L36). */
export const RECONFIRM_OBSERVE_FOR_MS = 7 * 24 * 60 * 60 * 1000

export type ReconfirmOutcome = 'fresh' | 'confirmed' | 'failed'

export type ReconfirmState = Record<string, { since: number }>

interface StateKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list: KVNamespace['list']
}

/** The recorded failing subjects. An unreadable record is logged and read as empty, so a fresh stretch starts. */
export async function readReconfirmState(kv: Pick<StateKv, 'get'>): Promise<ReconfirmState> {
  const raw = await kv.get(RECONFIRM_STATE_KEY)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    const out: ReconfirmState = {}
    if (parsed && typeof parsed === 'object') {
      for (const [subject, entry] of Object.entries(parsed as Record<string, unknown>)) {
        const since = (entry as { since?: unknown } | null)?.since
        if (typeof since === 'number' && Number.isFinite(since)) out[subject] = { since }
      }
    }
    return out
  } catch {
    console.error(`[${PARTNER_CONSTANTS_RECONFIRM_JOB}] the record of failing reconfirms is not JSON; starting it again`)
    return {}
  }
}

/**
 * Record what one prewarm run did. A failed workflows read records only itself,
 * since no organization was tried; otherwise each organization's outcome sets
 * or clears its entry, and an organization no longer active is dropped. A
 * 'fresh' copy counts as a success: something read the rows and wrote it within
 * the interval. Writes only when the record changed.
 */
export async function recordReconfirmOutcomes(
  kv: Pick<StateKv, 'get' | 'put'>,
  run: { workflowsReadError: string | null; reconfirms: Record<string, ReconfirmOutcome> },
  nowMs: number,
): Promise<ReconfirmState> {
  const held = await readReconfirmState(kv)
  const next: ReconfirmState = {}
  if (run.workflowsReadError !== null) {
    Object.assign(next, held)
    next[WORKFLOWS_SUBJECT] = held[WORKFLOWS_SUBJECT] ?? { since: nowMs }
  } else {
    for (const [org, outcome] of Object.entries(run.reconfirms)) {
      if (outcome === 'failed') next[org] = held[org] ?? { since: nowMs }
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(held)) await kv.put(RECONFIRM_STATE_KEY, JSON.stringify(next))
  return next
}

export type ReconfirmCheckOutcome = 'observing' | 'suppressed' | 'reported'

/** What one standing subject says, as an alert line. */
function describe(subject: string, since: number): string {
  if (subject === WORKFLOWS_SUBJECT) {
    return `The prewarm could not read the active workflows since ${etTime(since)}, so no organization's partner constants were confirmed against the database.`
  }
  return `The partner constants of organization ${subject} have not been confirmed against the database since ${etTime(since)}.`
}

/**
 * Judge the record: quiet in the first week (logged as would page), quiet while
 * stored copies are in use, otherwise the shared alerter is told the standing
 * subjects, and an empty list is its all clear.
 */
export async function checkReconfirmFailures(deps: {
  kv: StateKv
  supabase: SupabaseClient
  state: ReconfirmState
  nowMs: number
  notify?: typeof notifyExportFailure
}): Promise<ReconfirmCheckOutcome> {
  const { kv, state, nowMs } = deps
  const standing = Object.entries(state)
    .filter(([, e]) => nowMs - e.since >= RECONFIRM_ALERT_AFTER_MS)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const startedRaw = await kv.get(RECONFIRM_OBSERVING_SINCE_KEY)
  let started = startedRaw === null ? Number.NaN : Number(startedRaw)
  if (!Number.isFinite(started)) {
    started = nowMs
    await kv.put(RECONFIRM_OBSERVING_SINCE_KEY, String(nowMs))
  }
  if (nowMs - started < RECONFIRM_OBSERVE_FOR_MS) {
    if (standing.length > 0) {
      console.log(`[${PARTNER_CONSTANTS_RECONFIRM_JOB}] would page (observing until ${new Date(started + RECONFIRM_OBSERVE_FOR_MS).toISOString()}): ${standing.map(([s, e]) => `${s} since ${new Date(e.since).toISOString()}`).join(', ')}`)
    }
    return 'observing'
  }

  try {
    const reading = await readStoredCopyLedger(kv, nowMs, STORED_COPY_SERVING_WINDOW_MINUTES)
    if (reading.activeMinutes > 0) return 'suppressed'
  } catch (e) {
    // An unreadable ledger is not proof copies are in use: judge as usual.
    console.error(`[${PARTNER_CONSTANTS_RECONFIRM_JOB}] could not read the stored copy ledger: ${formatErr(e)}`)
  }

  const notify = deps.notify ?? notifyExportFailure
  await notify(deps.supabase, PARTNER_CONSTANTS_RECONFIRM_JOB, standing.map(([s, e]) => describe(s, e.since)), kv, {
    title: 'Partner constants are not being confirmed',
    context: 'Bidding keeps using the partner constants it holds, so a partner switched on or off, a sell-off offer or a sub-account change made since then has not reached it. The held copy is refused 30 minutes after its last confirmation, and leads then fail.',
    fixHint: `search the worker logs for partner-constants. This clears on the first confirmation that succeeds.`,
  }, nowMs, { keys: standing.map(([s]) => s) })
  return 'reported'
}
