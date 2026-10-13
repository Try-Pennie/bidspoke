/**
 * Post-response writes that timed out, recorded so they can be read back
 * later (#1880).
 *
 * On 2026-10-08 the database stalled for about 90 seconds (12:20:00 to 12:21:30
 * UTC). Every write made after a run's answer outlasted the post-response
 * budget, and each was dead-lettered at once as "Outcome Record Lost ... not
 * saved and not auto-recovered". All of them had landed: every execution row,
 * 273 step rows and every lead sighting, finalized. The budget measures only
 * that nothing CONFIRMED the write in time (the request is never cancelled), so
 * reporting it as lost claimed what the check had not measured (L11).
 *
 * So a write that only timed out is recorded here as unconfirmed, naming the
 * record and the effect to read back, and the minute sweep
 * (lib/unconfirmed-write-sweep.ts) reads it back once any request still queued
 * in the database has had time to finish. A write that came back with an error
 * is not recorded here: it failed, and is dead-lettered at once as before.
 *
 * WHY KV. The moment an entry is written is the moment the database is not
 * answering, so the database cannot be where it goes. KV answers independently
 * of Postgres, and it is already where the dead letter keeps its durable count.
 * Its eventual consistency costs nothing here: the sweep reads an entry only
 * once it is READ_BACK_MIN_AGE_MS old, well past KV's propagation, and each
 * entry has its own key, written once, so deleting one can never remove another
 * written after the sweep listed.
 *
 * The money Worker is the only one running the engine, so every entry is read
 * back from the bidding database. The ops Worker binds no KV and runs no engine.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from '../lib/format-error'
import { isPermanentDbError, toDbError } from '../lib/db-retry'

export const UNCONFIRMED_WRITE_PREFIX = 'unconfirmed-write:'

/**
 * How long an entry lives. Every entry is read back within minutes, or alerted
 * on as unconfirmable at 15 minutes, so this is only the ceiling for one the
 * sweep never reached. A day also keeps every entry inside the life of the rows
 * it names: lead_sighting_bids drain about a day after they are written.
 */
export const UNCONFIRMED_WRITE_TTL_SECONDS = 24 * 60 * 60

/**
 * What to read back, and which effect proves the write landed. Every variant
 * names the table's partition column (workflow_executions on started_at,
 * lead_sightings on execution_started_at_utc, lead_sighting_bids on
 * attempted_at_utc), because an unbounded read of a partitioned table scans
 * every partition.
 */
export type ReadBack =
  /** The finalize UPDATE: the row exists and is no longer at 'running'. */
  | { kind: 'execution_finalized'; execution_id: string; started_at: string }
  /** The sighting INSERT: the row exists. */
  | { kind: 'sighting_present'; sighting_id: string; execution_started_at_utc: string }
  /** The sighting finalize UPDATE: outcome_state is 'finalized'. */
  | { kind: 'sighting_finalized'; sighting_id: string; execution_started_at_utc: string }
  /** A bid row INSERT, by its conflict key. */
  | { kind: 'bid_present'; execution_id: string; partner_slug: string; attempted_at_utc: string }
  /** A failed Salesforce write's replay row (#1993), by its unique key. */
  | { kind: 'writeback_deadletter_present'; execution_id: string; step_namespace: string; sf_object: string; sf_record_id: string; sf_operation: string }
  /** The winner mark: the partner's bid row in this run carries is_winner. */
  | { kind: 'bid_winner'; execution_id: string; partner_slug: string; attempted_from: string; attempted_to: string }
  /**
   * The run's step rows (#1881): at least `expected` of them. execution_steps is
   * partitioned on each step's own started_at, so the read is bounded by the
   * run's start and an hour after it. Tier 1: a miss is told in the slowdown
   * summary, never dead-lettered.
   */
  | {
      kind: 'steps_present'
      execution_id: string
      execution_started_at: string
      started_from: string
      started_to: string
      expected: number
    }

/** The run a write belonged to, for the alert and the slowdown summary. */
export interface UnconfirmedRun {
  workflow_id: string
  workflow_name: string
  execution_id: string
}

export interface UnconfirmedWrite {
  /** This entry's own id, unique per timed out write. */
  id: string
  /** The dead letter label the write would have carried, e.g. 'lead_sightings.finalize'. */
  label: string
  org_id: string
  /** When the budget gave up waiting, ISO. */
  first_seen_at: string
  read_back: ReadBack
  run?: UnconfirmedRun
  /** What the write reported when it was given up on. */
  error_message: string
  /** Set once the 15 minute "could not confirm" alert has named this entry. */
  could_not_confirm_alerted_at?: string
}

export interface UnconfirmedKv {
  put(key: string, value: string, opts?: { expiration?: number; expirationTtl?: number }): Promise<void>
}

/**
 * The key sorts by first seen time, so a KV list (lexicographic) returns the
 * oldest first and a bounded tick works through a backlog in order.
 */
export function unconfirmedWriteKey(entry: Pick<UnconfirmedWrite, 'first_seen_at' | 'id'>): string {
  return `${UNCONFIRMED_WRITE_PREFIX}${String(Date.parse(entry.first_seen_at)).padStart(15, '0')}:${entry.id}`
}

