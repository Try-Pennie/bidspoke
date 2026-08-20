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

/**
 * Builds the INSERT for one batch.
 *
 * Values are inlined rather than bound because the wire form is base64, which
 * carries no quote to escape, and the batch is sized in bytes against a
 * statement limit measured at 50 MB. Every value still goes through
 * escapeSqlLiteral, because "this input cannot contain a quote" is exactly the
 * assumption that stops being true later.
 */
export function buildInsert(rows: ArchiveRow[], archivedAtUtc: string): string {
  if (rows.length === 0) {
    throw new Error('refusing to build an INSERT for an empty batch, which would report a send that sent nothing')
  }
  const values = rows
    .map((r) => {
      return (
        `('${escapeSqlLiteral(r.executionId)}',` +
        `'${escapeSqlLiteral(r.archiveDay)}'::DATE,` +
        `${r.incomplete ? 'TRUE' : 'FALSE'},` +
        `${r.stepCount},` +
        `'${escapeSqlLiteral(r.wire)}',` +
        `${r.wire.length},` +
        `'${escapeSqlLiteral(archivedAtUtc)}'::TIMESTAMP_NTZ)`
      )
    })
    .join(',')

  return (
    `INSERT INTO ${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE} ` +
    `(execution_id, archive_day, archived_incomplete, step_count, bundle_gz_b64, bundle_bytes, archived_at_utc) ` +
    `VALUES ${values}`
  )
}

export async function sendArchiveBatch(env: Env, rows: ArchiveRow[]): Promise<void> {
  const statement = buildInsert(rows, new Date().toISOString().replace('Z', ''))
  const config = archiveConfig(env, 'writer')
  const response = await executeStatement(config, statement)

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
