/**
 * The minute job that reads back post-answer Salesforce writes that were cut off,
 * and resends the ones that did not land (#2023, phase E of #2015).
 *
 * WHY. On 2026-10-13, 8 of 18 post-answer writes cut off by a Salesforce slowdown
 * never landed (#2015), and in the week to 2026-10-15, 19 of 42 timed out Prospect
 * reject patches never did (#2163). The at-risk watch (engine/at-risk-writes.ts,
 * #2022) keeps each write still out after 2 s in KV, its body encrypted. This
 * job is what reads those records, and it is the only automatic resender of
 * post-answer writes, so #468 is narrowed to writes outside it.
 *
 * WHAT IT JUDGES. Writes to Applicant__c, Prospect__c, Lead and, since #2203,
 * Submission__c carrying their own engine stamp (engine/write-marker.ts, whose
 * one object list the stamp and this job both read). "Landed" means the record
 * holds THIS write's marker, never that its fields look equal. An update held
 * without its own stamp (one recorded before the stamp shipped for its object,
 * or one whose marker would not fit) is never this job's, and is left to the
 * held alert (#2163), which the capture still sends for it.
 *
 * EACH TICK, separate from the database read-back (lib/unconfirmed-write-sweep.ts):
 * its own KV prefix, answering flag, read budget and minimum age, so Salesforce
 * being down never holds the database entries up, nor the reverse.
 *  - The held writes are grouped by record and merged in attempt order, and each
 *    record is read once (one GET naming the marker, LastModifiedDate and every
 *    field the writes set).
 *  - A write whose marker the record holds landed: dropped, counted. A later
 *    write's stamp says nothing about an earlier one (#2020), so each write is
 *    judged by its own; a field a later write of the run also sets belongs to
 *    the later one (newer wins), and an earlier write whose every field a later
 *    one sets is superseded.
 *  - A write whose marker is absent is resent through the node's one call path
 *    (bulkhead slot, timeout, fresh login on a 401), stamped with attempt 1 or
 *    2, at most twice. A resend goes only under a claim keyed on the write and
 *    the attempt that fails CLOSED (makeSendClaims; the alert claim fails open):
 *    a claim that cannot be asked sends nothing and spends no attempt, one
 *    another tick holds is that tick's to send, and a won claim's attempt count
 *    is written BEFORE the send (its claim freed if that write fails).
 *  - A field that now holds a different non-blank value, set by another writer
 *    since the write began, is not overwritten. It is named, field name only, in
 *    a conflict alert, and conflicts are counted per field against the resends
 *    that carried it. "Since the write began" is read off LastModifiedDate: a
 *    record nobody has written since then holds only values from before the
 *    write, which are exactly what it was sent to replace (a Prospect's No Bid,
 *    which every reject patch replaces). A record written since, or one whose
 *    stamp cannot be read, is judged field by field, which overwrites nothing
 *    another writer may have set.
 *  - Nothing is sent while Salesforce's bulkhead is full or cannot be asked
 *    (fail closed), and the first call that gets no answer stops the tick's
 *    Salesforce traffic, which is this job's circuit: no Salesforce circuit
 *    breaker exists in the codebase (the breakers are per partner).
 *
 * MINIMUM AGE (SF_READ_BACK_MIN_AGE_MS, 3 minutes). A post-answer step starts
 * after the answer, and Cloudflare cancels all of a request's work 30 seconds
 * after the answer (WAIT_UNTIL_LIMIT_MS), so no attempt of the step is sent later
 * than 30 s after it began. A PATCH that was sent can still land while Salesforce
 * is slow: on 2026-10-13, 23 of the 42 reject patches that timed out landed after
 * the abort (#2163), but how long after was not recorded anywhere this could read,
 * so the bound is the longest Salesforce answer measured, 91.5 s on 2026-07-22
 * (a 9 minute slowdown of the same kind, project memory of that incident). 30 s
 * plus 91.5 s, rounded up to whole minutes, is 3 minutes from the step's start,
 * or from the read-back's own last resend. Reading sooner costs at worst an
 * identical second PATCH, which re-fires nothing on an unchanged record (the
 * post-answer write contract, question 5).
 *
 * ALERTS: a resend Salesforce refused, a write still not confirmed (after two
 * unanswered resends, or past 15 minutes with one), a field left out because
 * another writer moved it, writes waiting unread for 15 minutes (with why), and,
 * from a separate check run by another minute job, the read-back not running
 * while writes wait (checkSalesforceReadBackLiveness).
 *
 * A CREDIT INQUIRY POST (#2172, Dan's D5 on #1680, 2026-10-15) is held the same
 * way, recorded before it is sent (engine/at-risk-writes.ts), and judged here by
 * the one marker every successful post that carries inquiries leaves: the
 * `Inquiries_<leadId>` file linked to the Submission's Lead, created since the
 * post began (#2169, 150 of 150; engine/inquiry-post.ts). It has no fields to
 * merge or conflict on, so each post is its own unit:
 *  - an empty list wrote nothing and was answered 200, so it landed; a missing
 *    list, or a body the endpoint cannot read, is answered 500 before any write,
 *    so there is nothing to send. Both are settled at once, unread and unsent;
 *  - otherwise the Submission's Lead is read, then the file. Present is landed.
 *    Absent is resent ONCE (MAX_INQUIRY_RESENDS), the held body exactly as sent,
 *    under the same claim that fails closed, its attempt counted before the send;
 *  - a resend answered 2xx is confirmed. One refused (a 404) is the resend
 *    failed alert. One answered 500 is unknown (the class does not roll back, so
 *    rows can be written without the file) and is read again, as is one with no
 *    answer; still no file after the one resend is the still not confirmed alert;
 *  - a Submission gone, or with no Lead, is never sent (Salesforce refuses it)
 *    and is said in the resend failed alert, worded as not resent.
 * The minimum age, the windows, the liveness check and the unread alert are the
 * updates' own: the post is sent once, at its step's start, so the same bound holds.
 *
 * Its own state is in KV beside the held writes, under `sf-read-back:`, and holds
 * field names, counts and times, never a value, so the key rotation does not
 * touch it. A write's record expires with the held write it describes (24 hours),
 * the per field conflict counts after 8 days, and the liveness check's one
 * first-seen time never (see checkSalesforceReadBackLiveness).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { AT_RISK_WRITE_PREFIX, AT_RISK_WRITE_TTL_SECONDS, atRiskKey, parseAtRiskEntry, readBackOwnsHeld, type AtRiskEntry } from '../engine/at-risk-writes'
import { WRITE_MARKER_FIELD, parseWriteMarker, stampsWrites, writeMarker } from '../engine/write-marker'
import { salesforceRejectedTheWrite } from '../engine/nodes/salesforce'
import { CREDIT_INQUIRY_APEX_PATH, inquiryMarkerQuery, inquiryPostOf, type InquiryPost } from '../engine/inquiry-post'
import { decryptSecret, secretKeys, type SecretKeyInput } from './secret-crypto'
import { makeAlertClaims, makeSendClaims, raceDeadline, type AlertClaims, type SendClaims } from './alert-claim'
import { isSalesforceApiName, isSalesforceRecordId, salesforcePortFor, type SalesforcePort } from './writeback-replay'
import { WAIT_UNTIL_LIMIT_MS } from './post-response-budget'
import { completedKey } from './cron-heartbeat'
import { formatErr } from './format-error'
import { recordFinishedJobRun, type JobRunEnding } from './job-run-record'
import { getSlackConnection, sendSalesforceReadBackAlert, type SlackConnection } from './slack'
import { BulkheadClient, salesforceBulkheadLimit } from './bulkhead-client'
import type { ReadBackAlertWrite, SalesforceReadBackAlert, UnreadReason } from './salesforce-read-back-alert'

export const SF_READ_BACK_JOB = 'salesforce-read-back'

/** The longest a sent Salesforce PATCH has taken to answer, measured on 2026-07-22. See the header. */
export const LONGEST_MEASURED_SALESFORCE_ANSWER_MS = 91_500

