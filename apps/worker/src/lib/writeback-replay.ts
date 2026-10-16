/**
 * Replays a held Salesforce write by hand (#471).
 *
 * A post-answer Salesforce write that failed is kept, encrypted, in
 * `outcome_writeback_deadletters` (#1993). This is the manual escape hatch for
 * it: preview the exact fields beside what Salesforce holds now, send the patch
 * once, and record how it ended. A person can also close a row they dealt with
 * in Salesforce themselves. The automatic drain (#468, writeback-drain.ts) sends
 * through drainHeldWrite below, on the same claim and the same record of how a
 * send ended, so there is one send path for a stored write.
 *
 * THE BODY IS SENT AS LITERAL JSON. It was resolved once, in the run, and holds
 * the lead's own values. Passing it through the node's template resolution again
 * would let a value like `{{env.SALESFORCE_CLIENT_SECRET}}` typed into a form
 * reach a secret, so the replay never builds a node; it sends through the node's
 * single call path (bulkhead slot, own timeout) with the stored body as is.
 *
 * ONCE, under a race. A replay first claims the row with a compare and set on
 * `attempts`; a second replay of the same row in the same moment loses the
 * claim and sends nothing. The outcome is then written only while the row still
 * holds that claim.
 *
 * NEVER BESIDE THE READ-BACK (#468). A write the Salesforce read-back holds as
 * its own is that job's to resend, so a row for the same run and step is refused,
 * preview included, and one whose holder cannot be asked sends nothing.
 *
 * A changed field is the person's call (Dan, 2026-10-13): the preview shows each
 * field's current Salesforce value beside the one to be sent, and a confirmed
 * replay sends the whole patch as captured. The drain, which has nobody to ask,
 * leaves such a field out instead (drainHeldWrite).
 *
 * A call the Salesforce bulkhead refuses sent nothing, so it gives its attempt
 * back and the row stays as it was (`held`), for a person and the drain alike.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { decryptSecret, encryptSecret, type SecretKeyInput } from './secret-crypto'
import { formatErr } from './format-error'
import { requireRowsAffected, NO_ROW_MATCHED_CODE } from './db-retry'
import { fetchAllPaged } from './paginate'
import { loadEnvVars } from './env-loader'
import { buildSandboxEnv } from './sandbox-env'
import { salesforceBulkheads } from './bulkhead-client'
import { isSalesforceApiName, isSalesforceRecordId } from './salesforce-names'
import {
  getSalesforceToken,
  isSalesforceBulkheadShed,
  performSalesforceCall,
  salesforceRejectedTheWrite,
  salesforceTokenCacheKey,
} from '../engine/nodes/salesforce'
import { WRITE_MARKER_FIELD } from '../engine/write-marker'
import { fieldsMovedSince } from './salesforce-field-conflict'

/**
 * Every status a held write can carry: the CHECK on the table, and what each
 * action writes. The one list both the route's filter and the code read, so a
 * status added later is added here or nowhere.
 */
export const HELD_WRITE_STATUSES = ['pending', 'replayed', 'refused', 'abandoned'] as const
export type HeldWriteStatus = (typeof HELD_WRITE_STATUSES)[number]

