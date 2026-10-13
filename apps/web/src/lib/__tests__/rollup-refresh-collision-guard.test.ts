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
 * The analytics rollup refreshes (#833, #849, #837, #1884, #1150).
 *
 * Each of workflow_stats_daily and field_presence_daily is kept current by three
 * pg_cron jobs: a frequent pass, an hourly "recent" pass, and a nightly
 * reconciler. The nightly and hourly passes are both a delete-then-insert
 * reaggregation of a window of days (refresh_workflow_stats_daily /
 * refresh_field_presence_daily), the correctness backstop.
 *
 * The frequent pass differs by table:
 *   workflow_stats_daily   refresh_workflow_stats_daily(0): today, delete-then-insert.
 *   field_presence_daily   refresh_field_presence_incremental(): a watermark
 *                          incremental that reads only executions finished since
 *                          the last pass and ADDS them, so its cost is the new
 *                          work, not the size of today's partition (#1150).
 *
 * These guards protect the properties that keep that safe:
 *
 *   1. every refresh function serializes with itself, which is the #833 fix (a
 *      reschedule alone still collides whenever a run overruns its slot), and the
 *      field-presence incremental shares the reconcile's lock so an ADD and a
 *      delete-then-insert never interleave (#1150)
 *   2. each table's nightly and hourly minutes are off its frequent grid, so the
 *      common case never contends at all
 *   3. a full-refresh lookback never exceeds raw retention, or the nightly run
 *      deletes rollup history whose source partitions are already dropped and
 *      cannot put it back (#849)
 *   4. the outcome expression in the GROUP BY matches the one in the INSERT, or a
 *      NULL and an empty-string outcome form two groups that collide on one
 *      primary key (#837)
 *   5. every heavy scheduled reader starts in a minute nothing else starts in
 *      (#1884)
 *   6. every refresh job states its own statement_timeout, in the cron command
 *      and never in the function body where it would not bind (#1147)
 */

/** The delete-then-insert reconcilers, one per rollup table. */
const RECONCILE_FUNCTIONS = ['refresh_workflow_stats_daily', 'refresh_field_presence_daily'] as const
/** The watermark incremental that drives the field-presence frequent pass (#1150). */
const INCREMENTAL_FUNCTION = 'refresh_field_presence_incremental'
/** Every refresh function whose body is a timing concern. */
const ALL_REFRESH_FUNCTIONS = [...RECONCILE_FUNCTIONS, INCREMENTAL_FUNCTION] as const

/**
 * Each rollup table's three jobs, by name, and the function its frequent pass is
 * expected to call. Keyed on job name rather than on the function, because the
 * two tables no longer drive their frequent pass with the same function.
 */
const ROLLUP_GROUPS = [
  {
    label: 'workflow_stats_daily',
    frequent: 'refresh-workflow-stats-daily',
    recent: 'refresh-workflow-stats-daily-recent',
    nightly: 'refresh-workflow-stats-daily-full',
    frequentRoutine: 'refresh_workflow_stats_daily',
  },
  {
    label: 'field_presence_daily',
    frequent: 'refresh-field-presence-daily',
    recent: 'refresh-field-presence-daily-recent',
    nightly: 'refresh-field-presence-daily-full',
    frequentRoutine: INCREMENTAL_FUNCTION,
  },
] as const

/** Every rollup job, by name: three per table. */
const ROLLUP_JOB_NAMES = ROLLUP_GROUPS.flatMap((g) => [g.frequent, g.recent, g.nightly])

/**
 * The JOB whose cron argument is the authoritative raw retention window.
 *
 * Keyed on the job name, never on the procedure it calls (#873, L305, L15).
 */
const RETENTION_JOB = 'purge-old-execution-partitions'

const migrations = readMigrations()
const jobs = [...liveCronJobs(migrations).values()]

/** The one live cron job with this name; a lookup that misses fails the test that asked (L100). */
function job(name: string) {
  const j = jobs.find((x) => x.name === name)
  if (!j) throw new Error(`no live cron job named '${name}'`)
  return j
}

/** The advisory-lock key a function's body takes, e.g. `883301, 2`, or null. */
function lockKey(fn: string): string | null {
  const body = latestRoutineBody(fn, migrations)?.body ?? ''
  return /pg_advisory_xact_lock\s*\(\s*([^)]+)\)/.exec(body)?.[1]?.trim() ?? null
}

describe('rollup refresh: the parse itself', () => {
  // A regex that matches nothing makes every loop below vacuous and green
  // (LESSONS L100, L143), so assert the inputs exist before asserting anything
  // about them.
  it('finds every refresh function and all six rollup jobs', () => {
    for (const fn of ALL_REFRESH_FUNCTIONS) {
      expect(latestRoutineBody(fn, migrations), `${fn} definition`).not.toBeNull()
    }
    for (const name of ROLLUP_JOB_NAMES) {
      expect(jobs.find((j) => j.name === name), `${name} job`).toBeDefined()
    }
    expect(ROLLUP_JOB_NAMES).toHaveLength(6)
  })

  it('each frequent pass calls the function it is meant to', () => {
    for (const g of ROLLUP_GROUPS) {
      expect(commandRoutine(job(g.frequent).command), `${g.label} frequent routine`).toBe(g.frequentRoutine)
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
  it.each(ALL_REFRESH_FUNCTIONS)('%s takes a transaction-scoped advisory lock', (fn) => {
    const found = latestRoutineBody(fn, migrations)
    expect(found).not.toBeNull()
    expect(found!.body, `${fn} in ${found!.migration}`).toMatch(/pg_advisory_xact_lock\s*\(/)
  })

  it('the two reconcilers lock on different keys', () => {
    const keys = RECONCILE_FUNCTIONS.map((fn) => lockKey(fn))
    expect(keys.every((k) => k !== null), `lock keys ${JSON.stringify(keys)}`).toBe(true)
    expect(new Set(keys).size, `lock keys ${JSON.stringify(keys)}`).toBe(keys.length)
  })

  it('the field-presence incremental and reconcile share one lock, so an ADD and a rebuild never interleave', () => {
    const incremental = lockKey(INCREMENTAL_FUNCTION)
    const reconcile = lockKey('refresh_field_presence_daily')
    expect(incremental, 'incremental lock key').not.toBeNull()
    expect(reconcile, 'reconcile lock key').not.toBeNull()
    expect(incremental, `incremental ${incremental} vs reconcile ${reconcile}`).toBe(reconcile)
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
  it.each(ROLLUP_GROUPS.map((g) => [g.label, g] as const))(
    '%s hourly and nightly jobs are off the frequent grid',
    (_label, g) => {
      const frequent = job(g.frequent)
      expect(isFrequent(frequent.schedule), `${g.frequent} (${frequent.schedule}) is not a frequent schedule`).toBe(true)

      const grid = fires(frequent.schedule)
      for (const name of [g.recent, g.nightly]) {
        const other = job(name)
        expect(isFrequent(other.schedule), `${name} (${other.schedule}) is unexpectedly frequent`).toBe(false)
        const shared = [...fires(other.schedule)].filter((m) => grid.has(m))
        expect(shared, `${name} (${other.schedule}) starts on the ${frequent.schedule} grid`).toEqual([])
      }
    },
  )
})

/**
 * The frequent pass is light (#1884, #1150).
 *
 * workflow_stats recounts today alone (lookback 0), reading today's partition
 * rather than three days; field_presence goes further and reads only the
 * executions finished since the last pass, via the watermark incremental, rather
 * than the whole of today's partition.
 */
describe('rollup refresh: the frequent pass is light', () => {
  it('workflow_stats frequent pass reads today only', () => {
    const frequent = job('refresh-workflow-stats-daily')
    expect(commandArg(frequent.command), `${frequent.name}: ${frequent.command}`).toBe(0)
  })

  it('field_presence frequent pass is the watermark incremental, not a day reaggregation', () => {
    const frequent = job('refresh-field-presence-daily')
    expect(commandRoutine(frequent.command)).toBe(INCREMENTAL_FUNCTION)
    // The incremental takes no lookback: it reads from the watermark, not a window.
    expect(commandArg(frequent.command), `${frequent.name}: ${frequent.command}`).toBeNull()
  })
})

/**
 * The two days before today are recounted at least hourly by a reconcile pass, so
 * a late completion or a stranded execution finalised hours later cannot sit
 * stale for a day (#1884). The field-presence incremental is the freshness; this
 * is the backstop, and it is the reconcile passes (lookback >= 2) that provide it.
 */
describe('rollup refresh: the past two days are recounted at least hourly', () => {
  it.each(ROLLUP_GROUPS.map((g) => [g.label, g] as const))('%s has a covering pass at least hourly', (_label, g) => {
    const covering = [g.frequent, g.recent, g.nightly]
      .map((name) => job(name))
      .filter((j) => (commandArg(j.command) ?? 0) >= 2)
    const starts = [...new Set(covering.flatMap((j) => [...fires(j.schedule)]))].sort((a, b) => a - b)
    expect(starts.length, `${g.label} has no job covering the two days before today`).toBeGreaterThan(0)
    let longest = 0
    for (let i = 0; i < starts.length; i++) {
      const next = i + 1 < starts.length ? starts[i + 1] : starts[0] + 24 * 60
      longest = Math.max(longest, next - starts[i])
    }
    expect(longest, `${g.label}: the two days before today can go ${longest} minutes without a recount`).toBeLessThanOrEqual(60)
  })
})

/**
 * Heavy scheduled readers start alone (#1884).
 *
 * Every rollup pass and the stranded execution drain must start in a minute no
 * other pg_cron job and no worker cron starts in. Every DAILY worker cron must
 * start in a minute no pg_cron job starts in. The worker's every-minute cron is
 * the one exemption, because no minute is free of it.
 */
describe('heavy scheduled readers start alone', () => {
  const EVERY_MINUTE = '* * * * *'
  const STRANDED_DRAIN = 'reduce-finalize-stranded'
  const worker = workerCrons().filter((c) => c !== EVERY_MINUTE)

  const heavyNames = new Set<string>([STRANDED_DRAIN, ...ROLLUP_JOB_NAMES])
  const heavy = jobs.filter((j) => heavyNames.has(j.name))

  it('finds the readers it judges', () => {
    // An empty or short list would make every assertion below vacuous (L100).
    expect(heavy.map((j) => j.name)).toContain(STRANDED_DRAIN)
    expect(heavy.length).toBe(ROLLUP_JOB_NAMES.length + 1)
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

  it('every reconcile lookback is within raw retention', () => {
    // Only the jobs that pass a lookback: the incremental reads from the watermark
    // and passes none, so it has no window to outrun retention.
    const reconcileJobs = ROLLUP_JOB_NAMES.map((name) => job(name)).filter((j) => commandArg(j.command) !== null)
    expect(reconcileJobs.length, 'no reconcile jobs found to judge').toBeGreaterThan(0)
    for (const j of reconcileJobs) {
      const lookback = commandArg(j.command)!
      expect(
        lookback,
        `${j.name} re-aggregates ${lookback} days from a table retaining ${retentionDays}`,
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
 * `postgres` and that role carries no override. The budget must be set in the
 * cron command, never inside the function body where `SET LOCAL statement_timeout`
 * does not bind the running call (LESSONS L188), and a lock wait must not be able
 * to consume most of it.
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

  const rollupJobs = ROLLUP_JOB_NAMES.map((name) => job(name))

  it('finds the jobs it is about to judge', () => {
    // Without this the assertions below are vacuous on an empty list (L100, L143).
    expect(rollupJobs.length).toBe(ROLLUP_JOB_NAMES.length)
    expect(rollupJobs.length).toBe(6)
  })

  it.each(rollupJobs.map((j) => [j.name, j.command] as const))(
    '%s states its own statement_timeout',
    (_name, command) => {
      const value = setting(command, 'statement_timeout')
      expect(value, 'no statement_timeout in the cron command').not.toBeNull()
      expect(timeoutMs(value!)).toBeGreaterThan(0)
    },
  )

  it.each(ALL_REFRESH_FUNCTIONS)('%s does not set statement_timeout in its body', (fn) => {
    // The placement is the whole point: in the body this line is inert.
    const found = latestRoutineBody(fn, migrations)
    expect(found).not.toBeNull()
    expect(
      setting(found!.body, 'statement_timeout'),
      `${fn} in ${found!.migration} sets statement_timeout inside the function, ` +
        'where it does not bind the running call',
    ).toBeNull()
  })

  it.each(ALL_REFRESH_FUNCTIONS)('%s leaves most of its budget for the work, not the lock wait', (fn) => {
    const found = latestRoutineBody(fn, migrations)
    expect(found).not.toBeNull()
    const lock = setting(found!.body, 'lock_timeout')
    expect(lock, `${fn} sets no lock_timeout`).not.toBeNull()

    // Every job whose command invokes this function states a budget.
    const fnJobs = jobs.filter((j) => commandRoutine(j.command) === fn)
    expect(fnJobs.length, `${fn} has no driving job`).toBeGreaterThan(0)
    const budgets = fnJobs.map((j) => {
      const v = setting(j.command, 'statement_timeout')
      expect(v, `${j.name} sets no statement_timeout`).not.toBeNull()
      return timeoutMs(v!)
    })
    // A full lock wait must leave at least two thirds of the smallest budget
    // for the work.
    expect(
      timeoutMs(lock!),
      `${fn} lock wait ${lock} against a ${Math.min(...budgets)}ms budget`,
    ).toBeLessThanOrEqual(Math.min(...budgets) / 3)
  })

  /**
   * A run that spends its ENTIRE budget must still finish inside its own slot
   * (#1147), with a cushion to roll back and release the lock before the next run.
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

  const frequentJobs = rollupJobs.filter((j) => isFrequent(j.schedule))

  it('finds at least one frequent rollup job to judge', () => {
    // The filter silently empties if the schedule format changes, and an empty
    // it.each is green (L100).
    expect(frequentJobs.length).toBeGreaterThan(0)
  })

  it.each(frequentJobs.map((j) => [j.name, j.schedule, j.command] as const))(
    '%s cannot outlive its own slot',
    (_name, schedule, command) => {
      const intervalMs = shortestGapMinutes(schedule) * 60_000
      const value = setting(command, 'statement_timeout')
      expect(value, 'no statement_timeout in the cron command').not.toBeNull()
      const budgetMs = timeoutMs(value!)

      expect(
        budgetMs + CUSHION_MS,
        `a run may spend ${budgetMs}ms of a ${intervalMs}ms slot, leaving under ` +
          `${CUSHION_MS}ms to roll back and release the lock before the next run`,
      ).toBeLessThanOrEqual(intervalMs)
    },
  )
})