/** A held write is read only this long after its step began, or after this job last resent it. See the header. */
export const SF_READ_BACK_MIN_AGE_MS = Math.ceil((WAIT_UNTIL_LIMIT_MS + LONGEST_MEASURED_SALESFORCE_ANSWER_MS) / 60_000) * 60_000

/** A write resent with no answer this long after its step began is said to be still not confirmed. Dan's 15 minutes (#2015, 2026-10-13). */
export const UNKNOWN_WINDOW_MS = 15 * 60_000

/** A write that could not be read for this long is reported, with why. */
export const UNREAD_ALERT_AFTER_MS = 15 * 60_000

/** Resends per write, at most. */
export const MAX_RESENDS = 2

/** Resends per credit inquiry post, at most: each one that lands attaches another file (D5). */
export const MAX_INQUIRY_RESENDS = 1

/** Salesforce calls this job has out at once. */
export const SF_CONCURRENCY = 2

/** Records one tick reads, at most, oldest first. */
export const MAX_RECORDS_PER_TICK = 25

/**
 * How long a tick keeps starting Salesforce calls. One call is bounded at
 * SF_CALL_DEADLINE_MS, so a tick ends inside the minute job's 50 s deadline even
 * when the last call started just before this.
 */
export const SF_PHASE_BUDGET_MS = 20_000

/** How long one Salesforce call may take before it counts as no answer. */
export const SF_CALL_DEADLINE_MS = 12_000

/** Held writes waiting for the read-back that one tick gathers, the oldest runs first (the key leads with a UUIDv7 run id); settled and unowned ones listed on the way do not count toward it. */
export const ENTRY_SCAN_LIMIT = 200

/** The read-back has not finished a run for this long while writes wait: the liveness alert. */
export const LIVENESS_AFTER_MS = 10 * 60_000

/**
 * Salesforce keeps LastModifiedDate in whole seconds, and its clock is not the
 * Worker's. A record last written within this of a write's start is read as
 * written since, the side that overwrites nothing.
 */
export const LAST_MODIFIED_MARGIN_MS = 2_000

const STATE_PREFIX = 'sf-read-back:state:'
const CONFLICTS_PREFIX = 'sf-read-back:conflicts:'
const LIVENESS_FIRST_SEEN_KEY = 'sf-read-back:liveness-first-seen'
const RESEND_CLAIM_PREFIX = 'sf-read-back-resend:'
const ALERT_CLAIM_PREFIX = 'sf-read-back-alert:'
const UNREAD_CLAIM_TTL_SECONDS = 30 * 60
const NOT_RUNNING_CLAIM_TTL_SECONDS = 60 * 60
const CONFLICT_COUNTS_TTL_SECONDS = 8 * 24 * 60 * 60

export interface ReadBackKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expiration?: number; expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(opts: { prefix: string; limit: number; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete?: boolean; cursor?: string }>
}

type SweepSlack = Pick<SlackConnection, 'bot_token' | 'default_channel' | 'config_alerts_enabled'>

export interface SalesforceReadBackDeps {
  kv: ReadBackKv
  keys: SecretKeyInput
  /** The org's Salesforce through the node's one call path, as the run's workflow sees it. */
  portFor: (orgId: string, workflowId: string) => Promise<SalesforcePort>
  /** Why no Salesforce call should go out this minute, or null. Fails closed. */
  busy: () => Promise<UnreadReason | null>
  /** The resend claim: claimed for the one caller that may send. Must fail closed, and say when it could not be asked. */
  resendClaims: SendClaims
  /** The alert claim, so overlapping ticks post once. Fails open. */
  alertClaims?: AlertClaims
  slackFor: (orgId: string) => Promise<SweepSlack | null>
  sendAlert?: (slack: SweepSlack, payload: SalesforceReadBackAlert, appUrl: string) => Promise<boolean>
  /** Workflow names for the alerts; a failed read falls back to "A workflow". */
  workflowNames?: (ids: string[]) => Promise<Map<string, string>>
  appUrl: string
  now?: () => number
  /** Resolves when a Salesforce call has waited long enough. A test passes one that never resolves. */
  callDeadline?: (ms: number) => Promise<void>
  recordRun?: (startedAtMs: number, ending: JobRunEnding) => Promise<void>
}

export interface ReadBackSummary {
  listed: number
  /** More held writes than one list returns. */
  truncated: boolean
  /** Gone between the list and the read, or not a record the watch wrote. */
  skipped: number
  /** Not the read-back's: an update held without its own stamp (from before the stamp shipped for its object). */
  not_ours: number
  /** A body the keys could not open. */
  unreadable_entries: number
  /** Credit inquiry posts that could never write anything (no list, or a body the endpoint cannot read). */
  nothing_to_send: number
  /** Settled earlier and waiting to expire. */
  finished: number
  young: number
  unread: number
  reads: number
  landed: number
  /** Of those, landed through one of this job's resends. */
  landed_by_resend: number
  superseded: number
  resent: number
  resent_confirmed: number
  resend_unanswered: number
  resend_refused: number
  exhausted: number
  /** Writes with at least one field left out as moved. */
  conflicts: number
  /** Left for a later tick: the claim said no, or the attempt could not be recorded. */
  deferred: number
  /** This tick's resends, per object and field: how many carried the field, and how many found it moved. */
  conflict_fields: Record<string, { conflicts: number; candidates: number }>
  alerts: number
  stopped?: UnreadReason
}

/** What this job keeps about one held write. Field names and counts only. */
interface ReadBackState {
  v: 1
  /** Resends started. Written before each one is sent. */
  attempts: number
  last_attempt_at?: string
  /** Fields a later write of the same run owns, kept once that write is gone. */
  owned_by_later?: string[]
  /** Settled without landing, and why. */
  done?: {
    kind: 'resend_failed' | 'unknown' | 'conflict'
    at: string
    fields: string[]
    detail?: string
    conflict_fields?: string[]
    resent?: boolean
  }
  /** When each alert about it reached Slack. */
  alerted?: { unknown?: string; done?: string }
}

const freshState = (): ReadBackState => ({ v: 1, attempts: 0 })

function parseState(raw: string | null): ReadBackState {
  if (!raw) return freshState()
  try {
    const v = JSON.parse(raw) as Partial<ReadBackState>
    if (v.v !== 1 || typeof v.attempts !== 'number' || !Number.isFinite(v.attempts)) return freshState()
    return v as ReadBackState
  } catch {
    return freshState()
  }
}

interface Held {
  /** `<execution id>:<step>`, the at-risk key without its prefix. */
  id: string
  key: string
  entry: AtRiskEntry
  body: Record<string, unknown>
  state: ReadBackState
  firstAttemptMs: number
  /** When KV deletes the held write: its last write plus 24 hours. */
  expiresAtMs: number
  /** Set for a credit inquiry post (#2172): what its body can write. */
  inquiry?: InquiryPost
}

/**
 * What one held write is to the read-back: gone, not its own (held without its
 * own marker, which keeps the held alert), settled (waiting
 * only for KV to expire it), unopenable with the keys, or owned and unsettled.
 * The one classifier the tick and the liveness check both use, so "waiting for
 * the read-back" means the same thing in both (merge review, #2201).
 */
type HeldRead =
  | { kind: 'gone' }
  | { kind: 'not_ours' }
  | { kind: 'settled'; held: Held }
  | { kind: 'unopenable'; held: Held }
  | { kind: 'owned'; held: Held }

