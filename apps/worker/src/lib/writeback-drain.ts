/**
 * The drain of stored failed Salesforce writes (#468 step 3, the plan Dan
 * approved on 2026-10-15).
 *
 * WHAT IT DRAINS. A post-answer Salesforce write that failed WITH an answer (a
 * 5xx, a 429, a retryable 4xx, a refused login or permission) is stored pending in
 * outcome_writeback_deadletters (#1993). A write the KV at-risk store holds for
 * the Salesforce read-back is never also stored there (step 1), and this job
 * never touches that store: it asks the read-back only through the replay's own
 * guard (readBackHolds), and a row the read-back holds is left for it.
 *
 * ONE SEND PATH. Every row is sent by drainHeldWrite in writeback-replay.ts, the
 * same code a person's replay (#471) sends through: its compare and set on
 * `attempts` is what makes two overlapping ticks, or a tick beside a person,
 * send a row once. This file only decides which row goes when.
 *
 * EACH MINUTE:
 *  - the pending, replayable updates are read, oldest first (DRAIN_LIST_LIMIT);
 *  - nothing is sent while Salesforce's bulkhead is full or cannot be asked
 *    (fail closed). A call the bulkhead refuses anyway gives its attempt back;
 *  - rows are grouped by record and sent in the order they were written. A later
 *    row of a record waits until every earlier one is closed, so an older write
 *    never lands over a newer one; a value an earlier row sent this tick counts
 *    as ours, so the newer row replaces it;
 *  - a field another writer changed since the row was written is left out and
 *    named in an alert (the read-back's one rule, salesforce-field-conflict.ts);
 *  - at most DRAIN_MAX_ATTEMPTS attempts per row, the second no sooner than
 *    DRAIN_BACKOFF_MS after the first ended. A rejection closes the row refused
 *    (salesforceRejectedTheWrite), and a failed last attempt closes it abandoned;
 *  - the first call Salesforce does not answer, or answers with a failure that is
 *    not a rejection, stops the tick's Salesforce traffic, as the read-back's does.
 *
 * WELL INSIDE THE BACKLOG ALERT. The backlog alert (writeback-backlog.ts) pages on
 * a row pending past WRITEBACK_BACKLOG_MAX_AGE_MS (30 minutes). drainWorstCaseMs is
 * the longest a working drain keeps a row: a tick to find it, the first attempt,
 * the backoff, a tick to find it again and the last attempt, about 7 minutes, and
 * writeback-drain-schedule.test.ts holds it to half the alert's age. Past that,
 * the drain is blocked (Salesforce not answering, the bulkhead full, a queue
 * longer than a tick), and that page is the one to send.
 *
 * ALERTS: a resend Salesforce refused, a write given up, and a field left out,
 * one alert per organization and kind, objects and field names only. A row is
 * closed before its alert is sent, so the alert is first written to a KV outbox
 * under DRAIN_OUTBOX_PREFIX and deleted once Slack takes it; one Slack refused is
 * said on a later tick. Its liveness is the cron heartbeat's (CRON_JOBS
 * 'writeback-drain'), read by a different minute job from KV alone (L71).
 *
 * The table has never held a row in production (0 inserts at 2026-10-16), so
 * every behaviour here is proven by tests on built rows.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { abandonHeldWrite, drainHeldWrite, salesforcePortFor, supabaseHeldWriteStore, type HeldWriteRow, type HeldWriteStore, type ReplayDeps, type SalesforcePort } from './writeback-replay'
import { bulkheadBusy, readBackHoldsStep, slackForEnv, SF_CALL_DEADLINE_MS, SF_READ_BACK_MIN_AGE_MS } from './salesforce-read-back'
import { makeAlertClaims, raceDeadline, type AlertClaims } from './alert-claim'
import { secretKeys, type SecretKeyInput } from './secret-crypto'
import { formatErr } from './format-error'
import { recordFinishedJobRun, type JobRunEnding } from './job-run-record'
import { sendWritebackDrainAlert, type SlackConnection, type WritebackDrainAlert } from './slack'

export const WRITEBACK_DRAIN_JOB = 'writeback-drain'

/** Attempts per row, at most: a person's replays count toward them. */
export const DRAIN_MAX_ATTEMPTS = 2

/**
 * The least time between a row's attempts. The read-back's minimum age: the
 * longest a sent Salesforce PATCH has taken to answer, rounded up, so an attempt
 * that got no answer has had its chance to land before the next is sent.
 */
