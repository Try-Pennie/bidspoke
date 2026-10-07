/**
 * The time budget for the database reads a lead waits on (#1844).
 *
 * In a database outage supabase-js retries a failed read three times, waiting
 * 1, 2 and 4 seconds, so each read took about 7 s before any fallback, longer
 * than the buyer steps' own budgets (800 ms to 5 s): those steps failed before
 * they ever reached their last-good copy. Dan decided on 2026-10-07 to fall back
 * fast instead.
 *
 * So a read that HAS a last-good copy is run through leadRead on a lead's own
 * client: no library retries, a deadline, and any failure answered at once so
 * the caller takes its copy. After the first failure in a lead, every later
 * leadRead in that lead answers at once without asking the database, so an
 * outage costs a lead one deadline, not one per read.
 *
 * Writes are never given a deadline here: a write that timed out may still
 * have landed, and nothing here could tell. A write the lead waits on bounds
 * itself, and one that did not answer in time says so through
 * noteLeadWriteUnanswered, which trips the lead exactly as a failed read does
 * (#1849); leadDatabaseDown then lets a write with its own repair skip a
 * database the lead has already seen fail. A read with no copy to fall back on
 * is not routed through leadRead, because a deadline would turn a slow healthy
 * read into a failed lead. It does lose the library's retries: the lead's client
 * is built with them off, as plan A1 says for every read a lead waits on, so in
 * an outage such a read fails after one attempt instead of after 7 s of
 * retrying. Scheduled jobs and the signed-in app use plain clients, on which
 * leadRead runs the read exactly as before.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import type { Database } from '../types/database'
import { createSupabaseClient } from './supabase'

/**
 * Above healthy read times. Measured 2026-10-07 from Supabase edge logs over 24
 * hours of lead path reads: 1 in 100 under 670 ms on every table, 1 in 1,000
 * under 1,056 ms. A read past it takes its copy, which on a healthy day is at
 * most minutes old.
 */
export const LEAD_READ_DEADLINE_MS = 1_000

/** The code a read answered without asking the database carries. */
export const LEAD_DB_DOWN_CODE = 'BIDSPOKE_LEAD_DB_DOWN'

interface LeadState {
  deadline: (ms: number) => AbortSignal
  /** The first call that failed, and how: an HTTP status, no answer at all, or a write that ran out of time. */
  failed: { what: string; how: string } | null
}

const leads = new WeakMap<object, LeadState>()

export interface LeadClientOptions {
  /** The network beneath the client; tests only. */
  fetch?: typeof fetch
  /** Makes the abort signal for a deadline; tests pass one they fire by hand. */
  deadline?: (ms: number) => AbortSignal
}

/** A database client for one lead. Make one per request and pass it down. */
export function createLeadSupabaseClient(env: Env, options: LeadClientOptions = {}): SupabaseClient<Database> {
  const client = createSupabaseClient(env, { fetch: options.fetch, retry: false })
  leads.set(client, { deadline: options.deadline ?? ((ms) => AbortSignal.timeout(ms)), failed: null })
  return client
}

// `.single()` and `.maybeSingle()` are typed as the base builder, which does not
// declare abortSignal although the object still carries it; checked at run time.
interface ReadQuery<R> extends PromiseLike<R> {
  abortSignal?: (signal: AbortSignal) => unknown
  retry(enabled: boolean): unknown
}

interface ReadResult {
  error: { message: string } | null
  status: number
}

/**
 * Say that a write this lead waited on did not answer in time (#1849), so the
 * lead's later leadReads answer at once and take their copies, as after a failed
 * read. The write is not touched: it may still land, and nothing undoes it.
 * Without this, a hung database cost a lead the write's deadline and then each
 * later read's deadline in turn. Changes nothing on a client that is not a lead's.
 */
export function noteLeadWriteUnanswered(client: object, what: string): void {
  const lead = leads.get(client)
  if (!lead || lead.failed) return
  lead.failed = { what, how: 'did not answer in time' }
  console.warn(JSON.stringify({ event: 'lead_db_write_unanswered', what }))
}

/**
 * Why this lead already knows its database is not answering (an earlier read
 * failed, or a write did not answer), or null (#1849). A write the lead waits on
 * that has its own repair (the buyer_sales drain, the next click re-recording a
 * held claim) checks it and is not sent, rather than waiting out a deadline on
 * a database the lead has already seen fail. Null on any other client.
 */
export function leadDatabaseDown(client: object): string | null {
  const failed = leads.get(client)?.failed
  return failed ? `an earlier database call in this lead failed (${failed.what}, ${failed.how})` : null
}

/**
 * Run a read that has a last-good copy. `what` names it in the log line a
 * failure writes. `deadlineMs` lets a caller inside a tighter budget ask for
 * less than LEAD_READ_DEADLINE_MS.
 */
export async function leadRead<R extends ReadResult>(client: object, query: ReadQuery<R>, what: string, options: { deadlineMs?: number } = {}): Promise<R> {
  const lead = leads.get(client)
  if (!lead) return await query

  if (lead.failed) {
    return {
      data: null,
      error: {
        code: LEAD_DB_DOWN_CODE,
        message: `Not asked: an earlier database call in this lead failed (${lead.failed.what}, ${lead.failed.how})`,
        details: '',
        hint: '',
      },
      count: null,
      status: 0,
      statusText: '',
    } as unknown as R
  }

  if (typeof query.abortSignal !== 'function') {
    // Without it the deadline cannot be attached, and the read would be unbounded.
    throw new Error(`leadRead(${what}): the query carries no abortSignal, so it cannot be given a deadline`)
  }
  query.retry(false)
  query.abortSignal(lead.deadline(options.deadlineMs ?? LEAD_READ_DEADLINE_MS))
  const result = await query
  if (result.error && (result.status === 0 || result.status >= 500)) {
    // A request that never got a response carries status 0, which is no HTTP status.
    lead.failed = { what, how: result.status > 0 ? `status ${result.status}` : 'no answer' }
    console.warn(JSON.stringify({ event: 'lead_db_read_failed', what, status: result.status, message: result.error.message }))
  }
  return result
}
