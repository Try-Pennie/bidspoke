/**
 * Read only probes for a slow archive write (#1454). The runbook is
 * docs/snowflake-slow-write.md, and `scripts/diagnose-archive-write.ts` runs
 * these as the archive's WRITER identity.
 *
 * The writer, because a role without admin privileges sees only its own
 * statements in INFORMATION_SCHEMA.QUERY_HISTORY, so the reader cannot see the
 * writes that are failing.
 *
 * Nothing here writes. The history is a SELECT, and the compile probe is an
 * EXPLAIN, which compiles the real INSERT against the real table and executes
 * nothing. A scratch table is not an alternative: the writer holds no CREATE
 * TABLE, by design.
 */
import { buildInsert } from '../lib/execution-archive-send'
import type { ArchiveRow } from '../lib/execution-archive'
import { ARCHIVE_DATABASE, ARCHIVE_SCHEMA, ARCHIVE_TABLE } from '../lib/archive-snowflake'
import type { SnowflakeStatementResponse } from '../lib/snowflake'

/**
 * Seventy two hours answers "is this recurring" inside the statement timeout.
 * A seven day scan did not finish inside it on 2026-09-22.
 */
export const HISTORY_DEFAULT_HOURS = 72

/**
 * Snowflake refuses a window reaching further back than seven days with
 * `Cannot retrieve data from more than 7 days ago` rather than returning what
 * it has, so a longer one is refused here before it is sent.
 */
export const HISTORY_MAX_HOURS = 7 * 24

const ARCHIVE_TABLE_NAME = `${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE}`

/**
 * The archive's INSERTs over the last `hours`, with their time split four ways.
 * The statement text is filtered on and never selected: it carries the archived
 * bundles, and with them applicant data.
 */
export function queryHistoryStatement(hours: number): string {
  if (!Number.isInteger(hours) || hours < 1) {
    throw new Error(`the window must be a whole number of hours, at least 1 (got ${hours})`)
  }
  if (hours > HISTORY_MAX_HOURS) {
    throw new Error(
      `Snowflake keeps query history for 7 days (${HISTORY_MAX_HOURS} hours) and refuses a longer window (got ${hours})`,
    )
  }
  return (
    'SELECT start_time, query_id, execution_status, error_code, total_elapsed_time, ' +
    'compilation_time, execution_time, queued_overload_time, queued_provisioning_time, transaction_blocked_time ' +
    `FROM TABLE(${ARCHIVE_DATABASE}.INFORMATION_SCHEMA.QUERY_HISTORY(` +
    `END_TIME_RANGE_START => DATEADD('hour', -${hours}, CURRENT_TIMESTAMP()), RESULT_LIMIT => 10000)) ` +
    `WHERE query_type = 'INSERT' AND STARTSWITH(query_text, 'INSERT INTO ${ARCHIVE_TABLE_NAME} ') ` +
    'ORDER BY start_time DESC'
  )
}

export interface HistoryRow {
  startTime: string
  queryId: string
  status: string
  errorCode: string | null
  totalMs: number
  compilationMs: number
  executionMs: number
  queuedMs: number
  /** Waiting for the warehouse to resume or resize, which a suspended XS warehouse pays on its first statement. */
  provisioningMs: number
  blockedMs: number
}

const HISTORY_COLUMNS = [
  'start_time',
  'query_id',
  'execution_status',
  'error_code',
  'total_elapsed_time',
  'compilation_time',
  'execution_time',
  'queued_overload_time',
  'queued_provisioning_time',
  'transaction_blocked_time',
] as const

