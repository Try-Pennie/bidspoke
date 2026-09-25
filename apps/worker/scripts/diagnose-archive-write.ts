/**
 * Why is an archive write slow? Read only (#1454). The runbook that uses this
 * is docs/snowflake-slow-write.md.
 *
 *   npx tsx scripts/diagnose-archive-write.ts history [hours]
 *     The archive's INSERTs over the last `hours` (default 72, at most 168),
 *     each with its time split into compilation, execution, queued,
 *     warehouse starting and blocked.
 *
 *   npx tsx scripts/diagnose-archive-write.ts explain [rows] [kb per row]
 *     Compiles one archive INSERT of `rows` rows (default 150) of `kb` KB each
 *     (default 13), every row a distinct random payload, behind EXPLAIN, so it
 *     writes nothing, and prints how long the compile took.
 *
 * Runs as the archive WRITER, because a role without admin privileges sees
 * only its own statements in the query history, and the writes that fail are
 * the writer's. The key is read from ~/.bidspoke/archive-keys/archive_writer.p8
 * (or ARCHIVE_KEY_FILE) and the account from SNOWFLAKE_ACCOUNT in the environment or
 * apps/worker/.dev.vars, as scripts/verify-archive-identity.ts does.
 *
 * It never prints a statement's text: the archive's statements carry the
 * bundles, and with them applicant data.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { executeStatement } from '../src/lib/snowflake'
import { archiveConfig } from '../src/lib/archive-snowflake'
import {
  HISTORY_DEFAULT_HOURS,
  queryHistoryStatement,
  readHistory,
  dominantWait,
  summarizeHistory,
  probeRows,
  type HistoryRow,
  explainProbeStatement,
} from '../src/archive/write-diagnosis'
import { loadDevVars } from './lib/dev-vars'

function writerConfig() {
  const keyFile = process.env.ARCHIVE_KEY_FILE ?? resolve(homedir(), '.bidspoke', 'archive-keys', 'archive_writer.p8')
  // The account is not a secret (it is also in archive-settings-check.ts); the
  // environment wins so the script runs from a checkout with no .dev.vars.
  const account = process.env.SNOWFLAKE_ACCOUNT ?? loadDevVars().SNOWFLAKE_ACCOUNT
  if (!account) throw new Error('SNOWFLAKE_ACCOUNT is not in apps/worker/.dev.vars')
  const env = {
    SNOWFLAKE_ACCOUNT: account,
    ARCHIVE_WRITER_USER: 'bidspoke_archive_writer_svc',
    ARCHIVE_WRITER_PRIVATE_KEY: readFileSync(keyFile, 'utf8'),
  } as unknown as Parameters<typeof archiveConfig>[0]
  return archiveConfig(env, 'writer')
}

function positiveInt(raw: string | undefined, fallback: number, what: string): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a whole number above 0 (got "${raw}")`)
  return n
}

const SLOWEST_SHOWN = 20

function line(r: HistoryRow): string {
  const start = Number.isFinite(Number(r.startTime)) ? new Date(Number(r.startTime) * 1000).toISOString() : r.startTime
  return [start, r.status, r.totalMs, r.compilationMs, r.executionMs, r.queuedMs, r.provisioningMs, r.blockedMs, dominantWait(r), r.errorCode ?? '', r.queryId].join('\t')
}

async function history(hours: number): Promise<void> {
  const rows = readHistory(await executeStatement(writerConfig(), queryHistoryStatement(hours)))
  const s = summarizeHistory(rows, SLOWEST_SHOWN)
  if (s.total === 0) {
    // No writes is not a healthy window: either the archive did not run or this
    // identity is not the one that wrote (L98).
    console.log(`no archive INSERTs by this identity in the last ${hours} hours`)
    return
  }
  console.log(`${s.total} archive INSERTs in the last ${hours} hours, ${s.failed.length} not successful`)
  console.log(
    `mostly compiling ${s.mostly.compilation}, mostly executing ${s.mostly.execution}, ` +
      `mostly queued ${s.mostly.queued}, mostly waiting for the warehouse to start ${s.mostly.provisioning}, ` +
      `mostly blocked ${s.mostly.blocked}\n`,
  )
  const header = ['start', 'status', 'total', 'compile', 'execute', 'queued', 'starting', 'blocked', 'mostly', 'error', 'query id'].join('\t')
  if (s.failed.length > 0) {
    console.log('not successful (times in ms):')
    console.log(header)
    for (const r of s.failed) console.log(line(r))
    console.log('')
  }
  console.log(`slowest ${s.slowest.length} (times in ms):`)
  console.log(header)
  for (const r of s.slowest) console.log(line(r))
}

async function explain(count: number, kb: number): Promise<void> {
  const statement = explainProbeStatement(probeRows(count, kb * 1024))
  console.log(`compiling one INSERT of ${count} rows x ${kb} KB (${(statement.length / 1024 / 1024).toFixed(1)} MB) behind EXPLAIN`)
  const started = Date.now()
  await executeStatement(writerConfig(), statement)
  // End to end, so it includes the round trip and any warehouse resume; a result
  // far above the compile times the history shows is what points at the table.
  console.log(`compiled in ${Date.now() - started} ms end to end, nothing written`)
}

async function main(): Promise<void> {
  const [mode, a, b] = process.argv.slice(2)
  if (mode === 'history') return history(positiveInt(a, HISTORY_DEFAULT_HOURS, 'hours'))
  if (mode === 'explain') return explain(positiveInt(a, 150, 'rows'), positiveInt(b, 13, 'kb per row'))
  throw new Error('usage: diagnose-archive-write.ts history [hours] | explain [rows] [kb per row]')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
