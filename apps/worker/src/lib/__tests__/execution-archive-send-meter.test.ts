/**
 * The archive run records what its Snowflake sends cost (#1443).
 *
 * The meter is created by the run, handed to every send, and its figures are
 * written into the run's own job_runs row, both as progress and at the close.
 * These tests drive the REAL runExecutionArchive against the recording double,
 * so they read the row that reached the database rather than a return value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../index'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

const executeStatement = vi.fn()
vi.mock('../snowflake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snowflake')>()),
  executeStatement: (...args: unknown[]) => executeStatement(...args),
}))

import { runExecutionArchive, type ArchiveRow } from '../execution-archive'
import { archiveSender } from '../execution-archive-send'
import { SnowflakeSendMeter } from '../snowflake'
import { EXPECTED_ORGANIZATION_SLUG } from '../../archive/disposition'
import { makeArchiveDouble, makeKV, rowsFor, NOW } from './_archive-double'

beforeEach(() => executeStatement.mockReset())

describe('the archive run records its Snowflake send figures (#1443)', () => {
  async function run() {
    const double = makeArchiveDouble({ organizationSlug: EXPECTED_ORGANIZATION_SLUG, executions: 3 })
    const env = { IDEMPOTENCY: makeKV(), SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env
    const meters: unknown[] = []
    const summary = await runExecutionArchive(env, double.client, {
      // Stands in for the real client: one resubmitted statement per batch.
      sendBatch: async (_rows: ArchiveRow[], _giveUpAt: number, meter?: SnowflakeSendMeter) => {
        meters.push(meter)
        meter?.recordAttempt(70_000, 524)
        meter?.recordResubmit()
        meter?.recordAttempt(9_000, 200)
        meter?.recordStatement(79_000)
      },
      now: () => NOW,
    })
    return { summary, meters, writes: double.writes }
  }

  it('hands every send the run\'s own meter', async () => {
    const { meters } = await run()
    expect(meters.length).toBeGreaterThan(0)
    expect(meters[0]).toBeInstanceOf(SnowflakeSendMeter)
    expect(new Set(meters).size).toBe(1)
  })

  it('returns the figures in its summary', async () => {
    const { summary, meters } = await run()
    expect(summary.snowflakeSend).toMatchObject({
      statements: meters.length,
      attempts: 2 * meters.length,
      resubmits: meters.length,
      worstStatus: 524,
      slowestAttemptMs: 70_000,
      slowestStatementMs: 79_000,
    })
  })

  it('writes the figures into the job_runs row it closes', async () => {
    const { writes, meters } = await run()
    const closing = (rowsFor(writes, 'job_runs') as Array<Record<string, unknown>>).find(
      (r) => r.finished_at !== undefined,
    )
    const recorded = (closing?.summary as Record<string, unknown> | undefined)?.snowflakeSend
    expect(recorded).toMatchObject({ statements: meters.length, resubmits: meters.length, failedAttempts: { '524': meters.length } })
  })

  it('writes them into the progress stamps too, so a killed run still leaves them', async () => {
    const { writes } = await run()
    const stamps = (rowsFor(writes, 'job_runs') as Array<Record<string, unknown>>).filter(
      (r) => r.finished_at === undefined && r.summary !== undefined,
    )
    expect(stamps.length).toBeGreaterThan(0)
    const last = stamps[stamps.length - 1].summary as Record<string, unknown>
    expect(last.snowflakeSend).toMatchObject({ resubmits: expect.any(Number) })
  })

  it('reports zeros, not a missing field, for a run that sent nothing', async () => {
    const double = makeArchiveDouble({ organizationSlug: EXPECTED_ORGANIZATION_SLUG, executions: 0 })
    const env = { IDEMPOTENCY: makeKV(), SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env
    const summary = await runExecutionArchive(env, double.client, { sendBatch: async () => {}, now: () => NOW })
    expect(summary.snowflakeSend).toMatchObject({ statements: 0, attempts: 0, resubmits: 0 })
  })
})

describe('archiveSender, the one send function every archive caller uses (#1443)', () => {
  const scalars = {
    organizationId: 'o', workflowId: 'w', workflowVersionId: null, parentExecutionId: null,
    resumedFromExecutionId: null, traceId: null, source: null, status: 'completed', outcome: null,
    isTest: false, startedAtUtc: null, completedAtUtc: null, durationMs: null, costUsd: null, ssnHash: null,
  }
  const rows = [{ executionId: 'a', archiveDay: '2026-08-16', wire: 'x', incomplete: false, stepCount: 2, scalars }]
  const env = { SNOWFLAKE_ACCOUNT: 'acct', ARCHIVE_WRITER_USER: 'u', ARCHIVE_WRITER_PRIVATE_KEY: 'k' } as unknown as Env

  it('passes the run\'s deadline and meter through to the Snowflake client', async () => {
    executeStatement.mockResolvedValue({ data: [['1']] })
    const meter = new SnowflakeSendMeter(() => 0)

    await archiveSender(env)(rows as unknown as ArchiveRow[], 1_234_567, meter)

    expect(executeStatement.mock.calls[0][3]).toEqual({ giveUpAt: 1_234_567, meter })
  })
})