/** Reads the history by column NAME, and refuses rather than reading a shifted cell. */
export function readHistory(response: SnowflakeStatementResponse): HistoryRow[] {
  const names = (response.resultSetMetaData?.rowType ?? []).map((c) => c.name.toLowerCase())
  const at = Object.fromEntries(HISTORY_COLUMNS.map((c) => [c, names.indexOf(c)])) as Record<
    (typeof HISTORY_COLUMNS)[number],
    number
  >
  const missing = HISTORY_COLUMNS.filter((c) => at[c] < 0)
  if (missing.length > 0) {
    throw new Error(`the query history came back without ${missing.join(', ')}`)
  }
  const ms = (v: unknown): number => Number(v ?? 0)
  return (response.data ?? []).map((r) => ({
    startTime: String(r[at.start_time]),
    queryId: String(r[at.query_id]),
    status: String(r[at.execution_status]),
    errorCode: r[at.error_code] === null || r[at.error_code] === undefined ? null : String(r[at.error_code]),
    totalMs: ms(r[at.total_elapsed_time]),
    compilationMs: ms(r[at.compilation_time]),
    executionMs: ms(r[at.execution_time]),
    queuedMs: ms(r[at.queued_overload_time]),
    provisioningMs: ms(r[at.queued_provisioning_time]),
    blockedMs: ms(r[at.transaction_blocked_time]),
  }))
}

/**
 * Which part a statement spent most of its time in. Each points at a different
 * cause: compiling the statement, running it, waiting behind other work on a
 * busy warehouse, waiting for a suspended warehouse to start, or waiting on a lock.
 */
export function dominantWait(row: HistoryRow): 'compilation' | 'execution' | 'queued' | 'provisioning' | 'blocked' {
  const parts = [
    ['compilation', row.compilationMs],
    ['execution', row.executionMs],
    ['queued', row.queuedMs],
    ['provisioning', row.provisioningMs],
    ['blocked', row.blockedMs],
  ] as const
  return parts.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
}

export interface HistorySummary {
  total: number
  failed: HistoryRow[]
  /** How many statements spent most of their time in each part. */
  mostly: Record<ReturnType<typeof dominantWait>, number>
  slowest: HistoryRow[]
}

/** The shape of a window: how many writes, which failed, where the time went, the slowest `top`. */
export function summarizeHistory(rows: HistoryRow[], top: number): HistorySummary {
  const mostly = { compilation: 0, execution: 0, queued: 0, provisioning: 0, blocked: 0 }
  for (const r of rows) mostly[dominantWait(r)]++
  return {
    total: rows.length,
    failed: rows.filter((r) => r.status !== 'SUCCESS'),
    mostly,
    slowest: [...rows].sort((a, b) => b.totalMs - a.totalMs).slice(0, top),
  }
}

type RandomFill = (bytes: Uint8Array) => Uint8Array

const defaultRandom: RandomFill = (bytes) => crypto.getRandomValues(bytes)

/** Base64 of fresh random bytes, cut to exactly `length` characters. */
function randomWire(length: number, random: RandomFill): string {
  const bytes = random(new Uint8Array(Math.ceil((length * 3) / 4) + 3))
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).slice(0, length)
}

/**
 * Rows shaped like a real batch, each with its OWN random payload.
 *
 * Distinct per row on purpose. The first probe on 2026-09-22 repeated one
 * 13 KB literal 150 times, reported about a second, and let Snowflake off work
 * it genuinely has to do with real bundles, which are all different (L48).
 */
export function probeRows(count: number, bytesPerRow: number, random: RandomFill = defaultRandom): ArchiveRow[] {
  const rows: ArchiveRow[] = []
  for (let i = 0; i < count; i++) {
    rows.push({
      executionId: `diagnosis-probe-${i}-${randomWire(12, random)}`,
      archiveDay: '2026-01-01',
      wire: randomWire(bytesPerRow, random),
      incomplete: false,
      stepCount: 10,
      scalars: {
        organizationId: 'diagnosis-probe',
        workflowId: 'diagnosis-probe',
        workflowVersionId: null,
        parentExecutionId: null,
        resumedFromExecutionId: null,
        traceId: null,
        source: 'diagnosis-probe',
        status: 'completed',
        outcome: null,
        isTest: true,
        startedAtUtc: '2026-01-01T00:00:00.000',
        completedAtUtc: '2026-01-01T00:00:01.000',
        durationMs: 1000,
        costUsd: null,
        ssnHash: null,
      },
    })
  }
  return rows
}

/** The archive's own INSERT for `rows`, behind EXPLAIN, so it compiles and writes nothing. */
export function explainProbeStatement(rows: ArchiveRow[]): string {
  return `EXPLAIN ${buildInsert(rows, '2026-01-01T00:00:00.000')}`
}