async function readHeldWrite(kv: Pick<ReadBackKv, 'get'>, keys: SecretKeyInput, name: string): Promise<HeldRead> {
  const id = name.slice(AT_RISK_WRITE_PREFIX.length)
  const entry = parseAtRiskEntry(await kv.get(name))
  if (!entry) return { kind: 'gone' }
  // A credit inquiry post (#2172) is always the read-back's: it needs no stamp.
  const inquiryPost = entry.sf_operation === 'apex' && entry.apex_path === CREDIT_INQUIRY_APEX_PATH
  if (!inquiryPost && !stampsWrites(entry.sf_object)) return { kind: 'not_ours' }
  const state = parseState(await kv.get(`${STATE_PREFIX}${id}`))
  const base = { id, key: name, entry, state, firstAttemptMs: Date.parse(entry.first_attempt_at), expiresAtMs: Date.parse(entry.recorded_at) + AT_RISK_WRITE_TTL_SECONDS * 1000 }
  // Marks a settled or unopenable post as one, so its alert is worded as a post.
  const asPost: Partial<Held> = inquiryPost ? { inquiry: { kind: 'malformed', reason: 'not opened' } } : {}
  if (state.done) return { kind: 'settled', held: { ...base, body: {}, ...asPost } }
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await decryptSecret(entry.body_encrypted, keys))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the held body is not an object')
    body = parsed as Record<string, unknown>
  } catch (e) {
    console.error(`[${SF_READ_BACK_JOB}] could not open the held write ${id}:`, formatErr(e))
    return { kind: 'unopenable', held: { ...base, body: {}, ...asPost } }
  }
  // The one rule the watch also reports a kept record by, so the capture never
  // stores a write for the replay that this job resends (#468).
  if (!readBackOwnsHeld(entry, body)) return { kind: 'not_ours' }
  return { kind: 'owned', held: { ...base, body, ...(inquiryPost ? { inquiry: inquiryPostOf(body) } : {}) } }
}

/**
 * Whether this job holds one step's write as its own: the step's at-risk record,
 * read through the same classifier the tick uses, is owned and not yet settled.
 * The engine's unfinished work alert stays quiet only on this answer (#2024), so
 * a write is never both left to this job and paged there, and never neither.
 * Anything else answers false: no record, a record without its own stamp, an
 * object with no marker field, or one the keys cannot open. A KV failure throws,
 * and the caller pages.
 */
export async function readBackHoldsStep(kv: Pick<ReadBackKv, 'get'>, keys: SecretKeyInput, executionId: string, stepNamespace: string): Promise<boolean> {
  const read = await readHeldWrite(kv, keys, atRiskKey(executionId, stepNamespace))
  return read.kind === 'owned'
}

/** Keys one list call asks KV for. */
const SCAN_PAGE = 200
/** Held writes classified at once. */
const SCAN_CHUNK = 25
/** Keys one scan lists at most, settled and unowned ones included. */
export const MAX_KEYS_SCANNED = 1000

/**
 * Lists the held writes oldest first and classifies them, page after page, until
 * `wanted` writes waiting for the read-back (owned and unsettled, or unopenable)
 * are found, the list ends, or MAX_KEYS_SCANNED keys have been looked at. Paging
 * matters because settled writes stay in KV until they expire, and unstamped ones
 * are never the read-back's: a single first page can be full of
 * them and hide every write still waiting (#2201 review).
 */
async function scanHeldWrites(kv: ReadBackKv, keys: SecretKeyInput, wanted: number): Promise<{ reads: HeldRead[]; listed: number; truncated: boolean }> {
  const reads: HeldRead[] = []
  let listed = 0
  let waiting = 0
  let cursor: string | undefined
  for (;;) {
    const page = await kv.list({ prefix: AT_RISK_WRITE_PREFIX, limit: SCAN_PAGE, ...(cursor ? { cursor } : {}) })
    listed += page.keys.length
    for (let i = 0; i < page.keys.length; i += SCAN_CHUNK) {
      const chunk = await Promise.all(page.keys.slice(i, i + SCAN_CHUNK).map(({ name }) => readHeldWrite(kv, keys, name)))
      reads.push(...chunk)
      waiting += chunk.filter((r) => r.kind === 'owned' || r.kind === 'unopenable').length
    }
    if (page.list_complete !== false || !page.cursor) return { reads, listed, truncated: false }
    if (waiting >= wanted || listed >= MAX_KEYS_SCANNED) return { reads, listed, truncated: true }
    cursor = page.cursor
  }
}

const fieldsOf = (body: Record<string, unknown>) => Object.keys(body).filter((f) => f !== WRITE_MARKER_FIELD)
/** The fields a held write set, for its alert: none for a credit inquiry post, which sets no field by name. */
const heldFields = (h: Pick<Held, 'body' | 'inquiry'>) => (h.inquiry ? [] : fieldsOf(h.body))
const isBlank = (v: unknown) => v === null || v === undefined || v === ''

/** A Salesforce time read as ms: `2026-10-15T12:00:00.000+0000` included. NaN otherwise. */
function salesforceTimeMs(v: unknown): number {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(v)) return Number.NaN
  return Date.parse(v.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))
}

/**
 * Whether a value Salesforce holds is the value a write sent, allowing for the
 * ways Salesforce spells a value back: a number as text or text as a number, a
 * time to the second in +0000, a checkbox as true or "true". Anything else
 * different is different, the side that overwrites nothing.
 */
export function sameSalesforceValue(current: unknown, sent: unknown): boolean {
  if (current === sent) return true
  if (isBlank(current) && isBlank(sent)) return true
  if (isBlank(current) || isBlank(sent)) return false
  const asNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : Number.NaN)
  if (typeof current === 'number' || typeof sent === 'number') {
    const a = asNumber(current)
    const b = asNumber(sent)
    return Number.isFinite(a) && Number.isFinite(b) && a === b
  }
  if (typeof current === 'boolean' || typeof sent === 'boolean') {
    const asBoolean = (v: unknown) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null)
    const a = asBoolean(current)
    return a !== null && a === asBoolean(sent)
  }
  if (typeof current === 'string' && typeof sent === 'string') {
    const a = salesforceTimeMs(current)
    const b = salesforceTimeMs(sent)
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.floor(a / 1000) === Math.floor(b / 1000)
    return false
  }
  return JSON.stringify(current) === JSON.stringify(sent)
}

export interface RecordEntry {
  id: string
  body: Record<string, unknown>
  /** Resends already started. */
  attempts: number
  /** Fields a later write of the run owns, from an earlier tick. */
  ownedByLater: string[]
  /** When its step began. Absent, the record is judged as written since. */
  firstAttemptMs?: number
}

export type RecordDecision =
  | { id: string; verdict: 'landed'; attempt: number }
  | { id: string; verdict: 'superseded' }
  | { id: string; verdict: 'exhausted' }
  | { id: string; verdict: 'conflict_only'; conflicts: string[]; ownedByLater: string[]; candidates: string[] }
  | { id: string; verdict: 'resend'; send: Record<string, unknown>; conflicts: string[]; ownedByLater: string[]; candidates: string[] }

/**
 * Decides every held write to one record from one read of it. `entries` are in
 * attempt order, oldest first.
 */
