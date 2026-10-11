import { describe, expect, it } from 'vitest'
import { liveCronJobs, readMigrations } from './_pg-cron'

/**
 * Every scheduled pg_cron job has a chosen statement_timeout, not the silently
 * inherited cluster default (#1149).
 *
 * pg_cron runs as `postgres`, which carried no statement_timeout, so every job
 * inherited the 120s cluster default; nothing chose it, and it killed
 * refresh_field_presence_daily at 121.97s while every health signal read normal
 * (#1147). There are two shapes of job and the budget reaches them differently
 * (measured on Postgres 17, 2026-10-11):
 *
 *   * a SELECT-of-function job states its budget in its own cron command
 *     (`SET statement_timeout = '...'; ... SELECT fn()`), which binds because the
 *     function runs as one statement;
 *   * a CALL-of-procedure job cannot: the procedure COMMITs internally, and a
 *     multi-statement `SET ...; CALL proc()` runs in one implicit transaction whose
 *     COMMIT then fails. Those jobs take the budget from the postgres role default,
 *     which 20261011140000 states explicitly.
 */

/** The value a `SET <name> = '<literal>'` assigns in a command, or null. */
function statementTimeoutOf(command: string): string | null {
  return /SET\s+statement_timeout\s*=\s*'([^']+)'/i.exec(command)?.[1] ?? null
}

/** A command whose operative statement is CALL (a procedure), vs SELECT (a function). */
function isProcedureCall(command: string): boolean {
  return /\bCALL\s+/i.test(command)
}

const jobs = [...liveCronJobs().values()]

describe('every scheduled job has a chosen statement_timeout (#1149)', () => {
  it('reads a full set of jobs (anti-vacuous)', () => {
    // A broken parse makes every assertion below pass on an empty list (L100).
    const procedures = jobs.filter((j) => isProcedureCall(j.command))
    const functions = jobs.filter((j) => !isProcedureCall(j.command))
    expect(jobs.length).toBeGreaterThanOrEqual(14)
    expect(functions.length).toBeGreaterThanOrEqual(8)
    expect(procedures.length).toBeGreaterThanOrEqual(4)
  })

  for (const job of jobs.filter((j) => !isProcedureCall(j.command))) {
    it(`${job.name} (a function job) states its own statement_timeout`, () => {
      const value = statementTimeoutOf(job.command)
      expect(value, `${job.name} has no statement_timeout in its cron command: ${job.command}`).not.toBeNull()
      expect(/^\d+/.test(value!)).toBe(true)
    })
  }

  for (const job of jobs.filter((j) => isProcedureCall(j.command))) {
    it(`${job.name} (a procedure job) does not carry a per-command statement_timeout`, () => {
      // A SET before a committing CALL breaks it, so these must NOT have one; they
      // rely on the role default asserted below. Catching a per-command SET here
      // keeps someone from adding one that would fail at runtime.
      expect(
        statementTimeoutOf(job.command),
        `${job.name} is a CALL of a committing procedure; a per-command statement_timeout breaks its COMMIT`,
      ).toBeNull()
    })
  }

  it('the postgres role default statement_timeout is stated explicitly, and is a sane budget', () => {
    // The last ALTER ROLE wins. Assert the effective value is a real duration of at
    // least 30s, so a later migration setting an absurdly small one (which would
    // start killing the CALL-procedure jobs) fails here rather than passing on mere
    // presence.
    const re = /ALTER\s+ROLE\s+postgres\s+SET\s+statement_timeout\s*=\s*'([^']+)'/gi
    let last: string | null = null
    for (const m of readMigrations()) {
      for (const hit of m.sql.matchAll(re)) last = hit[1]
    }
    expect(last, 'no migration states ALTER ROLE postgres SET statement_timeout').not.toBeNull()
    const ms = /^(\d+)\s*(ms|s|min)?$/.exec(last!.trim())
    expect(ms, `unparsable role statement_timeout '${last}'`).not.toBeNull()
    const n = Number(ms![1])
    const value = ms![2] === 's' ? n * 1000 : ms![2] === 'min' ? n * 60_000 : n
    expect(value, `the postgres role statement_timeout '${last}' is below a sane 30s floor`).toBeGreaterThanOrEqual(30_000)
  })
})