export interface HeldWriteRow {
  id: string
  organization_id: string
  workflow_id: string
  execution_id: string
  step_namespace: string
  sf_object: string
  sf_record_id: string
  sf_operation: string
  body_encrypted: string
  error_encrypted: string
  error_type: string | null
  replayable: boolean
  status: string
  attempts: number
  last_error_encrypted: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

/** What a list shows: every column but the encrypted ones, so it carries no lead data. */
export type HeldWriteSummary = Omit<HeldWriteRow, 'body_encrypted' | 'error_encrypted' | 'last_error_encrypted'>

const SUMMARY_COLUMNS =
  'id, organization_id, workflow_id, execution_id, step_namespace, sf_object, sf_record_id, sf_operation, ' +
  'error_type, replayable, status, attempts, created_at, updated_at, finished_at'

export interface HeldWriteStore {
  get(orgId: string, id: string): Promise<HeldWriteRow | null>
  /** Takes the row for one replay: true only when it was pending at exactly `attempts`. */
  claim(orgId: string, id: string, attempts: number): Promise<boolean>
  /** Writes an outcome only while the row is still pending at `attempts`. */
  finish(id: string, attempts: number, patch: Partial<HeldWriteRow>): Promise<boolean>
  list(orgId: string, status?: string): Promise<HeldWriteSummary[]>
}

export interface SalesforcePort {
  /** `path` is below `/services/data/v60.0`. Throws when no answer came back. */
  send(method: 'GET' | 'PATCH', path: string, body?: string): Promise<{ status: number; text: string }>
  /**
   * A POST to an Apex REST endpoint, `path` below the instance (`/services/apexrest/...`),
   * through the same call path. The read-back's one resend of a credit inquiry
   * post (#2172). Throws when no answer came back.
   */
  postApex(path: string, body: string): Promise<{ status: number; text: string }>
}

/** An Apex REST path a port may post to: plain path segments under /services/apexrest/. */
const APEX_PATH = /^\/services\/apexrest(?:\/[A-Za-z0-9_-]+)+$/

export interface ReplayDeps {
  store: HeldWriteStore
  /** Built lazily: loading the credentials can fail, and a preview still shows the fields then. */
  salesforce: () => Promise<SalesforcePort>
  keys: SecretKeyInput
  /**
   * Whether the Salesforce read-back (#2023) holds this run's step as its own
   * (readBackHoldsStep): then it is that write's one sender and the row is
   * refused (#468). Throws when it cannot be asked, and nothing is sent.
   */
  readBackHolds: (executionId: string, stepNamespace: string) => Promise<boolean>
  /** The clock an outcome is stamped with. */
  now?: () => number
}

/**
 * Why a row the store holds must not be sent while the read-back holds the same
 * write, or null when it may be (#468). The capture never stores a write the
 * read-back owns, so a refusal here means a row from before that rule or a rule
 * broken since: either way the read-back resends it, and a replay beside it
 * would send it twice. A read-back that cannot be asked refuses too.
 */
async function heldByReadBack(deps: ReplayDeps, row: HeldWriteRow): Promise<{ kind: 'not_replayable'; reason: string } | { kind: 'unreadable'; error: string } | null> {
  try {
    if (!(await deps.readBackHolds(row.execution_id, row.step_namespace))) return null
  } catch (e) {
    return { kind: 'unreadable', error: `could not tell whether the Salesforce read-back holds this write, so nothing was sent: ${formatErr(e)}` }
  }
  return { kind: 'not_replayable', reason: 'the Salesforce read-back holds this write and resends it itself' }
}

export type PreviewResult =
  | { kind: 'not_found' }
  | { kind: 'not_replayable'; reason: string }
  | { kind: 'unreadable'; error: string }
  | {
      kind: 'preview'
      id: string
      execution_id: string
      step_namespace: string
      sf_object: string
      sf_record_id: string
      status: string
      attempts: number
      fields: Array<{ field: string; send: unknown; current: unknown; differs: boolean | null }>
      /** Why the current values are missing, when Salesforce could not be read. */
      current_unreadable?: string
    }

export type ReplayResult =
  | { kind: 'not_found' }
  | { kind: 'not_replayable'; reason: string }
  | { kind: 'unreadable'; error: string }
  | { kind: 'no_salesforce'; error: string }
  | { kind: 'conflict' }
  | { kind: 'replayed'; recorded: boolean }
  | { kind: 'refused'; error: string; recorded: boolean }
  | { kind: 'still_pending'; error: string; recorded: boolean }
  /** The bulkhead refused the call before anything was sent: the attempt is given back. */
  | { kind: 'held'; error: string; recorded: boolean }

/** How the drain of stored writes (#468 step 3) sends one row. */
export interface DrainOptions {
  /** The last attempt allowed: a failure on it closes the row as abandoned. */
  maxAttempts: number
  /** Bodies sent to the same record earlier this tick: their values are ours, and this newer write replaces them. */
  earlier?: Array<Record<string, unknown>>
}

export type DrainResult =
  | { kind: 'not_found' }
  | { kind: 'not_replayable'; reason: string }
  | { kind: 'unreadable'; error: string }
  | { kind: 'no_salesforce'; error: string }
  | { kind: 'conflict' }
  | { kind: 'held'; error: string; recorded: boolean }
  /** The read before sending got no answer: nothing was spent. */
  | { kind: 'read_unanswered'; error: string }
  /** The read before sending was answered with a failure that is not a refusal (5xx, 401, 403, 429): nothing was spent. */
  | { kind: 'read_failed'; error: string }
  /** Sent and landed. `moved` are the fields left out because another writer changed them; `sent` is what was sent. */
  | { kind: 'replayed'; recorded: boolean; moved: string[]; sent: Record<string, unknown> }
  /** Every field had moved, so nothing was sent and the row was closed as abandoned. */
  | { kind: 'all_moved'; moved: string[]; recorded: boolean }
  /** Salesforce rejected the write, or refused to read its record (then `resent` is false). */
  | { kind: 'refused'; error: string; recorded: boolean; resent: boolean }
  /** Failed with attempts left. `answered` is false when Salesforce never answered, so it may have landed. */
  | { kind: 'still_pending'; error: string; recorded: boolean; answered: boolean }
  /** Failed on its last attempt, and closed. */
  | { kind: 'abandoned'; error: string; recorded: boolean; answered: boolean }

export type AbandonResult =
  | { kind: 'not_found' }
  | { kind: 'not_pending'; status: string }
  | { kind: 'replay_in_flight' }
  | { kind: 'conflict' }
  | { kind: 'abandoned' }

/**
 * How long a replay's claim holds the row against an abandon: longer than any
 * replay can run (the bulkhead wait, the 15 s call timeout, a fresh login and one
 * resend), so an abandon never closes a row whose write may still be landing.
 */
export const REPLAY_LEASE_MS = 2 * 60 * 1000

/** Salesforce names: the one rule (salesforce-names.ts), re-exported for the read-back (#2023), which builds the same URLs. */
export { isSalesforceApiName, isSalesforceRecordId }

function whyNotReplayable(row: HeldWriteRow): string | null {
  if (row.status !== 'pending') return `the write is already ${row.status}`
  if (!row.replayable) return 'the write failed for good, so Salesforce would refuse it again'
  if (row.sf_operation !== 'update') return `a ${row.sf_operation} cannot be replayed, only an update`
  if (!isSalesforceApiName(row.sf_object)) return 'the stored object name is not a Salesforce API name'
  if (!isSalesforceRecordId(row.sf_record_id)) return 'the stored record id is not a Salesforce record id'
  return null
}

async function readBody(row: HeldWriteRow, keys: SecretKeyInput): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await decryptSecret(row.body_encrypted, keys))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the stored body is not an object')
  const body = parsed as Record<string, unknown>
  const bad = Object.keys(body).find((f) => !isSalesforceApiName(f))
  if (bad !== undefined) throw new Error(`the stored body names a field that is not a Salesforce API name: ${bad}`)
  return body
}

