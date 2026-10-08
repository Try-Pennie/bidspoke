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
 * `cron.alter_job` in the one shape this repo writes it (#1884): the job found
 * by name, then an optional new schedule and an optional new command, each by
 * named argument. Altering in place keeps the jobid and so the run history,
 * which an unschedule and reschedule discards.
 */
const ALTER_RE =
  /cron\.alter_job\(\s*job_id\s*:=\s*\(\s*SELECT\s+jobid\s+FROM\s+cron\.job\s+WHERE\s+jobname\s*=\s*'([^']+)'\s*\)\s*(?:,\s*schedule\s*:=\s*'([^']+)'\s*)?(?:,\s*command\s*:=\s*\$\$([\s\S]*?)\$\$\s*)?\)/g
/** Any alter_job at all, so one written in a shape ALTER_RE misses is refused rather than skipped (L100). */
const ANY_ALTER_RE = /cron\.alter_job\s*\(/g

/**
 * The cron jobs a fresh database would hold after every migration is applied,
 * keyed by job name. An unschedule with no later schedule removes the job.
 */
export function liveCronJobs(migrations: MigrationFile[] = readMigrations()): Map<string, CronJob> {
  const jobs = new Map<string, CronJob>()
  for (const { name: migration, sql } of migrations) {
    // Order matters within a file: the unschedule/reschedule pair is the normal
    // way a schedule is changed, so walk every event in the order it appears.
    interface Alter { name: string; schedule?: string; command?: string }
    interface Event { at: number; kind: 'schedule' | 'unschedule' | 'alter'; job: CronJob | string | Alter }
    const events: Event[] = []
    const alters = [...sql.matchAll(ALTER_RE)]
    const anyAlters = [...sql.matchAll(ANY_ALTER_RE)]
    if (alters.length !== anyAlters.length) {
      throw new Error(
        `${migration}: ${anyAlters.length} cron.alter_job call(s) but only ${alters.length} in the shape this parser reads ` +
          "(job_id := (SELECT jobid FROM cron.job WHERE jobname = '...'), schedule := '...', command := $$...$$)",
      )
    }
    for (const m of alters) {
      events.push({
        at: m.index ?? 0,
        kind: 'alter',
        job: { name: m[1], schedule: m[2], command: m[3]?.trim() },
      })
    }
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
      else if (e.kind === 'unschedule') jobs.delete(e.job as string)
      else {
        const alter = e.job as Alter
        const current = jobs.get(alter.name)
        // On a fresh database cron.alter_job fails on a job that does not exist,
        // so a parse that reaches here has found a migration that cannot replay.
        if (!current) throw new Error(`${migration}: cron.alter_job on '${alter.name}', which no earlier migration schedules`)
        jobs.set(alter.name, {
          name: alter.name,
          schedule: alter.schedule ?? current.schedule,
          command: alter.command ?? current.command,
          migration,
        })
      }
    }
  }
  return jobs
}

/** The worker's cron triggers, read from apps/worker/wrangler.toml. */
export function workerCrons(): string[] {
  const toml = readFileSync(path.join(REPO_ROOT, 'apps/worker/wrangler.toml'), 'utf8')
  const m = /^crons\s*=\s*\[([^\]]*)\]/m.exec(toml)
  if (!m) throw new Error('apps/worker/wrangler.toml declares no crons = [...] line')
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

/**
 * The values one cron field names, inside [lo, hi]: `*`, `*\/n`, `a`, `a-b`,
 * `a-b/n` and comma lists of them. Null for anything else, so a caller cannot
 * read an unparsed field as firing never.
 */
export function cronFieldValues(field: string, lo: number, hi: number): number[] | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return null
    const step = m[4] === undefined ? 1 : Number(m[4])
    const from = m[1] === '*' ? lo : Number(m[2])
    const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from
    if (step < 1 || from < lo || to > hi || from > to) return null
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out.size === 0 ? null : [...out].sort((a, b) => a - b)
}

/**
 * Every minute of the day (hour * 60 + minute) a schedule can start in, or null
 * when the minute or hour field is not readable. The day of month, month and
 * weekday fields are ignored on purpose: a weekly job is treated as firing every
 * day, which can only find MORE collisions, never hide one.
 */
export function minutesOfDay(schedule: string): Set<number> | null {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minutes = cronFieldValues(fields[0], 0, 59)
  const hours = cronFieldValues(fields[1], 0, 23)
  if (!minutes || !hours) return null
  const out = new Set<number>()
  for (const h of hours) for (const m of minutes) out.add(h * 60 + m)
  return out
}

/**
 * The body of the newest CREATE [OR REPLACE] FUNCTION/PROCEDURE for `name`,
 * scoped to that one definition so a match elsewhere in a large migration
 * cannot answer for it (LESSONS L135).
 *
 * The opening delimiter is whatever dollar quote the routine actually uses, not
 * `$$`. Postgres allows any tag, and the deletion gate's own routines are
 * written `AS $function$`. Reading only `$$` did not fail loudly on those: it
 * found the next `$$` belonging to some LATER routine in the same file and
 * returned a body from the wrong definition, or none at all, so a guard built on
 * it passed while inspecting nothing (#1143, L98).
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
      // The first dollar quote after the header opens the body; its own tag
      // closes it. An empty tag is the ordinary `$$` case.
      const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(from))
      if (open === null) continue
      const tag = open[0]
      const bodyStart = from + (open.index ?? 0) + tag.length
      const close = sql.indexOf(tag, bodyStart)
      if (close === -1) continue
      found = { body: sql.slice(bodyStart, close), migration }
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
