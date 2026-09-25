import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

// #541. The sightings buffer purge runs in the database
// (`purge_exported_sightings`, pg_cron), and its grace is also written in the
// Worker as PURGE_GRACE_HOURS, which the bid recording check
// (bid-recording-coverage.ts, via BID_PURGE_HORIZON_MS) uses to know how far back
// bid rows can already be gone (L592). Two copies of one number drift silently:
// the check would then judge a window the purge no longer keeps. So this reads
// both and requires them to agree, from the migration that defines the
// procedure LAST, which is the one the database runs.
//
// Read as text because apps/worker targets the Workers runtime and its own
// suite cannot read the filesystem, which is why this guard lives here.

const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations')
const WORKER_EXPORT = path.join(REPO_ROOT, 'apps/worker/src/lib/sightings-export.ts')

function latestProcedureSql(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  let latest: { file: string; sql: string } | null = null
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    if (/CREATE OR REPLACE PROCEDURE public\.purge_exported_sightings\(/.test(sql)) latest = { file, sql }
  }
  if (latest === null) throw new Error('No migration defines public.purge_exported_sightings, so its grace cannot be read')
  return latest
}

describe('the sightings purge grace is one number (#541)', () => {
  const { file, sql } = latestProcedureSql()
  const workerHours = Number(/export const PURGE_GRACE_HOURS = (\d+)/.exec(readFileSync(WORKER_EXPORT, 'utf8'))?.[1])

  it('was read from both places', () => {
    expect(Number.isInteger(workerHours)).toBe(true)
    expect(sql).toMatch(/p_grace\s+INTERVAL\s+DEFAULT interval '\d+ hours'/i)
  })

  it('the procedure default matches PURGE_GRACE_HOURS', () => {
    const sqlDefault = Number(/p_grace\s+INTERVAL\s+DEFAULT interval '(\d+) hours'/i.exec(sql)?.[1])
    expect(sqlDefault, file).toBe(workerHours)
  })

  it('the floor a caller cannot go below matches it too', () => {
    const floor = Number(/greatest\(p_grace, interval '(\d+) hours'\)/i.exec(sql)?.[1])
    expect(floor, file).toBe(workerHours)
  })
})