export function decideRecord(entries: RecordEntry[], current: Record<string, unknown>): RecordDecision[] {
  const stamp = parseWriteMarker(current[WRITE_MARKER_FIELD])
  const stampedId = stamp ? `${stamp.executionId}:${stamp.stepNamespace}` : null
  const lastModifiedMs = salesforceTimeMs(current.LastModifiedDate)
  // The newest write of the run to set each field owns it.
  const owner = new Map<string, number>()
  entries.forEach((e, i) => fieldsOf(e.body).forEach((f) => owner.set(f, i)))

  return entries.map((e, i): RecordDecision => {
    if (stamp && stampedId === e.id) return { id: e.id, verdict: 'landed', attempt: stamp.attempt }
    const fields = fieldsOf(e.body)
    const ownedByLater = fields.filter((f) => owner.get(f) !== i || e.ownedByLater.includes(f))
    const own = fields.filter((f) => !ownedByLater.includes(f))
    if (own.length === 0) return { id: e.id, verdict: 'superseded' }
    if (e.attempts >= MAX_RESENDS) return { id: e.id, verdict: 'exhausted' }
    // Nobody has written the record since this write began: whatever it holds
    // came before the write, which is what the write was sent to replace.
    const untouched = Number.isFinite(lastModifiedMs) && e.firstAttemptMs !== undefined && lastModifiedMs + LAST_MODIFIED_MARGIN_MS <= e.firstAttemptMs
    const conflicts = untouched
      ? []
      : own.filter((f) => {
          const now = current[f]
          if (isBlank(now) || sameSalesforceValue(now, e.body[f])) return false
          // A value an earlier write of the run sent is ours, and this newer write replaces it.
          return !entries.slice(0, i).some((earlier) => Object.hasOwn(earlier.body, f) && sameSalesforceValue(now, earlier.body[f]))
        })
    const send = own.filter((f) => !conflicts.includes(f))
    if (send.length === 0) return { id: e.id, verdict: 'conflict_only', conflicts, ownedByLater, candidates: own }
    return { id: e.id, verdict: 'resend', send: Object.fromEntries(send.map((f) => [f, e.body[f]])), conflicts, ownedByLater, candidates: own }
  })
}

function emptySummary(): ReadBackSummary {
  return {
    listed: 0, truncated: false, skipped: 0, not_ours: 0, unreadable_entries: 0, nothing_to_send: 0, finished: 0, young: 0, unread: 0, reads: 0,
    landed: 0, landed_by_resend: 0, superseded: 0, resent: 0, resent_confirmed: 0, resend_unanswered: 0, resend_refused: 0,
    exhausted: 0, conflicts: 0, deferred: 0, conflict_fields: {}, alerts: 0,
  }
}

/** One write an alert is about, and which flag its delivery sets. */
interface Finding {
  kind: 'resend_failed' | 'unknown' | 'conflict'
  flag: 'done' | 'unknown'
  held: Pick<Held, 'id' | 'entry' | 'expiresAtMs' | 'inquiry'> & { state: ReadBackState }
  fields: string[]
  detail?: string
  conflict_fields?: string[]
  resent?: boolean
  still_trying?: boolean
}

type CallResult = { kind: 'answer'; status: number; text: string } | { kind: 'no_answer'; error: string }

function errorCodeOf(text: string): string | null {
  try {
    const v = JSON.parse(text) as unknown
    const first = Array.isArray(v) ? (v[0] as { errorCode?: unknown }) : (v as { errorCode?: unknown })
    return first && typeof first.errorCode === 'string' && /^[A-Z_]+$/.test(first.errorCode) ? first.errorCode : null
  } catch {
    return null
  }
}

/** ET calendar day, for the per field conflict counts the alert calls "today". */
const etDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))

