import { describe, it, expect } from 'vitest'
import { liveCronJobs, commandArg, commandRoutine, readMigrations, latestRoutineBody } from './_pg-cron'
import { RETENTION_DAYS } from '../../../../worker/src/archive/candidate-days'

/**
 * The half of the deletion gate that CI can run (#873, #1014, #1137).
 *
 * The gate's behaviour is exercised against a real database, on a throwaway
 * Supabase branch, by `supabase/tests/verified_deletion_gate.test.sql`. That
 * cannot run here: the procedures COMMIT after each partition, on purpose, and
 * there is no Postgres in CI to point them at.
 *
 * So this file guards the things that are decidable from the migrations, and
 * they are the ones a fixture seam puts at risk. The procedures take their
 * parent table names as parameters so a test can drive them against fixture
 * partitions; the danger in that is a production job left pointing somewhere
 * harmless, or the defaults quietly changed, either of which leaves the real
 * tables ungated while every behavioural test still passes.
 */

const TRUNCATE_JOB = 'purge-old-execution-partitions'
const REAP_JOB = 'reap-empty-execution-partitions'

/** The procedures that consult the gate. */
const GATED = {
  [TRUNCATE_JOB]: 'truncate_verified_execution_partitions',
  [REAP_JOB]: 'drop_verified_execution_partitions',
} as const

/** The superseded pair, left in place unscheduled for one release. */
const UNGATED = ['truncate_expired_execution_partitions', 'drop_expired_execution_partitions_safe']

describe('the destructive execution jobs consult the gate', () => {
  const jobs = liveCronJobs()

  for (const [jobName, procedure] of Object.entries(GATED)) {
    it(`${jobName} calls ${procedure}`, () => {
      const job = jobs.get(jobName)
      expect(job, `${jobName} is not scheduled by any migration`).toBeDefined()
      expect(commandRoutine(job!.command)).toBe(procedure)
    })
  }

  it('neither job still calls a procedure that deletes without checking the archive', () => {
    const live = [jobs.get(TRUNCATE_JOB), jobs.get(REAP_JOB)]
      .filter((j) => j !== undefined)
      .map((j) => commandRoutine(j!.command))
    for (const ungated of UNGATED) {
      expect(live).not.toContain(ungated)
    }
  })

  it('no other scheduled job calls either ungated procedure', () => {
    // The superseded procedures still EXIST, deliberately, for one release. What
    // must not happen is a third job quietly driving one of them, which would
    // reopen the whole gap while both gated jobs still read as correct.
    const offenders = [...jobs.values()]
      .filter((j) => UNGATED.includes(commandRoutine(j.command) ?? ''))
      .map((j) => `${j.name} (${j.migration}): ${j.command}`)
    expect(offenders).toEqual([])
  })
})

describe('the retention window stays readable to the drift guard', () => {
  const jobs = liveCronJobs()

  // #1017 shipped `execution_purge_retention()` hours before the gate, and it
  // reads the window by parsing the first integer literal out of the command
  // text. The phase issue sketched `CALL proc(verified_purgeable_days(7))`,
  // which that parser cannot read: measured on 2026-09-03, it returns NULL and
  // the drift guard then reports the window as unreadable rather than comparing
  // it. Keeping the command shaped as `CALL proc(<integer>)` is what stops a
  // guard going dark at the moment the thing it watches changes.
  const PARSER_RE = /^[^(]*\(\s*(\d+)\s*\).*$/

  for (const jobName of [TRUNCATE_JOB, REAP_JOB]) {
    it(`${jobName}'s command still yields an integer retention`, () => {
      const command = jobs.get(jobName)?.command
      expect(command, `${jobName} is not scheduled`).toBeDefined()
      expect(commandArg(command!), `no integer literal in: ${command!}`).not.toBeNull()
      // The production parser, character for character, not a paraphrase of it.
      expect(PARSER_RE.exec(command!)?.[1]).toBe(String(commandArg(command!)))
    })
  }

  it('both jobs use the retention the code declares', () => {
    for (const jobName of [TRUNCATE_JOB, REAP_JOB]) {
      expect(commandArg(jobs.get(jobName)!.command)).toBe(RETENTION_DAYS)
    }
  })
})

describe('the fixture seam cannot leave production ungated', () => {
  const migrations = readMigrations()

  for (const procedure of Object.values(GATED)) {
    it(`${procedure} defaults to the real partitioned parents`, () => {
      // The parameters exist so the suite can aim the procedure at fixtures.
      // If a default were ever changed to a fixture name, the scheduled command
      // passes only the retention, so production would silently stop being
      // gated while every behavioural test kept passing.
      const source = migrations
        .filter((m) => m.sql.includes(procedure))
        .map((m) => m.sql)
        .join('\n')
      expect(source).toContain("p_step_parent         TEXT DEFAULT 'execution_steps'")
      expect(source).toContain("p_execution_parent    TEXT DEFAULT 'workflow_executions'")
    })
  }

  it('the gate refuses a day whose measurement is missing, not just one that disagrees', () => {
    // The decision function must treat any NULL input as a refusal. Written the
    // obvious way (`NOT probe_ok`), three valued logic makes an unmeasured day
    // fall through to verified and authorise a deletion from a reading nobody
    // took. Asserting the guard's presence in source is weak, so the real
    // coverage is the behavioural run against a database; this only stops the
    // branch being deleted wholesale.
    //
    // Read from the NEWEST definition, not from every migration that mentions
    // the routine. Joining them all let a superseded definition answer for the
    // live one, so this kept passing on `THEN 'unmeasured'` after #1143 renamed
    // that code, which is a guard defending a version nothing runs (L336).
    const found = latestRoutineBody('verified_day_refusal')
    expect(found, 'verified_day_refusal is not defined in any migration').not.toBeNull()
    const body = found!.body
    expect(body).toContain("THEN 'never-measured'")
    // Every input the decision reads, so a parameter added without a NULL guard
    // is caught rather than falling through to verified.
    for (const parameter of [
      'p_pg_execution_count',
      'p_erased_execution_count',
      'p_sf_execution_count',
      'p_pg_step_count',
      'p_sf_step_count',
      'p_orphan_execution_count',
      'p_hours_recorded',
      'p_hours_execution_count',
      'p_probe_ok',
      'p_probe_sampled',
      'p_incomplete_count',
      'p_measured_at',
    ]) {
      expect(body, `${parameter} has no NULL guard`).toContain(`${parameter} IS NULL`)
    }
  })

  it('the abandoned orphan column is dropped, so it cannot be wired up by mistake', () => {
    // It was NULL on every production row while reading exactly like one of the
    // gate's conditions, and the phase issue's own body named it as the orphan
    // input.
    const source = migrations.map((m) => m.sql).join('\n')
    expect(source).toContain('DROP COLUMN IF EXISTS pg_orphan_step_count')
  })
})

describe('the emptiness check the reap job is named for', () => {
  it('drop_verified_execution_partitions refuses a partition that still holds rows', () => {
    const found = latestRoutineBody('drop_verified_execution_partitions')
    expect(found, 'the procedure is not defined in any migration').not.toBeNull()
    // Behaviour is proven on a real database in the SQL suite. This asserts the
    // refusal branch exists at all, because the procedure it replaced selected
    // purely by age and never checked, so it could destroy a full partition the
    // gate had deliberately spared (#1014).
    expect(found!.body).toContain('Refused to drop')
    expect(found!.body).toMatch(/IF v_has_rows THEN[\s\S]{0,300}CONTINUE;/)
  })
})
