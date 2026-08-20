import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * pg_cron_health must count a run as failed only once it has FINISHED.
 *
 * It previously counted every row whose status was not 'succeeded', which
 * includes a run that has started and is still working. Observed in production
 * on 2026-08-20: Slack reported one failed run for two different jobs, quoting
 * timestamps that are the START times of two runs both recorded as succeeded,
 * with "no message recorded" because a run in flight has not written one.
 * Queried afterwards the function reported zero failures in the same window.
 *
 * The watcher runs hourly on the hour, and the two jobs affected fire every 5
 * and every 30 minutes, so it collided essentially every hour. An alert that
 * cries wolf gets ignored, and the cost is the real failures this exists to
 * surface (L36).
 *
 * This asserts the shipped definition, in the migration that is the source of
 * truth for it, rather than a copy of the rule written beside it (L107).
 */
const MIGRATIONS = join(process.cwd(), '..', '..', 'supabase', 'migrations')

/** The definition that actually ships is the one in the LAST migration to touch it. */
function shippedDefinition(): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  let found: { file: string; sql: string } | null = null
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    if (/FUNCTION\s+(public\.)?pg_cron_health/i.test(sql)) found = { file, sql }
  }
  if (!found) throw new Error('no migration defines pg_cron_health, so this guard would pass vacuously')
  return found
}

/** The body of the failures CTE, which is the part that decides what counts. */
function failuresClause(sql: string): string {
  const match = /WITH\s+failures\s+AS\s*\(([\s\S]*?)\),/i.exec(sql)
  if (!match) throw new Error('could not find the failures CTE, so the assertions below would not be checking it')
  return match[1]
}

describe('the shipped pg_cron_health definition', () => {
  const { file, sql } = shippedDefinition()
  const failures = failuresClause(sql)

  it('was found in a real migration, so this file cannot pass vacuously', () => {
    expect(file).toMatch(/\.sql$/)
    expect(failures.length).toBeGreaterThan(50)
  })

  // The load-bearing line. Without it, a run that started seconds ago and is
  // still working is counted as a failure.
  it('counts only runs that have finished', () => {
    expect(failures).toMatch(/end_time\s+IS\s+NOT\s+NULL/i)
  })

  it('still counts a finished run that did not succeed', () => {
    expect(failures).toMatch(/status\s*<>\s*'succeeded'/i)
  })

  // Keyed on the absence of an end time rather than on a list of in-progress
  // status names, so an unrecognised terminal status still counts as a failure
  // instead of being waved through by a name the list forgot (L93).
  it('does not decide by matching in-progress status names', () => {
    for (const name of ['running', 'starting', 'sending', 'connecting', 'scheduled']) {
      expect(failures.toLowerCase(), `decides by the '${name}' status name`).not.toContain(`'${name}'`)
    }
  })

  it('keeps the window bounded, since the run table is never pruned', () => {
    expect(failures).toMatch(/window_hours/)
  })

  it('is not callable by anon or authenticated over the REST API', () => {
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.pg_cron_health/i)
  })
})
