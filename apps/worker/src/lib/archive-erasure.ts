/**
 * Erasing one subject from every place their identity landed (#875, Phase A7).
 *
 * The verdict logic is in `archive/erasure.ts` and is pure. This is the half
 * that runs the deletes, as the ERASER identity, which is the only credential in
 * the account holding DELETE on the archive (verified daily by #914).
 *
 * ONE OPERATION, FOUR TARGETS. Deleting from `execution_archive` alone would
 * report success while the SSN survives in `LEAD_SIGHTINGS`, the very table used
 * to FIND it. ADR 0009 puts it plainly: erasing the archive without erasing
 * LEAD_SIGHTINGS is not erasure. So every target reports its own row count, and
 * the word "erased" is reserved for a run where all of them succeeded.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { requireRowsAffected, isNoRowMatchedError } from './db-retry'
import { fetchAllPaged } from './paginate'
import { executeStatement, type SnowflakeStatementResponse } from './snowflake'
import {
  archiveConfig,
  ARCHIVE_DATABASE,
  ARCHIVE_SCHEMA,
  ARCHIVE_TABLE,
  ARCHIVE_UNDO_WINDOW_DAYS,
} from './archive-snowflake'
import { hashSsn } from '../engine/persons-crypto'
import {
  erasureVerdict,
  erasureSummary,
  ERASURE_TARGETS,
  type TargetOutcome,
  type ErasureVerdict,
} from '../archive/erasure'
import type { Env } from '../index'
import { chunk } from './chunk'

const ARCHIVE = `${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE}`
const SIGHTINGS = 'BIDSPOKE.PUBLIC.LEAD_SIGHTINGS'
const SIGHTING_BIDS = 'BIDSPOKE.PUBLIC.LEAD_SIGHTING_BIDS'

/** Ids per statement, so a subject with a long history does not build one enormous IN list. */
const IDS_PER_STATEMENT = 500

export interface ErasureRequest {
  ssn: string
  reason: string
  organizationId: string
  requestedBy: string
  /**
   * Report what would be removed and remove nothing (#823).
   *
   * Erasure DELETES (Dan, 2026-09-09) on production consumer data with no undo,
   * so this is the gate rather than a convenience. It resolves the subject by
   * exactly the same query the real run uses, and counts through exactly the
   * same predicate, because a dry run that matched a different set than the run
   * it is previewing is worse than none.
   *
   * Defaults off: a caller that forgets it deletes, which is the behaviour that
   * already existed.
   */
  dryRun?: boolean
}

export interface ErasureResult {
  verdict: ErasureVerdict
  outcomes: TargetOutcome[]
  summary: string
  /** Executions the resolvers found, so a caller can see what the erasure was about. */
  executionIds: string[]
}

export interface ErasureDeps {
  query?: (statement: string) => Promise<SnowflakeStatementResponse>
}

/**
 * Both spellings of the SSN, because the two stores were not written by the same
 * code path.
 *
 * The sightings export writes what the engine handed it, which goes through
 * `formatSsn` on some paths and not others. Matching only one spelling would
 * leave rows behind and still report an erasure, which is the failure this phase
 * exists to prevent, so the delete matches both and says so.
 */
export function ssnSpellings(ssn: string): string[] {
  const digits = ssn.replace(/\D/g, '')
  if (digits.length !== 9) throw new Error('an SSN must be nine digits')
  return [digits, `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`]
}

/**
 * One `?` per value, for a bound IN list.
 *
 * BOUND, not interpolated. This file DELETES from three tables on a
 * caller-supplied SSN, and the identity check issues its own DELETE as the one
 * credential in the account that can destroy archived rows. Escaping is correct
 * today and its correctness rests on every future edit remembering to call the
 * helper; binding removes the class rather than defending against it (#1006).
 */
function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(',')
}

/** A statement and the values it binds, so the two cannot be paired wrongly. */
interface BoundStatement {
  sql: string
  bindings: unknown[]
}

/**
 * Rows a DML statement reported affecting.
 *
 * Returns null when the response carries no readable count. NOT zero: "deleted
 * nothing" and "we cannot tell what happened" are different facts, and reading
 * the second as the first would report a store as clean that nobody can vouch
 * for (L90, L215).
 */