const recordPath = (row: HeldWriteRow) => `/sobjects/${row.sf_object}/${row.sf_record_id}`

export async function previewReplay(deps: ReplayDeps, orgId: string, id: string): Promise<PreviewResult> {
  const row = await deps.store.get(orgId, id)
  if (!row) return { kind: 'not_found' }
  const why = whyNotReplayable(row)
  if (why) return { kind: 'not_replayable', reason: why }
  const readBack = await heldByReadBack(deps, row)
  if (readBack) return readBack
  let body: Record<string, unknown>
  try {
    body = await readBody(row, deps.keys)
  } catch (e) {
    return { kind: 'unreadable', error: formatErr(e) }
  }
  const names = Object.keys(body)
  let current: Record<string, unknown> | null = null
  let unreadable: string | undefined
  try {
    const sf = await deps.salesforce()
    const res = await sf.send('GET', `${recordPath(row)}?fields=${names.join(',')}`)
    if (res.status < 200 || res.status >= 300) throw new Error(`Salesforce answered ${res.status}: ${res.text.slice(0, 300)}`)
    current = JSON.parse(res.text) as Record<string, unknown>
  } catch (e) {
    unreadable = formatErr(e)
  }
  return {
    kind: 'preview',
    id: row.id,
    execution_id: row.execution_id,
    step_namespace: row.step_namespace,
    sf_object: row.sf_object,
    sf_record_id: row.sf_record_id,
    status: row.status,
    attempts: row.attempts,
    fields: names.map((field) => ({
      field,
      send: body[field],
      current: current ? current[field] : undefined,
      differs: current ? JSON.stringify(current[field] ?? null) !== JSON.stringify(body[field] ?? null) : null,
    })),
    ...(unreadable !== undefined ? { current_unreadable: unreadable } : {}),
  }
}

