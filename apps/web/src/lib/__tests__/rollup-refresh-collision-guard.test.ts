import { describe, expect, it } from 'vitest'
import {
  commandArg,
  commandRoutine,
  cronFieldValues,
  latestRoutineBody,
  liveCronJobs,
  minutesOfDay,
  readMigrations,
  workerCrons,
} from './_pg-cron'

/**
 * The analytics rollup refreshes (#833, #849, #837).
 *
 * workflow_stats_daily and field_presence_daily are each refreshed by one
 * delete-then-insert function driven by two pg_cron jobs: an incremental pass
 * every 5 minutes and a nightly reconciler. Because 03:45 and 03:50 are
 * themselves multiples of 5, the reconciler and the incremental pass started at
 * the same instant every night. Neither DELETE can see the other's uncommitted
 * rows, so both re-inserted the same day and whichever committed second aborted
 * on the primary key: 128 duplicate-key failures and 6 deadlocks between
 * 2026-05-18 and 2026-08-18.
 *
 * These guards protect the three properties that stop it, and one adjacent
 * defect in the same statement:
 *
 *   1. the functions serialize with themselves, which is the actual fix (a
 *      reschedule alone still collides whenever a run overruns its slot)
 *   2. the nightly minute is off the incremental grid, so the common case
 *      never contends at all
 *   3. a full-refresh lookback never exceeds raw retention, or the nightly run
 *      deletes rollup history whose source partitions are already dropped and
 *      cannot put it back (#849). This rule was written in a comment in
 *      20260522000002 and a later table cloned the pre-fix value anyway, which
 *      is why it is a test now and not a comment.
 *   4. the outcome expression in the GROUP BY matches the one in the INSERT, or
 *      a NULL and an empty-string outcome form two groups that collide on one
 *      primary key (#837).
 */

/** Rollup refresh functions, and the table each one keys its rows in. */
const ROLLUP_FUNCTIONS = ['refresh_workflow_stats_daily', 'refresh_field_presence_daily'] as const

/**
 * The JOB whose cron argument is the authoritative raw retention window.
 *
 * Keyed on the job name, never on the procedure it calls. This guard used to
 * name `truncate_expired_execution_partitions`, and #873 repointed the job at
 * `truncate_verified_execution_partitions` so the deletion consults the archive
 * first. Nothing about the retention window changed, but the lookup found no job,
 * `commandArg(undefined) ?? 0` gave a retention of zero, and all three
 * assertions below failed claiming the raw tables retain nothing. The job name is
 * the stable identifier and survives the next rename too (L305, L15).
 */
const RETENTION_JOB = 'purge-old-execution-partitions'

const migrations = readMigrations()
const jobs = [...liveCronJobs(migrations).values()]

/** Jobs driving one of the rollup refresh functions, grouped by function. */
function jobsFor(fn: string) {
  return jobs.filter((j) => commandRoutine(j.command) === fn)
}

describe('rollup refresh: the parse itself', () => {
  // A regex that matches nothing makes every loop below vacuous and green
  // (LESSONS L100, L143), so assert the inputs exist before asserting anything
  // about them.
  it('finds both rollup refresh functions and three live jobs for each (today, recent, nightly)', () => {
    for (const fn of ROLLUP_FUNCTIONS) {
      expect(latestRoutineBody(fn, migrations), `${fn} definition`).not.toBeNull()
      expect(jobsFor(fn).map((j) => j.name).sort(), `${fn} jobs`).toHaveLength(3)
    }
  })

  it('finds the retention window the rollups must not outrun', () => {
    const purge = jobs.find((j) => j.name === RETENTION_JOB)
    expect(purge, RETENTION_JOB).toBeDefined()
    expect(commandArg(purge!.command)).toBeGreaterThan(0)
  })
})