export function rowsAffected(response: SnowflakeStatementResponse): number | null {
  const cell = response.data?.[0]?.[0]
  const n = typeof cell === 'string' || typeof cell === 'number' ? Number(cell) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * One target's work, as `FROM <table> WHERE <predicate>` fragments.
 *
 * The fragment is built once and rendered as a DELETE or a SELECT COUNT, so the
 * dry run cannot match a different set than the run it previews. Rewriting a
 * finished DELETE into a count with string surgery would be the version of this
 * that silently diverges.
 */
function renderStatements(fragments: BoundStatement[], dryRun: boolean): BoundStatement[] {
  return fragments.map((f) => ({
    sql: dryRun ? `SELECT COUNT(*) ${f.sql}` : `DELETE ${f.sql}`,
    bindings: f.bindings,
  }))
}

async function deleteTarget(
  target: TargetOutcome['target'],
  statements: BoundStatement[],
  query: (statement: string, bindings?: unknown[]) => Promise<SnowflakeStatementResponse>,
): Promise<TargetOutcome> {
  let total = 0
  try {
    for (const statement of statements) {
      const rows = rowsAffected(await query(statement.sql, statement.bindings))
      if (rows === null) {
        throw new Error('the delete reported no readable row count, so what it removed is unknown')
      }
      total += rows
    }
    return { target, rowsDeleted: total, error: null }
  } catch (err) {
    // rowsDeleted stays null even when earlier statements succeeded: a partial
    // count would read as "this much was removed" when the truth is that the
    // target is in an unknown state.
    return { target, rowsDeleted: null, error: formatErr(err) }
  }
}

export async function eraseSubject(
  env: Env,
  supabase: SupabaseClient,
  request: ErasureRequest,
  deps: ErasureDeps = {},
): Promise<ErasureResult> {
  const dryRun = request.dryRun === true
  // A dry run reads. Using the eraser identity for it would mean every preview
  // was performed by the one credential in the account that can destroy the
  // archive, so it borrows the reader.
  const query =
    deps.query ??
    ((statement: string, bindings?: unknown[]) =>
      executeStatement(archiveConfig(env, dryRun ? 'reader' : 'eraser'), statement, bindings))
  const spellings = ssnSpellings(request.ssn)

  // RESOLVE FIRST, and from two directions.
  //
  // The primary resolver is LEAD_SIGHTINGS, keyed on the SSN as stored. The
  // secondary is the archive's own ssn_hash, which the archiver writes from the
  // trigger payload (#927). The secondary is deliberately not primary: computing
  // it means extracting an SSN from arbitrary untyped JSONB, and a compliance
  // guarantee standing on that alone is the shape that has failed here before.
  // Together they cover an execution whose sighting row has already been purged
  // AND one whose payload carried no readable SSN.
  const pepper = env.SSN_HASH_PEPPER
  const resolvers = [
    `execution_id IN (SELECT execution_id FROM ${SIGHTINGS} WHERE ssn IN (${placeholders(spellings)}))`,
  ]
  const resolveBindings: unknown[] = [...spellings]
  if (typeof pepper === 'string' && pepper.length > 0) {
    resolvers.push('ssn_hash = ?')
    resolveBindings.push(await hashSsn(spellings[0], pepper))
  }

  let executionIds: string[] = []
  let days: string[] = []
  let resolveError: string | null = null
  try {
    const found = await query(
      `SELECT DISTINCT execution_id, archive_day FROM ${ARCHIVE} WHERE ${resolvers.join(' OR ')}`,
      resolveBindings,
    )
    for (const row of found.data ?? []) {
      if (typeof row[0] === 'string') executionIds.push(row[0])
      if (typeof row[1] === 'string') days.push(row[1])
    }
    executionIds = [...new Set(executionIds)]
    days = [...new Set(days)]
  } catch (err) {
    resolveError = formatErr(err)
  }

  const outcomes: TargetOutcome[] = []
  let heldBack = false

  if (resolveError !== null) {
    // Every target is unknown, because nothing could be resolved. Reported as
    // four failures rather than as one, so the response cannot read as "the
    // archive was cleared and the rest matched nothing".
    for (const target of ERASURE_TARGETS) {
      outcomes.push({ target, rowsDeleted: null, error: `the subject could not be resolved: ${resolveError}` })
    }
  } else {
    // THE WRITEBACKS FIRST (#1993). Their rows are found only by run id, and the
    // run ids only through the archive and the sightings, so they go before
    // either. When their delete fails, the stores that name the runs are KEPT,
    // so a re-run can still find them, rather than leaving encrypted lead fields
    // that nothing can resolve any more.
    const pgResolve = await resolvePostgresSightings(supabase, spellings)
    const pgRunIds = pgResolve.ok
      ? pgResolve.sightings.map((r) => r.execution_id).filter((id): id is string => typeof id === 'string')
      : []
    const writeback = await eraseWritebackRows(
      supabase,
      request.organizationId,
      [...new Set([...executionIds, ...pgRunIds])],
      pgResolve.ok,
      dryRun,
    )
    if (writeback.deleteFailed) {
      heldBack = true
      const held = `kept so a re-run can find the failed Salesforce writes of these runs, whose erasure failed: ${writeback.outcome.error}`
      for (const target of ERASURE_TARGETS) {
        outcomes.push(target === writeback.outcome.target ? writeback.outcome : { target, rowsDeleted: null, error: held })
      }
    } else {
      outcomes.push(
        await deleteTarget(
          'execution_archive',
          executionIds.length === 0
            ? []
            : renderStatements(chunk(executionIds, IDS_PER_STATEMENT).map(
                (ids) => ({
                  sql:
                    `FROM ${ARCHIVE} WHERE execution_id IN (${placeholders(ids)})` +
                    // A pruning hint only. The id list is the correctness bound, and
                    // the day list comes from the same rows, so it can never exclude
                    // one the ids would include.
                    (days.length > 0 ? ` AND archive_day IN (${placeholders(days)})` : ''),
                  bindings: days.length > 0 ? [...ids, ...days] : [...ids],
                }),
              ), dryRun),
          query,
        ),
      )
      outcomes.push(
        await deleteTarget(
          'lead_sightings',
          renderStatements(
            [{ sql: `FROM ${SIGHTINGS} WHERE ssn IN (${placeholders(spellings)})`, bindings: [...spellings] }],
            dryRun,
          ),
          query,
        ),
      )
      outcomes.push(
        await deleteTarget(
          'lead_sighting_bids',
          renderStatements(
            [{ sql: `FROM ${SIGHTING_BIDS} WHERE ssn IN (${placeholders(spellings)})`, bindings: [...spellings] }],
            dryRun,
          ),
          query,
        ),
      )
      outcomes.push(...(await erasePostgresSightings(supabase, spellings, pgResolve, dryRun)))
      outcomes.push(
        dryRun
          ? { target: 'audit_log', rowsDeleted: 0, error: null }
          : await deleteAuditRows(supabase, request.organizationId, executionIds),
      )
      // Reported last, where it always was, though it ran first.
      outcomes.push(writeback.outcome)
    }
  }

  // WRITTEN WHATEVER THE OUTCOME, and before the day's Postgres partition is
  // truncated, so A4's gate can subtract it. An erasure that deleted rows and
  // then failed to record it would make the gate report a shortfall it can never
  // clear: re-running the archiver re-inserts nothing, because the rows were
  // deliberately destroyed.
  // NOT on a dry run, nor when the stores were held back. A recorded erasure
  // makes the archive gate subtract rows that are still there, and nothing puts
  // them back: re-running the archiver re-inserts nothing, because the gate
  // believes they were deliberately destroyed.
  if (!dryRun && !heldBack) await recordErasures(supabase, executionIds, days, request.reason)

  const verdict = erasureVerdict(outcomes)
  return {
    verdict,
    outcomes,
    // The dry run says so FIRST. A preview whose summary reads like a completed
    // erasure is the one way this feature makes things worse than having none.
    summary:
      (dryRun ? 'DRY RUN, nothing was removed. ' : '') +
      erasureSummary(verdict, outcomes, ARCHIVE_UNDO_WINDOW_DAYS),
    executionIds,
  }
}

/**
 * The audit rows the archived-read path writes (A6, #874).
 *
 * That path does not exist yet, so this target legitimately matches nothing
 * today. It still RUNS and still reports its zero, because a target nobody ran
 * and a target that found nothing are different facts, and the enumerated set
 * has to be complete before A6 makes it non-empty rather than after.
 */
/**
 * The POSTGRES `lead_sightings` and `lead_sighting_bids` (#823).
 *
 * Distinct from the Snowflake copies above, and reached differently. Sightings
 * are found by the indexed `ssn`. Bids are found by `sighting_id`, because bids
 * carries no ssn index and an ssn match there would cross every partition.
 *
 * Every statement carries a PARTITION-KEY predicate, derived from the rows
 * actually found rather than guessed, because a delete without one scans all
 * partitions on a table that has eight of them.
 *
 * Bids go first: they hang off the sightings, and deleting the parents first
 * would leave nothing to resolve the children by.
 */
type PgSighting = { id: string; execution_started_at_utc: string; execution_id: string | null }
type PgResolve = { ok: true; sightings: PgSighting[] } | { ok: false; error: string }

/** The subject's Postgres sightings, read once and before anything is deleted. */
async function resolvePostgresSightings(supabase: SupabaseClient, spellings: string[]): Promise<PgResolve> {
  try {
    // PAGED, and this is not a performance note. PostgREST caps a read at 1,000
    // rows, so an unpaged select would have seen the first 1,000 sightings of a
    // subject who has more, deleted those, and reported the erasure complete.
    // A silent partial erasure is the exact failure this whole path exists to
    // prevent. Ordered by id so the pages cannot repeat or skip rows.
    const sightings = await fetchAllPaged<PgSighting>(
      (from, to) =>
        supabase
          .from('lead_sightings')
          .select('id, execution_started_at_utc, execution_id')
          .in('ssn', spellings)
          .order('id')
          .range(from, to) as unknown as PromiseLike<{
          data: unknown[] | null
          error: { message: string } | null
        }>,
      'pg_lead_sightings resolve',
    )
    return { ok: true, sightings }
  } catch (err) {
    return { ok: false, error: formatErr(err) }
  }
}

async function erasePostgresSightings(
  supabase: SupabaseClient,
  spellings: string[],
  resolved: PgResolve,
  dryRun: boolean,
): Promise<TargetOutcome[]> {
  if (!resolved.ok) {
    // Unknown, not zero. A resolve that failed and a subject with no Postgres
    // rows are different facts, and only one of them means there is nothing to
    // erase.
    const why = `the Postgres sightings could not be resolved: ${resolved.error}`
    return [
      { target: 'pg_lead_sighting_bids', rowsDeleted: null, error: why },
      { target: 'pg_lead_sightings', rowsDeleted: null, error: why },
    ]
  }
  const sightings = resolved.sightings
  if (sightings.length === 0) {
    return [
      { target: 'pg_lead_sighting_bids', rowsDeleted: 0, error: null },
      { target: 'pg_lead_sightings', rowsDeleted: 0, error: null },
    ]
  }

  const ids = sightings.map((r) => r.id)
  const stamps = sightings.map((r) => r.execution_started_at_utc).sort()
  const sightingFrom = stamps[0]
  const sightingTo = stamps[stamps.length - 1]

  const outcomes: TargetOutcome[] = []

  // BIDS FIRST.
  try {
    // Paged for the same reason as the sightings above: a subject with more than
    // 1,000 bid rows would otherwise have had the rest left behind.
    const bids = await fetchAllPaged<{ id: string; attempted_at_utc: string }>(
      (from, to) =>
        supabase
          .from('lead_sighting_bids')
          .select('id, attempted_at_utc')
          .in('sighting_id', ids)
          .order('id')
          .range(from, to) as unknown as PromiseLike<{
          data: unknown[] | null
          error: { message: string } | null
        }>,
      'pg_lead_sighting_bids resolve',
    )
    if (bids.length === 0 || dryRun) {
      outcomes.push({ target: 'pg_lead_sighting_bids', rowsDeleted: bids.length, error: null })
    } else {
      const bidStamps = bids.map((b) => b.attempted_at_utc).sort()
      const { rows, error: delError } = await requireRowsAffected<{ id: string }>(
        'pg_lead_sighting_bids erasure',
        () =>
          supabase
            .from('lead_sighting_bids')
            .delete()
            .in('sighting_id', ids)
            .gte('attempted_at_utc', bidStamps[0])
            .lte('attempted_at_utc', bidStamps[bidStamps.length - 1])
            .select('id'),
      )
      if (delError && !isNoRowMatchedError(delError)) throw new Error(formatErr(delError))
      outcomes.push({ target: 'pg_lead_sighting_bids', rowsDeleted: rows.length, error: null })
    }
  } catch (err) {
    outcomes.push({ target: 'pg_lead_sighting_bids', rowsDeleted: null, error: formatErr(err) })
  }

  // THEN THE SIGHTINGS.
  try {
    if (dryRun) {
      outcomes.push({ target: 'pg_lead_sightings', rowsDeleted: sightings.length, error: null })
    } else {
      const { rows, error } = await requireRowsAffected<{ id: string }>(
        'pg_lead_sightings erasure',
        () =>
          supabase
            .from('lead_sightings')
            .delete()
            .in('ssn', spellings)
            .gte('execution_started_at_utc', sightingFrom)
            .lte('execution_started_at_utc', sightingTo)
            .select('id'),
      )
      if (error && !isNoRowMatchedError(error)) throw new Error(formatErr(error))
      outcomes.push({ target: 'pg_lead_sightings', rowsDeleted: rows.length, error: null })
    }
  } catch (err) {
    outcomes.push({ target: 'pg_lead_sightings', rowsDeleted: null, error: formatErr(err) })
  }

  return outcomes
}

async function deleteAuditRows(
  supabase: SupabaseClient,
  organizationId: string,
  executionIds: string[],
): Promise<TargetOutcome> {
  if (executionIds.length === 0) return { target: 'audit_log', rowsDeleted: 0, error: null }
  try {
    let total = 0
    for (const ids of chunk(executionIds, IDS_PER_STATEMENT)) {
      // Through requireRowsAffected because supabase-js reports error null on a
      // DELETE that matched nothing, so reading the count by hand would let a
      // silent miss pass (#583). Here a zero match is LEGITIMATE and expected,
      // since the archived-read path that writes these rows does not exist yet,
      // so its own no-row error is the one thing not treated as a failure.
      const { rows, error } = await requireRowsAffected<{ id: string }>(
        'audit_log erasure',
        () =>
          supabase
            .from('audit_log')
            .delete()
            .eq('organization_id', organizationId)
            .in('entity_id', ids)
            .select('id'),
      )
      if (error && !isNoRowMatchedError(error)) throw new Error(formatErr(error))
      total += rows.length
    }
    return { target: 'audit_log', rowsDeleted: total, error: null }
  } catch (err) {
    return { target: 'audit_log', rowsDeleted: null, error: formatErr(err) }
  }
}

/**
 * The failed Salesforce writes held for replay (#1993), by the subject's run ids.
 * Its body is encrypted lead fields, so a subject erased everywhere else but here
 * would still have them on record. Same shape as the audit rows: a zero match is
 * the common, legitimate answer, since most runs never fail a write.
 *
 * A dry run COUNTS the rows rather than reporting zero, so the preview names what
 * the real run would remove. When the Postgres sightings could not be resolved,
 * the rows of the runs that were found are still removed, and the outcome is
 * unknown rather than a count, since runs only those sightings record may remain.
 * `deleteFailed` says the delete itself failed, which is what holds the other
 * stores back.
 */
async function eraseWritebackRows(
  supabase: SupabaseClient,
  organizationId: string,
  executionIds: string[],
  allRunsResolved: boolean,
  dryRun: boolean,
): Promise<{ outcome: TargetOutcome; deleteFailed: boolean }> {
  const target = 'pg_outcome_writeback_deadletters'
  try {
    let total = 0
    for (const ids of chunk(executionIds, IDS_PER_STATEMENT)) {
      if (dryRun) {
        const rows = await fetchAllPaged<{ id: string }>(
          (from, to) =>
            supabase
              .from('outcome_writeback_deadletters')
              .select('id')
              .eq('organization_id', organizationId)
              .in('execution_id', ids)
              .order('id')
              .range(from, to),
          'outcome_writeback_deadletters count',
          { maxPages: 200 },
        )
        total += rows.length
        continue
      }
      const { rows, error } = await requireRowsAffected<{ id: string }>(
        'outcome_writeback_deadletters erasure',
        () =>
          supabase
            .from('outcome_writeback_deadletters')
            .delete()
            .eq('organization_id', organizationId)
            .in('execution_id', ids)
            .select('id'),
      )
      if (error && !isNoRowMatchedError(error)) throw new Error(formatErr(error))
      total += rows.length
    }
    if (!allRunsResolved) {
      const error =
        `${total} ${dryRun ? 'would be' : 'were'} removed for the runs that were found, but the Postgres ` +
        'sightings could not be resolved, so the rows of runs only they record may remain'
      return { outcome: { target, rowsDeleted: null, error }, deleteFailed: false }
    }
    return { outcome: { target, rowsDeleted: total, error: null }, deleteFailed: false }
  } catch (err) {
    return { outcome: { target, rowsDeleted: null, error: formatErr(err) }, deleteFailed: !dryRun }
  }
}

async function recordErasures(
  supabase: SupabaseClient,
  executionIds: string[],
  days: string[],
  reason: string,
): Promise<void> {
  if (executionIds.length === 0) return
  // One row per (execution, day). The day comes from the archive rows
  // themselves, so an execution that somehow spans two is recorded under both
  // and the gate subtracts it from the right one.
  const day = days[0] ?? null
  if (day === null) return
  const { error } = await supabase.from('execution_archive_erasures').upsert(
    executionIds.map((execution_id) => ({ execution_id, archive_day: day, reason })),
    { onConflict: 'execution_id,archive_day' },
  )
  // Loud, and NOT swallowed into the erasure's own verdict: the deletes may have
  // succeeded, and the missing record is a separate problem with a separate
  // remedy (the gate will report an unexplained shortfall on that day).
  if (error) console.error(`[archive-erasure] the erasure ledger was not written: ${formatErr(error)}`)
}