type Prepared = { row: HeldWriteRow; readAttempts: number; body: Record<string, unknown>; sf: SalesforcePort }
type NotPrepared = Extract<ReplayResult, { kind: 'not_found' | 'not_replayable' | 'unreadable' | 'no_salesforce' }>

/**
 * Everything that can fail before sending, BEFORE any claim, so a key or
 * credential fault costs no attempt and leaves the row as it was. The read-back
 * is asked first: a write it holds is its own to send (#468).
 */
async function prepare(deps: ReplayDeps, orgId: string, id: string): Promise<Prepared | NotPrepared> {
  const row = await deps.store.get(orgId, id)
  if (!row) return { kind: 'not_found' }
  // The count as READ, held apart from the row object, which a store may share.
  const readAttempts = row.attempts
  const why = whyNotReplayable(row)
  if (why) return { kind: 'not_replayable', reason: why }
  const readBack = await heldByReadBack(deps, row)
  if (readBack) return readBack
  let body: Record<string, unknown>
  try {
    body = await readBody(row, deps.keys)
  } catch (e) {
    return { kind: 'unreadable', error: formatErr(e) }
  }
  let sf: SalesforcePort
  try {
    sf = await deps.salesforce()
  } catch (e) {
    return { kind: 'no_salesforce', error: formatErr(e) }
  }
  return { row, readAttempts, body, sf }
}

/** Writes and locks for one row: every outcome a send records goes through these. */
function recorderFor(deps: ReplayDeps, id: string) {
  const now = () => new Date(deps.now?.() ?? Date.now()).toISOString()
  // Once the patch is sent, nothing may throw over what Salesforce answered: a
  // database fault while recording the outcome is reported as not recorded,
  // never as a failed replay, since the write may well have landed.
  const record = async (attempts: number, patch: Partial<HeldWriteRow>): Promise<boolean> => {
    try {
      const done = await deps.store.finish(id, attempts, patch)
      if (!done) console.error(`[writeback-replay] the outcome of held write ${id} was not recorded: the row changed meanwhile`)
      return done
    } catch (e) {
      console.error(`[writeback-replay] the outcome of held write ${id} could not be recorded:`, formatErr(e))
      return false
    }
  }
  // The error is kept locked; if it cannot be locked it is left out of the update,
  // so the previous error stays rather than being wiped, and nothing is stored in the clear.
  const withError = (locked: string | null): Partial<HeldWriteRow> => (locked === null ? {} : { last_error_encrypted: locked })
  const lock = (text: string): Promise<string | null> =>
    encryptSecret(text, deps.keys).catch((e) => {
      console.error(`[writeback-replay] the error of held write ${id} could not be encrypted, so it is not stored:`, formatErr(e))
      return null
    })
  return { now, record, withError, lock }
}

type SendOutcome =
  | { kind: 'held'; error: string; recorded: boolean }
  | { kind: 'replayed'; recorded: boolean }
  | { kind: 'refused'; error: string; recorded: boolean }
  | { kind: 'still_pending' | 'abandoned'; error: string; recorded: boolean; answered: boolean }

/**
 * The one send of a claimed row, and the one record of how it ended. The
 * person's replay and the drain both end here, so the rules for an answer are
 * written once: a 2xx is replayed, only salesforceRejectedTheWrite closes the
 * row as refused, a bulkhead refusal gives the attempt back, and anything else
 * stays pending, or closes as abandoned when this was the last attempt allowed.
 */