export async function runSalesforceReadBack(deps: SalesforceReadBackDeps): Promise<ReadBackSummary> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const s = emptySummary()
  const findings: Finding[] = []

  const stateKey = (id: string) => `${STATE_PREFIX}${id}`
  // A state record never outlives the held write it describes; KV wants 60 s at least.
  const putState = (h: Pick<Held, 'id' | 'expiresAtMs'>, state: ReadBackState) =>
    deps.kv.put(stateKey(h.id), JSON.stringify(state), { expiration: Math.max(Math.floor(h.expiresAtMs / 1000), Math.floor(now() / 1000) + 60) })
  const resolved = new Set<string>()
  // Read this tick, found not landed, and not resent: the claim said no or the attempt could not be counted.
  const deferred = new Set<string>()
  const forget = async (h: Held) => {
    resolved.add(h.id)
    await deps.kv.delete(h.key)
    await deps.kv.delete(stateKey(h.id))
  }
  const finish = async (h: Held, done: Omit<NonNullable<ReadBackState['done']>, 'at' | 'fields'>, extra: Partial<Finding> = {}) => {
    resolved.add(h.id)
    const fields = heldFields(h)
    const state: ReadBackState = { ...h.state, done: { ...done, at: new Date(now()).toISOString(), fields } }
    // A write already said to be still not confirmed is not said again when the
    // read-back stops trying.
    if (done.kind === 'unknown' && state.alerted?.unknown) state.alerted = { ...state.alerted, done: state.alerted.unknown }
    h.state = state
    try {
      await putState(h, state)
    } catch (e) {
      console.error(`[${SF_READ_BACK_JOB}] could not record that ${h.id} is settled (${done.kind}); it is read again next tick:`, formatErr(e))
    }
    if (!state.alerted?.done) findings.push({ kind: done.kind, flag: 'done', held: h, fields, detail: done.detail, conflict_fields: done.conflict_fields, resent: done.resent, ...extra })
  }

  // ── Find the held writes this job owns ────────────────────────────────────
  const scan = await scanHeldWrites(deps.kv, deps.keys, ENTRY_SCAN_LIMIT)
  s.listed = scan.listed
  s.truncated = scan.truncated
  const held: Held[] = []
  // Held writes on the marker objects whose body the keys could not open.
  const unopenable: Held[] = []
  for (const r of scan.reads) {
    if (r.kind === 'gone') s.skipped++
    else if (r.kind === 'not_ours') s.not_ours++
    else if (r.kind === 'settled') {
      // Settled; its alert is sent again only if it never reached Slack.
      s.finished++
      const { state } = r.held
      if (state.done && !state.alerted?.done) {
        findings.push({ kind: state.done.kind, flag: 'done', held: r.held, fields: state.done.fields, detail: state.done.detail, conflict_fields: state.done.conflict_fields, resent: state.done.resent, still_trying: false })
      }
    } else if (r.kind === 'unopenable') {
      s.unreadable_entries++
      // The capture left it to the read-back, so nothing else will say it: it is
      // reported with the unread writes, under its own reason (L13).
      unopenable.push(r.held)
    } else if (r.held.inquiry && r.held.inquiry.kind !== 'inquiries') {
      // A credit inquiry post that can write nothing is settled without reading
      // Salesforce: an empty list landed (answered 200, nothing written), and a
      // missing list or an unreadable body is answered 500 before any write, so
      // there is nothing to send, now or ever.
      const post = r.held.inquiry
      const why = post.kind === 'empty' ? 'an empty inquiry list, which writes nothing' : post.kind === 'missing_list' ? 'no inquiry list, which Salesforce refuses before writing anything' : post.reason
      console.log(`[${SF_READ_BACK_JOB}] credit inquiry post ${r.held.id} needs no read back: ${why}`)
      if (post.kind === 'empty') s.landed++
      else s.nothing_to_send++
      await forget(r.held)
    } else held.push(r.held)
  }

  // ── Group by record, oldest write first, and keep the records due ─────────
  const byRecord = new Map<string, Held[]>()
  for (const h of held) {
    // A credit inquiry post is its own unit: nothing of it merges with an update.
    const k = h.inquiry ? `inquiry|${h.id}` : `${h.entry.org_id}|${h.entry.sf_object}|${h.entry.sf_record_id}`
    byRecord.set(k, [...(byRecord.get(k) ?? []), h])
  }
  // An unreadable resend time reads as just sent: the side that sends nothing early (L50).
  const lastSendMs = (h: Held) => {
    if (!h.state.last_attempt_at) return h.firstAttemptMs
    const sent = Date.parse(h.state.last_attempt_at)
    return Number.isFinite(sent) ? Math.max(h.firstAttemptMs, sent) : startedAt
  }
  const due: Held[][] = []
  for (const group of byRecord.values()) {
    group.sort((a, b) => a.firstAttemptMs - b.firstAttemptMs || a.entry.recorded_at.localeCompare(b.entry.recorded_at) || a.id.localeCompare(b.id))
    // A record is read only once every write to it is old enough: a younger
    // write of the run may still be landing.
    if (group.some((h) => startedAt - lastSendMs(h) < SF_READ_BACK_MIN_AGE_MS)) {
      s.young += group.length
      continue
    }
    due.push(group)
  }
  due.sort((a, b) => a[0].firstAttemptMs - b[0].firstAttemptMs)

  // ── Read and resend, capped, stopping at the first unanswered call ────────
  let stopped: UnreadReason | null = due.length > 0 ? await deps.busy().catch(() => 'bulkhead_unknown' as const) : null
  let unreadReason: UnreadReason | null = null
  const unread: Held[] = []
  const ports = new Map<string, Promise<SalesforcePort>>()
  const tally = new Map<string, { sf_object: string; field: string; conflicts: number; candidates: number }>()

  const call = async (port: SalesforcePort, method: 'GET' | 'PATCH', path: string, body?: string): Promise<CallResult> => {
    const raced = await raceDeadline(() => port.send(method, path, body), SF_CALL_DEADLINE_MS, deps.callDeadline)
    if (raced.kind === 'ok') return { kind: 'answer', ...raced.value }
    return { kind: 'no_answer', error: raced.kind === 'threw' ? formatErr(raced.error) : `no answer within ${SF_CALL_DEADLINE_MS / 1000} s` }
  }
  const stopFor = (status: number): UnreadReason => (status === 401 || status === 403 ? 'salesforce_login' : 'salesforce_not_answering')
  const count = (h: Held, candidates: string[], conflicts: string[]) => {
    for (const field of candidates) {
      const k = `${h.entry.sf_object}.${field}`
      const t = tally.get(k) ?? { sf_object: h.entry.sf_object, field, conflicts: 0, candidates: 0 }
      t.candidates++
      if (conflicts.includes(field)) t.conflicts++
      tally.set(k, t)
    }
  }

  /**
   * The claim, then the attempt counted, before anything is sent. Only a won
   * claim spends an attempt. One the object could not answer sends nothing and
   * spends nothing, so a claim object that is down cannot use up a write's
   * resends; one another tick holds is that tick's to send. An attempt that
   * cannot be counted is not made, and its claim is freed so the next tick can
   * make it. True when the caller may send.
   */
  const claimAttempt = async (h: Held, attempt: number, extra: Partial<ReadBackState> = {}): Promise<boolean> => {
    const claimKey = `${RESEND_CLAIM_PREFIX}${h.id}:${attempt}`
    const claimed = await deps.resendClaims.claim(claimKey, AT_RISK_WRITE_TTL_SECONDS)
    if (claimed !== 'claimed') {
      s.deferred++
      deferred.add(h.id)
      return false
    }
    const state: ReadBackState = { ...h.state, ...extra, attempts: attempt, last_attempt_at: new Date(now()).toISOString() }
    try {
      await putState(h, state)
    } catch (e) {
      console.error(`[${SF_READ_BACK_JOB}] could not record attempt ${attempt} of ${h.id}, so it is not sent:`, formatErr(e))
      await deps.resendClaims.release(claimKey)
      s.deferred++
      deferred.add(h.id)
      return false
    }
    h.state = state
    return true
  }

  const resend = async (h: Held, d: Extract<RecordDecision, { verdict: 'resend' }>, port: SalesforcePort, path: string): Promise<UnreadReason | null> => {
    const attempt = h.state.attempts + 1
    const marker = writeMarker(h.entry.execution_id, h.entry.step_namespace, attempt)
    if (!marker) {
      // Cannot happen (the attempt 0 marker fit, and this one is as long); said if it does.
      console.error(`[${SF_READ_BACK_JOB}] no marker fits for ${h.id} attempt ${attempt}, so it is not resent`)
      s.deferred++
      return null
    }
    if (!(await claimAttempt(h, attempt, { owned_by_later: d.ownedByLater }))) return null
    count(h, d.candidates, d.conflicts)
    if (d.conflicts.length > 0) s.conflicts++
    s.resent++
    const answer = await call(port, 'PATCH', path, JSON.stringify({ ...d.send, [WRITE_MARKER_FIELD]: marker }))
    if (answer.kind === 'no_answer') {
      console.warn(`[${SF_READ_BACK_JOB}] resend ${attempt} of ${h.id} got no answer: ${answer.error}`)
      s.resend_unanswered++
      return 'salesforce_not_answering'
    }
    if (answer.status >= 200 && answer.status < 300) {
      s.resent_confirmed++
      if (d.conflicts.length > 0) await finish(h, { kind: 'conflict', conflict_fields: d.conflicts, resent: true })
      else await forget(h)
      return null
    }
    if (salesforceRejectedTheWrite(answer.status, answer.text)) {
      s.resend_refused++
      const code = errorCodeOf(answer.text)
      await finish(h, { kind: 'resend_failed', detail: `Salesforce answered ${answer.status}${code ? ` ${code}` : ''}` })
      return null
    }
    s.resend_unanswered++
    return stopFor(answer.status)
  }

  /** One read for a credit inquiry post: its body, or how the post was settled or the tick stopped. */
  const readFor = async (h: Held, port: SalesforcePort, path: string, what: string): Promise<{ body: Record<string, unknown> } | { unread?: boolean; stop?: UnreadReason; settled?: boolean }> => {
    s.reads++
    const read = await call(port, 'GET', path)
    if (read.kind === 'no_answer') {
      console.warn(`[${SF_READ_BACK_JOB}] reading the ${what} for ${h.id} got no answer: ${read.error}`)
      return { unread: true, stop: 'salesforce_not_answering' }
    }
    if (read.status < 200 || read.status >= 300) {
      if (salesforceRejectedTheWrite(read.status, read.text)) {
        const code = errorCodeOf(read.text)
        await finish(h, {
          kind: 'resend_failed',
          resent: false,
          detail: read.status === 404 ? `the ${what} no longer exists in Salesforce` : `Salesforce refused to read the ${what} (${read.status}${code ? ` ${code}` : ''})`,
        })
        return { settled: true }
      }
      return { unread: true, stop: stopFor(read.status) }
    }
    try {
      const parsed: unknown = JSON.parse(read.text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      return { body: parsed as Record<string, unknown> }
    } catch {
      return { unread: true, stop: 'salesforce_not_answering' }
    }
  }

  /** One credit inquiry post that carries inquiries (#2172): its Lead, its file, and at most one resend. */
  const processInquiry = async (h: Held, post: Extract<InquiryPost, { kind: 'inquiries' }>, port: SalesforcePort): Promise<{ unread?: boolean; stop?: UnreadReason }> => {
    const sub = await readFor(h, port, `/sobjects/Submission__c/${post.submissionId}?fields=Lead__c`, 'Submission')
    if (!('body' in sub)) return sub.settled ? {} : sub
    const lead = sub.body.Lead__c
    if (typeof lead !== 'string' || !isSalesforceRecordId(lead)) {
      // InquiryParserRest answers 404 for a Submission with no Lead, writing nothing.
      await finish(h, { kind: 'resend_failed', resent: false, detail: 'the Submission has no Lead, so Salesforce refuses the post' })
      return {}
    }
    const marker = await readFor(h, port, `/query?q=${encodeURIComponent(inquiryMarkerQuery(lead, h.firstAttemptMs))}`, 'Inquiries file')
    if (!('body' in marker)) return marker.settled ? {} : marker
    const found = marker.body.totalSize
    if (typeof found !== 'number') return { unread: true, stop: 'salesforce_not_answering' }
    if (found > 0) {
      s.landed++
      if (h.state.attempts > 0) s.landed_by_resend++
      await forget(h)
      return {}
    }
    if (h.state.attempts >= MAX_INQUIRY_RESENDS) {
      s.exhausted++
      await finish(h, { kind: 'unknown' }, { still_trying: false })
      return {}
    }
    const attempt = h.state.attempts + 1
    if (!(await claimAttempt(h, attempt))) return {}
    s.resent++
    // The held body exactly as the run sent it: the endpoint has no marker field to add.
    const raced = await raceDeadline(() => port.postApex(CREDIT_INQUIRY_APEX_PATH, JSON.stringify(h.body)), SF_CALL_DEADLINE_MS, deps.callDeadline)
    if (raced.kind !== 'ok') {
      console.warn(`[${SF_READ_BACK_JOB}] resend ${attempt} of credit inquiry post ${h.id} got no answer: ${raced.kind === 'threw' ? formatErr(raced.error) : 'past its deadline'}`)
      s.resend_unanswered++
      return { stop: 'salesforce_not_answering' }
    }
    const { status, text } = raced.value
    if (status >= 200 && status < 300) {
      s.resent_confirmed++
      await forget(h)
      return {}
    }
    if (salesforceRejectedTheWrite(status, text)) {
      s.resend_refused++
      await finish(h, { kind: 'resend_failed', resent: true, detail: `Salesforce answered ${status}` })
      return {}
    }
    // A 500 is the class's own catch, which does not roll back: rows may be
    // written without the file, so it is unknown and read again. Salesforce did
    // answer, so the tick goes on; a login refusal or a rate limit stops it.
    s.resend_unanswered++
    console.warn(`[${SF_READ_BACK_JOB}] resend ${attempt} of credit inquiry post ${h.id} was answered ${status}, so whether it landed is read again`)
    return status >= 500 ? {} : { stop: stopFor(status) }
  }

  const processRecord = async (group: Held[]): Promise<{ unread?: boolean; stop?: UnreadReason }> => {
    const head = group[0].entry
    const portKey = `${head.org_id}|${head.workflow_id}`
    let portPromise = ports.get(portKey)
    if (!portPromise) {
      portPromise = deps.portFor(head.org_id, head.workflow_id)
      ports.set(portKey, portPromise)
    }
    let port: SalesforcePort
    try {
      port = await portPromise
    } catch (e) {
      console.error(`[${SF_READ_BACK_JOB}] Salesforce settings for workflow ${head.workflow_id} could not be loaded:`, formatErr(e))
      unreadReason = 'credentials'
      return { unread: true }
    }
    const inquiry = group[0].inquiry
    if (inquiry) return inquiry.kind === 'inquiries' ? processInquiry(group[0], inquiry, port) : {}
    const fields = [...new Set(group.flatMap((h) => fieldsOf(h.body)))]
    const settleAll = async (detail: string) => {
      for (const h of group) await finish(h, { kind: 'resend_failed', detail })
    }
    if (!isSalesforceApiName(head.sf_object) || !isSalesforceRecordId(head.sf_record_id) || !fields.every(isSalesforceApiName)) {
      await settleAll('it names something that is not a Salesforce record or field, so it was not read back')
      return {}
    }
    const path = `/sobjects/${head.sf_object}/${head.sf_record_id}`
    s.reads++
    const read = await call(port, 'GET', `${path}?fields=${[WRITE_MARKER_FIELD, 'LastModifiedDate', ...fields].join(',')}`)
    if (read.kind === 'no_answer') {
      console.warn(`[${SF_READ_BACK_JOB}] reading ${head.sf_object} ${head.sf_record_id} got no answer: ${read.error}`)
      return { unread: true, stop: 'salesforce_not_answering' }
    }
    if (read.status === 404) {
      await settleAll('the record no longer exists in Salesforce')
      return {}
    }
    if (read.status < 200 || read.status >= 300) {
      if (salesforceRejectedTheWrite(read.status, read.text)) {
        const code = errorCodeOf(read.text)
        await settleAll(`Salesforce refused to read the record back (${read.status}${code ? ` ${code}` : ''})`)
        return {}
      }
      return { unread: true, stop: stopFor(read.status) }
    }
    let current: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(read.text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      current = parsed as Record<string, unknown>
    } catch {
      return { unread: true, stop: 'salesforce_not_answering' }
    }

    const decisions = decideRecord(
      group.map((h) => ({ id: h.id, body: h.body, attempts: h.state.attempts, ownedByLater: h.state.owned_by_later ?? [], firstAttemptMs: h.firstAttemptMs })),
      current,
    )
    // Oldest first, so a newer write's resend lands last and its stamp is the one left.
    for (const [i, d] of decisions.entries()) {
      const h = group[i]
      if (d.verdict === 'landed') {
        s.landed++
        if (d.attempt > 0) s.landed_by_resend++
        await forget(h)
      } else if (d.verdict === 'superseded') {
        s.superseded++
        await forget(h)
      } else if (d.verdict === 'exhausted') {
        s.exhausted++
        await finish(h, { kind: 'unknown' }, { still_trying: false })
      } else if (d.verdict === 'conflict_only') {
        count(h, d.candidates, d.conflicts)
        s.conflicts++
        await finish(h, { kind: 'conflict', conflict_fields: d.conflicts, resent: false })
      } else {
        const stop = await resend(h, d, port, path)
        if (stop) return { stop }
      }
    }
    return {}
  }

  let next = 0
  let taken = 0
  const worker = async () => {
    for (;;) {
      if (stopped || next >= due.length) return
      if (taken >= MAX_RECORDS_PER_TICK || now() - startedAt >= SF_PHASE_BUDGET_MS) {
        stopped = stopped ?? 'tick_full'
        return
      }
      const group = due[next++]
      taken++
      const r = await processRecord(group)
      if (r.unread) unread.push(...group)
      if (r.stop) stopped = stopped ?? r.stop
    }
  }
  await Promise.all(Array.from({ length: SF_CONCURRENCY }, () => worker()))
  for (let i = next; i < due.length; i++) unread.push(...due[i])
  s.unread = unread.length
  if (stopped) s.stopped = stopped

  // ── Still not confirmed past its window ───────────────────────────────────
  for (const h of held) {
    if (resolved.has(h.id) || h.state.done || h.state.alerted?.unknown) continue
    // Never read is the unread alert's; read and resent, or read and not resendable, is this one.
    if (h.state.attempts < 1 && !deferred.has(h.id)) continue
    if (startedAt - h.firstAttemptMs < UNKNOWN_WINDOW_MS) continue
    findings.push({ kind: 'unknown', flag: 'unknown', held: h, fields: heldFields(h), still_trying: h.state.attempts < (h.inquiry ? MAX_INQUIRY_RESENDS : MAX_RESENDS) })
  }

  // ── Conflict counts per field, by ET day ──────────────────────────────────
  s.conflict_fields = Object.fromEntries([...tally.entries()].map(([k, t]) => [k, { conflicts: t.conflicts, candidates: t.candidates }]))
  const dayCounts = await carryConflictCounts(deps.kv, tally, startedAt)

  // ── Alerts ────────────────────────────────────────────────────────────────
  s.alerts += await deliverFindings(deps, findings, dayCounts, putState, now)
  const reason = stopped ?? unreadReason
  if (unread.length > 0 && reason) s.alerts += await reportUnread(deps, unread, reason, startedAt)
  if (unopenable.length > 0) s.alerts += await reportUnread(deps, unopenable, 'held_unreadable', startedAt)

  if (deps.recordRun && (s.reads > 0 || s.unread > 0 || s.alerts > 0)) {
    await deps.recordRun(startedAt, {
      outcome: s.resend_refused > 0 || s.exhausted > 0 ? 'unresolved-found' : s.unread > 0 ? 'unread' : 'resolved',
      detail: `landed=${s.landed} nothing_to_send=${s.nothing_to_send} resent=${s.resent} confirmed=${s.resent_confirmed} unanswered=${s.resend_unanswered} refused=${s.resend_refused} conflicts=${s.conflicts} unread=${s.unread} young=${s.young}`,
      summary: { ...s },
    }).catch((e) => console.error(`[${SF_READ_BACK_JOB}] could not record the run:`, formatErr(e)))
  }
  return s
}