export const DRAIN_BACKOFF_MS = SF_READ_BACK_MIN_AGE_MS

/** How long one Salesforce call may take before it counts as no answer: the read-back's. */
export const DRAIN_CALL_DEADLINE_MS = SF_CALL_DEADLINE_MS

/** How long a tick keeps starting rows; the last call is bounded by DRAIN_CALL_DEADLINE_MS. */
export const DRAIN_PHASE_BUDGET_MS = 20_000

/** Rows one tick sends, at most. */
export const DRAIN_ROWS_PER_TICK = 25

/** Rows one read takes, oldest first. The table has never held one. */
export const DRAIN_LIST_LIMIT = 200

/** Where an alert waits until Slack takes it. */
export const DRAIN_OUTBOX_PREFIX = 'writeback-drain:alert:'
const OUTBOX_TTL_SECONDS = 7 * 24 * 60 * 60
const OUTBOX_SCAN_LIMIT = 100
const ALERT_CLAIM_PREFIX = 'writeback-drain-alert:'
/** Long enough for one tick to post; short enough that a tick killed mid post is retried soon. */
const ALERT_CLAIM_TTL_SECONDS = 30 * 60

/**
 * The longest a working drain keeps a row pending: each attempt waits at most
 * one tick to be picked up and runs at most as long as the minute waits for a
 * minute job, and the backoff sits between attempts.
 */
export function drainWorstCaseMs(tickIntervalMs: number, tickDeadlineMs: number): number {
  return DRAIN_MAX_ATTEMPTS * (tickIntervalMs + tickDeadlineMs) + (DRAIN_MAX_ATTEMPTS - 1) * DRAIN_BACKOFF_MS
}

export type DrainRow = Pick<HeldWriteRow, 'id' | 'organization_id' | 'workflow_id' | 'execution_id' | 'step_namespace' | 'sf_object' | 'sf_record_id' | 'attempts' | 'created_at' | 'updated_at'>

const DRAIN_COLUMNS = 'id, organization_id, workflow_id, execution_id, step_namespace, sf_object, sf_record_id, attempts, created_at, updated_at'

export interface DrainKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(opts: { prefix: string; limit: number }): Promise<{ keys: Array<{ name: string }> }>
}

type DrainSlack = Pick<SlackConnection, 'bot_token' | 'default_channel' | 'config_alerts_enabled'>

export interface WritebackDrainDeps {
  /** Pending, replayable updates, oldest first. Throws on a failed read. */
  list: () => Promise<DrainRow[]>
  store: HeldWriteStore
  keys: SecretKeyInput
  /** The org's Salesforce as the row's workflow sees it, waiting 0 for a bulkhead slot. */
  salesforceFor: (orgId: string, workflowId: string) => Promise<SalesforcePort>
  /** The replay's guard: whether the read-back holds this run's step. */
  readBackHolds: (executionId: string, stepNamespace: string) => Promise<boolean>
  /** Why no Salesforce call should go out this minute, or null. Fails closed. */
  busy: () => Promise<'bulkhead_busy' | 'bulkhead_unknown' | null>
  /** The alert outbox. */
  kv: DrainKv
  alertClaims?: AlertClaims
  slackFor: (orgId: string) => Promise<DrainSlack | null>
  sendAlert?: (slack: DrainSlack, alert: WritebackDrainAlert) => Promise<boolean>
  now?: () => number
  /** Resolves when a Salesforce call has waited long enough. */
  callDeadline?: (ms: number) => Promise<void>
  recordRun?: (startedAtMs: number, ending: JobRunEnding) => Promise<void>
}

/** Why a tick stopped sending. */
export type DrainStop = 'salesforce_not_answering' | 'salesforce_failing' | 'bulkhead_busy' | 'tick_full'

export interface DrainSummary {
  listed: number
  replayed: number
  refused: number
  abandoned: number
  /** Rows with at least one field left out because another writer changed it. */
  moved: number
  /** Failed with an attempt left. */
  retrying: number
  /** Inside the backoff, or behind an earlier row of the same record. */
  waiting: number
  /** The read-back holds it, or it could not be opened or sent from (logged). */
  skipped: number
  /** Another tick or a person claimed it first. */
  deferred: number
  /** Read before sending, and Salesforce gave no usable answer. Nothing spent. */
  unread: number
  /** Nothing was sent this minute: the bulkhead was full or could not be asked. */
  held?: 'bulkhead_busy' | 'bulkhead_unknown'
  stopped?: DrainStop
  alerts: number
  alert_failures: number
}