describe('the cron parse reads cron.alter_job (#1884)', () => {
  // Every guard here reads the schedules through liveCronJobs. #1884 changes
  // them with cron.alter_job, which keeps a job's run history, so a parse that
  // skipped alter_job would judge the schedules from before the change and pass.
  const base = {
    name: '001.sql',
    sql: "SELECT cron.schedule('a-job', '*/5 * * * *', $$SELECT f(2)$$);",
  }

  it('applies a schedule and a command altered in place, keeping what was not altered', () => {
    const live = liveCronJobs([
      base,
      {
        name: '002.sql',
        sql: "SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'a-job'), schedule := '1-59/5 * * * *', command := $$SELECT f(0)$$);",
      },
      {
        name: '003.sql',
        sql: "SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'a-job'), schedule := '2-59/5 * * * *');",
      },
    ])
    expect(live.get('a-job')).toMatchObject({ schedule: '2-59/5 * * * *', command: 'SELECT f(0)', migration: '003.sql' })
  })

  it('refuses an alter_job written in a shape it cannot read, rather than skipping it', () => {
    expect(() =>
      liveCronJobs([base, { name: '002.sql', sql: "SELECT cron.alter_job(42, '1 * * * *');" }]),
    ).toThrow(/002\.sql: 1 cron\.alter_job call/)
  })

  it('refuses an alter_job on a job no earlier migration schedules', () => {
    expect(() =>
      liveCronJobs([
        { name: '002.sql', sql: "SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'ghost'), schedule := '1 * * * *');" },
      ]),
    ).toThrow(/'ghost'/)
  })

  it('reads every minute a schedule can start in', () => {
    expect([...(minutesOfDay('27,57 3 * * *') ?? [])]).toEqual([207, 237])
    expect(minutesOfDay('1-59/5 * * * *')?.size).toBe(12 * 24)
    expect(minutesOfDay('61 * * * *')).toBeNull()
    expect(minutesOfDay('0 */2 * * *')?.size).toBe(12)
  })
})

describe('rollup refresh: serializes with itself', () => {
  it.each(ROLLUP_FUNCTIONS)('%s takes a transaction-scoped advisory lock', (fn) => {
    const found = latestRoutineBody(fn, migrations)
    expect(found).not.toBeNull()
    expect(found!.body, `${fn} in ${found!.migration}`).toMatch(/pg_advisory_xact_lock\s*\(/)
  })

  it('the two functions lock on different keys', () => {
    const keys = ROLLUP_FUNCTIONS.map((fn) => {
      const body = latestRoutineBody(fn, migrations)?.body ?? ''
      return /pg_advisory_xact_lock\s*\(\s*([^)]+)\)/.exec(body)?.[1]?.trim() ?? null
    })
    expect(keys.every((k) => k !== null)).toBe(true)
    expect(new Set(keys).size, `lock keys ${JSON.stringify(keys)}`).toBe(keys.length)
  })
})

/** The minutes of the day a job starts in; a schedule the reader cannot parse fails the test that asked. */
function fires(schedule: string): Set<number> {
  const set = minutesOfDay(schedule)
  if (set === null) throw new Error(`unreadable schedule '${schedule}'`)
  return set
}

/** More than once an hour: the pass that runs all day long. */
const isFrequent = (schedule: string) => fires(schedule).size > 24

describe('rollup refresh: schedules cannot coincide', () => {
  it.each(ROLLUP_FUNCTIONS)('%s hourly and nightly jobs are off the frequent grid', (fn) => {
    const group = jobsFor(fn)
    const frequent = group.filter((j) => isFrequent(j.schedule))
    expect(frequent, `${fn} has no frequent job`).toHaveLength(1)

    const others = group.filter((j) => !isFrequent(j.schedule))
    expect(others, `${fn} has no hourly or nightly job`).not.toHaveLength(0)

    const grid = fires(frequent[0].schedule)
    for (const job of others) {
      const shared = [...fires(job.schedule)].filter((m) => grid.has(m))
      expect(shared, `${job.name} (${job.schedule}) starts on the ${frequent[0].schedule} grid`).toEqual([])
    }
  })
})

/**
 * Only today is recounted often (#1884).
 *
 * Each pass deletes and rewrites `CURRENT_DATE - lookback` onwards by reading
 * every workflow_executions row of those days. With a lookback of 2 every 5
 * minutes, workflow_stats_daily read about 296 MB per run (1,178 GB in two
 * weeks, 85 GB a day) and was the largest reader on a Micro database that
 * stalled for 30 s on 2026-10-08. Only today changes between passes, so the
 * frequent pass reads today alone and an hourly pass keeps the two days before
 * it current, which is what the frequent pass used to cover: a late completion
 * or a stranded execution finalised hours later still reaches its own day.
 */
