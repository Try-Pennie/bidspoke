import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

/**
 * Shared reader for the pg_cron jobs and SQL functions declared across
 * supabase/migrations. Several guards need the same view, so it is parsed once
 * here rather than three times with three slightly different regexes.
 *
 * Migrations are applied in filename order and both cron.schedule and
 * CREATE OR REPLACE FUNCTION are last-writer-wins, so the authoritative
 * definition of anything is the one in the newest migration that touches it.
 * A guard reading the FIRST definition would pass on a value that was
 * superseded months ago.
 */

export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations')

/** Comments are stripped everywhere, so a guard can never be satisfied by prose
 * describing the thing it checks for (LESSONS L103). */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, '')
}

export interface MigrationFile {
  name: string
  sql: string
}

export function readMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: stripSqlComments(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')),
    }))
}

export interface CronJob {
  name: string
  schedule: string
  command: string
  migration: string
}

const SCHEDULE_RE =
  /cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(?:\$\$([\s\S]*?)\$\$|'((?:[^']|'')*)')\s*\)/g
const UNSCHEDULE_NAME_RE = /cron\.unschedule\(\s*'([^']+)'\s*\)/g
const UNSCHEDULE_JOBID_RE = /cron\.unschedule\(\s*jobid\s*\)[\s\S]{0,200}?jobname\s*=\s*'([^']+)'/g

/**
 * The cron jobs a fresh database would hold after every migration is applied,
 * keyed by job name. An unschedule with no later schedule removes the job.
 */
export function liveCronJobs(migrations: MigrationFile[] = readMigrations()): Map<string, CronJob> {
  const jobs = new Map<string, CronJob>()
  for (const { name: migration, sql } of migrations) {
    // Order matters within a file: the unschedule/reschedule pair is the normal
    // way a schedule is changed, so walk every event in the order it appears.
    interface Event { at: number; kind: 'schedule' | 'unschedule'; job: CronJob | string }
    const events: Event[] = []
    for (const m of sql.matchAll(SCHEDULE_RE)) {
      events.push({
        at: m.index ?? 0,
        kind: 'schedule',
        job: {
          name: m[1],
          schedule: m[2],
          command: (m[3] ?? m[4] ?? '').trim(),
          migration,
        },
      })
    }
    for (const re of [UNSCHEDULE_NAME_RE, UNSCHEDULE_JOBID_RE]) {
      for (const m of sql.matchAll(re)) {
        events.push({ at: m.index ?? 0, kind: 'unschedule', job: m[1] })
      }
    }
    for (const e of events.sort((a, b) => a.at - b.at)) {
      if (e.kind === 'schedule') jobs.set((e.job as CronJob).name, e.job as CronJob)
      else jobs.delete(e.job as string)
    }
  }
  return jobs
}

/**
 * The body of the newest CREATE [OR REPLACE] FUNCTION/PROCEDURE for `name`,
 * scoped to that one definition so a match elsewhere in a large migration
 * cannot answer for it (LESSONS L135).
 */
export function latestRoutineBody(
  name: string,
  migrations: MigrationFile[] = readMigrations(),
): { body: string; migration: string } | null {
  let found: { body: string; migration: string } | null = null
  const header = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\s+(?:public\\.)?${name}\\s*\\(`,
    'gi',
  )
  for (const { name: migration, sql } of migrations) {
    for (const m of sql.matchAll(header)) {
      const from = m.index ?? 0
      const open = sql.indexOf('$$', from)
      if (open === -1) continue
      const close = sql.indexOf('$$', open + 2)
      if (close === -1) continue
      found = { body: sql.slice(open + 2, close), migration }
    }
  }
  return found
}

/** The integer literal a cron command passes, e.g. `SELECT f(7)` -> 7. */
export function commandArg(command: string): number | null {
  const m = /\(\s*(\d+)\s*\)/.exec(command)
  return m ? Number(m[1]) : null
}

/** The routine a cron command invokes, e.g. `CALL foo(7)` -> `foo`. */
export function commandRoutine(command: string): string | null {
  const m = /(?:SELECT|CALL)\s+(?:public\.)?([a-z0-9_]+)\s*\(/i.exec(command)
  return m ? m[1] : null
}

/** The minute field of a 5-field cron expression. */
export function cronMinute(schedule: string): string {
  return schedule.trim().split(/\s+/)[0] ?? ''
}
