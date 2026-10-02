import { describe, expect, it } from 'vitest'
import { commandRoutine, latestRoutineBody, liveCronJobs, readMigrations, stripSqlComments } from './_pg-cron'

/**
 * The nightly purge lost a lock race and left a day half deleted (#1720).
 *
 * On 2026-10-01 and 2026-10-02 `truncate_verified_execution_partitions` gave up
 * on `workflow_executions_2026_09_23` after three 2s lock timeouts. The holder was
 * `refresh_field_presence_daily`, which starts on the same 03:30:00 tick and ran
 * 21.6s. Its date bounds were `CURRENT_DATE - p_lookback_days`, which the
 * planner cannot evaluate, so it could not prune at plan time and took a lock on
 * EVERY partition of `workflow_executions`, not only the two days it reads.
 * Measured read only against production: that query shape locked 430 relations
 * including a day eight days old; the same query with literal bounds locked 30.
 *
 * The day was stamped `executions_truncated_at` once its steps had gone. That
 * is the #1204 design, not this defect: the stamp authorised the retry, which
 * lost the lock again. It is asserted in supabase/tests/verified_deletion_gate.test.sql
 * Part 3b and deliberately left alone here.
 *
 * Two properties stop it, guarded here.
 */

const migrations = readMigrations()
const jobs = [...liveCronJobs(migrations).values()]

/** The partitioned execution tables, whose partitions the purge takes. */
const PARTITIONED = ['workflow_executions', 'execution_steps']

/**
 * A partition key compared against an expression the planner cannot fold.
 *
 * `CURRENT_DATE` and `now()` are STABLE, so a bound built from them is only
 * known at execution, the planner opens every partition, and each one is locked
 * until the transaction ends. A bound passed in as a literal is pruned at plan
 * time and locks only the partitions it names.
 */
const UNPRUNABLE_BOUND = /\bstarted_at\s*(?:>=|>|<=|<)\s*\(?\s*(?:CURRENT_DATE|now\s*\(\s*\)|current_timestamp)/i

describe('scheduled readers lock only the partitions they read', () => {
  const routines = [...new Set(jobs.map((j) => commandRoutine(j.command)).filter((r): r is string => r !== null))]

  it('finds the scheduled routines it is about to judge', () => {
    // A parse that finds nothing makes the loop below vacuous and green (L100).
    expect(routines).toContain('refresh_field_presence_daily')
    expect(routines).toContain('refresh_workflow_stats_daily')
  })

  for (const routine of ['refresh_field_presence_daily', 'refresh_workflow_stats_daily']) {
    it(`${routine} bounds its scan of the execution partitions with literals`, () => {
      const found = latestRoutineBody(routine, migrations)
      expect(found, `${routine} is not defined in any migration`).not.toBeNull()
      const body = stripSqlComments(found!.body)
      expect(body, `${routine} in ${found!.migration} still bounds started_at by a stable expression`).not.toMatch(
        UNPRUNABLE_BOUND,
      )
      // The bounds reach the statement as literals, which is the only form the
      // planner prunes on in every plan cache state (a parameter in a cached
      // generic plan is pruned at executor start, after every partition is locked).
      expect(body, `${routine} does not run its scan as a statement with literal bounds`).toMatch(
        /EXECUTE\s+format\s*\([\s\S]*started_at\s*>=\s*%L/i,
      )
    })
  }

  it('no scheduled routine scans an execution partition by a stable date bound', () => {
    const offenders: string[] = []
    for (const routine of routines) {
      const found = latestRoutineBody(routine, migrations)
      if (found === null) continue
      const body = stripSqlComments(found.body)
      if (!PARTITIONED.some((t) => body.includes(t))) continue
      if (UNPRUNABLE_BOUND.test(body)) offenders.push(`${routine} (${found.migration})`)
    }
    expect(offenders).toEqual([])
  })
})

describe('the purge outlasts an ordinary co-scheduled reader', () => {
  /**
   * The seconds the purge waits on one partition before giving up: every attempt
   * waits its lock_timeout, and every attempt but the last then sleeps 2s per
   * attempt so far. Derived from the procedure text rather than written out.
   */
  function retryWindowSeconds(body: string): number {
    const attempts = Number(/p_max_attempts\s+INTEGER\s+DEFAULT\s+(\d+)/i.exec(body)?.[1] ?? NaN)
    const lockSeconds = Number(/SET\s+lock_timeout\s*=\s*'(\d+)s'/i.exec(body)?.[1] ?? NaN)
    const sleepPerAttempt = Number(/pg_sleep\s*\(\s*(\d+)\s*\*\s*v_attempt\s*\)/i.exec(body)?.[1] ?? NaN)
    let total = attempts * lockSeconds
    for (let k = 1; k < attempts; k++) total += sleepPerAttempt * k
    return total
  }

  it('waits longer per partition than the slowest rollup refresh has run', () => {
    // The rollup refreshes no longer lock old partitions, but anything that reads
    // a partition can still hold it, and the field presence refresh has run to
    // 39s at p99 (#1147). A window shorter than that made the first expired
    // partition reached lose every slow night. The per attempt wait stays short
    // on purpose: while TRUNCATE waits, live reads of the table queue behind it.
    const migration = migrations
      .filter((m) => /CREATE\s+OR\s+REPLACE\s+PROCEDURE\s+public\.truncate_verified_execution_partitions/i.test(m.sql))
      .at(-1)
    expect(migration).toBeDefined()
    const window = retryWindowSeconds(migration!.sql)
    expect(Number.isFinite(window), 'could not read the retry settings').toBe(true)
    expect(window).toBeGreaterThan(39)
    expect(Number(/SET\s+lock_timeout\s*=\s*'(\d+)s'/i.exec(migration!.sql)?.[1])).toBeLessThanOrEqual(2)
  })
})
