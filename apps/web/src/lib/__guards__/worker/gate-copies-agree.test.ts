import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'
import { latestRoutineBody, readMigrations, stripSqlComments } from '../../__tests__/_pg-cron'
import { HOURS_IN_A_DAY } from '../../../../../worker/src/archive/gate'

/**
 * The two copies of the deletion gate must refuse on the same conditions (#1143).
 *
 * The rule that decides whether a day of execution history may be destroyed
 * exists twice: `refusalsFor` in apps/worker/src/archive/gate.ts, which draws
 * the report and deletes nothing, and `verified_day_refusal` in Postgres, which
 * is the only one the purge actually asks. Measured on 2026-09-04, the SQL copy
 * checked eight conditions to the reporter's eleven.
 *
 * The asymmetry runs the wrong way: the copy with FEWER checks is the one that
 * destroys data, and the richer one only draws a dashboard, so the two can
 * disagree about a day and the disagreement is invisible. The reporter says
 * refused, the purge proceeds.
 *
 * This compares the VOCABULARIES, which is what makes it cheap enough to run in
 * CI with no database: both sides emit stable code strings, so a condition added
 * to one and not the other changes one set and not the other. It is deliberately
 * not a behavioural test. The behaviour is exercised against a real database by
 * supabase/tests/verified_deletion_gate.test.sql, which CI cannot run.
 *
 * Both sets are DERIVED, never listed here. A hand-written expectation would
 * only ever check the conditions whoever wrote it remembered (L96), which is the
 * same failure as the gap it is guarding.
 */

const GATE_TS = path.join(REPO_ROOT, 'apps/worker/src/archive/gate.ts')

/** Every code `refusalsFor` can emit, read off the source rather than listed. */
function reporterCodes(): Set<string> {
  const source = readFileSync(GATE_TS, 'utf8')
  return new Set([...source.matchAll(/\bcode:\s*'([a-z-]+)'/g)].map((m) => m[1]))
}

/** Every code `verified_day_refusal` can return, read off its newest definition. */
function sqlCodes(): Set<string> {
  const found = latestRoutineBody('verified_day_refusal')
  expect(found, 'verified_day_refusal is not defined in any migration').not.toBeNull()
  return new Set([...found!.body.matchAll(/THEN\s+'([a-z-]+)'/g)].map((m) => m[1]))
}

describe('the reporter and the purge refuse on the same conditions', () => {
  it('neither copy can refuse on a condition the other has never heard of', () => {
    const reporter = reporterCodes()
    const sql = sqlCodes()

    // Both directions, separately, because they are different faults. A code the
    // SQL lacks is a day the purge destroys while the report refuses it. A code
    // the reporter lacks is a refusal nobody can explain from the dashboard.
    const onlyInReporter = [...reporter].filter((c) => !sql.has(c)).sort()
    const onlyInSql = [...sql].filter((c) => !reporter.has(c)).sort()

    expect(
      onlyInReporter,
      'conditions the report refuses on that the purge cannot even ask about',
    ).toEqual([])
    expect(onlyInSql, 'conditions the purge refuses on that the report never shows').toEqual([])
  })

  it('finds a real vocabulary on each side, so an empty set cannot pass', () => {
    // Without this, a regex that stopped matching makes both sets empty and the
    // comparison above succeeds while comparing nothing (L98).
    expect(reporterCodes().size).toBeGreaterThanOrEqual(11)
    expect(sqlCodes().size).toBeGreaterThanOrEqual(11)
  })
})

describe('the purge is given the measurements it needs to answer them', () => {
  const passedToRefusal = (): string => {
    const body = latestRoutineBody('verified_purgeable_days')
    expect(body, 'verified_purgeable_days is not defined in any migration').not.toBeNull()
    const call = /verified_day_refusal\s*\(([\s\S]*?)\)/.exec(body!.body)
    expect(call, 'verified_purgeable_days does not call verified_day_refusal').not.toBeNull()
    return call![1]
  }

  // The three the SQL copy could not answer at all, because the numbers never
  // reached it. They are already columns on execution_archive_days, so this is
  // arguments rather than new measurement.
  for (const column of ['hours_recorded', 'hours_execution_count', 'probe_sampled']) {
    it(`passes ${column} through to the decision`, () => {
      expect(passedToRefusal()).toContain(column)
    })

    it(`${column} is actually read by the decision, not merely accepted`, () => {
      // A parameter added to the signature and never used in the CASE would make
      // the call site above read as correct while changing no verdict.
      const body = latestRoutineBody('verified_day_refusal')!.body
      const parameter = `p_${column.replace(/^hours_recorded$/, 'hours_recorded')}`
      const uses = body.split(parameter).length - 1
      expect(uses, `${parameter} is never consulted in the CASE`).toBeGreaterThanOrEqual(1)
    })
  }
})

describe('the two copies agree on how long a day is', () => {
  it('the hours-missing threshold is the reporter\'s HOURS_IN_A_DAY', () => {
    // The reporter holds it as a named constant and the SQL has to inline it, so
    // this is the one number that genuinely exists twice. Asserting it here is
    // what makes the migration's claim that they match true of the code rather
    // than only of its comment (L407).
    const body = latestRoutineBody('verified_day_refusal')!.body
    const threshold = /p_hours_recorded\s*<\s*(\d+)\s+THEN\s+'hours-missing'/.exec(body)
    expect(threshold, 'no hours-missing threshold found in verified_day_refusal').not.toBeNull()
    expect(Number(threshold![1])).toBe(HOURS_IN_A_DAY)
  })
})

describe('no weaker copy of the decision is left callable', () => {
  it('the superseded arity of verified_day_refusal is dropped', () => {
    // Postgres overloads on arity, so replacing the function with a wider
    // signature LEAVES the old one callable. That old one is precisely the
    // version that authorises deletion without the three conditions above, and
    // it would keep its GRANT (L29).
    //
    // Reduced to a boolean before asserting: matching against the whole
    // concatenated migration set would render every byte of it into the failure
    // message and bury the sentence explaining what went wrong (L445).
    const dropped = readMigrations().some((m) =>
      /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.verified_day_refusal\s*\(/i.test(
        stripSqlComments(m.sql),
      ),
    )
    expect(dropped, 'no migration drops the 11 argument verified_day_refusal').toBe(true)
  })
})