/** Adds this tick's per field counts to today's (ET), and returns today's. Never throws. */
async function carryConflictCounts(
  kv: ReadBackKv,
  tally: Map<string, { sf_object: string; field: string; conflicts: number; candidates: number }>,
  nowMs: number,
): Promise<Map<string, { sf_object: string; field: string; conflicts: number; candidates: number }>> {
  const key = `${CONFLICTS_PREFIX}${etDay(nowMs)}`
  const day = new Map<string, { sf_object: string; field: string; conflicts: number; candidates: number }>()
  try {
    const raw = await kv.get(key)
    const stored = raw ? (JSON.parse(raw) as Record<string, { sf_object: string; field: string; conflicts: number; candidates: number }>) : {}
    for (const [k, v] of Object.entries(stored)) if (v && typeof v.candidates === 'number') day.set(k, { ...v })
  } catch (e) {
    console.error(`[${SF_READ_BACK_JOB}] today's conflict counts were unreadable, starting again:`, formatErr(e))
  }
  if (tally.size === 0) return day
  for (const [k, t] of tally) {
    const have = day.get(k) ?? { sf_object: t.sf_object, field: t.field, conflicts: 0, candidates: 0 }
    day.set(k, { ...have, conflicts: have.conflicts + t.conflicts, candidates: have.candidates + t.candidates })
  }
  try {
    await kv.put(key, JSON.stringify(Object.fromEntries(day)), { expirationTtl: CONFLICT_COUNTS_TTL_SECONDS })
  } catch (e) {
    console.error(`[${SF_READ_BACK_JOB}] could not store today's conflict counts:`, formatErr(e))
  }
  return day
}