async function sendClaimed(
  deps: ReplayDeps,
  row: HeldWriteRow,
  readAttempts: number,
  sf: SalesforcePort,
  body: Record<string, unknown>,
  opts: { lastAttempt: boolean; note?: string },
): Promise<SendOutcome> {
  const claimed = readAttempts + 1
  const { now, record, withError, lock } = recorderFor(deps, row.id)
  const failed = async (error: string, answered: boolean): Promise<SendOutcome> => {
    const locked = await lock(error)
    if (!opts.lastAttempt) return { kind: 'still_pending', error, answered, recorded: await record(claimed, { ...withError(locked), updated_at: now() }) }
    const at = now()
    return { kind: 'abandoned', error, answered, recorded: await record(claimed, { status: 'abandoned', ...withError(locked), finished_at: at, updated_at: at }) }
  }

  let answer: { status: number; text: string }
  try {
    answer = await sf.send('PATCH', recordPath(row), JSON.stringify(body))
  } catch (e) {
    const error = formatErr(e)
    // Refused by the bulkhead before anything left: nothing can have landed, so
    // the attempt is given back and the row is held as it was (#468).
    if (isSalesforceBulkheadShed(e)) return { kind: 'held', error, recorded: await record(claimed, { attempts: readAttempts }) }
    // No answer is not a refusal: the write may be resent, and may have landed.
    return failed(error, false)
  }
  if (answer.status >= 200 && answer.status < 300) {
    const at = now()
    const note = opts.note === undefined ? {} : withError(await lock(opts.note))
    return { kind: 'replayed', recorded: await record(claimed, { status: 'replayed', ...note, finished_at: at, updated_at: at }) }
  }
  const error = `Salesforce API error (${answer.status}): ${answer.text}`
  // Only a rejection of the write itself closes the row as refused. A transient
  // failure, or a login or permission refusal (a fault on our side), does not.
  if (!salesforceRejectedTheWrite(answer.status, answer.text)) return failed(error, true)
  const at = now()
  const recorded = await record(claimed, { status: 'refused', replayable: false, ...withError(await lock(error)), finished_at: at, updated_at: at })
  return { kind: 'refused', error, recorded }
}

export async function replayHeldWrite(deps: ReplayDeps, orgId: string, id: string): Promise<ReplayResult> {
  const p = await prepare(deps, orgId, id)
  if (!('row' in p)) return p
  if (!(await deps.store.claim(orgId, id, p.readAttempts))) return { kind: 'conflict' }
  // A person's replay sends the whole patch as captured (Dan, 2026-10-13) and
  // never closes a row as abandoned: that is the person's own call.
  const out = await sendClaimed(deps, p.row, p.readAttempts, p.sf, p.body, { lastAttempt: false })
  switch (out.kind) {
    case 'replayed':
      return { kind: 'replayed', recorded: out.recorded }
    case 'refused':
    case 'held':
      return { kind: out.kind, error: out.error, recorded: out.recorded }
    case 'still_pending':
    case 'abandoned':
      return { kind: 'still_pending', error: out.error, recorded: out.recorded }
  }
}

/**
 * The drain's send of one stored write (#468 step 3). The person's replay with
 * the person's decisions made by rule:
 *  - the record is read first (LastModifiedDate and every field), and a field
 *    another writer moved since the row was written is left out and returned by
 *    name, through the read-back's one rule (salesforce-field-conflict.ts). The
 *    row's creation is when the write began for this rule: the failed attempts
 *    were all answered before it, so a change after it is another writer's;
 *  - a read with no usable answer spends nothing; a read Salesforce refuses
 *    (the record is gone, a field it does not know) closes the row as refused,
 *    since the write would be refused too;
 *  - every field moved: nothing is sent, and the row is closed as abandoned;
 *  - a failure on the last attempt allowed closes the row as abandoned.
 */
