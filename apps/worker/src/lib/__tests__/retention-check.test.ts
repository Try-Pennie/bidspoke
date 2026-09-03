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

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))

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

  it('does not treat a null answer as an empty list of jobs', async () => {
    // `data: null` with no error is a shape PostgREST can return; reading it as
    // zero rows would be a second way to report a broken read as a measurement.
    const db = supabaseDouble({ data: null })

    const result = await checkExecutionRetention(env, db.client)

    expect(result.alerted).toBe(true)
    expect(result.differences.map((d) => d.code)).toEqual(['unreadable'])
  })
})