async function workflowNamesFor(deps: SalesforceReadBackDeps, ids: string[]): Promise<Map<string, string>> {
  if (!deps.workflowNames || ids.length === 0) return new Map()
  try {
    return await deps.workflowNames(ids)
  } catch (e) {
    console.error(`[${SF_READ_BACK_JOB}] workflow names unreadable, the alert says "A workflow":`, formatErr(e))
    return new Map()
  }
}

/** One alert per org and kind, naming each write once. Returns alerts delivered. */
async function deliverFindings(
  deps: SalesforceReadBackDeps,
  findings: Finding[],
  dayCounts: Map<string, { sf_object: string; field: string; conflicts: number; candidates: number }>,
  putState: (h: Pick<Held, 'id' | 'expiresAtMs'>, state: ReadBackState) => Promise<void>,
  now: () => number,
): Promise<number> {
  if (findings.length === 0) return 0
  const names = await workflowNamesFor(deps, [...new Set(findings.map((f) => f.held.entry.workflow_id))])
  const groups = new Map<string, Finding[]>()
  for (const f of findings) {
    // A credit inquiry post is worded as one, so it is never grouped with updates.
    const k = `${f.held.entry.org_id}|${f.kind}|${f.held.inquiry ? 'inquiry' : 'update'}`
    groups.set(k, [...(groups.get(k) ?? []), f])
  }
  let delivered = 0
  const send = deps.sendAlert ?? sendSalesforceReadBackAlert
  for (const group of groups.values()) {
    const { kind } = group[0]
    const orgId = group[0].held.entry.org_id
    const claimed: Finding[] = []
    for (const f of group) {
      if (!deps.alertClaims || (await deps.alertClaims.claim(`${ALERT_CLAIM_PREFIX}${f.flag}:${f.held.id}`, AT_RISK_WRITE_TTL_SECONDS))) claimed.push(f)
    }
    if (claimed.length === 0) continue
    const writes: ReadBackAlertWrite[] = claimed.map((f) => ({
      workflow_id: f.held.entry.workflow_id,
      workflow_name: names.get(f.held.entry.workflow_id) ?? 'A workflow',
      execution_id: f.held.entry.execution_id,
      sf_object: f.held.entry.sf_object,
      sf_record_id: f.held.entry.sf_record_id,
      fields: f.fields,
      first_attempt_at: f.held.entry.first_attempt_at,
      expires_at: new Date(f.held.expiresAtMs).toISOString(),
      resends: f.held.state.attempts,
      ...(f.held.inquiry ? { inquiry_post: true } : {}),
      ...(f.detail ? { detail: f.detail } : {}),
      ...(f.still_trying !== undefined ? { still_trying: f.still_trying } : {}),
      ...(f.conflict_fields ? { conflict_fields: f.conflict_fields } : {}),
      ...(f.resent !== undefined ? { resent: f.resent } : {}),
    }))
    const payload: SalesforceReadBackAlert = { kind, writes }
    if (kind === 'conflict') {
      const named = new Set(claimed.flatMap((f) => (f.conflict_fields ?? []).map((field) => `${f.held.entry.sf_object}.${field}`)))
      payload.conflict_rates = [...named].map((k) => dayCounts.get(k)).filter((r): r is NonNullable<typeof r> => r !== undefined)
    }
    let ok = false
    try {
      const slack = await deps.slackFor(orgId)
      if (!slack) console.error(`[${SF_READ_BACK_JOB}] ${claimed.length} ${kind} findings for org ${orgId}, and no Slack connection to say so`)
      else ok = slack.config_alerts_enabled ? await send(slack, payload, deps.appUrl) : true
    } catch (e) {
      console.error(`[${SF_READ_BACK_JOB}] ${kind} alert failed for org ${orgId}:`, formatErr(e))
    }
    if (!ok) {
      // Not delivered: the claims are freed and the flags left unset, so the next tick says it.
      for (const f of claimed) await deps.alertClaims?.release(`${ALERT_CLAIM_PREFIX}${f.flag}:${f.held.id}`)
      continue
    }
    delivered++
    const at = new Date(now()).toISOString()
    for (const f of claimed) {
      const state: ReadBackState = { ...f.held.state, alerted: { ...f.held.state.alerted, [f.flag]: at } }
      f.held.state = state
      await putState(f.held, state).catch((e) => console.error(`[${SF_READ_BACK_JOB}] could not mark ${f.held.id} alerted:`, formatErr(e)))
    }
  }
  return delivered
}

/** How many of the waiting writes are credit inquiry posts, for the alert to say; nothing when none are. */
function inquiryCount(entries: AtRiskEntry[]): { inquiry_posts?: number } {
  const n = entries.filter((e) => e.sf_operation === 'apex').length
  return n > 0 ? { inquiry_posts: n } : {}
}

/** The oldest unread write per org, once it has waited UNREAD_ALERT_AFTER_MS. Returns alerts delivered. */
async function reportUnread(deps: SalesforceReadBackDeps, unread: Held[], reason: UnreadReason, nowMs: number): Promise<number> {
  const byOrg = new Map<string, Held[]>()
  for (const h of unread) byOrg.set(h.entry.org_id, [...(byOrg.get(h.entry.org_id) ?? []), h])
  let delivered = 0
  const send = deps.sendAlert ?? sendSalesforceReadBackAlert
  for (const [orgId, list] of byOrg) {
    const oldest = list.reduce((a, b) => (b.firstAttemptMs < a.firstAttemptMs ? b : a))
    if (nowMs - oldest.firstAttemptMs < UNREAD_ALERT_AFTER_MS) continue
    const claimKey = `${ALERT_CLAIM_PREFIX}unread:${reason}:${orgId}`
    if (deps.alertClaims && !(await deps.alertClaims.claim(claimKey, UNREAD_CLAIM_TTL_SECONDS))) continue
    let ok = false
    try {
      const slack = await deps.slackFor(orgId)
      if (!slack) console.error(`[${SF_READ_BACK_JOB}] ${list.length} writes unread for org ${orgId}, and no Slack connection to say so`)
      else
        ok = slack.config_alerts_enabled
          ? await send(slack, {
              kind: 'unread',
              writes: [],
              count: list.length,
              ...inquiryCount(list.map((h) => h.entry)),
              oldest_at: oldest.entry.first_attempt_at,
              oldest_expires_at: new Date(Math.min(...list.map((h) => h.expiresAtMs))).toISOString(),
              reason,
            }, deps.appUrl)
          : true
    } catch (e) {
      console.error(`[${SF_READ_BACK_JOB}] unread alert failed for org ${orgId}:`, formatErr(e))
    }
    if (ok) delivered++
    else await deps.alertClaims?.release(claimKey)
  }
  return delivered
}