export async function drainHeldWrite(deps: ReplayDeps, orgId: string, id: string, opts: DrainOptions): Promise<DrainResult> {
  const p = await prepare(deps, orgId, id)
  if (!('row' in p)) return p
  const { row, readAttempts, body, sf } = p
  if (readAttempts >= opts.maxAttempts) return { kind: 'not_replayable', reason: 'its attempts are spent' }
  const { now, record, withError, lock } = recorderFor(deps, id)
  const names = Object.keys(body)

  let read: { status: number; text: string }
  try {
    read = await sf.send('GET', `${recordPath(row)}?fields=${['LastModifiedDate', ...names].join(',')}`)
  } catch (e) {
    // A read the full bulkhead refused never left: a hold, not Salesforce silent.
    // Nothing is claimed yet, so there is nothing to give back.
    if (isSalesforceBulkheadShed(e)) return { kind: 'held', error: formatErr(e), recorded: true }
    return { kind: 'read_unanswered', error: formatErr(e) }
  }
  if (read.status < 200 || read.status >= 300) {
    const error = `Salesforce API error (${read.status}) reading the record: ${read.text}`
    if (!salesforceRejectedTheWrite(read.status, read.text)) return { kind: 'read_failed', error }
    const at = now()
    const recorded = await record(readAttempts, { status: 'refused', replayable: false, ...withError(await lock(error)), finished_at: at, updated_at: at })
    return { kind: 'refused', error, recorded, resent: false }
  }
  let current: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(read.text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    current = parsed as Record<string, unknown>
  } catch (e) {
    return { kind: 'read_failed', error: `the record read back was not readable: ${formatErr(e)}` }
  }

  const fields = names.filter((f) => f !== WRITE_MARKER_FIELD)
  const moved = fieldsMovedSince({ fields, body, current, sinceMs: Date.parse(row.created_at), earlier: opts.earlier ?? [] })
  const note = moved.length > 0 ? `Sent without the fields changed in Salesforce since the write failed: ${moved.join(', ')}` : undefined
  if (moved.length > 0 && moved.length === fields.length) {
    const at = now()
    const recorded = await record(readAttempts, { status: 'abandoned', ...withError(await lock(`Not sent: every field had changed in Salesforce since the write failed: ${moved.join(', ')}`)), finished_at: at, updated_at: at })
    return { kind: 'all_moved', moved, recorded }
  }
  const sent = Object.fromEntries(names.filter((f) => !moved.includes(f)).map((f) => [f, body[f]]))

  if (!(await deps.store.claim(orgId, id, readAttempts))) return { kind: 'conflict' }
  const out = await sendClaimed(deps, row, readAttempts, sf, sent, { lastAttempt: readAttempts + 1 >= opts.maxAttempts, note })
  switch (out.kind) {
    case 'replayed':
      return { kind: 'replayed', recorded: out.recorded, moved, sent }
    case 'refused':
      return { ...out, resent: true }
    default:
      return out
  }
}

export async function abandonHeldWrite(store: HeldWriteStore, orgId: string, id: string, nowMs: number = Date.now()): Promise<AbandonResult> {
  const row = await store.get(orgId, id)
  if (!row) return { kind: 'not_found' }
  if (row.status !== 'pending') return { kind: 'not_pending', status: row.status }
  // A claim moves updated_at, so a row a replay touched inside the lease may be
  // mid send. A row never replayed (attempts 0) has no replay to wait for.
  if (row.attempts > 0 && nowMs - Date.parse(row.updated_at) < REPLAY_LEASE_MS) return { kind: 'replay_in_flight' }
  const readAttempts = row.attempts
  const at = new Date().toISOString()
  return (await store.finish(id, readAttempts, { status: 'abandoned', finished_at: at, updated_at: at }))
    ? { kind: 'abandoned' }
    : { kind: 'conflict' }
}

// ------------------------------------------------------------------
// The real store and the real Salesforce
// ------------------------------------------------------------------

export function supabaseHeldWriteStore(supabase: SupabaseClient): HeldWriteStore {
  // A missed compare and set is the expected answer to a lost race, so it reads
  // as false; a real database error throws rather than reading as a lost claim.
  const changedOne = (label: string, result: Awaited<ReturnType<typeof requireRowsAffected<{ id: string }>>>) => {
    if (result.error && result.error.code !== NO_ROW_MATCHED_CODE) throw new Error(`${label} failed: ${result.error.message}`)
    return result.rows.length === 1
  }
  return {
    async get(orgId, id) {
      const { data, error } = await supabase
        .from('outcome_writeback_deadletters')
        .select('*')
        .eq('organization_id', orgId)
        .eq('id', id)
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(`reading the held write failed: ${error.message}`)
      return (data as HeldWriteRow | null) ?? null
    },
    async claim(orgId, id, attempts) {
      const label = 'outcome_writeback_deadletters claim'
      return changedOne(
        label,
        await requireRowsAffected<{ id: string }>(
          label,
          () =>
            supabase
              .from('outcome_writeback_deadletters')
              .update({ attempts: attempts + 1, updated_at: new Date().toISOString() })
              .eq('organization_id', orgId)
              .eq('id', id)
              .eq('status', 'pending')
              .eq('attempts', attempts)
              .select('id'),
          { onMiss: 'silent' },
        ),
      )
    },
    async finish(id, attempts, patch) {
      const label = 'outcome_writeback_deadletters outcome'
      return changedOne(
        label,
        await requireRowsAffected<{ id: string }>(
          label,
          () =>
            supabase
              .from('outcome_writeback_deadletters')
              .update(patch)
              .eq('id', id)
              .eq('status', 'pending')
              .eq('attempts', attempts)
              .select('id'),
          { onMiss: 'silent' },
        ),
      )
    },
    async list(orgId, status) {
      return fetchAllPaged<HeldWriteSummary>(
        (from, to) =>
          (status
            ? supabase.from('outcome_writeback_deadletters').select(SUMMARY_COLUMNS).eq('organization_id', orgId).eq('status', status)
            : supabase.from('outcome_writeback_deadletters').select(SUMMARY_COLUMNS).eq('organization_id', orgId)
          )
            .order('created_at', { ascending: false })
            .order('id')
            .range(from, to),
        'listing held Salesforce writes',
        { maxPages: 50 },
      )
    },
  }
}

