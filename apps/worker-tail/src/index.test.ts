/**
 * The tail consumer skips the ops Worker's traces (#1709 part 3, plan 0.E).
 *
 * bidspoke-worker-ops sends its traces here too (its wrangler.ops.toml names
 * this Worker as a tail consumer). This consumer adds each execution's request
 * and CPU cost onto workflow_executions in the BIDDING database, keyed by the
 * execution id in the trace's log line. An ops execution's id names nothing
 * there, or worse, could name a bidding row, so an ops trace is skipped whole
 * until Phase 1 points cost attribution for ops runs at the ops database.
 *
 * The database is reached through fetch, mocked here, so no test touches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { OPS_WORKER_SCRIPT } from './index'

const env = { SUPABASE_URL: 'https://bidding.test', SUPABASE_SECRET_KEY: 'test-key' }
const ctx = {} as ExecutionContext

function trace(scriptName: string | null, executionId: string): TraceItem {
  return {
    scriptName,
    outcome: 'ok',
    cpuTime: 12,
    logs: [{ timestamp: 0, level: 'log', message: [JSON.stringify({ event: 'execution_complete', execution_id: executionId })] }],
  } as unknown as TraceItem
}

let requested: string[]

beforeEach(() => {
  requested = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    requested.push(`${init?.method ?? 'GET'} ${url}`)
    if ((init?.method ?? 'GET') === 'GET') return Promise.resolve(Response.json({ cost_usd: 0, started_at: '2026-10-06T12:00:00Z' }))
    return Promise.resolve(new Response(null, { status: 204 }))
  })
})

afterEach(() => vi.restoreAllMocks())

describe('worker-tail', () => {
  it('names the ops Worker it skips by its deployed script name', () => {
    expect(OPS_WORKER_SCRIPT).toBe('bidspoke-worker-ops')
  })

  it('skips an ops Worker trace without reaching the database', async () => {
    await worker.tail([trace(OPS_WORKER_SCRIPT, 'ops-exec-1')], env, ctx)
    expect(requested).toEqual([])
  })

  it('still adds a bidding Worker trace\'s cost, so the skip is the ops one only (positive control)', async () => {
    await worker.tail([trace('bidspoke-worker', 'money-exec-1')], env, ctx)
    expect(requested.some((r) => r.startsWith('GET ') && r.includes('id=eq.money-exec-1'))).toBe(true)
    expect(requested.some((r) => r.startsWith('PATCH ') && r.includes('id=eq.money-exec-1'))).toBe(true)
  })

  it('handles a mixed batch: the bidding trace is applied and the ops one never is', async () => {
    await worker.tail([trace(OPS_WORKER_SCRIPT, 'ops-exec-2'), trace('bidspoke-worker', 'money-exec-2')], env, ctx)
    expect(requested.filter((r) => r.includes('ops-exec-2'))).toEqual([])
    expect(requested.filter((r) => r.includes('money-exec-2')).length).toBe(2)
  })

  it('keeps applying a trace with no script name, as it always has', async () => {
    await worker.tail([trace(null, 'money-exec-3')], env, ctx)
    expect(requested.filter((r) => r.includes('money-exec-3')).length).toBe(2)
  })
})