export interface LivenessDeps {
  kv: ReadBackKv
  /** Opens the held bodies, whose stamp says whether the read-back owns them. */
  keys: SecretKeyInput
  now?: () => number
  slackFor: (orgId: string) => Promise<SweepSlack | null>
  sendAlert?: (slack: SweepSlack, payload: SalesforceReadBackAlert, appUrl: string) => Promise<boolean>
  alertClaims?: AlertClaims
  appUrl: string
}

export interface LivenessResult {
  waiting: number
  last_finished_at: string | null
  alerted: boolean
}

/** Waiting held writes the liveness check gathers before it stops listing; the alert says how many it found. */
const LIVENESS_SCAN_LIMIT = 50

/**
 * Whether the read-back has stopped finishing runs while writes wait for it.
 * Run by a different minute job than the read-back (L71), so the read-back's own
 * failure cannot silence it. One KV read a minute while the read-back is healthy.
 *
 * Counts only the held writes the read-back owns and has not settled (and any it
 * cannot open) that are older than its minimum age, read through the classifier
 * the tick uses. It opens their bodies to see the stamp, but only once the
 * read-back has gone 10 minutes without finishing a run.
 */
export async function checkSalesforceReadBackLiveness(deps: LivenessDeps): Promise<LivenessResult> {
  const now = deps.now ?? Date.now
  const nowMs = now()
  const lastFinished = await deps.kv.get(completedKey(SF_READ_BACK_JOB))
  const lastMs = lastFinished ? Date.parse(lastFinished) : Number.NaN
  const quiet = (waiting: number): LivenessResult => ({ waiting, last_finished_at: lastFinished, alerted: false })
  if (Number.isFinite(lastMs) && nowMs - lastMs < LIVENESS_AFTER_MS) return quiet(0)
  if (!Number.isFinite(lastMs)) {
    // Never finished a run: the same grace from when this check first looked, as
    // the cron heartbeat gives a fresh deploy. The marker is kept for good, with
    // no expiry, exactly like the heartbeat's first-seen marker: the grace is for
    // the first deploy only, and a read-back that has still never finished a run
    // long after it is exactly what this check exists to say. It holds one time.
    const firstSeen = await deps.kv.get(LIVENESS_FIRST_SEEN_KEY)
    if (!firstSeen) {
      await deps.kv.put(LIVENESS_FIRST_SEEN_KEY, new Date(nowMs).toISOString())
      return quiet(0)
    }
    if (nowMs - Date.parse(firstSeen) < LIVENESS_AFTER_MS) return quiet(0)
  }
  const { reads } = await scanHeldWrites(deps.kv, deps.keys, LIVENESS_SCAN_LIMIT)
  const byOrg = new Map<string, AtRiskEntry[]>()
  for (const r of reads) {
    // Waiting for the read-back: one it owns and has not settled, or one it
    // cannot open, which nothing else will report while it is not running. A
    // settled write waits only for KV, and one it does not own keeps the held alert.
    if (r.kind !== 'owned' && r.kind !== 'unopenable') continue
    const { entry } = r.held
    if (nowMs - Date.parse(entry.first_attempt_at) < SF_READ_BACK_MIN_AGE_MS) continue
    byOrg.set(entry.org_id, [...(byOrg.get(entry.org_id) ?? []), entry])
  }
  let waiting = 0
  let alerted = false
  const send = deps.sendAlert ?? sendSalesforceReadBackAlert
  for (const [orgId, entries] of byOrg) {
    waiting += entries.length
    const claimKey = `${ALERT_CLAIM_PREFIX}not-running:${orgId}`
    if (deps.alertClaims && !(await deps.alertClaims.claim(claimKey, NOT_RUNNING_CLAIM_TTL_SECONDS))) continue
    const oldest = entries.map((e) => e.first_attempt_at).sort()[0]
    const oldestExpiry = entries.map((e) => Date.parse(e.recorded_at) + AT_RISK_WRITE_TTL_SECONDS * 1000).sort((a, b) => a - b)[0]
    let ok = false
    try {
      const slack = await deps.slackFor(orgId)
      if (!slack) console.error(`[${SF_READ_BACK_JOB}] read-back not running with ${entries.length} writes waiting for org ${orgId}, and no Slack connection to say so`)
      else
        ok = slack.config_alerts_enabled
          ? await send(slack, {
              kind: 'not_running',
              writes: [],
              count: entries.length,
              ...inquiryCount(entries),
              oldest_at: oldest,
              oldest_expires_at: new Date(oldestExpiry).toISOString(),
              last_finished_at: lastFinished,
            }, deps.appUrl)
          : true
    } catch (e) {
      console.error(`[${SF_READ_BACK_JOB}] not-running alert failed for org ${orgId}:`, formatErr(e))
    }
    if (ok) alerted = true
    else await deps.alertClaims?.release(claimKey)
  }
  return { waiting, last_finished_at: lastFinished, alerted }
}

// ── Production wiring ───────────────────────────────────────────────────────

/**
 * The org's Slack connection. `supabase` is the scheduled handler's client, on
 * which getSlackConnection is bounded and falls back to the last-good copy
 * (#1303, scheduled-slack.ts), so a read-back alert still speaks while the
 * database is down.
 */
function slackForEnv(supabase: SupabaseClient) {
  return (orgId: string) => getSlackConnection(supabase, orgId)
}

/** Whether Salesforce's bulkhead has room, asked of the limiter itself and failing closed. */
async function bulkheadBusy(env: Env): Promise<UnreadReason | null> {
  if (!env.SALESFORCE_BULKHEAD) return null
  const asked = await raceDeadline(() => new BulkheadClient(env, 'salesforce', salesforceBulkheadLimit(env)).status(), 2_000)
  if (asked.kind !== 'ok') {
    console.error(`[${SF_READ_BACK_JOB}] the Salesforce bulkhead could not be asked, so nothing is sent this minute: ${asked.kind === 'threw' ? formatErr(asked.error) : 'no answer'}`)
    return 'bulkhead_unknown'
  }
  return asked.value.inflight >= asked.value.limit ? 'bulkhead_busy' : null
}

export async function runSalesforceReadBackForEnv(supabase: SupabaseClient, env: Env): Promise<ReadBackSummary> {
  const keys = secretKeys(env)
  return runSalesforceReadBack({
    kv: env.IDEMPOTENCY,
    keys,
    portFor: (orgId, workflowId) => salesforcePortFor(env, supabase, keys, orgId, workflowId, { waitMs: 0 }),
    busy: () => bulkheadBusy(env),
    // No claim object means no resend: the claim fails closed.
    resendClaims: env.ALERT_CLAIM
      ? makeSendClaims(env.ALERT_CLAIM)
      : { claim: () => Promise.resolve('unanswered' as const), release: () => Promise.resolve() },
    alertClaims: env.ALERT_CLAIM ? makeAlertClaims(env.ALERT_CLAIM) : undefined,
    slackFor: slackForEnv(supabase),
    workflowNames: async (ids) => {
      const { data, error } = await supabase.from('workflows').select('id, name').in('id', ids)
      if (error) throw new Error(error.message)
      return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((w) => [w.id, w.name]))
    },
    appUrl: env.APP_URL,
    recordRun: (startedAtMs, ending) => recordFinishedJobRun(supabase, SF_READ_BACK_JOB, startedAtMs, ending),
  })
}

export async function checkSalesforceReadBackLivenessForEnv(supabase: SupabaseClient, env: Env): Promise<LivenessResult> {
  return checkSalesforceReadBackLiveness({
    kv: env.IDEMPOTENCY,
    keys: secretKeys(env),
    slackFor: slackForEnv(supabase),
    alertClaims: env.ALERT_CLAIM ? makeAlertClaims(env.ALERT_CLAIM) : undefined,
    appUrl: env.APP_URL,
  })
}