/**
 * Salesforce as the run that wrote the row saw it: the credentials come from the
 * same env the engine loads for that workflow, and every call goes through the
 * node's one call path, so the bulkhead and the timeout hold here too.
 */
export async function salesforcePortFor(
  env: Env,
  supabase: SupabaseClient,
  keys: SecretKeyInput,
  orgId: string,
  workflowId: string,
  /**
   * How long a call waits for a bulkhead slot. The Salesforce read-back (#2023)
   * passes 0: a minute job waits for nobody, and a full bulkhead is a reason not
   * to send at all.
   */
  opts: { waitMs?: number } = {},
): Promise<SalesforcePort> {
  const vars = buildSandboxEnv(env, await loadEnvVars(orgId, env.WORKFLOW_CACHE, supabase, keys, { workflowId }))
  const instanceUrl = (vars.SALESFORCE_INSTANCE_URL ?? '').replace(/\/$/, '')
  const clientId = vars.SALESFORCE_CLIENT_ID ?? ''
  const clientSecret = vars.SALESFORCE_CLIENT_SECRET ?? ''
  if (!instanceUrl || !clientId || !clientSecret) {
    throw new Error('SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET must all be set for this workflow')
  }
  // A replay, and the read-back that shares this port (#2023), run on their own
  // schedule, outside any run's post-answer window, so they take the main bulkhead
  // as they always have, not the post-answer share (#2170). The read-back's one
  // resend of a credit inquiry post (#2172) goes the same way.
  const { gates: bulkheads, waitMs: defaultWaitMs } = salesforceBulkheads(env, false)
  const waitMs = opts.waitMs ?? defaultWaitMs
  const call = async (method: 'GET' | 'PATCH' | 'POST', path: string, body: string | undefined) => {
    const tokenStart = Date.now()
    const token = await getSalesforceToken(env, orgId, instanceUrl, clientId, clientSecret)
    const apex = method === 'POST'
    const { res, responseText } = await performSalesforceCall(body, {
      url: apex ? `${instanceUrl}${path}` : `${instanceUrl}/services/data/v60.0${path}`,
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      bulkheads,
      waitMs,
      signal: undefined,
      resolvedInput: { template: {}, resolved: {} },
      traceId: 'writeback-replay',
      operation: apex ? 'apex' : method === 'GET' ? 'query' : 'update',
      targetLabel: path.split('?')[0],
      tokenMs: Date.now() - tokenStart,
    })
    return { status: res.status, text: responseText }
  }
  // A revoked cached token (#1741): Salesforce refused before running anything,
  // so one more send with a fresh login cannot write twice, an Apex post included.
  const withFreshLogin = async (send: () => Promise<{ status: number; text: string }>) => {
    const first = await send()
    if (first.status !== 401) return first
    await env.WORKFLOW_CACHE.delete(salesforceTokenCacheKey(orgId))
    return send()
  }
  return {
    send(method, path, body) {
      return withFreshLogin(() => call(method, path, body))
    },
    postApex(path, body) {
      if (!APEX_PATH.test(path)) return Promise.reject(new Error(`not an Apex REST path: ${path.slice(0, 80)}`))
      return withFreshLogin(() => call('POST', path, body))
    },
  }
}
