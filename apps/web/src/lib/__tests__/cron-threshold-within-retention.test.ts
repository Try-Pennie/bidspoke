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
 *
 * It lives here rather than in `__guards__/worker/` because it reads
 * `supabase/migrations`, not worker source. The placement guard enforces that
 * distinction and caught this file in the wrong directory on the first run.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'
import { EXECUTION_RETENTION_DAYS } from '../execution-retention'

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
      found = parseDays(m[1], `retention argument in ${file}`)
    }
  }
  expect(found, 'no migration schedules a partition purge, so this guard has no window to judge against').not.toBeNull()
  return found as number
}

/**
 * Parse a day count, refusing anything that is not a finite positive integer.
 *
 * The direct `Number(...)` this replaces is L50 exactly: a value that fails to
 * parse yields NaN, and NaN compares false against EVERY threshold, so the
 * comparison below would silently pass on every job. For a guard that is the
 * worst available outcome, because it reports green while blind. The regexes here
 * capture digits only, so this should be unreachable; that is precisely the
 * argument that stops being true the first time somebody widens one.
 */
export function parseDaysForTest(raw: string): number {
  return parseDays(raw, 'test')
}

function parseDays(raw: string, where: string): number {
  const n = Number(raw)
  expect(Number.isInteger(n) && n > 0, `could not read a day count from "${raw}" (${where})`).toBe(true)
  return n
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

    // Asserted rather than assumed: if retention itself were NaN, every
    // comparison below would be false and this guard would pass on everything.
    expect(Number.isInteger(retention) && retention > 0).toBe(true)

    for (const [name, body] of liveCronJobs()) {
      for (const m of body.matchAll(/INTERVAL\s+'(\d+)\s+days?'/gi)) {
        const days = parseDays(m[1], `cron job ${name}`)
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

describe('the day-count parser', () => {
  // A guard whose number parsing can yield NaN passes on everything, silently,
  // which is worse than having no guard (L50). So the refusal has its own test
  // rather than resting on the regexes happening to capture digits today.
  it('refuses anything that is not a positive integer', () => {
    for (const bad of ['', 'seven', '0', '-3', '1.5', 'NaN']) {
      expect(() => parseDaysForTest(bad), bad).toThrow()
    }
  })

  it('accepts a plain day count', () => {
    expect(parseDaysForTest('7')).toBe(7)
    expect(parseDaysForTest('14')).toBe(14)
  })
})

describe('the retention window itself', () => {
  it('is the 21 days the purge actually runs at', () => {
    // Pinned so a change to retention is a deliberate act that updates this
    // line, rather than something the guard silently absorbs.
    //
    // TEMPORARILY 21 (2026-08-24, migration 20260824000002): roughly 119 hours
    // across 2026-08-17 to 08-23 were still unarchived with nobody available to
    // intervene, and deletion is not gated on the archive yet (#873), so a stalled
    // backlog walk would delete unbacked-up days with no alert at all. Back to 7
    // once every day the database holds shows 24 archived hours.
    expect(retentionDays()).toBe(21)
  })

  it('is the same number the UI quotes to people', () => {
    // `EXECUTION_RETENTION_DAYS` is what the missing-execution notice states, and
    // its own comment asked for the two to be updated together with nothing
    // enforcing it: a list maintained by hand beside its source of truth (L41).
    // The cron is the authority, because it is the thing that deletes.
    expect(EXECUTION_RETENTION_DAYS).toBe(retentionDays())
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
