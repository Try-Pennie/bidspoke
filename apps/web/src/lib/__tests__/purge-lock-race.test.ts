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
    expect(routines).toContain('refresh_field_presence_incremental')
  })

  // The incremental pass (#1150) scans workflow_executions every 15 minutes, so it
  // too must bound started_at with a literal or it locks every partition.
  for (const routine of ['refresh_field_presence_daily', 'refresh_workflow_stats_daily', 'refresh_field_presence_incremental']) {
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

describe('reduce_finalize_stranded locks only the partitions it reads (#1722)', () => {
  /**
   * The strand drain runs every 30 minutes, including on the 03:30 tick the purge
   * uses. Its scans bounded their partition keys with `now() - make_interval(...)`,
   * a stable expression the planner cannot fold, and it joins `workflow_executions`
   * with no time bound at all, so it opened and locked every partition of all three
   * execution tables for about 3.5s per run (#1722, same shape #1720 fixed in the
   * two rollups). The partition keys are `execution_started_at_utc` (lead_sightings),
   * `attempted_at_utc` (lead_sighting_bids) and `started_at` (workflow_executions).
   */
  const STRAND_UNPRUNABLE =
    /\b(?:execution_started_at_utc|attempted_at_utc|e\.started_at|started_at)\s*(?:>=|>|<=|<)\s*\(?\s*(?:CURRENT_DATE|now\s*\(\s*\)|current_timestamp)/i

  const found = latestRoutineBody('reduce_finalize_stranded', migrations)

  it('is defined in a migration (anti-vacuous)', () => {
    expect(found, 'reduce_finalize_stranded is not defined in any migration').not.toBeNull()
  })

  it('bounds no execution partition key by a stable date expression', () => {
    const body = stripSqlComments(found!.body)
    expect(
      body,
      `reduce_finalize_stranded in ${found!.migration} still bounds a partition key by a stable expression`,
    ).not.toMatch(STRAND_UNPRUNABLE)
  })

  it('runs its partitioned scans as statements with literal bounds', () => {
    const body = stripSqlComments(found!.body)
    // The lead_sightings scan (and, in the same shape, the workflow_executions
    // join and the lead_sighting_bids scans) reach the planner as literals, the
    // only form pruned in every plan-cache state.
    expect(
      body,
      'reduce_finalize_stranded does not run its scans as statements with literal bounds',
    ).toMatch(/EXECUTE\s+format\s*\([\s\S]*execution_started_at_utc\s*>=\s*%L/i)
    // Every workflow_executions join is bounded on its own partition key, so the
    // planner prunes it too (the table #1722 measured locked in full). This bound
    // is pruning-only, so NOTHING else guards it: a behavioural test cannot see a
    // join that still returns the right rows while locking every partition. So
    // count, rather than match anywhere: every `workflow_executions e` join must
    // carry a literal started_at bound, or one statement could drop its bound and
    // the guard stay green because the other two keep theirs.
    const joins = (body.match(/workflow_executions\s+e\b/gi) ?? []).length
    const boundedJoins = (body.match(/\be\.started_at\s*>=\s*%L/gi) ?? []).length
    expect(joins, 'expected reduce_finalize_stranded to join workflow_executions').toBeGreaterThanOrEqual(1)
    expect(boundedJoins, 'a workflow_executions join is missing its literal started_at bound').toBe(joins)
    // The lead_sighting_bids scan (statement 2) is bounded on its own partition
    // key too; without this assertion that one scan could revert to a stable bound.
    expect(
      body,
      'reduce_finalize_stranded does not bound the lead_sighting_bids scan on attempted_at_utc',
    ).toMatch(/EXECUTE\s+format\s*\([\s\S]*\battempted_at_utc\s*>=\s*%L/i)
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
