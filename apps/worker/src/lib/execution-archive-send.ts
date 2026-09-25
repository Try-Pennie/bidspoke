/**
 * Sending assembled archive rows to Snowflake (#871, Phase A3).
 *
 * Plain INSERT, never MERGE. The deletion gate counts COUNT(DISTINCT
 * execution_id), so a duplicate row cannot block a day, which was the only
 * reason to reach for MERGE. With that, MERGE would cost a per-hour scan of the
 * growing current-day partitions for nothing.
 *
 * Correctness against a crash or a retry comes from three things, in order of
 * how much they carry: the watermark, so a crash costs one hour rather than a
 * full re-scan; the COUNT(DISTINCT) gate, so a re-run's duplicates are harmless;
 * and the KV run lock, which is only an optimisation.
 */
import { executeStatement, escapeSqlLiteral } from './snowflake'
import { archiveConfig, ARCHIVE_DATABASE, ARCHIVE_SCHEMA, ARCHIVE_TABLE } from './archive-snowflake'
import type { ArchiveRow } from './execution-archive'
import type { Env } from '../index'

/** A SQL literal, already escaped and quoted, or the NULL keyword. */
function text(value: string | null): string {
  return value === null ? 'NULL' : `'${escapeSqlLiteral(value)}'`
}

function timestamp(value: string | null): string {
  return value === null ? 'NULL' : `'${escapeSqlLiteral(value)}'::TIMESTAMP_NTZ`
}

/**
 * A number, or NULL. NaN and Infinity are refused rather than interpolated,
 * because both render as a bare word that Snowflake reads as an identifier, and
 * the statement then fails for a reason that names a column rather than a value.
 */
function numeric(value: number | null): string {
  if (value === null) return 'NULL'
  if (!Number.isFinite(value)) throw new Error(`refusing to write ${String(value)} as a number`)
  return String(value)
}

function boolean(value: boolean | null): string {
  if (value === null) return 'NULL'
  return value ? 'TRUE' : 'FALSE'
}

/**
 * How each column of the archive table gets its value.
 *
 * The column list and the VALUES tuple are derived from this one map rather
 * than written twice, so they cannot drift into a silent off-by-one where every
 * row is written with its fields shifted. That is a class of defect the
 * database cannot catch whenever the shifted columns share a type.
 */
const VALUE_OF: Record<string, (row: ArchiveRow, archivedAtUtc: string) => string> = {
  execution_id: (r) => text(r.executionId),
  archive_day: (r) => `${text(r.archiveDay)}::DATE`,
  organization_id: (r) => text(r.scalars.organizationId),
  workflow_id: (r) => text(r.scalars.workflowId),
  workflow_version_id: (r) => text(r.scalars.workflowVersionId),
  parent_execution_id: (r) => text(r.scalars.parentExecutionId),
  resumed_from_execution_id: (r) => text(r.scalars.resumedFromExecutionId),
  trace_id: (r) => text(r.scalars.traceId),
  source: (r) => text(r.scalars.source),
  status: (r) => text(r.scalars.status),
  outcome: (r) => text(r.scalars.outcome),
  is_test: (r) => boolean(r.scalars.isTest),
  started_at_utc: (r) => timestamp(r.scalars.startedAtUtc),
  completed_at_utc: (r) => timestamp(r.scalars.completedAtUtc),
  duration_ms: (r) => numeric(r.scalars.durationMs),
  cost_usd: (r) => numeric(r.scalars.costUsd),
  step_count: (r) => String(r.stepCount),
  archived_incomplete: (r) => boolean(r.incomplete),
  // From the execution's own trigger payload, hashed with the shared peppered
  // hash so an erasure request in A7 (#875) hashes to the same value (#927).
  // Still never the only resolver: an execution carrying no SSN writes null
  // here and is resolvable only through the bundle.
  ssn_hash: (r) => text(r.scalars.ssnHash),
  bundle_gz_b64: (r) => text(r.wire),
  bundle_bytes: (r) => String(r.wire.length),
  archived_at_utc: (_r, archivedAtUtc) => timestamp(archivedAtUtc),
}

/**
 * The columns this INSERT names, in the order the VALUES tuples supply them.
 *
 * Exported so a test can compare it against the committed table definition. The
 * table is created by a SQL file run by hand against Snowflake, so nothing else
 * in the build relates the two, and a column the table requires and this list
 * omits is a constraint violation on the first real send rather than a test
 * failure.
 */
export const insertColumns: string[] = Object.keys(VALUE_OF)

/**
 * Builds the INSERT for one batch.
 *
 * Values are inlined rather than bound because the wire form is base64, which
 * carries no quote to escape, and the batch is sized in bytes against a
 * statement limit measured at 50 MB. Every value still goes through
 * escapeSqlLiteral, because "this input cannot contain a quote" is exactly the
 * assumption that stops being true later, and unlike the bundle these scalars
 * carry free text a person wrote (a source name, an outcome).
 */
export function buildInsert(rows: ArchiveRow[], archivedAtUtc: string): string {
  if (rows.length === 0) {
    throw new Error('refusing to build an INSERT for an empty batch, which would report a send that sent nothing')
  }
  const values = rows
    .map((r) => `(${insertColumns.map((column) => VALUE_OF[column](r, archivedAtUtc)).join(',')})`)
    .join(',')

  return (
    `INSERT INTO ${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE} ` +
    `(${insertColumns.join(', ')}) ` +
    `VALUES ${values}`
  )
}

/**
 * `giveUpAt` is the moment the run's wall budget runs out (#1451). A batch that
 * keeps failing then stops resubmitting before it can spend past it, so the run
 * ends on a send failure it records rather than on the platform's kill.
 */
export async function sendArchiveBatch(env: Env, rows: ArchiveRow[], giveUpAt?: number): Promise<void> {
  const statement = buildInsert(rows, new Date().toISOString().replace('Z', ''))
  const config = archiveConfig(env, 'writer')
  const response = await executeStatement(config, statement, undefined, { giveUpAt })

  // Snowflake reports how many rows an INSERT affected. Checking it is the
  // difference between "the statement was accepted" and "the rows are there",
  // and the local id record written next claims the latter.
  const affected = Number(response.data?.[0]?.[0])
  if (!Number.isFinite(affected)) {
    throw new Error(`archive INSERT returned no row count: ${response.message ?? 'no message'}`)
  }
  if (affected !== rows.length) {
    throw new Error(`archive INSERT reported ${affected} rows for a batch of ${rows.length}`)
  }
}
