import { describe, it, expect } from 'vitest'
import { latestRoutineBody, readMigrations } from './_pg-cron'

/**
 * pg_cron_health must return each job's jobid.
 *
 * The watcher grants a job with no successful run on record a grace period
 * before it pages, so that a job which was just rescheduled, and whose run
 * history a reschedule orphans, is not reported as dead. That grace is only
 * sound if the stamp recording when the job was first seen belongs to the job
 * being judged, and jobid is the only field that says so: `cron.unschedule`
 * plus `cron.schedule` mints a new jobid, while the name and the schedule can
 * both survive unchanged.
 *
 * On 2026-09-04 a migration changed only the COMMAND of the two nightly rollup
 * jobs. Both came back under new jobids with no run history, both inherited the
 * first-seen stamp written for their previous incarnation 17 days earlier under
 * an identical name and schedule, and both paged as "has never succeeded" 30
 * minutes after a healthy deploy (#1152, L576).
 *
 * Asserts the shipped definition in the migration that is the source of truth
 * for it, read through the shared reader that strips SQL comments, so nothing
 * here can be satisfied by prose describing the rule rather than the rule
 * itself (L103, L107).
 */
const MIGRATIONS = readMigrations()

function shippedDefinition(): { file: string; body: string; sql: string } {
  const found = latestRoutineBody('pg_cron_health', MIGRATIONS)
  if (!found) throw new Error('no migration defines pg_cron_health, so this guard would pass vacuously')
  const migration = MIGRATIONS.find((m) => m.name === found.migration)
  if (!migration) throw new Error(`migration ${found.migration} is not in the migration list`)
  return { file: found.migration, body: found.body, sql: migration.sql }
}

/**
 * The declared return columns, and nothing else.
 *
 * The first version of this file asked whether `jobid` appeared anywhere
 * between `RETURNS TABLE (` and a later `)`, which every version of this
 * function has always satisfied: the run-detail CTEs mention `d.jobid` and the
 * join mentions `j.jobid`, so the guard passed against the very definition it
 * was written to reject. Each clause is isolated here instead (L1, L63).
 */
function returnColumns(sql: string): string {
  const match = /RETURNS\s+TABLE\s*\(([^)]*)\)/i.exec(sql)
  if (!match) throw new Error('could not find the RETURNS TABLE list, so the assertions below would not be checking it')
  return match[1]
}

/** The final query over cron.job, split from the CTEs above it. */
function finalQuery(body: string): { select: string; groupBy: string } {
  const fromIdx = body.search(/FROM\s+cron\.job\s+j\b/i)
  if (fromIdx < 0) throw new Error('could not find the final query over cron.job, so the assertions below would not be checking it')
  const selectIdx = body.lastIndexOf('SELECT', fromIdx)
  if (selectIdx < 0) throw new Error('the final query over cron.job has no SELECT above it')
  const groupMatch = /GROUP\s+BY([\s\S]*)$/i.exec(body.slice(fromIdx))
  if (!groupMatch) throw new Error('the final query over cron.job has no GROUP BY')
  return { select: body.slice(selectIdx, fromIdx), groupBy: groupMatch[1] }
}

describe('the shipped pg_cron_health definition', () => {
  const { file, body, sql } = shippedDefinition()
  const columns = returnColumns(sql)
  const { select, groupBy } = finalQuery(body)

  it('was found in a real migration, so this file cannot pass vacuously', () => {
    expect(file).toMatch(/\.sql$/)
    expect(columns).toMatch(/jobname/)
    expect(select).toMatch(/j\.jobname/)
    expect(groupBy).toMatch(/j\.jobname/)
  })

  it('declares jobid among the columns it returns', () => {
    expect(columns).toMatch(/\bjobid\b/)
  })

  it('selects the jobid from cron.job rather than from the run details', () => {
    // The run rows carry a jobid too, but a job with no runs at all has no run
    // rows, and that is precisely the job whose identity this has to report.
    expect(select).toMatch(/j\.jobid/)
  })

  it('groups by jobid, so one job stays one row', () => {
    expect(groupBy).toMatch(/j\.jobid/)
  })

  it('is not callable by anon or authenticated over the REST API', () => {
    // A DROP discards the ACL, so a definition that replaces this one by
    // dropping and recreating has to re-issue the revoke (L124).
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.pg_cron_health/i)
  })
})
