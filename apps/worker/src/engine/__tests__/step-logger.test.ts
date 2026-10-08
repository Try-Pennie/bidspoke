import { describe, it, expect, vi } from 'vitest'
import { createExecutionRecord, updateExecutionRecord, flushStepLogs, NO_ROW_MATCHED_CODE, UPDATE_RETRY_DELAYS_MS, CREATE_RETRY_DELAYS_MS, FLUSH_RETRY_DELAYS_MS } from '../step-logger'
import { MIN_AGE_MINUTES as STRAND_DRAIN_MIN_AGE_MINUTES } from '../../lib/stranded-executions'
import {
  PostResponseBudget,
  POST_RESPONSE_BUDGET_MS,
  DEAD_LETTER_RESERVE_MS,
  FINALIZE_RESERVE_MS,
} from '../../lib/post-response-budget'
import { DB_WRITE_RETRY_DELAYS_MS } from '../../lib/db-retry'
import { VirtualClock } from '../../lib/__tests__/_virtual-clock'

// Total wall-clock the finalize ladder spans before it gives up.
const ladderSpanMs = () => UPDATE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
import type { SupabaseClient } from '@supabase/supabase-js'

// Regression guard for the 2026-06-10 incident: the nightly partition purge
// held an ACCESS EXCLUSIVE lock, the workflow_executions insert hit the 8s
// statement timeout, createExecutionRecord threw with no retry, and 8
// executions lost their entire audit trail (execution row, step rows, lead
// sighting). The lock clears within seconds; a short backoff saves the row.

function clientWith(results: Array<{ error: { code?: string; message: string } | null }>) {
  let call = 0
  const insert = vi.fn().mockImplementation(() => Promise.resolve(results[Math.min(call++, results.length - 1)]))
  const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
  return { client, insert }
}

const record = {
  id: 'exec-1',
  workflow_id: 'wf-1',
  workflow_version_id: 'ver-1',
  source: 'test',
  trigger_payload: {},
  trace_id: 'trace-1',
  started_at: '2026-06-10T03:30:00Z',
  is_test: false,
}

