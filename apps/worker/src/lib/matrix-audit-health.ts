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
import { MatrixAuditStepError, runMatrixAudit, type AuditResult, type MatrixAuditStep } from './sf-matrix-audit'
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

/**
 * The audit could not read its saved copy of the matrix from our own database
 * (#835). Before this it was told to check Salesforce.
 */
export const MATRIX_AUDIT_SNAPSHOT_READ_REMEDY: AlertRemedy = {
  consequence:
    'The hourly audit of the Salesforce bid matrix could not read its saved copy of the matrix from our ' +
    'Supabase database, so nothing was compared and an edit to the matrix would go unreported until it ' +
    'succeeds again. Bidding itself is unaffected. It retries every hour on its own:',
  fixHint:
    'This is our database, not Salesforce: read the error above for why the sf_bid_matrix_audit table could ' +
    'not be read. The alert clears itself on the next successful hourly run.',
}

/**
 * The audit compared the matrix and could not save what it saw (#835). Any edit
 * it found was already reported by then, since it reports before it saves, so
 * "an edit would go unreported" was false here.
 */
export const MATRIX_AUDIT_SNAPSHOT_WRITE_REMEDY: AlertRemedy = {
  consequence:
    'The hourly audit of the Salesforce bid matrix compared the matrix but could not save what it saw to our ' +
    'Supabase database. Any edit it found was reported before the save; the next run compares against the ' +
    'older copy, so it may report the same edit again. Bidding itself is unaffected:',
  fixHint:
    'This is our database, not Salesforce: read the error above for why the sf_bid_matrix_audit write failed. ' +
    'The alert clears itself on the next successful hourly run.',
}

const STEP_WORDING: Readonly<Record<MatrixAuditStep, { says: string; remedy: AlertRemedy }>> = {
  snapshot_read: { says: 'could not read its saved copy of the matrix from Supabase', remedy: MATRIX_AUDIT_SNAPSHOT_READ_REMEDY },
  snapshot_write: { says: 'could not save its copy of the matrix to Supabase', remedy: MATRIX_AUDIT_SNAPSHOT_WRITE_REMEDY },
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
async function alertQuietly(
  supabase: SupabaseClient,
  env: Env,
  messages: string[],
  remedy: AlertRemedy = MATRIX_AUDIT_REMEDY,
): Promise<void> {
  try {
    await notifyExportFailure(supabase, MATRIX_AUDIT_JOB, messages, env.IDEMPOTENCY, remedy)
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
    const step = err instanceof MatrixAuditStepError ? STEP_WORDING[err.step] : null
    const detail = step
      ? `the bid matrix audit ${step.says}: ${formatErr(err)}`
      : `the bid matrix audit failed: ${formatErr(err)}`
    console.error(`[sf-matrix-audit] ${detail}`)
    await alertQuietly(supabase, env, [detail], step?.remedy)
    return { ok: false, result: null, error: detail }
  }

  if (result.rows_fetched === 0) {
    // Measured from the saved copy rather than a number written once (#835).
    const held = result.snapshot_rows ?? 0
    const detail =
      'the bid matrix audit fetched no BidRangeRow__c rows from Salesforce, so nothing was compared and the ' +
      'snapshot was not advanced; ' +
      (held > 0
        ? `the saved copy from the last good read holds ${held} rows, so an empty answer is a failed read, not an empty matrix`
        : 'the saved copy is empty too, so whether the matrix itself is empty is unknown')
    console.error(`[sf-matrix-audit] ${detail}`)
    await alertQuietly(supabase, env, [detail])
    return { ok: false, result, error: detail }
  }

  await alertQuietly(supabase, env, [])
  return { ok: true, result, error: null }
}
