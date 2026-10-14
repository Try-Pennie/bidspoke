/**
 * Reading the purge jobs' retention back out of the database, on a schedule
 * (#1017).
 *
 * The CI guard compares the code against the MIGRATIONS, which catches a recorded
 * change before it merges and cannot see a job edited directly in the database.
 * This is the half that can. A setting whose value carries the guarantee is
 * asserted on a schedule, not audited at change time (L502).
 *
 * Drives the real function against a recording Supabase double, so it sees the
 * RPC actually issued and the messages actually sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import { checkExecutionRetention, RETENTION_CHECK_JOB } from '../retention-check'
import { notifyExportFailure } from '../export-alerts'
import { RETENTION_DAYS } from '../../archive/candidate-days'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const env = { IDEMPOTENCY: undefined } as unknown as Env

const TRUNCATE = 'purge-old-execution-partitions'
const REAP = 'reap-empty-execution-partitions'

function row(jobname: string, over: Record<string, unknown> = {}) {
  return {
    jobname,
    active: true,
    retention_days: RETENTION_DAYS,
    command: `CALL some_procedure(${RETENTION_DAYS})`,
    ...over,
  }
}

/** A double that answers the one RPC and records that it was the one asked for. */
function supabaseDouble(answer: { data?: unknown; error?: unknown }) {
  const calls: string[] = []
  const client = {
    rpc(name: string) {
      calls.push(name)
      return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })
    },
  } as unknown as SupabaseClient
  return { client, calls }
}

function alerted(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === RETENTION_CHECK_JOB)
    .flatMap((c) => c[2] as string[])
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('checkExecutionRetention', () => {
  it('is silent when both jobs match the window the code declares', async () => {
    const db = supabaseDouble({ data: [row(TRUNCATE), row(REAP)] })

    const result = await checkExecutionRetention(env, db.client)

    expect(db.calls).toEqual(['execution_purge_retention'])
    expect(result.differences).toEqual([])
    expect(result.alerted).toBe(false)
    expect(alerted()).toEqual([])
  })

  it('still calls the alerter on a clean run, because an empty list is the recovery signal', async () => {
    // `notifyExportFailure` reads no errors as "recovered" and clears its alert
    // state with it. Short-circuiting a clean run would leave a drift that has
    // been FIXED still looking unresolved to the next run, so the clean path has
    // to reach the alerter rather than skip it.
    const db = supabaseDouble({ data: [row(TRUNCATE), row(REAP)] })

    await checkExecutionRetention(env, db.client)

    const calls = vi.mocked(notifyExportFailure).mock.calls.filter((c) => c[1] === RETENTION_CHECK_JOB)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[2]).toEqual([])
  })

  it('alerts, naming both numbers, when a job runs at a different window', async () => {
    const db = supabaseDouble({
      data: [row(TRUNCATE, { retention_days: 9, command: 'CALL truncate_expired_execution_partitions(9)' }), row(REAP)],
    })

    const result = await checkExecutionRetention(env, db.client)

    expect(result.alerted).toBe(true)
    expect(alerted().join(' ')).toContain('9 days')
    expect(alerted().join(' ')).toContain(String(RETENTION_DAYS))
  })

  it('alerts that it could not read, rather than reporting agreement, when the RPC fails', async () => {
    // A read that failed is not evidence retention is correct. Reporting no
    // differences here is the one answer this check must never give without
    // having measured (L98, L11).
    const db = supabaseDouble({ error: { message: 'permission denied for schema cron' } })

    const result = await checkExecutionRetention(env, db.client)

    expect(result.alerted).toBe(true)
    expect(result.differences.map((d) => d.code)).toEqual(['unreadable'])
    expect(alerted().join(' ')).toContain('permission denied')
  })

  it('alerts when the RPC answers with no rows at all', async () => {
    // Distinct from a failed read: the call worked and found no purge jobs, which
    // means nothing is destroying execution data on a schedule anybody recorded.
    const db = supabaseDouble({ data: [] })

    const result = await checkExecutionRetention(env, db.client)

    expect(result.alerted).toBe(true)
    expect(result.differences.map((d) => d.code)).toEqual(['job-missing', 'job-missing'])
  })

  it('reports an unparseable command as unreadable, quoting what it saw', async () => {
    const db = supabaseDouble({
      data: [
        row(TRUNCATE, { retention_days: null, command: 'CALL truncate_expired_execution_partitions(days_from_config())' }),
        row(REAP),
      ],
    })

    const result = await checkExecutionRetention(env, db.client)

    expect(result.differences.map((d) => d.code)).toEqual(['retention-unreadable'])
    expect(alerted().join(' ')).toContain('days_from_config()')
  })

  it('alerts and returns rather than throwing when the read throws outright', async () => {
    // An RPC that REJECTS, rather than resolving with an error, is a different
    // path from the one above. It has to alert too: a caught error that never
    // reaches monitoring is invisible twice (L13), and the daily batch's own
    // heartbeat only covers this check never RUNNING, not it dying halfway.
    //
    // Tested here rather than in the cron handler on purpose. Failure behaviour
    // that lives inside `scheduled()` is unreachable from a test, which is why
    // this function is the thing that must not throw.
    const client = {
      rpc() {
        throw new Error('connection reset')
      },
    } as unknown as SupabaseClient

    const result = await checkExecutionRetention(env, client)

    expect(result.alerted).toBe(true)
    expect(result.differences.map((d) => d.code)).toEqual(['failed'])
    expect(alerted().join(' ')).toContain('connection reset')
  })

  it('still returns a result when even the alerting fails, so the caller is not handed a rejection', async () => {
    // The alerter is the thing that broke. There is nothing left but the log, and
    // throwing here would replace a reported problem with an unhandled rejection.
    vi.mocked(notifyExportFailure).mockRejectedValueOnce(new Error('slack webhook 500'))
    const db = supabaseDouble({ error: { message: 'permission denied' } })

    const result = await checkExecutionRetention(env, db.client)

    expect(result.alerted).toBe(true)
    expect(result.differences.map((d) => d.code)).toEqual(['unreadable'])
  })

  it('does not treat a null answer as an empty list of jobs', async () => {
    // `data: null` with no error is a shape PostgREST can return; reading it as
    // zero rows would be a second way to report a broken read as a measurement.
    const db = supabaseDouble({ data: null })

    const result = await checkExecutionRetention(env, db.client)

    expect(result.alerted).toBe(true)
    expect(result.differences.map((d) => d.code)).toEqual(['unreadable'])
  })
})