/** One outcome an alert reports. Objects and field names only. */
interface DrainFinding {
  id: string
  org_id: string
  kind: WritebackDrainAlert['kind']
  sf_object: string
  fields?: string[]
  resent?: boolean
  answered?: boolean
}

const outboxKey = (id: string) => `${DRAIN_OUTBOX_PREFIX}${id}`

function parseFinding(raw: string | null): DrainFinding | null {
  if (!raw) return null
  try {
    const f = JSON.parse(raw) as Partial<DrainFinding>
    if (typeof f.id !== 'string' || typeof f.org_id !== 'string' || typeof f.sf_object !== 'string') return null
    if (f.kind !== 'refused' && f.kind !== 'abandoned' && f.kind !== 'moved') return null
    return f as DrainFinding
  } catch {
    return null
  }
}

export async function runWritebackDrain(deps: WritebackDrainDeps): Promise<DrainSummary> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const s: DrainSummary = { listed: 0, replayed: 0, refused: 0, abandoned: 0, moved: 0, retrying: 0, waiting: 0, skipped: 0, deferred: 0, unread: 0, alerts: 0, alert_failures: 0 }
  const findings: DrainFinding[] = []

  // A failed read throws: it is never read as nothing pending.
  const listed = await deps.list()
  s.listed = listed.length
  if (listed.length > 0) {
    const held = await deps.busy().catch(() => 'bulkhead_unknown' as const)
    if (held) s.held = held
    else await drainRows(deps, listed, s, findings, now, startedAt)
  }

  await deliver(deps, findings, s)

  if (deps.recordRun && (s.listed > 0 || s.alerts > 0 || s.alert_failures > 0)) {
    await deps.recordRun(startedAt, {
      outcome: s.refused > 0 || s.abandoned > 0 || s.moved > 0 ? 'unresolved-found' : s.held || s.stopped ? 'unread' : 'resolved',
      detail: `listed=${s.listed} replayed=${s.replayed} refused=${s.refused} abandoned=${s.abandoned} moved=${s.moved} retrying=${s.retrying} waiting=${s.waiting} skipped=${s.skipped} deferred=${s.deferred} unread=${s.unread}${s.held ? ` held=${s.held}` : ''}${s.stopped ? ` stopped=${s.stopped}` : ''}`,
      summary: { ...s },
    }).catch((e) => console.error(`[${WRITEBACK_DRAIN_JOB}] could not record the run:`, formatErr(e)))
  }
  return s
}