/** The first seen time a key carries, or NaN for a key not written by this module. */
export function firstSeenOfKey(key: string): number {
  const m = /^unconfirmed-write:(\d{15}):/.exec(key)
  return m ? Number(m[1]) : Number.NaN
}

/**
 * Writes (or rewrites) an entry. The expiry is absolute, from the first seen
 * time, so a rewrite (the could-not-confirm flag) never extends its life.
 * KV refuses an expiry less than 60 seconds ahead, hence the floor.
 */
export async function putUnconfirmedWrite(kv: UnconfirmedKv, entry: UnconfirmedWrite, nowMs: number = Date.now()): Promise<void> {
  const expiresAt = Math.floor(Date.parse(entry.first_seen_at) / 1000) + UNCONFIRMED_WRITE_TTL_SECONDS
  const expiration = Math.max(expiresAt, Math.floor(nowMs / 1000) + 60)
  await kv.put(unconfirmedWriteKey(entry), JSON.stringify(entry), { expiration })
}

/** Parses a stored entry; null for anything that is not one. */
export function parseUnconfirmedWrite(raw: string | null): UnconfirmedWrite | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<UnconfirmedWrite>
    if (typeof v.id !== 'string' || typeof v.label !== 'string' || typeof v.org_id !== 'string') return null
    if (typeof v.first_seen_at !== 'string' || !v.read_back || typeof v.read_back !== 'object') return null
    return v as UnconfirmedWrite
  } catch {
    return null
  }
}

export type ReadBackVerdict =
  | { verdict: 'landed' }
  /** The effect is not there. `row_absent` when the row itself is missing. */
  | { verdict: 'missing'; row_absent: boolean; detail: string }
  /**
   * The database did not give an answer. `permanent` when it refused this read
   * for good (a schema error), which says nothing about whether it would answer
   * the next one; otherwise it is not answering at all.
   */
  | { verdict: 'unreadable'; error: string; permanent?: boolean }

type Rows = { data: unknown; error: unknown }

function firstRow(res: Rows): Record<string, unknown> | null {
  const rows = Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : []
  return rows[0] ?? null
}

/**
 * Reads one entry's record back. Plain PostgREST reads, every one bounded by
 * the table's partition column. A read error is 'unreadable', never 'missing':
 * a database that cannot answer has not said the row is absent (L215).
 */
export async function readBack(supabase: SupabaseClient, check: ReadBack): Promise<ReadBackVerdict> {
  let res: Rows
  try {
    switch (check.kind) {
      case 'execution_finalized':
        res = await supabase
          .from('workflow_executions')
          .select('id,status')
          .eq('id', check.execution_id)
          .eq('started_at', check.started_at)
          .limit(1)
        break
      case 'sighting_present':
      case 'sighting_finalized':
        res = await supabase
          .from('lead_sightings')
          .select('id,outcome_state')
          .eq('id', check.sighting_id)
          .eq('execution_started_at_utc', check.execution_started_at_utc)
          .limit(1)
        break
      case 'bid_present':
        res = await supabase
          .from('lead_sighting_bids')
          .select('id')
          .eq('execution_id', check.execution_id)
          .eq('partner_slug', check.partner_slug)
          .eq('attempted_at_utc', check.attempted_at_utc)
          .limit(1)
        break
      case 'writeback_deadletter_present':
        res = await supabase
          .from('outcome_writeback_deadletters')
          .select('id')
          .eq('execution_id', check.execution_id)
          .eq('step_namespace', check.step_namespace)
          .eq('sf_object', check.sf_object)
          .eq('sf_record_id', check.sf_record_id)
          .eq('sf_operation', check.sf_operation)
          .limit(1)
        break
      case 'steps_present':
        res = await supabase
          .from('execution_steps')
          .select('id')
          .eq('execution_id', check.execution_id)
          .gte('started_at', check.started_from)
          .lt('started_at', check.started_to)
          .limit(check.expected)
        break
      case 'bid_winner':
        res = await supabase
          .from('lead_sighting_bids')
          .select('id')
          .eq('execution_id', check.execution_id)
          .eq('partner_slug', check.partner_slug)
          // A partner pinged twice in one run has two rows, and the mark sets both.
          .eq('is_winner', true)
          .gte('attempted_at_utc', check.attempted_from)
          .lt('attempted_at_utc', check.attempted_to)
          .limit(1)
        break
    }
  } catch (e) {
    return { verdict: 'unreadable', error: formatErr(e) }
  }
  if (res.error) return { verdict: 'unreadable', error: formatErr(res.error), permanent: isPermanentDbError(toDbError(res.error)) }
  const row = firstRow(res)
  switch (check.kind) {
    case 'steps_present': {
      const found = Array.isArray(res.data) ? res.data.length : 0
      return found >= check.expected
        ? { verdict: 'landed' }
        : { verdict: 'missing', row_absent: found === 0, detail: `${found} of ${check.expected} step rows` }
    }
    case 'execution_finalized':
      if (!row) return { verdict: 'missing', row_absent: true, detail: 'the execution row is not there' }
      if (row.status === 'running') return { verdict: 'missing', row_absent: false, detail: "the execution row is still at status 'running'" }
      return { verdict: 'landed' }
    case 'sighting_present':
      return row ? { verdict: 'landed' } : { verdict: 'missing', row_absent: true, detail: 'the lead sighting row is not there' }
    case 'sighting_finalized':
      if (!row) return { verdict: 'missing', row_absent: true, detail: 'the lead sighting row is not there' }
      if (row.outcome_state !== 'finalized') {
        return { verdict: 'missing', row_absent: false, detail: `the lead sighting is still at outcome_state '${String(row.outcome_state)}'` }
      }
      return { verdict: 'landed' }
    case 'bid_present':
      return row ? { verdict: 'landed' } : { verdict: 'missing', row_absent: true, detail: 'the bid row is not there' }
    case 'writeback_deadletter_present':
      return row ? { verdict: 'landed' } : { verdict: 'missing', row_absent: true, detail: 'the replay row for the failed Salesforce write is not there' }
    case 'bid_winner':
      return row ? { verdict: 'landed' } : { verdict: 'missing', row_absent: false, detail: "no bid row for this partner in this run is marked the winner" }
  }
}

