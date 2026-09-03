import { describe, it, expect } from 'vitest'
import { readMigrations, stripSqlComments } from './_pg-cron'

/**
 * The migration directory has to be replayable onto an empty database, because
 * that is the only way to stand up a fresh one: a Supabase preview branch, a
 * staging project, a local stack, or a database in CI.
 *
 * NOT because of disaster recovery, which was the first assumption here and was
 * wrong. `docs/disaster-recovery.md` Scenario A restores from a dump in every case,
 * including total project loss, and then applies only PENDING migrations, so
 * recovery never replays this directory from empty. Recorded because a wrong reason
 * attached to a correct guard is worse than no reason: it is read as a considered
 * decision and argued with instead of the code.
 *
 * The real cost is compounding, and it is why this went unnoticed for months. With
 * no way to create a working empty database, nothing in this repo has ever been
 * tested against real Postgres: every SQL guard reads migration TEXT rather than
 * executing it, including this one.
 *
 * It was not replayable. Measured 2026-09-03 on two independent throwaway branches:
 * both applied 22 of 119 migrations and both stopped at the same file.
 * `20260424000001` opened with `DROP CONSTRAINT execution_steps_execution_fk`, a
 * name that appears nowhere earlier in the history, because
 * `20260402000002_core_tables.sql` declares that foreign key inline and unnamed and
 * Postgres therefore auto-names it. The dropped name only ever existed in
 * production, where somebody had made it by hand. So the statement raised `42704`
 * on any fresh database and the remaining 96 migrations never ran, from
 * 2026-04-24 until it was found.
 *
 * The failure was silent in the direction that matters. Production was fine, every
 * migration after it applied there one at a time, and nothing ever replayed the
 * directory from scratch, so the recovery path degraded with no signal at all.
 *
 * This guard is the cheap half of the fix: it catches the CLASS statically, on
 * every push. It cannot prove a replay succeeds, and it is not a substitute for
 * actually rehearsing one against a real empty database.
 */

/**
 * Dropping a named object without `IF EXISTS`.
 *
 * The name is the fragile part. A constraint or index whose name was never chosen
 * explicitly gets one from Postgres, and that generated name depends on the
 * columns and on how many siblings already exist, so a migration that hardcodes
 * one is asserting something about a database it did not build. `IF EXISTS` makes
 * the statement idempotent and replayable; a lookup by shape is stronger still.
 *
 * TRIGGER and POLICY are included because both are routinely dropped by name and
 * both fail the same way. TABLE, FUNCTION, VIEW and TYPE are deliberately NOT:
 * their names are always chosen by whoever wrote the CREATE, so a hardcoded name
 * is a fact about this repository rather than a guess about Postgres.
 */
const UNGUARDED_DROP =
  /\bDROP\s+(CONSTRAINT|INDEX|COLUMN|TRIGGER|POLICY)\s+(?!IF\s+EXISTS\b)([A-Za-z_][\w$]*)/gi

describe('every migration can be replayed onto an empty database', () => {
  const migrations = readMigrations()

  it('reads the whole migration directory', () => {
    // A regex that matches nothing makes the assertion below vacuous and green
    // (L100), and a scan that covered nothing has not earned the right to report
    // clean (L98). This is the count guard for the file list itself.
    expect(migrations.length).toBeGreaterThan(100)
  })

  it('no migration drops a named constraint, index, column, trigger or policy without IF EXISTS', () => {
    const offenders: string[] = []
    for (const { name, sql } of migrations) {
      // readMigrations already strips comments, so prose describing one of these
      // statements cannot satisfy or trip the check (L103). Re-stripping is
      // harmless and keeps the guard correct if that ever changes.
      for (const m of stripSqlComments(sql).matchAll(UNGUARDED_DROP)) {
        offenders.push(`${name}: DROP ${m[1].toUpperCase()} ${m[2]}`)
      }
    }
    expect(
      offenders,
      'these will raise on an empty database and stop every later migration:\n  ' +
        offenders.join('\n  '),
    ).toEqual([])
  })

  it('the guard actually matches the statement that broke the replay', () => {
    // Without this, the assertion above passes just as well when the regex is
    // broken, and the whole file becomes decorative. This is the shape the real
    // defect had, character for character from the migration as it was.
    const wasBroken = 'ALTER TABLE execution_steps\n  DROP CONSTRAINT execution_steps_execution_fk;'
    expect([...wasBroken.matchAll(UNGUARDED_DROP)]).toHaveLength(1)

    // And it must NOT fire on the guarded form, or the only way to satisfy it
    // would be to delete the statement.
    const isFixed = 'ALTER TABLE execution_steps DROP CONSTRAINT IF EXISTS execution_steps_execution_fk;'
    expect([...isFixed.matchAll(UNGUARDED_DROP)]).toHaveLength(0)

    // Case and whitespace are not the contract; the shape is.
    expect([...'drop   constraint   foo'.matchAll(UNGUARDED_DROP)]).toHaveLength(1)
    expect([...'DROP CONSTRAINT if exists foo'.matchAll(UNGUARDED_DROP)]).toHaveLength(0)
  })
})