async function drainRows(deps: WritebackDrainDeps, listed: DrainRow[], s: DrainSummary, findings: DrainFinding[], now: () => number, startedAt: number): Promise<void> {
  // One record's rows together, in the order they were written; records in the order of their oldest row.
  const groups = new Map<string, DrainRow[]>()
  for (const r of [...listed].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const k = `${r.organization_id}|${r.sf_object}|${r.sf_record_id}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }

  // Each call is cut off at its deadline and counts as no answer, so one hung
  // call cannot hold the tick past the minute job's own deadline.
  const ports = new Map<string, Promise<SalesforcePort>>()
  const portFor = (orgId: string, workflowId: string): Promise<SalesforcePort> => {
    const k = `${orgId}|${workflowId}`
    let p = ports.get(k)
    if (!p) {
      p = deps.salesforceFor(orgId, workflowId).then((base): SalesforcePort => {
        const bounded = async <T>(call: () => Promise<T>): Promise<T> => {
          const raced = await raceDeadline(call, DRAIN_CALL_DEADLINE_MS, deps.callDeadline)
          if (raced.kind === 'ok') return raced.value
          if (raced.kind === 'threw') throw raced.error
          throw new Error(`no answer within ${DRAIN_CALL_DEADLINE_MS / 1000} s`)
        }
        return { send: (m, path, body) => bounded(() => base.send(m, path, body)), postApex: (path, body) => bounded(() => base.postApex(path, body)) }
      })
      ports.set(k, p)
    }
    return p
  }
  const replayDeps = (r: DrainRow): ReplayDeps => ({
    store: deps.store,
    keys: deps.keys,
    salesforce: () => portFor(r.organization_id, r.workflow_id),
    readBackHolds: deps.readBackHolds,
    now,
  })
  const found = (r: DrainRow, kind: DrainFinding['kind'], extra: Partial<DrainFinding> = {}) =>
    findings.push({ id: r.id, org_id: r.organization_id, kind, sf_object: r.sf_object, ...extra })

  let taken = 0
  for (const group of groups.values()) {
    // Values this tick sent to the record: ours, so the newer row replaces them.
    const earlier: Array<Record<string, unknown>> = []
    for (let i = 0; i < group.length; i++) {
      if (s.stopped) return
      if (taken >= DRAIN_ROWS_PER_TICK || now() - startedAt >= DRAIN_PHASE_BUDGET_MS) {
        s.stopped = 'tick_full'
        return
      }
      const r = group[i]
      const behind = group.length - i - 1
      // Holds this row's record: it and every later row of it wait for a later tick.
      const hold = () => { s.waiting += 1 + behind }

      if (r.attempts >= DRAIN_MAX_ATTEMPTS) {
        // Spent already (by a person's replays): closed, once no replay can still be in flight.
        const a = await abandonHeldWrite(deps.store, r.organization_id, r.id, now())
        if (a.kind === 'abandoned') {
          s.abandoned++
          found(r, 'abandoned')
          continue
        }
        if (a.kind === 'not_found' || a.kind === 'not_pending') continue
        hold()
        break
      }
      // An unreadable time reads as just tried: the side that sends nothing early (L50).
      if (r.attempts > 0 && !(now() - Date.parse(r.updated_at) >= DRAIN_BACKOFF_MS)) {
        hold()
        break
      }

      taken++
      const out = await drainHeldWrite(replayDeps(r), r.organization_id, r.id, { maxAttempts: DRAIN_MAX_ATTEMPTS, earlier })
      if (out.kind === 'replayed') {
        s.replayed++
        earlier.push(out.sent)
        if (out.moved.length > 0) {
          s.moved++
          found(r, 'moved', { fields: out.moved, resent: true })
        }
        continue
      }
      if (out.kind === 'all_moved') {
        s.moved++
        found(r, 'moved', { fields: out.moved, resent: false })
        continue
      }
      if (out.kind === 'refused') {
        s.refused++
        found(r, 'refused', { resent: out.resent })
        continue
      }
      if (out.kind === 'not_found') continue
      if (out.kind === 'abandoned' || out.kind === 'still_pending') {
        if (out.kind === 'abandoned') {
          s.abandoned++
          found(r, 'abandoned', { answered: out.answered })
        } else {
          s.retrying++
          hold()
        }
        s.stopped = out.answered ? 'salesforce_failing' : 'salesforce_not_answering'
        return
      }
      if (out.kind === 'read_unanswered' || out.kind === 'read_failed' || out.kind === 'held') {
        s.unread++
        hold()
        s.stopped = out.kind === 'held' ? 'bulkhead_busy' : out.kind === 'read_unanswered' ? 'salesforce_not_answering' : 'salesforce_failing'
        console.warn(`[${WRITEBACK_DRAIN_JOB}] held write ${r.id} was not sent: ${out.error}`)
        return
      }
      if (out.kind === 'conflict') {
        s.deferred++
      } else {
        // not_replayable (the read-back holds it), unreadable, no_salesforce.
        s.skipped++
        const why = out.kind === 'not_replayable' ? out.reason : out.error
        console.log(`[${WRITEBACK_DRAIN_JOB}] held write ${r.id} was left pending: ${why}`)
      }
      s.waiting += behind
      break
    }
  }
}

/**
 * Says this tick's outcomes, and any an earlier tick could not, one alert per
 * organization and kind. Each is kept in the outbox until Slack takes it. Never throws.
 */
async function deliver(deps: WritebackDrainDeps, fresh: DrainFinding[], s: DrainSummary): Promise<void> {
  for (const f of fresh) {
    await deps.kv.put(outboxKey(f.id), JSON.stringify(f), { expirationTtl: OUTBOX_TTL_SECONDS })
      .catch((e) => console.error(`[${WRITEBACK_DRAIN_JOB}] could not keep the alert for held write ${f.id}; it is sent now or not at all:`, formatErr(e)))
  }
  const byId = new Map(fresh.map((f) => [f.id, f]))
  try {
    const page = await deps.kv.list({ prefix: DRAIN_OUTBOX_PREFIX, limit: OUTBOX_SCAN_LIMIT })
    for (const { name } of page.keys) {
      const id = name.slice(DRAIN_OUTBOX_PREFIX.length)
      if (byId.has(id)) continue
      const f = parseFinding(await deps.kv.get(name))
      if (f) byId.set(id, f)
    }
  } catch (e) {
    console.error(`[${WRITEBACK_DRAIN_JOB}] could not read the alerts waiting to be sent:`, formatErr(e))
  }
  if (byId.size === 0) return

  const groups = new Map<string, DrainFinding[]>()
  for (const f of byId.values()) groups.set(`${f.org_id}|${f.kind}`, [...(groups.get(`${f.org_id}|${f.kind}`) ?? []), f])
  const send = deps.sendAlert ?? sendWritebackDrainAlert
  for (const group of groups.values()) {
    const { org_id: orgId, kind } = group[0]
    const claimed: DrainFinding[] = []
    for (const f of group) {
      if (!deps.alertClaims || (await deps.alertClaims.claim(`${ALERT_CLAIM_PREFIX}${f.id}`, ALERT_CLAIM_TTL_SECONDS))) claimed.push(f)
    }
    if (claimed.length === 0) continue
    claimed.sort((a, b) => a.sf_object.localeCompare(b.sf_object))
    let ok = false
    try {
      const slack = await deps.slackFor(orgId)
      if (!slack) console.error(`[${WRITEBACK_DRAIN_JOB}] ${claimed.length} ${kind} outcomes for org ${orgId}, and no Slack connection to say so`)
      else
        ok = slack.config_alerts_enabled
          ? await send(slack, {
              kind,
              tries: DRAIN_MAX_ATTEMPTS,
              writes: claimed.map((f) => ({
                sf_object: f.sf_object,
                ...(f.fields ? { fields: f.fields } : {}),
                ...(f.resent !== undefined ? { resent: f.resent } : {}),
                ...(f.answered !== undefined ? { answered: f.answered } : {}),
              })),
            })
          : true
    } catch (e) {
      console.error(`[${WRITEBACK_DRAIN_JOB}] ${kind} alert failed for org ${orgId}:`, formatErr(e))
    }
    if (!ok) {
      // Kept in the outbox, and the claims freed, so a later tick says it.
      s.alert_failures++
      for (const f of claimed) await deps.alertClaims?.release(`${ALERT_CLAIM_PREFIX}${f.id}`)
      continue
    }
    s.alerts++
    for (const f of claimed) {
      await deps.kv.delete(outboxKey(f.id)).catch((e) => console.error(`[${WRITEBACK_DRAIN_JOB}] could not clear the sent alert for held write ${f.id}:`, formatErr(e)))
    }
  }
}

// ── Production wiring ───────────────────────────────────────────────────────

/** The pending, replayable updates, oldest first, without the encrypted columns. */
export async function listDrainRows(supabase: SupabaseClient): Promise<DrainRow[]> {
  const { data, error } = await supabase
    .from('outcome_writeback_deadletters')
    .select(DRAIN_COLUMNS)
    .eq('status', 'pending')
    .eq('replayable', true)
    .eq('sf_operation', 'update')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(DRAIN_LIST_LIMIT)
  if (error) throw new Error(`reading the stored Salesforce writes failed: ${error.message}`)
  return data ?? []
}

export async function runWritebackDrainForEnv(supabase: SupabaseClient, env: Env): Promise<DrainSummary> {
  const keys = secretKeys(env)
  return runWritebackDrain({
    list: () => listDrainRows(supabase),
    store: supabaseHeldWriteStore(supabase),
    keys,
    salesforceFor: (orgId, workflowId) => salesforcePortFor(env, supabase, keys, orgId, workflowId, { waitMs: 0 }),
    readBackHolds: (executionId, stepNamespace) => readBackHoldsStep(env.IDEMPOTENCY, keys, executionId, stepNamespace),
    busy: () => bulkheadBusy(env, WRITEBACK_DRAIN_JOB),
    kv: env.IDEMPOTENCY,
    alertClaims: env.ALERT_CLAIM ? makeAlertClaims(env.ALERT_CLAIM) : undefined,
    slackFor: slackForEnv(supabase),
    recordRun: (startedAtMs, ending) => recordFinishedJobRun(supabase, WRITEBACK_DRAIN_JOB, startedAtMs, ending),
  })
}
