/**
 * Dan's decision 2 bound lives in the ops database and is copied once into the
 * Worker (#2340): record_connection_refresh escalates a refresh streak to
 * needs_reauth at c_limit failures with the first c_span old (supabase-ops
 * migration 20261018170000), and the login page pages a refresh_failing streak
 * at REFRESH_FAILING_PAGE_FAILURES and REFRESH_FAILING_PAGE_SPAN_MS
 * (apps/worker/src/lib/ops-gateway-contract.ts). A page at another bound than
 * the escalation's would either page a streak the database still holds, or
 * stay silent past the point the database gave up on it, so the two are held
 * equal here, read from both sources.
 *
 * The bound is read from the LATEST migration that defines
 * record_connection_refresh, so a later migration changing it is the one
 * compared.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'

const MIGRATIONS = path.join(REPO_ROOT, 'supabase-ops/supabase/migrations')
const CONTRACT = readFileSync(path.join(WORKER_SRC, 'lib/ops-gateway-contract.ts'), 'utf8')

/** The body of the last migration defining record_connection_refresh. */
function latestRefreshFunction(): { file: string; body: string } {
  const defining = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(path.join(MIGRATIONS, file), 'utf8') }))
    .filter(({ sql }) => /CREATE (OR REPLACE )?FUNCTION public\.record_connection_refresh\(/.test(sql))
  expect(defining.length, 'no ops migration defines record_connection_refresh').toBeGreaterThan(0)
  const last = defining[defining.length - 1]
  const start = last.sql.search(/CREATE (OR REPLACE )?FUNCTION public\.record_connection_refresh\(/)
  const end = last.sql.indexOf('$fn$;', start)
  return { file: last.file, body: last.sql.slice(start, end) }
}

export function databaseBound(body: string): { failures: number; spanMinutes: number } {
  const failures = /c_limit CONSTANT integer := (\d+);/.exec(body)
  const span = /c_span CONSTANT interval := interval '(\d+) minutes';/.exec(body)
  expect(failures, 'record_connection_refresh no longer states c_limit as an integer constant').not.toBeNull()
  expect(span, 'record_connection_refresh no longer states c_span in minutes').not.toBeNull()
  return { failures: Number(failures![1]), spanMinutes: Number(span![1]) }
}

export function workerBound(source: string): { failures: number; spanMinutes: number } {
  const failures = /export const REFRESH_FAILING_PAGE_FAILURES = (\d+)\n/.exec(source)
  const span = /export const REFRESH_FAILING_PAGE_SPAN_MS = (\d+) \* 60_000\n/.exec(source)
  expect(failures, 'REFRESH_FAILING_PAGE_FAILURES is no longer a literal in ops-gateway-contract.ts').not.toBeNull()
  expect(span, 'REFRESH_FAILING_PAGE_SPAN_MS is no longer minutes times 60_000 in ops-gateway-contract.ts').not.toBeNull()
  return { failures: Number(failures![1]), spanMinutes: Number(span![1]) }
}

describe('the refresh_failing page bound is the database\'s escalation bound (#2340)', () => {
  it('reads both bounds', () => {
    const { body } = latestRefreshFunction()
    expect(databaseBound(body).failures).toBeGreaterThan(0)
    expect(workerBound(CONTRACT).failures).toBeGreaterThan(0)
  })

  it('pages at exactly the failures and span record_connection_refresh escalates at', () => {
    const { file, body } = latestRefreshFunction()
    expect(workerBound(CONTRACT), `the bound in ${file}`).toEqual(databaseBound(body))
  })

  it('tells the two apart when they differ, so a green run means the comparison can fail', () => {
    const body = "c_limit CONSTANT integer := 6;\n  c_span CONSTANT interval := interval '15 minutes';"
    expect(databaseBound(body)).not.toEqual(workerBound(CONTRACT))
  })
})
