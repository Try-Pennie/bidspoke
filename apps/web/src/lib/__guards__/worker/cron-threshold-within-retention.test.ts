/**
 * A scheduled job whose age threshold sits outside the retention window can
 * never fire (#826).
 *
 * `compact-execution-payloads` nulled payloads on rows older than 14 days while
 * the partition purge truncated them at 7. No row could ever reach 14 days, so
 * it matched zero rows on every run for months. Measured 2026-08-21: 0 rows
 * older than 14 days, and the oldest live execution was 7 days old.
 *
 * The wasted run was not the problem. The problem was that a migration comment
 * described the job as a second line of defence scrubbing payloads, so anyone
 * reasoning about exposure would conclude one existed. It did not.
 *
 * This guard is the class, not the instance (L30). Dropping the one dead job
 * fixes today; the next person to shorten retention, or to add a job with a
 * generous threshold, recreates it. A job that cannot fire is indistinguishable
 * from a job with nothing to do (L98), so nothing at runtime will ever report it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations')

const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()

const allSql = (): string => migrationFiles().map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8')).join('\n')

/**
 * The retention window in days, taken from the LAST migration that schedules a
 * partition purge. Derived rather than hardcoded, so halving retention again
 * cannot leave this guard asserting against a number nobody uses (L41).
 */
export function retentionDays(): number {
  let found: number | null = null
  for (const file of migrationFiles()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8')
    // Only the form used inside a cron.schedule body counts as setting the live
    // window; a one-off manual CALL in a backfill migration does not.
    for (const m of sql.matchAll(/'(?:CALL\s+)?(?:truncate|drop)_expired_execution_partitions(?:_safe)?\((\d+)\)'/g)) {
      found = Number(m[1])
    }
  }
  expect(found, 'no migration schedules a partition purge, so this guard has no window to judge against').not.toBeNull()
  return found as number
}

/**
 * Cron jobs still scheduled at the end of migration history: every name passed
 * to `cron.schedule`, minus every name later unscheduled. Without the
 * subtraction this would keep reporting a job that was deliberately removed,
 * since the migration that created it stays in history forever.
 */
export function liveCronJobs(): Map<string, string> {
  const jobs = new Map<string, string>()
  for (const file of migrationFiles()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8')

    // cron.schedule('name', 'schedule', $$ body $$)
    for (const m of sql.matchAll(/cron\.schedule\(\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*(\$\$[\s\S]*?\$\$|'(?:[^']|'')*')/g)) {
      jobs.set(m[1], m[2])
    }
    // cron.unschedule('name'), and the jobid form used when a job is removed by
    // its true identity. The jobid form cannot name what it removed, so a
    // migration using it must say so in a comment naming the job; that is what
    // the second assertion below checks.
    for (const m of sql.matchAll(/cron\.unschedule\(\s*'([^']+)'\s*\)/g)) {
      jobs.delete(m[1])
    }
    for (const m of sql.matchAll(/jobname\s*=\s*'([^']+)'[\s\S]{0,600}?cron\.unschedule\(/g)) {
      jobs.delete(m[1])
    }
  }
  return jobs
}

describe('a cron job threshold must sit inside the retention window', () => {
  it('reads a retention window and some live jobs, so it is asserting something', () => {
    expect(retentionDays()).toBeGreaterThan(0)
    expect(liveCronJobs().size).toBeGreaterThan(0)
  })

  // The check. A job that nulls or deletes rows older than N days, where N is at
  // or beyond the point the rows are physically gone, can never match anything.
  it('has no live job whose day threshold is at or beyond retention', () => {
    const retention = retentionDays()
    const offenders: string[] = []

    for (const [name, body] of liveCronJobs()) {
      for (const m of body.matchAll(/INTERVAL\s+'(\d+)\s+days?'/gi)) {
        const days = Number(m[1])
        if (days >= retention) offenders.push(`${name}: INTERVAL '${days} days' against ${retention} day retention`)
      }
    }

    expect(
      offenders,
      `these scheduled jobs can never match a row, because the rows are purged before reaching their threshold:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  // The specific job, kept as a named regression: it is the one that was dead
  // for months, and a guard whose general form got weakened would still fail
  // here (L63).
  it('no longer schedules compact-execution-payloads', () => {
    expect(liveCronJobs().has('compact-execution-payloads')).toBe(false)
  })

  // An unschedule by jobid cannot name the job it removed, so the name has to be
  // findable in the migration for the subtraction above to work at all. This
  // asserts the mechanism the guard depends on, rather than trusting it.
  it('can see a job removed by jobid rather than by name', () => {
    const dropMigration = readdirSync(MIGRATIONS).find((f) => f.includes('drop_dead_payload_compaction'))
    expect(dropMigration, 'the migration that drops the job is missing').toBeDefined()
    const sql = readFileSync(path.join(MIGRATIONS, dropMigration as string), 'utf8')
    expect(sql).toMatch(/jobname\s*=\s*'compact-execution-payloads'/)
    expect(sql).toMatch(/cron\.unschedule\(/)
  })
})

describe('the retention window itself', () => {
  it('is the 7 days the purge actually runs at', () => {
    // Pinned so a change to retention is a deliberate act that updates this
    // line, rather than something the guard silently absorbs.
    expect(retentionDays()).toBe(7)
  })

  it('is not contradicted by the whole migration corpus mentioning a longer one', () => {
    // A sanity check on the derivation: if a LATER migration schedules a purge
    // at a different number, retentionDays must have picked that one up.
    const scheduled = [...allSql().matchAll(/'(?:CALL\s+)?(?:truncate|drop)_expired_execution_partitions(?:_safe)?\((\d+)\)'/g)].map(
      (m) => Number(m[1]),
    )
    expect(scheduled.length).toBeGreaterThan(0)
    expect(scheduled[scheduled.length - 1]).toBe(retentionDays())
  })
})