describe('createExecutionRecord', () => {
  it('succeeds first try without sleeping', async () => {
    const { client, insert } = clientWith([{ error: null }])
    await createExecutionRecord(client, record, [1, 1])
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it('retries after a statement timeout and succeeds when the lock clears', async () => {
    const { client, insert } = clientWith([
      { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
      { error: null },
    ])
    await createExecutionRecord(client, record, [1, 1])
    expect(insert).toHaveBeenCalledTimes(2)
  })

  it('throws the last error once retries are exhausted', async () => {
    const { client, insert } = clientWith([
      { error: { code: '57014', message: 'statement timeout' } },
      { error: { code: '57014', message: 'statement timeout' } },
      { error: { code: '57014', message: 'still locked' } },
    ])
    await expect(createExecutionRecord(client, record, [1, 1])).rejects.toThrow(
      'workflow_executions insert failed: still locked'
    )
    expect(insert).toHaveBeenCalledTimes(3)
  })

  it('treats a unique violation on a retry as success (first attempt landed, response lost)', async () => {
    const { client, insert } = clientWith([
      { error: { code: '57014', message: 'statement timeout' } },
      { error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
    ])
    await expect(createExecutionRecord(client, record, [1, 1])).resolves.toBeUndefined()
    expect(insert).toHaveBeenCalledTimes(2)
  })

  it('resolves when every attempt reports a duplicate (the row exists either way)', async () => {
    const { client } = clientWith([
      { error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
      { error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
      { error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
    ])
    // A dup on attempt 0 retries once and then resolves via the retry-dup
    // rule. The audit row existing is the goal, so this is success, not an
    // error worth surfacing as "step logs failed to persist".
    await expect(createExecutionRecord(client, record, [1, 1])).resolves.toBeUndefined()
  })
})

describe('createExecutionRecord — error classification (2026-06-12 schema-cache 503)', () => {
  it('retries a PostgREST schema-cache 503 and succeeds once the reload finishes', async () => {
    const { client, insert } = clientWith([
      { error: { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' } },
      { error: null },
    ])
    await createExecutionRecord(client, record, [1, 1])
    expect(insert).toHaveBeenCalledTimes(2)
  })

  it('fails fast on a permanent data error without burning the retry budget', async () => {
    const { client, insert } = clientWith([
      { error: { code: '23502', message: 'null value in column "workflow_id" violates not-null constraint' } },
    ])
    await expect(createExecutionRecord(client, record, [1, 1])).rejects.toThrow('violates not-null constraint')
    expect(insert).toHaveBeenCalledTimes(1)
  })
})

const stepEntry = {
  execution_id: 'exec-1',
  execution_started_at: '2026-06-11T00:00:00Z',
  step_namespace: 'equifax',
  step_type: 'code',
  status: 'completed' as const,
  input: {},
  output: {},
  retries_used: 0,
  started_at: '2026-06-11T00:00:00Z',
  completed_at: '2026-06-11T00:00:01Z',
  duration_ms: 1000,
  step_order: 1,
}

describe('flushStepLogs — transient retry', () => {
  it('retries the batch on a schema-cache 503 then succeeds (no per-row fallback)', async () => {
    vi.useFakeTimers()
    try {
      const insert = vi
        .fn()
        .mockResolvedValueOnce({ error: { code: 'PGRST002', message: 'schema cache' } })
        .mockResolvedValueOnce({ error: null })
      const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
      const { flushStepLogs } = await import('../step-logger')
      const p = flushStepLogs(client, [stepEntry], '')
      await vi.advanceTimersByTimeAsync(2100)
      await expect(p).resolves.toBeNull()
      expect(insert).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a permanent row error; isolates it per-row instead', async () => {
    const insert = vi
      .fn()
      .mockResolvedValue({ error: { code: '22P02', message: 'invalid input syntax for type uuid' } })
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
    const { flushStepLogs } = await import('../step-logger')
    const result = await flushStepLogs(client, [stepEntry], '')
    // One batch attempt (permanent -> no retry) plus one per-row isolation attempt.
    expect(insert).toHaveBeenCalledTimes(2)
    expect(result).toContain('1/1 step rows failed')
  })
})

describe('updateExecutionRecord', () => {
  it('retries a schema-cache 503 on the finalize update then succeeds', async () => {
    vi.useFakeTimers()
    try {
      let call = 0
      const results = [
        { error: { code: 'PGRST002', message: 'schema cache' } },
        { data: [{ id: 'exec-1' }] },
      ]
      const select = vi.fn().mockImplementation(() => Promise.resolve(results[Math.min(call++, results.length - 1)]))
      const eq2 = vi.fn().mockReturnValue({ select })
      const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
      const update = vi.fn().mockReturnValue({ eq: eq1 })
      const client = { from: vi.fn().mockReturnValue({ update }) } as unknown as SupabaseClient

      const p = updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', {
        status: 'completed',
        completed_at: '2026-06-11T00:00:01Z',
        duration_ms: 1000,
      })
      await vi.advanceTimersByTimeAsync(2100)
      await p
      expect(select).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes response_status through to the workflow_executions update (issue #30)', async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ id: 'exec-1' }] })
    const eq2 = vi.fn().mockReturnValue({ select })
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
    const update = vi.fn().mockReturnValue({ eq: eq1 })
    const client = { from: vi.fn().mockReturnValue({ update }) } as unknown as SupabaseClient

    await updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', {
      status: 'completed',
      completed_at: '2026-06-11T00:00:01Z',
      duration_ms: 1000,
      response_body: { ok: true },
      response_status: 200,
    })

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ response_status: 200, response_body: { ok: true } })
    )
  })
})

// Issue #487 (AUD-024): the id-only fallback checked `error` but never whether
// any row was matched, so a finalize against a missing base row (createExecution
// Record failed permanently, yet finalize still runs) returned success. A lead
// was served a real response and left no execution row, no steps, and nothing
// for the strand drain to find, while the write that lost it reported OK.

// Mocks the two statements updateExecutionOnce issues:
//   partition-keyed: update(...).eq('id').eq('started_at').select('id')
//   id-only fallback: update(...).eq('id').select('id')
function updateClientWith(
  keyed: { data?: unknown[]; error?: { code?: string; message: string } | null },
  fallback: { data?: unknown[]; error?: { code?: string; message: string } | null }
) {
  const keyedSelect = vi.fn().mockResolvedValue({ error: null, ...keyed })
  const fallbackSelect = vi.fn().mockResolvedValue({ error: null, ...fallback })
  const eqStartedAt = vi.fn().mockReturnValue({ select: keyedSelect })
  const eqId = vi.fn().mockReturnValue({ eq: eqStartedAt, select: fallbackSelect })
  const update = vi.fn().mockReturnValue({ eq: eqId })
  const client = { from: vi.fn().mockReturnValue({ update }) } as unknown as SupabaseClient
  return { client, update, keyedSelect, fallbackSelect }
}

const finalize = {
  status: 'completed',
  completed_at: '2026-06-11T00:00:01Z',
  duration_ms: 1000,
}

describe('updateExecutionRecord: missing base row (#487)', () => {
  it('reports an error when neither statement matches a row', async () => {
    const { client } = updateClientWith({ data: [] }, { data: [] })
    const error = await updateExecutionRecord(client, 'exec-gone', '2026-06-11T00:00:00Z', finalize)
    expect(error).not.toBeNull()
    expect(error?.code).toBe(NO_ROW_MATCHED_CODE)
    expect(error?.message).toContain('exec-gone')
  })

  it('does not burn the retry ladder on a missing row (a row that does not exist cannot appear)', async () => {
    const { client, update } = updateClientWith({ data: [] }, { data: [] })
    await updateExecutionRecord(client, 'exec-gone', '2026-06-11T00:00:00Z', finalize)
    // One finalize attempt = the keyed statement plus its id-only fallback.
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('still succeeds when the id-only fallback matches the row (partition-pruning miss)', async () => {
    const { client, fallbackSelect } = updateClientWith({ data: [] }, { data: [{ id: 'exec-1' }] })
    const error = await updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', finalize)
    expect(error).toBeNull()
    expect(fallbackSelect).toHaveBeenCalledTimes(1)
  })

  it('returns the error after the retry ladder is exhausted on a transient failure', async () => {
    vi.useFakeTimers()
    try {
      const { client } = updateClientWith({ error: { code: 'PGRST002', message: 'schema cache' } }, { data: [] })
      const p = updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', finalize)
      // Derived from the ladder itself, never a literal: a hardcoded advance
      // silently stops covering the ladder the moment the ladder changes, and
      // the test then hangs or passes for the wrong reason.
      await vi.advanceTimersByTimeAsync(ladderSpanMs() + 1_000)
      const error = await p
      expect(error?.code).toBe('PGRST002')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns the error on a permanent failure', async () => {
    const { client } = updateClientWith({ error: { code: '42703', message: 'column does not exist' } }, { data: [] })
    const error = await updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', finalize)
    expect(error?.code).toBe('42703')
  })

  it('returns null on a clean finalize', async () => {
    const { client } = updateClientWith({ data: [{ id: 'exec-1' }] }, { data: [] })
    await expect(updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', finalize)).resolves.toBeNull()
  })
})

// Issue #584: a missing base row means createExecutionRecord failed permanently,
// yet the lead was served a real response. Alerting alone leaves the audit row
// gone forever. When the finalize call site can supply the create fields, the
// row is reconstructed from them plus the final-state finalize columns, so the
// record of a served lead survives. The dead-letter is kept only for the case
// where the reconstruction insert itself fails.

// Mocks both the update path (two statements, both zero-row) and the
// reconstruction insert on the same `workflow_executions` table.
function reconClientWith(insertResult: { error: { code?: string; message: string } | null }) {
  const zero = vi.fn().mockResolvedValue({ error: null, data: [] })
  const eqStartedAt = vi.fn().mockReturnValue({ select: zero })
  const eqId = vi.fn().mockReturnValue({ eq: eqStartedAt, select: zero })
  const update = vi.fn().mockReturnValue({ eq: eqId })
  const insert = vi.fn().mockResolvedValue(insertResult)
  const client = { from: vi.fn().mockReturnValue({ update, insert }) } as unknown as SupabaseClient
  return { client, update, insert }
}

const createFields = {
  workflow_id: 'wf-1',
  workflow_version_id: 'ver-1',
  source: 'engine',
  trigger_payload: { lead: 1 },
  trace_id: 'trace-1',
  is_test: false,
}

describe('updateExecutionRecord: reconstruction on missing base row (#584)', () => {
  it('reconstructs the row from createFields + the final-state update, and returns null', async () => {
    const { client, insert } = reconClientWith({ error: null })
    const error = await updateExecutionRecord(client, 'exec-gone', '2026-06-11T00:00:00Z', finalize, createFields)

    expect(error).toBeNull()
    expect(insert).toHaveBeenCalledTimes(1)
    const [rows] = insert.mock.calls[0]
    expect(rows).toHaveLength(1)
    // Identity + NOT NULL create fields, plus the FINAL status from finalize
    // (not 'running') so the reconstructed row is a complete terminal record.
    expect(rows[0]).toMatchObject({
      id: 'exec-gone',
      started_at: '2026-06-11T00:00:00Z',
      workflow_id: 'wf-1',
      workflow_version_id: 'ver-1',
      source: 'engine',
      trace_id: 'trace-1',
      trigger_type: 'http_webhook',
      status: 'completed',
      completed_at: '2026-06-11T00:00:01Z',
      duration_ms: 1000,
    })
  })

  it('returns the insert error when reconstruction also fails permanently', async () => {
    const { client } = reconClientWith({ error: { code: '42703', message: 'column does not exist' } })
    const error = await updateExecutionRecord(client, 'exec-gone', '2026-06-11T00:00:00Z', finalize, createFields)
    expect(error?.code).toBe('42703')
  })

  it('does not attempt reconstruction when no createFields are supplied (keeps the #487 dead-letter path)', async () => {
    const { client, insert } = reconClientWith({ error: null })
    const error = await updateExecutionRecord(client, 'exec-gone', '2026-06-11T00:00:00Z', finalize)
    expect(error?.code).toBe(NO_ROW_MATCHED_CODE)
    expect(insert).not.toHaveBeenCalled()
  })
})

// Issue #629: after the base row is reconstructed the FK-blocked step rows can
// finally land, so the caller re-flushes them. updateExecutionRecord signals a
// successful reconstruction through the onReconstructed callback (row now
// exists), and stays silent on a normal update or a failed reconstruction.
describe('updateExecutionRecord: reconstruction signal for step recovery (#629)', () => {
  it('invokes onReconstructed after a successful reconstruction', async () => {
    const { client } = reconClientWith({ error: null })
    const onReconstructed = vi.fn()
    await updateExecutionRecord(client, 'exec-gone', '2026-06-11T00:00:00Z', finalize, createFields, onReconstructed)
    expect(onReconstructed).toHaveBeenCalledTimes(1)
  })

  it('does not invoke onReconstructed when the reconstruction insert fails', async () => {
    const { client } = reconClientWith({ error: { code: '42703', message: 'column does not exist' } })
    const onReconstructed = vi.fn()
    await updateExecutionRecord(client, 'exec-gone', '2026-06-11T00:00:00Z', finalize, createFields, onReconstructed)
    expect(onReconstructed).not.toHaveBeenCalled()
  })

  it('does not invoke onReconstructed on a clean update that matched a row', async () => {
    const { client } = updateClientWith({ data: [{ id: 'exec-1' }] }, { data: [] })
    const onReconstructed = vi.fn()
    await updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', finalize, createFields, onReconstructed)
    expect(onReconstructed).not.toHaveBeenCalled()
  })
})

// Issue #1883 (defect B): finalize saw the row missing and rebuilt it, but the
// original create was still in flight and landed at the same moment, so the
// rebuild insert hit a duplicate key. That duplicate was counted as success and
// nothing was written: runs 01a11b75-e475 and 01a11b75-e477 on 2026-10-08 stayed
// 'running' with no response_status until the strand drain relabelled them.
// The row exists after a duplicate, so the finalize update is applied to it once
// more, and success is reported only when that update matched the row.

type DbResult = { data?: unknown[]; error?: { code?: string; message: string } | null }

// Every UPDATE is recorded with its payload and filters, and answers from
// `updates` in order (the last entry repeats). The insert answers from `inserts`.
function racingClient(updates: DbResult[], inserts: DbResult[]) {
  const calls: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown]> }> = []
  let u = 0
  let i = 0
  const update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
    const call = { payload, filters: [] as Array<[string, unknown]> }
    calls.push(call)
    const chain = {
      eq: (col: string, val: unknown) => {
        call.filters.push([col, val])
        return chain
      },
      select: () => Promise.resolve({ error: null, ...updates[Math.min(u++, updates.length - 1)] }),
    }
    return chain
  })
  const insert = vi.fn().mockImplementation(() =>
    Promise.resolve({ error: null, ...inserts[Math.min(i++, inserts.length - 1)] }),
  )
  const client = { from: vi.fn().mockReturnValue({ update, insert }) } as unknown as SupabaseClient
  return { client, calls, insert }
}

const missing: DbResult = { data: [] }
const duplicate: DbResult = {
  error: { code: '23505', message: 'duplicate key value violates unique constraint "workflow_executions_2026_10_08_pkey"' },
}

describe('updateExecutionRecord: the rebuild collides with the original create landing (#1883)', () => {
  const startedAt = '2026-10-08T12:21:01.000Z'

  it('applies the finalize update to the row that now exists and reports success only once it matched', async () => {
    // Keyed miss, id-only miss, rebuild duplicate, then the update against the landed row matches.
    const { client, calls, insert } = racingClient([missing, missing, { data: [{ id: 'exec-race' }] }], [duplicate])
    const onReconstructed = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const error = await updateExecutionRecord(client, 'exec-race', startedAt, finalize, createFields, onReconstructed)
      expect(error).toBeNull()
      expect(insert).toHaveBeenCalledTimes(1)
      // The third UPDATE goes to the landed row: the final state, pruned to one partition.
      expect(calls).toHaveLength(3)
      expect(calls[2].payload).toEqual(finalize)
      expect(calls[2].filters).toEqual([
        ['id', 'exec-race'],
        ['started_at', startedAt],
      ])
      // Nothing was rebuilt, so the step log re-flush must not run: the original
      // create's own flush is still chained behind it.
      expect(onReconstructed).not.toHaveBeenCalled()
      const lines = warn.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.includes('landed concurrently'))).toBe(true)
      expect(lines.some((l) => l.includes('base insert had failed'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('takes the failure path when the update against the landed row still matches no row', async () => {
    const { client, calls } = racingClient([missing, missing, missing], [duplicate])
    const onReconstructed = vi.fn()
    const error = await updateExecutionRecord(client, 'exec-race', startedAt, finalize, createFields, onReconstructed)
    expect(error?.code).toBe(NO_ROW_MATCHED_CODE)
    expect(calls).toHaveLength(3)
    expect(onReconstructed).not.toHaveBeenCalled()
  })

  it('retries a transient failure of that update on the injected clock and stops at the cut-off', async () => {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    budget.arm()
    const down: DbResult = { error: { code: 'PGRST002', message: 'schema cache' } }
    const { client } = racingClient([missing, missing, down], [duplicate])
    const onReconstructed = vi.fn()
    const p = updateExecutionRecord(client, 'exec-race', startedAt, finalize, createFields, onReconstructed, {
      clock,
      budget,
      reserveMs: DEAD_LETTER_RESERVE_MS,
    })
    await clock.run()
    expect((await p)?.code).toBe('PGRST002')
    expect(clock.sleeps.length).toBeGreaterThan(0)
    expect(clock.now()).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS - DEAD_LETTER_RESERVE_MS)
    expect(onReconstructed).not.toHaveBeenCalled()
  })
})

describe('flushStepLogs stamping', () => {
  it('stamps workflow_id and is_test on every row (issue #32: per-namespace percentile sampling)', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
    const { flushStepLogs } = await import('../step-logger')

    const entry = {
      execution_id: 'exec-1',
      execution_started_at: '2026-06-11T00:00:00Z',
      step_namespace: 'equifax',
      step_type: 'code',
      status: 'completed' as const,
      input: {},
      output: {},
      retries_used: 0,
      started_at: '2026-06-11T00:00:00Z',
      completed_at: '2026-06-11T00:00:01Z',
      duration_ms: 1000,
      step_order: 1,
    }
    await flushStepLogs(client, [entry], '', { workflowId: 'wf-1', isTest: false })

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ workflow_id: 'wf-1', is_test: false, step_namespace: 'equifax' }),
    ])
  })
})

// #1113: on 2026-09-02 Supabase answered the finalize PATCH with an empty-bodied
// HTTP 500 at 21:32:22, 21:32:24 and 21:32:31 UTC. The ladder was [2s, 5s], so
// three attempts spanning seven seconds, and it was spent while the wobble was
// still running. The run stranded, an alert fired, and the row sat at 'running'
// for 30 minutes waiting for the drain. #1113 then stretched the ladder to 112
// seconds on the belief that post-response time was free; it is not (#1850).
describe('updateExecutionRecord: a real outage, and the finalize ladder (#1113, #1850)', () => {
  // Measured from that incident: first 500 to last 500 was about 90 seconds.
  const OBSERVED_OUTAGE_MS = 90_000

  // #1850 reverses #1113's sizing. The 112 second ladder could not outlast the
  // observed outage anyway: Cloudflare cancels post-response work 30 seconds
  // after the answer, so its later rungs and the dead letter behind them never
  // ran. What the ladder owes now is to give up, with its error in hand, early
  // enough for that dead letter to be written.
  it('ends a 90 second outage with its error inside the budget, so the dead letter can follow', async () => {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    budget.arm()
    const keyedSelect = vi.fn(async () =>
      clock.now() < OBSERVED_OUTAGE_MS
        ? { data: null, error: { code: 'PGRST002', message: 'schema cache' } }
        : { data: [{ id: 'exec-1' }], error: null },
    )
    const eqStartedAt = vi.fn().mockReturnValue({ select: keyedSelect })
    const eqId = vi.fn().mockReturnValue({ eq: eqStartedAt, select: vi.fn().mockResolvedValue({ data: [], error: null }) })
    const update = vi.fn().mockReturnValue({ eq: eqId })
    const client = { from: vi.fn().mockReturnValue({ update }) } as unknown as SupabaseClient

    const p = updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', finalize, undefined, undefined, {
      clock,
      budget,
      reserveMs: DEAD_LETTER_RESERVE_MS,
    })
    await clock.run()

    expect((await p)?.code).toBe('PGRST002')
    expect(clock.now()).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS - DEAD_LETTER_RESERVE_MS)
  })

  // LESSONS L77: an error classified as survivable must still be countable. The
  // old seven-second ladder turned a 90 second wobble into a failed finalize and
  // a page; the new one absorbs it and returns success. That is the point, but it
  // also means a database degrading for two minutes at a time would now leave no
  // trace at all, and the widening outage would be invisible for exactly as long
  // as it lasted. A finalize that needed the ladder says so, mirroring the warn
  // the CREATE ladder beside it already emits.
  it('says so when the finalize only landed after burning retries', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let attempt = 0
      const keyedSelect = vi.fn(async () =>
        ++attempt < 3
          ? { data: null, error: { code: 'PGRST002', message: 'schema cache' } }
          : { data: [{ id: 'exec-1' }], error: null },
      )
      const eqStartedAt = vi.fn().mockReturnValue({ select: keyedSelect })
      const eqId = vi.fn().mockReturnValue({ eq: eqStartedAt, select: vi.fn().mockResolvedValue({ data: [], error: null }) })
      const update = vi.fn().mockReturnValue({ eq: eqId })
      const client = { from: vi.fn().mockReturnValue({ update }) } as unknown as SupabaseClient

      const p = updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', finalize)
      await vi.advanceTimersByTimeAsync(ladderSpanMs() + 1_000)
      expect(await p).toBeNull()

      const line = warn.mock.calls.find(([m]) => typeof m === 'string' && m.includes('workflow_executions'))
      expect(line, 'an absorbed outage must leave a trace').toBeDefined()
      // The count is the measurement: one retry and five are different events.
      expect(JSON.stringify(line)).toContain('3')
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('stays silent when the finalize lands on the first attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client } = updateClientWith({ data: [{ id: 'exec-1' }] }, { data: [] })
      expect(await updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', finalize)).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  // The ladder and the strand drain are two mechanisms for one problem, and the
  // drain is the backstop. If the ladder ever grew past the drain's floor the
  // drain would start finalizing rows a live retry was still working on, so the
  // relationship between the two constants is the thing worth asserting, rather
  // than a ceiling somebody picked.
  it('gives up well before the strand drain starts finalizing the same row', () => {
    expect(ladderSpanMs()).toBeLessThan((STRAND_DRAIN_MIN_AGE_MINUTES * 60_000) / 2)
  })
})

// #1214: a code node that PRINTS the payload it is about to send put the
// applicant's SSN into execution_steps.logs, a column the redactor never
// touched, and the execution archive carries that column for 13 months. These
// drive the real writers against a recording double and assert on the row that
// would actually be inserted.
describe('flushStepLogs redaction of the logs column', () => {
  const ssn = '123-45-6789'
  const entryWithSsnInLogs = () => ({
    execution_id: 'exec-1',
    step_namespace: 'pennie_or_eligibility',
    step_type: 'code',
    status: 'success',
    started_at: '2026-09-09T12:00:00Z',
    input: { social_security_number: ssn },
    output: { ok: true },
    logs: [
      {
        level: 'log' as const,
        message: `Sending body to Eligibility Scout: {"first_name":"Alice","social_security_number":"${ssn}"}`,
        ts: '2026-09-09T12:00:01Z',
      },
      { level: 'log' as const, message: 'Scout responded 200', ts: '2026-09-09T12:00:02Z' },
    ],
  })

  function recordingClient() {
    const rows: Record<string, unknown>[][] = []
    const insert = vi.fn().mockImplementation((r: Record<string, unknown>[]) => {
      rows.push(r)
      return Promise.resolve({ error: null })
    })
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
    return { client, rows }
  }

  it('scrubs a listed field out of a log line when redaction is configured', async () => {
    const { client, rows } = recordingClient()
    await flushStepLogs(client, [entryWithSsnInLogs()] as never, 'social_security_number')
    const written = JSON.stringify(rows[0])
    expect(written).not.toContain(ssn)
  })

  it('leaves the rest of the line, and the unlisted lines, intact', async () => {
    const { client, rows } = recordingClient()
    await flushStepLogs(client, [entryWithSsnInLogs()] as never, 'social_security_number')
    const logs = (rows[0][0] as { logs: Array<{ message: string }> }).logs
    expect(logs).toHaveLength(2)
    expect(logs[0].message).toContain('Sending body to Eligibility Scout:')
    expect(logs[0].message).toContain('Alice')
    expect(logs[1].message).toBe('Scout responded 200')
  })

  // The state ADR 0006 deliberately ships in: no fields listed, nothing
  // redacted anywhere. Asserted so the mechanism cannot start scrubbing on its
  // own without that decision being reversed on purpose.
  it('leaves logs untouched when no fields are configured', async () => {
    const { client, rows } = recordingClient()
    await flushStepLogs(client, [entryWithSsnInLogs()] as never, '')
    const logs = (rows[0][0] as { logs: Array<{ message: string }> }).logs
    expect(logs[0].message).toContain(ssn)
  })

  it('does not fail a step whose logs are absent', async () => {
    const { client, rows } = recordingClient()
    const noLogs = { ...entryWithSsnInLogs(), logs: undefined }
    await flushStepLogs(client, [noLogs] as never, 'social_security_number')
    expect((rows[0][0] as { logs?: unknown }).logs).toBeUndefined()
  })
})

// #1850: every ladder takes its time from an injected clock and stops at the
// shared post-response cut-off, so the dead letter behind it is written before
// Cloudflare cancels the request's waitUntil work.
describe('post-response budget (#1850)', () => {
  const down = { error: { code: 'PGRST002', message: 'schema cache' } }

  function armedAt(clock: VirtualClock) {
    const budget = new PostResponseBudget(clock)
    budget.arm()
    return budget
  }

  it('createExecutionRecord waits the CREATE ladder through the injected clock', async () => {
    const clock = new VirtualClock()
    const { client, insert } = clientWith([down])
    const p = createExecutionRecord(client, record, undefined, { clock })
    const settled = p.catch((e: Error) => e)
    await clock.run()
    expect(await settled).toBeInstanceOf(Error)
    expect(clock.sleeps).toEqual(CREATE_RETRY_DELAYS_MS)
    expect(insert).toHaveBeenCalledTimes(CREATE_RETRY_DELAYS_MS.length + 1)
  })

  it('createExecutionRecord gives up at its cut-off, leaving finalize its share', async () => {
    const clock = new VirtualClock()
    const budget = armedAt(clock)
    const { client } = clientWith([down])
    const late = clock.delay(POST_RESPONSE_BUDGET_MS - FINALIZE_RESERVE_MS - 3_000)
    await clock.run()
    await late
    const p = createExecutionRecord(client, record, undefined, { clock, budget, reserveMs: FINALIZE_RESERVE_MS })
    const settled = p.catch((e: Error) => e)
    await clock.run()
    const err = await settled
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('schema cache')
    // Only the waits that end before the cut-off were taken.
    expect(clock.sleeps).toEqual([CREATE_RETRY_DELAYS_MS[0]])
    expect(clock.now()).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS - FINALIZE_RESERVE_MS)
  })

  it('flushStepLogs waits the FLUSH ladder through the injected clock', async () => {
    const clock = new VirtualClock()
    const insert = vi.fn().mockResolvedValue(down)
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
    const p = flushStepLogs(client, [stepEntry], '', undefined, { clock })
    await clock.run()
    expect(await p).toContain('1/1 step rows failed')
    expect(clock.sleeps).toEqual(FLUSH_RETRY_DELAYS_MS)
  })

  it('flushStepLogs does not start the row by row fallback past its cut-off, and says so', async () => {
    const clock = new VirtualClock()
    const budget = armedAt(clock)
    const late = clock.delay(POST_RESPONSE_BUDGET_MS - FINALIZE_RESERVE_MS + 1)
    await clock.run()
    await late
    const insert = vi.fn().mockResolvedValue(down)
    const client = { from: vi.fn().mockReturnValue({ insert }) } as unknown as SupabaseClient
    const p = flushStepLogs(client, [stepEntry, { ...stepEntry, step_order: 2 }], '', undefined, {
      clock,
      budget,
      reserveMs: FINALIZE_RESERVE_MS,
    })
    await clock.run()
    const result = await p
    // One batch attempt and nothing after it: no waits, no per row inserts.
    expect(insert).toHaveBeenCalledTimes(1)
    expect(clock.sleeps).toEqual([])
    expect(result).toContain('2/2 step rows failed')
    expect(result).toContain('post-response budget')
  })

  it('updateExecutionRecord waits the UPDATE ladder through the injected clock', async () => {
    const clock = new VirtualClock()
    const { client } = updateClientWith(down, { data: [] })
    const p = updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', finalize, undefined, undefined, { clock })
    await clock.run()
    expect((await p)?.code).toBe('PGRST002')
    expect(clock.sleeps).toEqual(UPDATE_RETRY_DELAYS_MS)
  })

  it('updateExecutionRecord stops sleeping at its cut-off and returns the last error', async () => {
    const clock = new VirtualClock()
    const budget = armedAt(clock)
    const late = clock.delay(POST_RESPONSE_BUDGET_MS - DEAD_LETTER_RESERVE_MS - 2_500)
    await clock.run()
    await late
    const { client } = updateClientWith(down, { data: [] })
    const p = updateExecutionRecord(client, 'exec-1', '2026-06-11T00:00:00Z', finalize, undefined, undefined, {
      clock,
      budget,
      reserveMs: DEAD_LETTER_RESERVE_MS,
    })
    await clock.run()
    expect((await p)?.code).toBe('PGRST002')
    expect(clock.sleeps).toEqual(UPDATE_RETRY_DELAYS_MS.slice(0, 1))
    expect(clock.now()).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS - DEAD_LETTER_RESERVE_MS)
  })

  it('a reconstruction after a missing row retries on the same clock and stops at the same cut-off', async () => {
    const clock = new VirtualClock()
    const budget = armedAt(clock)
    const { client, insert } = reconClientWith(down)
    const p = updateExecutionRecord(client, 'exec-gone', '2026-06-11T00:00:00Z', finalize, createFields, undefined, {
      clock,
      budget,
      reserveMs: DEAD_LETTER_RESERVE_MS,
    })
    await clock.run()
    expect((await p)?.code).toBe('PGRST002')
    expect(clock.sleeps).toEqual(DB_WRITE_RETRY_DELAYS_MS)
    expect(insert).toHaveBeenCalledTimes(DB_WRITE_RETRY_DELAYS_MS.length + 1)
    expect(clock.now()).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS - DEAD_LETTER_RESERVE_MS)
  })
})