describe('rollup refresh: only today is recounted often', () => {
  it.each(ROLLUP_FUNCTIONS)('%s frequent pass reads today only', (fn) => {
    const frequent = jobsFor(fn).filter((j) => isFrequent(j.schedule))
    expect(frequent).toHaveLength(1)
    expect(commandArg(frequent[0].command), `${frequent[0].name}: ${frequent[0].command}`).toBe(0)
  })

  it.each(ROLLUP_FUNCTIONS)(
    '%s past two days are recounted at least hourly, so a late change cannot sit stale for a day',
    (fn) => {
      const covering = jobsFor(fn).filter((j) => (commandArg(j.command) ?? 0) >= 2)
      // The longest wait between two starts of any covering job, across midnight.
      const starts = [...new Set(covering.flatMap((j) => [...fires(j.schedule)]))].sort((a, b) => a - b)
      expect(starts.length, `${fn} has no job covering the two days before today`).toBeGreaterThan(0)
      let longest = 0
      for (let i = 0; i < starts.length; i++) {
        const next = i + 1 < starts.length ? starts[i + 1] : starts[0] + 24 * 60
        longest = Math.max(longest, next - starts[i])
      }
      expect(longest, `${fn}: the two days before today can go ${longest} minutes without a recount`).toBeLessThanOrEqual(60)
    },
  )
})

/**
 * Heavy scheduled readers start alone (#1884).
 *
 * On 2026-10-08 three pg_cron jobs (24, 45, 47) and the worker's hourly batch
 * all started at 12:00, and at 08:15 the timeout audit started a dozen
 * percentile queries in the same minute as jobs 45 and 47, slowing lead
 * requests to 8.5 s. A collision is a property of two schedules written in two
 * places (a migration and wrangler.toml), so no single change shows it.
 *
 * Every rollup pass and the stranded execution drain (103 MB read per run,
 * measured from pg_stat_statements on 2026-10-08) must start in a minute no
 * other pg_cron job and no worker cron starts in. Every DAILY worker cron (the
 * timeout audit, the 09:00 and 13:00 batches) must start in a minute no pg_cron
 * job starts in. The worker's every-minute cron is the one exemption, because no
 * minute is free of it.
 */
describe('heavy scheduled readers start alone', () => {
  const EVERY_MINUTE = '* * * * *'
  const STRANDED_DRAIN = 'reduce-finalize-stranded'
  const worker = workerCrons().filter((c) => c !== EVERY_MINUTE)

  const heavy = jobs.filter(
    (j) => j.name === STRANDED_DRAIN || (ROLLUP_FUNCTIONS as readonly string[]).includes(commandRoutine(j.command) ?? ''),
  )

  it('finds the readers it judges', () => {
    // An empty list would make every assertion below vacuous (L100).
    expect(heavy.map((j) => j.name)).toContain(STRANDED_DRAIN)
    expect(heavy.length).toBe(ROLLUP_FUNCTIONS.length * 3 + 1)
    expect(worker.length).toBeGreaterThan(3)
  })

  it.each(heavy.map((j) => [j.name, j.schedule] as const))(
    '%s (%s) starts in minutes nothing else starts in',
    (name, schedule) => {
      const mine = fires(schedule)
      const clashes: string[] = []
      for (const other of jobs) {
        if (other.name === name) continue
        if ([...fires(other.schedule)].some((m) => mine.has(m))) clashes.push(`pg_cron ${other.name} (${other.schedule})`)
      }
      for (const cron of worker) {
        if ([...fires(cron)].some((m) => mine.has(m))) clashes.push(`worker cron ${cron}`)
      }
      expect(clashes).toEqual([])
    },
  )

  it('every daily worker cron starts in a minute no pg_cron job starts in', () => {
    const daily = worker.filter((c) => fires(c).size === 1)
    expect(daily.length, 'no daily worker cron found').toBeGreaterThan(0)
    const clashes: string[] = []
    for (const cron of daily) {
      const [minute] = [...fires(cron)]
      for (const j of jobs) if (fires(j.schedule).has(minute)) clashes.push(`${cron} with pg_cron ${j.name} (${j.schedule})`)
    }
    expect(clashes).toEqual([])
  })
})

describe('rollup refresh: lookback never outruns retention', () => {
  const purge = jobs.find((j) => j.name === RETENTION_JOB)
  const retentionDays = commandArg(purge?.command ?? '') ?? 0

  it.each(ROLLUP_FUNCTIONS)('every %s lookback is within raw retention', (fn) => {
    const group = jobsFor(fn)
    expect(group).not.toHaveLength(0)
    for (const job of group) {
      const lookback = commandArg(job.command)
      expect(lookback, `${job.name} passes no lookback`).not.toBeNull()
      expect(
        lookback!,
        `${job.name} re-aggregates ${lookback} days from a table retaining ${retentionDays}`,
      ).toBeLessThanOrEqual(retentionDays)
    }
  })
})

