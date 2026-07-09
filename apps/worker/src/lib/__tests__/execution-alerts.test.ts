/**
 * Alert-metadata writes on workflow_executions (#583).
 *
 * Both writes (the pre-send snapshot and the post-send summary attach) target
 * the same row by the same key, and both only checked `error`. PostgREST reports
 * an UPDATE that matched nothing as a plain success, so when the execution row
 * is missing (the #487 case: its insert failed permanently) the alert fires and
 * the snapshot silently goes nowhere, leaving the banner with no structured
 * fallback and no trace of why.
 *
 * These writes are deliberately best-effort: a failure must never stop the Slack
 * alert going out. So the contract is "log loudly, never throw".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeExecutionAlertState } from '../execution-alerts'

let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

// update().eq().eq().select('id')
const clientReturning = (result: { data: unknown[] | null; error: unknown }) =>
  ({
    from: () => ({
      update: () => ({
        eq: () => ({
          eq: () => ({ select: () => Promise.resolve(result) }),
        }),
      }),
    }),
  }) as never

const call = (client: never) =>
  writeExecutionAlertState(client, 'exec-1', '2026-07-09T00:00:00Z', { slack_alert_type: 'failure' }, 'record alert metadata')

describe('writeExecutionAlertState (#583)', () => {
  it('reports a write that matched zero rows: the execution row is missing', async () => {
    await call(clientReturning({ data: [], error: null }))
    expect(errSpy).toHaveBeenCalledOnce()
    expect(String(errSpy.mock.calls[0][0])).toContain('matched zero rows')
    expect(errSpy.mock.calls[0][1]).toMatchObject({ executionId: 'exec-1' })
  })

  it('reports a genuine database error', async () => {
    await call(clientReturning({ data: null, error: { message: 'db down' } }))
    expect(errSpy).toHaveBeenCalledOnce()
    expect(errSpy.mock.calls[0][1]).toMatchObject({ error: 'db down' })
  })

  it('names the operation so the two call sites are distinguishable in logs', async () => {
    await call(clientReturning({ data: [], error: null }))
    expect(String(errSpy.mock.calls[0][0])).toContain('record alert metadata')
  })

  it('stays silent when the write lands', async () => {
    await call(clientReturning({ data: [{ id: 'exec-1' }], error: null }))
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('never throws: an alert must still go out when its snapshot fails', async () => {
    await expect(call(clientReturning({ data: null, error: { message: 'db down' } }))).resolves.toBeUndefined()
    await expect(call(clientReturning({ data: [], error: null }))).resolves.toBeUndefined()
  })
})
