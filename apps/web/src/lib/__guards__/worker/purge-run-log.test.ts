import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'
import { latestRoutineBody, readMigrations, stripSqlComments } from '../../__tests__/_pg-cron'

/**
 * The purge says which days it refused, and why (#1142).
 *
 * Both destructive procedures reported what they did, and what they refused,
 * only through RAISE NOTICE and RAISE WARNING. pg_cron records the run in
 * cron.job_run_details but not the notices, so the day list a run refused and
 * the reason for each was lost the moment it finished. A night where the gate
 * spared six days because the archive was short was indistinguishable, from
 * outside, from a night where nothing was expired at all.
 *
 * These are source guards, which is what CI can run with no database. The
 * behaviour is exercised by supabase/tests/verified_deletion_gate.test.sql
 * against a real one.
 */

const PROCEDURES = ['truncate_verified_execution_partitions', 'drop_verified_execution_partitions']

/** Outcomes that must exist, DERIVED from the reason codes the gate can return. */
const GATE_TS = path.join(REPO_ROOT, 'apps/worker/src/archive/gate.ts')

function bodyOf(routine: string): string {
  const found = latestRoutineBody(routine)
  expect(found, `${routine} is not defined in any migration`).not.toBeNull()
  return found!.body
}

describe('the purge log exists and is written by both destructive procedures', () => {
  it('a purge_run_log table is created', () => {
    const created = readMigrations().some((m) =>
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.purge_run_log/i.test(stripSqlComments(m.sql)),
    )
    expect(created, 'no migration creates public.purge_run_log').toBe(true)
  })

  for (const procedure of PROCEDURES) {
    it(`${procedure} writes to it`, () => {
      expect(bodyOf(procedure)).toMatch(/INSERT\s+INTO\s+public\.purge_run_log/i)
    })

    it(`${procedure} records an empty night as its own outcome`, () => {
      // Otherwise a night with nothing expired and a night where every day was
      // refused both leave no rows, and the log answers neither (L98).
      expect(bodyOf(procedure)).toContain('nothing_expired')
    })

    it(`${procedure} records a refusal against the day it refused`, () => {
      const body = bodyOf(procedure)
      expect(body).toContain('refused_unverified')
      // Keyed on the reason code the decision returned, not on prose assembled
      // here, so the log can be grouped and counted.
      expect(body).toMatch(/expired_day_verdicts/i)
    })
  }

  it('the truncate records a partition it gave up on after lock timeouts', () => {
    // A partition skipped for the whole run is a deletion that did not happen,
    // and it was previously only a RAISE WARNING.
    expect(bodyOf('truncate_verified_execution_partitions')).toContain('gave_up_locked')
  })

  it('the reap records a partition it refused for still holding rows', () => {
    expect(bodyOf('drop_verified_execution_partitions')).toContain('refused_non_empty')
  })
})

describe('expiry is defined once, so the log and the deletion cannot disagree', () => {
  it('verified_purgeable_days reads the same verdicts the log records', () => {
    // Two copies of "which days are past retention" is the defect this milestone
    // exists to remove, one level down: the log would then be able to report a
    // day the purge never considered, or stay silent about one it deleted (L370).
    expect(bodyOf('verified_purgeable_days')).toMatch(/expired_day_verdicts/i)
  })

  it('the expiry arithmetic appears in exactly one routine', () => {
    const routines = ['expired_day_verdicts', 'verified_purgeable_days']
    const withArithmetic = routines.filter((r) =>
      /archive_day\s*\+\s*1\s*<=/.test(bodyOf(r)),
    )
    expect(withArithmetic).toEqual(['expired_day_verdicts'])
  })

  it('every refusal code the reporter can emit is a value the log can carry', () => {
    // The log stores whatever verified_day_refusal returned, so this asserts the
    // column is free text rather than a CHECK list that would have to be kept in
    // step with the vocabulary by hand (L96).
    const source = readMigrations()
      .map((m) => stripSqlComments(m.sql))
      .join('\n')
    const table = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.purge_run_log\s*\(([\s\S]*?)\n\);/i.exec(source)
    expect(table, 'purge_run_log is not created with a column list').not.toBeNull()
    expect(table![1]).toMatch(/reason\s+TEXT/i)
    expect(table![1], 'a CHECK on reason would need hand maintenance against the gate vocabulary').not.toMatch(
      /reason[^,]*CHECK/i,
    )
    // And the vocabulary is real, so this is not comparing against nothing.
    const codes = new Set(
      [...readFileSync(GATE_TS, 'utf8').matchAll(/\bcode:\s*'([a-z-]+)'/g)].map((m) => m[1]),
    )
    expect(codes.size).toBeGreaterThanOrEqual(11)
  })
})