describe('rollup refresh: outcome is grouped as it is inserted', () => {
  it('refresh_workflow_stats_daily groups by the normalised outcome', () => {
    const found = latestRoutineBody('refresh_workflow_stats_daily', migrations)
    expect(found).not.toBeNull()
    const body = found!.body
    const groupBy = /GROUP\s+BY([\s\S]*?);/i.exec(body)?.[1]
    expect(groupBy, 'no GROUP BY found').toBeTruthy()

    // The INSERT normalises NULL to '' because the column is NOT NULL DEFAULT ''.
    // Grouping by the raw column leaves NULL and '' as two groups that collide
    // on one primary key, so the GROUP BY has to normalise identically.
    const normalised = /COALESCE\s*\(\s*\w+\.outcome\s*,\s*''\s*\)/i
    expect(normalised.test(body), 'INSERT does not normalise outcome').toBe(true)
    expect(normalised.test(groupBy!), `GROUP BY does not normalise outcome: ${groupBy}`).toBe(true)
    expect(
      /(?:^|[\s,(])\w+\.outcome(?:$|[\s,)])/i.test(groupBy!.replace(normalised, '')),
      `GROUP BY still carries a bare outcome: ${groupBy}`,
    ).toBe(false)
  })
})

/**
 * The rollup refreshes own their timeout budget (#1147).
 *
 * On 2026-09-03 a refresh-field-presence-daily run was killed at 121.97s by the
 * CLUSTER default statement_timeout of 120s, inherited because pg_cron runs as
 * `postgres` and that role carries no override. Nothing in this repo chose 120s,
 * and #435 had just doubled the work the job does (17.5 to 34.0 watched keys per
 * execution, so ~3.5M to ~7.1M expanded rows per refresh).
 *
 * Two properties are guarded, and the second is the one that is easy to get
 * wrong in a way that looks right:
 *
 *   1. every job driving a rollup refresh sets statement_timeout in its own
 *      command, so the budget is stated rather than inherited from whatever the
 *      platform currently defaults to
 *   2. the budget is set in the CRON COMMAND and never inside the function.
 *      `SET LOCAL statement_timeout` inside a plpgsql function does not bind the
 *      running call: the timer is armed when the outer statement begins, so the
 *      new value applies only to the NEXT statement. Probed against this
 *      database on 2026-09-04, a function setting it to 1s and then sleeping 3s
 *      slept the full 3s. In the function body it is a line that reads as a
 *      safeguard and enforces nothing (LESSONS L188), and no test that merely
 *      greps for the setting could tell the two placements apart.
 *
 * Plus the arithmetic that actually failed: the budget has to cover the
 * advisory-lock wait AND the work, so a lock wait must not be able to consume
 * most of it. 60s of wait against a 120s ceiling is what left a p99 of 39s with
 * nowhere to go.
 */