// ============================================================
// The answer journal (#1883)
// ============================================================
// What a run answered is recorded by its finalize update, in the database alone.
// On 2026-10-08 five Engine runs answered HTTP 200 during a stall, their
// finalize updates never ran, and the strand drain could only label them
// unresolved: nothing anywhere said what Engine had been told. So the engine
// also journals the answer here, in the same KV store and for the same reason
// as the unconfirmed entries above (it is written exactly when the database may
// not be answering), and the strand drain restores a stranded run from it.
//
// One KV write per live run, about 86,000 a day measured on 2026-10-08. The
// response body is the same class of data the idempotency cache in this KV
// namespace already keeps per request, redacted here with the step rows' field
// list, and it expires in three days rather than the execution row's seven.

export const ANSWER_JOURNAL_PREFIX = 'answer-journal:'

/**
 * Three days: past the strand drain's 30 minute floor many times over, and past
 * a weekend, so a drain that was itself down for a while still finds it.
 */
export const ANSWER_JOURNAL_TTL_SECONDS = 3 * 24 * 60 * 60

export interface AnswerJournal {
  execution_id: string
  started_at: string
  status: string
  outcome: string | null
  final_node_namespace: string | null
  final_node_id: string | null
  completed_at: string
  duration_ms: number
  response_status: number
  /** Redacted with the same field list the step rows are (PII_REDACTION_FIELDS). */
  response_body: unknown
  error_message: string | null
  failed_step_type: string | null
  /**
   * The rest of what the finalize writes, so a restored run is complete: the
   * sighting projection the sighting drain finalizes a stranded sighting from,
   * and the run's cost and capture fields.
   */
  sighting_finalize?: unknown
  cost_usd?: number
  field_presence?: Record<string, boolean>
  email_dropped?: boolean
  written_at: string
}

/** The terminal statuses a finalize writes; anything else is not a journal to restore. */
const JOURNAL_STATUSES = new Set(['completed', 'failed', 'degraded'])

export async function putAnswerJournal(
  kv: { put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> },
  journal: AnswerJournal,
): Promise<void> {
  await kv.put(`${ANSWER_JOURNAL_PREFIX}${journal.execution_id}`, JSON.stringify(journal), { expirationTtl: ANSWER_JOURNAL_TTL_SECONDS })
}

/** The run's journal, or null when there is none or it is not one. Throws only when KV does. */
export async function readAnswerJournal(
  kv: { get(key: string): Promise<string | null> },
  executionId: string,
): Promise<AnswerJournal | null> {
  const raw = await kv.get(`${ANSWER_JOURNAL_PREFIX}${executionId}`)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<AnswerJournal>
    if (v.execution_id !== executionId || typeof v.status !== 'string' || !JOURNAL_STATUSES.has(v.status)) return null
    if (typeof v.completed_at !== 'string' || !Number.isFinite(Date.parse(v.completed_at))) return null
    if (typeof v.duration_ms !== 'number' || !Number.isFinite(v.duration_ms)) return null
    if (typeof v.response_status !== 'number' || !Number.isInteger(v.response_status)) return null
    // Everything the drain writes into the row is held to the row's own types.
    const textOrNull = (x: unknown) => x === null || x === undefined || typeof x === 'string'
    if (![v.outcome, v.final_node_namespace, v.final_node_id, v.error_message, v.failed_step_type].every(textOrNull)) return null
    if (v.cost_usd !== undefined && (typeof v.cost_usd !== 'number' || !Number.isFinite(v.cost_usd))) return null
    if (v.field_presence !== undefined && (typeof v.field_presence !== 'object' || v.field_presence === null || Array.isArray(v.field_presence))) return null
    if (v.email_dropped !== undefined && typeof v.email_dropped !== 'boolean') return null
    return v as AnswerJournal
  } catch {
    return null
  }
}