/**
 * #835: "the window ... and the window this repo declares disagree. Nothing
 * failed" was sent when the check itself failed or could not read the jobs,
 * where nothing about the windows is known. And the gate no longer quotes a
 * deadline, so "quoting a deadline that is not the real one" is gone too.
 */
describe('the retention alert says unknown when it could not read the jobs', () => {
  const remedySent = () =>
    vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === RETENTION_CHECK_JOB && (c[2] as string[]).length > 0)?.[4] as {
      consequence: string
      fixHint: string
      headlineVerb?: string
    }

  it('does not say the windows disagree when the read failed', async () => {
    await checkExecutionRetention(env, supabaseDouble({ error: { message: 'permission denied' } }).client)
    const remedy = remedySent()
    expect(remedy.consequence).not.toMatch(/disagree\. Nothing failed/)
    expect(remedy.consequence).toMatch(/unknown/)
    expect(remedy.headlineVerb ?? '').not.toMatch(/disagrees/)
  })

  it('does not say the windows disagree when the check itself threw', async () => {
    const client = {
      rpc: () => {
        throw new Error('client exploded')
      },
    } as unknown as SupabaseClient
    await checkExecutionRetention(env, client)
    expect(remedySent().consequence).toMatch(/unknown/)
  })

  it('keeps the disagreement wording for a real difference, without a deadline the gate no longer quotes', async () => {
    await checkExecutionRetention(env, supabaseDouble({ data: [row(TRUNCATE, { retention_days: 9 }), row(REAP)] }).client)
    const remedy = remedySent()
    expect(remedy.consequence).toMatch(/disagree/)
    expect(`${remedy.consequence} ${alerted().join(' ')}`).not.toMatch(/deadline/)
  })
})

/**
 * Lessons review on #2088: the drift remedy also carries job-missing,
 * job-inactive and retention-unreadable, where "disagree. Nothing failed and
 * nothing is missing" is false. Each kind now gets wording true for it, and
 * the "the check needs attention rather than the schedule" fix survives for a
 * window that could not be read.
 */
describe('each purge job difference gets wording true for it', () => {
  const remedySent = () =>
    vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === RETENTION_CHECK_JOB && (c[2] as string[]).length > 0)?.[4] as {
      consequence: string
      fixHint: string
      headlineVerb?: string
    }
  const runWith = (rows: Array<Record<string, unknown>>) =>
    checkExecutionRetention(env, supabaseDouble({ data: rows }).client)

  it('says disagree, and nothing failed, only when the windows really disagree', async () => {
    await runWith([row(TRUNCATE, { retention_days: 9 }), row(REAP)])
    const remedy = remedySent()
    expect(remedy.consequence).toMatch(/disagree/)
    expect(remedy.headlineVerb).toMatch(/disagrees/)
    expect(remedy.fixHint).toMatch(/Decide which side is right/)
  })

  it('does not say nothing is missing when a job is missing', async () => {
    await runWith([row(REAP)])
    const remedy = remedySent()
    expect(remedy.consequence).not.toMatch(/nothing is missing|Nothing failed/i)
    expect(remedy.headlineVerb).not.toMatch(/disagrees/)
    expect(remedy.fixHint).toMatch(/Recreate the missing job/)
  })

  it('says a disabled job is not enforcing retention, and how to turn it back on', async () => {
    await runWith([row(TRUNCATE, { active: false }), row(REAP)])
    const remedy = remedySent()
    expect(remedy.consequence).not.toMatch(/Nothing failed/)
    expect(remedy.consequence).toMatch(/not being enforced/)
    expect(remedy.fixHint).toMatch(/Re-enable/)
  })

  it('keeps the fix that a window it could not parse needs the check, not the schedule', async () => {
    await runWith([row(TRUNCATE, { retention_days: null, command: 'CALL something_else()' }), row(REAP)])
    const remedy = remedySent()
    expect(remedy.consequence).not.toMatch(/disagree\./)
    expect(remedy.consequence).toMatch(/unknown/)
    expect(remedy.fixHint).toMatch(/the check itself needs attention rather than the schedule/)
    expect(remedy.fixHint).not.toMatch(/Decide which side is right/)
    // Nothing about the jobs differing was measured, so it may not open by
    // saying they are not as declared (lessons review, #835).
    expect(remedy.consequence).not.toMatch(/are not as this repo declares/)
  })
})
