/**
 * What an erasure actually erased, and whether it may be called one (#875,
 * Phase A7).
 *
 * Moving from a 7 day truncate to a 13 month archive multiplies the SSN
 * exposure window by roughly 56x, and `PII_REDACTION_FIELDS` is empty, so the
 * truncate was the ONLY control. The controls ship with the archive.
 *
 * THE RULE THIS ENCODES, from the ADR in as many words: erasing the archive
 * without erasing LEAD_SIGHTINGS is not erasure. A delete from
 * `execution_archive` alone would report success while the SSN survives in the
 * very table used to FIND it, which is worse than no erasure because it closes
 * the matter.
 *
 * So the outcome is never a single boolean and never a single number. Every
 * enumerated target reports its own row count, a target that failed is named,
 * and the word "erased" is reserved for a run where every target succeeded and
 * no target is unverified.
 *
 * It decides, it does not act.
 */

/** Every place a subject's identity lands, enumerated rather than remembered. */
export const ERASURE_TARGETS = [
  'execution_archive',
  'lead_sightings',
  'lead_sighting_bids',
  'audit_log',
] as const

export type ErasureTarget = (typeof ERASURE_TARGETS)[number]

/**
 * Targets that are enumerated but whose existence has NOT been established.
 *
 * Cloudflare Logpush is a possible fifth full-fidelity sink. Whether a job
 * exists could not be determined: the Cloudflare API answers `10000:
 * Authentication error` for every credential this codebase can reach, and no
 * token or wrangler session available here carries the Logpush read scope
 * (checked 2026-08-22). ADR 0009 records it as unresolved.
 *
 * It is listed HERE, rather than left out of the code until somebody finds out,
 * because the alternative is an erasure that reports completeness it has not
 * got. While this list is non-empty no erasure may be described as complete,
 * and the response names what was not covered. Emptying it is a deliberate act
 * that requires establishing the answer either way.
 */
export const UNVERIFIED_TARGETS: readonly string[] = ['cloudflare_logpush']

export interface TargetOutcome {
  target: ErasureTarget
  /** Null when the delete did not run or failed, which is not the same as zero. */
  rowsDeleted: number | null
  error: string | null
}

export type ErasureVerdict =
  /** Every target succeeded, something was deleted, and nothing is unverified. */
  | { status: 'erased'; totalRows: number }
  /**
   * Every target succeeded and matched nothing. Reported as its own outcome and
   * NEVER as success: "no rows matched" and "erased" answer different questions,
   * and telling a subject their data is gone when nothing was found is the
   * failure mode this whole phase exists to avoid.
   */
  | { status: 'no-rows-matched' }
  /**
   * At least one target failed. The subject's identity survives somewhere and
   * the matter is NOT closed.
   */
  | { status: 'partial'; failed: ErasureTarget[]; succeeded: ErasureTarget[] }
  /**
   * Everything asked for succeeded, but a target exists that nobody has been
   * able to check. Distinct from 'erased' because the difference is exactly
   * whether the subject can be told the matter is closed.
   */
  | { status: 'incomplete-coverage'; totalRows: number; unverified: readonly string[] }

export function erasureVerdict(
  outcomes: TargetOutcome[],
  unverified: readonly string[] = UNVERIFIED_TARGETS,
): ErasureVerdict {
  const failed = outcomes.filter((o) => o.error !== null).map((o) => o.target)
  const succeeded = outcomes.filter((o) => o.error === null).map((o) => o.target)

  // Judged FIRST. A partial erasure is the dangerous state, and any wording that
  // led with the rows it did delete would read as progress.
  if (failed.length > 0) return { status: 'partial', failed, succeeded }

  // A target nobody ran is not a target that matched nothing (L215).
  const missing = ERASURE_TARGETS.filter((t) => !outcomes.some((o) => o.target === t))
  if (missing.length > 0) return { status: 'partial', failed: missing, succeeded }

  const totalRows = outcomes.reduce((n, o) => n + (o.rowsDeleted ?? 0), 0)
  if (totalRows === 0) return { status: 'no-rows-matched' }
  if (unverified.length > 0) return { status: 'incomplete-coverage', totalRows, unverified }
  return { status: 'erased', totalRows }
}

/**
 * What the caller is told, worded as what was MEASURED (L82, L11).
 *
 * A Snowflake DELETE does not remove the rows. Time Travel keeps the prior
 * version readable for the table's retention window and Fail-safe holds a
 * further seven days that nobody can query or purge. So the response says rows
 * were removed from the live tables and names the residual window, rather than
 * claiming a deletion it never measured.
 */
export function erasureSummary(
  verdict: ErasureVerdict,
  outcomes: TargetOutcome[],
  undoWindowDays: number,
): string {
  const perTable = outcomes
    .map((o) => `${o.target}: ${o.error !== null ? `FAILED (${o.error})` : String(o.rowsDeleted ?? 0)}`)
    .join(', ')

  switch (verdict.status) {
    case 'no-rows-matched':
      return `no rows matched in any target (${perTable}). Nothing was erased, and nothing was found to erase.`
    case 'partial':
      return (
        `PARTIAL: ${verdict.failed.join(', ')} failed, so the subject's identity survives there and this is NOT ` +
        `an erasure (${perTable}).`
      )
    case 'incomplete-coverage':
      return (
        `${verdict.totalRows} rows removed from the live tables (${perTable}), recoverable through Time Travel ` +
        `for ${undoWindowDays} days and held in Fail-safe for 7 days after that, which Snowflake staff can ` +
        `recover and we cannot query. NOT COMPLETE: ${verdict.unverified.join(', ')} could not be checked, so ` +
        'whether a further copy exists is unknown.'
      )
    case 'erased':
      return (
        `${verdict.totalRows} rows removed from the live tables (${perTable}), recoverable through Time Travel ` +
        `for ${undoWindowDays} days and held in Fail-safe for 7 days after that.`
      )
  }
}
