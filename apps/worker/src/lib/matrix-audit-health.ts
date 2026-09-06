/**
 * The hourly Salesforce matrix audit, reporting its own failure (#982).
 *
 * `runMatrixAudit` watches `BidRangeRow__c` for edits and pages when it finds
 * one. It threw on every hourly run from at least May to 2026-09-04, because it
 * read the Salesforce credentials from a store that never held two of them
 * (#1174), and the only trace was a console line nobody was reading. For four
 * months a quiet audit and a quiet matrix looked identical, and the guard that
 * exists to catch a mid-day price edit was catching nothing.
 *
 * A job whose purpose is to notice something cannot be allowed to fail quietly
 * (L13). This wraps it: a throw becomes an alert carrying the audit's own
 * error, a query that returns no rows is a failure rather than an unchanged
 * matrix (the audit skips its snapshot write on zero rows, so that state would
 * otherwise read as "no change" for as long as it lasted, L98), and a clean
 * run reports itself so a standing alert can clear. It never throws: its caller
 * is a `waitUntil` where a rejection reaches only the console (L71).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { runMatrixAudit, type AuditResult } from './sf-matrix-audit'
import type { Env } from '../index'

export const MATRIX_AUDIT_JOB = 'sf-matrix-audit'

/**
 * In the vocabulary of the place the reader acts (L399). The shared alerter's
 * defaults are about exported rows and Snowflake; this job has neither.
 */
export const MATRIX_AUDIT_REMEDY: AlertRemedy = {
  consequence:
    'The hourly audit of the Salesforce bid matrix did not complete, so an edit to the matrix would go ' +
    'unreported until it succeeds again. Bidding itself is unaffected: prices are read from Salesforce, and this ' +
    'job only watches them for changes. It retries every hour on its own:',
  fixHint:
    'Read the line above. A credentials message means the Salesforce values in Settings, Environment (or the ' +
    'Worker secrets); a Salesforce query failure names the status Salesforce returned, so check its API access ' +
    'and the BidRangeRow__c fields; zero rows means Salesforce answered the query with nothing, and the snapshot ' +
    'was left as it was. The alert clears itself on the next successful hourly run.',
}

export interface WatchedAuditResult {
  ok: boolean
  result: AuditResult | null
  /** The failure as alerted, or null on a clean run. */
  error: string | null
}

export interface WatchedAuditDeps {
  /** The audit itself. Injected so its outcomes can be driven in tests (L196). */
  run?: (env: Env, supabase: SupabaseClient) => Promise<AuditResult>
}

/**
 * Send the alert, and never let the alerter's own failure become the result.
 * AN EMPTY LIST IS STILL SENT: `notifyExportFailure` reads no errors as the
 * recovery signal and clears its alert state with it.
 */
async function alertQuietly(supabase: SupabaseClient, env: Env, messages: string[]): Promise<void> {
  try {
    await notifyExportFailure(supabase, MATRIX_AUDIT_JOB, messages, env.IDEMPOTENCY, MATRIX_AUDIT_REMEDY)
  } catch (err) {
    console.error('[sf-matrix-audit] could not send its alert:', formatErr(err))
  }
}

export async function runMatrixAuditWatched(
  env: Env,
  supabase: SupabaseClient,
  deps: WatchedAuditDeps = {},
): Promise<WatchedAuditResult> {
  const run = deps.run ?? runMatrixAudit
  let result: AuditResult
  try {
    result = await run(env, supabase)
  } catch (err) {
    const detail = `the bid matrix audit failed: ${formatErr(err)}`
    console.error(`[sf-matrix-audit] ${detail}`)
    await alertQuietly(supabase, env, [detail])
    return { ok: false, result: null, error: detail }
  }

  if (result.rows_fetched === 0) {
    const detail =
      'the bid matrix audit fetched no BidRangeRow__c rows from Salesforce, so nothing was compared and the ' +
      'snapshot was not advanced; the matrix has held about 1,390 rows, so an empty answer is a failed read, not an empty matrix'
    console.error(`[sf-matrix-audit] ${detail}`)
    await alertQuietly(supabase, env, [detail])
    return { ok: false, result, error: detail }
  }

  await alertQuietly(supabase, env, [])
  return { ok: true, result, error: null }
}
