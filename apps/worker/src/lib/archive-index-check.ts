/**
 * The daily read-back of the index the archive depends on (#1044).
 *
 * The reading is one database function, `archive_index_health`, which returns
 * ONE ROW ALWAYS: a missing index comes back as a row saying so rather than as
 * no rows, because an empty result is what a caller reads as nothing to report
 * (L98). Verified against production on 2026-09-10, both ways: the real index
 * reports present, valid, 56 partitions, 56 attached, and a deliberately wrong
 * index name reports present false with attached zero.
 *
 * It alerts rather than merely logging, because it protects the read path the
 * deletion gate depends on: an archive that cannot read cannot verify a day,
 * and a day that cannot be verified is a day whose partition is spared and
 * whose data eventually is not.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { withJobRun } from './job-run-record'
import { indexFindings, type IndexHealthReading } from '../archive/index-health'

export const ARCHIVE_INDEX_JOB = 'execution-archive-index'

export const ARCHIVE_INDEX_REMEDY: AlertRemedy = {
  consequence:
    'The archive reads execution_steps by an index, and that index is no longer intact on every ' +
    'partition. Nothing is lost yet and nothing else reports this, because an index is a performance ' +
    'property: the first sign otherwise is the hourly archive timing out on a busy hour, and by then ' +
    'the archive has already stopped moving:',
  fixHint:
    'Recreate the index on execution_steps as (execution_started_at, started_at), or create it on the ' +
    'partitions that lack it. A partition ATTACHed rather than created does not inherit it and leaves the ' +
    'parent index invalid, so check how the newest partitions were made.',
  headlineVerb: 'reports the archive read index is not intact',
  itemNoun: { one: 'finding', many: 'findings' },
}

/**
 * The reading failed, so nothing is known about the index (#835). It used to
 * arrive under "that index is no longer intact", which nothing had measured.
 */
export const ARCHIVE_INDEX_UNREADABLE_REMEDY: AlertRemedy = {
  consequence:
    'Whether the index the archive reads execution_steps by is intact could not be read, so a missing or ' +
    'invalid index would go unreported until this check reads again:',
  fixHint:
    'The line below names why archive_index_health could not be read in our database. Fix that read; the ' +
    'check runs again on its next daily pass.',
  headlineVerb: 'could not read the archive read index',
  itemNoun: { one: 'finding', many: 'findings' },
}

export interface IndexCheckResult {
  reading: IndexHealthReading | null
  findings: ReturnType<typeof indexFindings>
  alerted: boolean
}

export async function checkArchiveIndex(
  supabase: SupabaseClient,
  kv: { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>; delete(k: string): Promise<void> },
): Promise<IndexCheckResult> {
  return withJobRun(
    supabase,
    ARCHIVE_INDEX_JOB,
    () => indexPass(supabase, kv),
    (result) => ({
      outcome: result.findings.length === 0 ? 'ok' : 'findings',
      detail: result.findings.length === 0 ? undefined : result.findings.map((f) => f.code).join(', '),
      summary: {
        present: result.reading?.present ?? null,
        valid: result.reading?.valid ?? null,
        partitions: result.reading?.partitions ?? null,
        attached: result.reading?.attached ?? null,
      },
    }),
  )
}

async function indexPass(
  supabase: SupabaseClient,
  kv: Parameters<typeof checkArchiveIndex>[1],
): Promise<IndexCheckResult> {
  let reading: IndexHealthReading | null = null
  // Why the reading is absent, carried into the finding (#835).
  let unreadableBecause: string | undefined
  try {
    const { data, error } = await supabase.rpc('archive_index_health')
    if (error) throw new Error(formatErr(error))
    const row = ((data ?? []) as Array<Record<string, unknown>>)[0]
    // COUNTS PARSE TO NULL, NEVER TO NaN. `Number()` on an unexpected value
    // gives NaN, and `attached < NaN` is false, so a misshapen reading would
    // produce no findings and read as an intact index. That is the permissive
    // side, which is the one direction this must never fail towards (L50).
    const count = (value: unknown): number | null => {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }

    const partitions = count(row?.partitions)
    const attached = count(row?.attached)

    // A function that always returns a row and returned none is itself a fault,
    // and so is one whose counts cannot be read: both stay null and report as
    // unreadable rather than as health.
    if (row === undefined) unreadableBecause = 'archive_index_health returned no row'
    else if (partitions === null || attached === null) {
      unreadableBecause = 'archive_index_health returned partition counts that are not numbers'
    }
    if (row !== undefined && partitions !== null && attached !== null) {
      reading = {
        // Not String(): the row is typed unknown, and String() on an object
        // yields the literal "[object Object]", which would then be printed
        // into an alert as though it were the index's name.
        indexName: typeof row.index_name === 'string' ? row.index_name : 'the archive read index',
        present: row.index_present === true,
        valid: row.index_valid === true,
        partitions,
        attached,
      }
    }
  } catch (err) {
    unreadableBecause = formatErr(err)
    console.error(`[archive-index] could not read the index health: ${unreadableBecause}`)
  }

  const findings = indexFindings(reading, unreadableBecause)
  const onlyUnreadable = findings.length > 0 && findings.every((f) => f.code === 'unreadable')
  await notifyExportFailure(
    supabase,
    ARCHIVE_INDEX_JOB,
    findings.map((f) => f.message),
    kv,
    onlyUnreadable ? ARCHIVE_INDEX_UNREADABLE_REMEDY : ARCHIVE_INDEX_REMEDY,
  )
  return { reading, findings, alerted: findings.length > 0 }
}