describe('rollup refresh: owns its timeout budget', () => {
  /** A Postgres timeout literal in milliseconds: '180s', '30s', '250ms', '5000'. */
  function timeoutMs(literal: string): number {
    const m = /^(\d+)\s*(ms|s|min)?$/.exec(literal.trim())
    if (!m) throw new Error(`unparsed timeout literal: ${literal}`)
    const n = Number(m[1])
    if (m[2] === 's') return n * 1000
    if (m[2] === 'min') return n * 60_000
    return n
  }

  /** The value a `SET <name> = '<literal>'` in `sql` assigns, or null. */
  function setting(sql: string, name: string): string | null {
    const re = new RegExp(`SET\\s+(?:LOCAL\\s+)?${name}\\s*=\\s*'([^']+)'`, 'i')
    return re.exec(sql)?.[1] ?? null
  }

  const rollupJobs = ROLLUP_FUNCTIONS.flatMap((fn) => jobsFor(fn))

  it('finds the jobs it is about to judge', () => {
    // Without this the three assertions below are vacuous on an empty list
    // (L100, L143), which is exactly how a guard passes hardest when the parse
    // has broken.
    expect(rollupJobs.length).toBe(ROLLUP_FUNCTIONS.length * 3)
  })

  it.each(rollupJobs.map((j) => [j.name, j.command] as const))(
    '%s states its own statement_timeout',
    (_name, command) => {
      const value = setting(command, 'statement_timeout')
      expect(value, 'no statement_timeout in the cron command').not.toBeNull()
      expect(timeoutMs(value!)).toBeGreaterThan(0)
    },
  )

  it.each(ROLLUP_FUNCTIONS)('%s does not set statement_timeout in its body', (fn) => {
    // The placement is the whole point: in the body this line is inert.
    const found = latestRoutineBody(fn, migrations)
    expect(found).not.toBeNull()
    expect(
      setting(found!.body, 'statement_timeout'),
      `${fn} in ${found!.migration} sets statement_timeout inside the function, ` +
        'where it does not bind the running call',
    ).toBeNull()
  })

  it.each(ROLLUP_FUNCTIONS)('%s leaves most of its budget for the work, not the lock wait', (fn) => {
    const found = latestRoutineBody(fn, migrations)
    expect(found).not.toBeNull()
    const lock = setting(found!.body, 'lock_timeout')
    expect(lock, `${fn} sets no lock_timeout`).not.toBeNull()

    const budgets = jobsFor(fn).map((j) => {
      const v = setting(j.command, 'statement_timeout')
      expect(v, `${j.name} sets no statement_timeout`).not.toBeNull()
      return timeoutMs(v!)
    })
    // A full lock wait must leave at least two thirds of the smallest budget
    // for the DELETE and the INSERT.
    expect(
      timeoutMs(lock!),
      `${fn} lock wait ${lock} against a ${Math.min(...budgets)}ms budget`,
    ).toBeLessThanOrEqual(Math.min(...budgets) / 3)
  })

  /**
   * A run that spends its ENTIRE budget must still finish inside its own slot.
   *
   * This is the relationship the 2026-09-03 failure was on the wrong side of.
   * The incremental pass fired every 5 minutes while the work grew past a p99
   * of 39s, and the 120s ceiling had to cover an advisory-lock wait of up to
   * 60s on top of that. Once a run can outlive its slot, the next one arrives
   * to find the lock held, waits, and spends its own budget waiting rather than
   * working, so one slow run turns into a queue of failures rather than a
   * single late refresh.
   *
   * Guarding the RELATIONSHIP rather than the literal cadence means it holds
   * whichever side someone changes later: dropping the field-presence pass to
   * every 15 minutes satisfies it, and so would leaving it at 5 minutes with a
   * smaller budget, but raising a budget past its interval fails (L63, L103).
   *
   * The cushion is there because a run killed at its ceiling still has to roll
   * back its DELETE and drop the advisory lock before the next attempt starts.
   */
  const CUSHION_MS = 60_000

  /** The shortest wait between two starts of an every-hour schedule, in minutes. */
  function shortestGapMinutes(schedule: string): number {
    const minutes = cronFieldValues(schedule.trim().split(/\s+/)[0] ?? '', 0, 59)
    if (minutes === null) throw new Error(`unreadable minute field in '${schedule}'`)
    let shortest = 60
    for (let i = 0; i < minutes.length; i++) {
      const next = i + 1 < minutes.length ? minutes[i + 1] : minutes[0] + 60
      shortest = Math.min(shortest, next - minutes[i])
    }
    return shortest
  }

  it.each(
    rollupJobs
      .filter((j) => isFrequent(j.schedule))
      .map((j) => [j.name, j.schedule, j.command] as const),
  )('%s cannot outlive its own slot', (_name, schedule, command) => {
    const intervalMs = shortestGapMinutes(schedule) * 60_000
    const value = setting(command, 'statement_timeout')
    expect(value, 'no statement_timeout in the cron command').not.toBeNull()
    const budgetMs = timeoutMs(value!)

    expect(
      budgetMs + CUSHION_MS,
      `a run may spend ${budgetMs}ms of a ${intervalMs}ms slot, leaving under ` +
        `${CUSHION_MS}ms to roll back and release the lock before the next run`,
    ).toBeLessThanOrEqual(intervalMs)
  })

  it('finds at least one frequent rollup job to judge', () => {
    // The filter above silently empties if the schedule format changes, and an
    // empty it.each is green (L100).
    expect(rollupJobs.filter((j) => isFrequent(j.schedule)).length).toBeGreaterThan(0)
  })
})
