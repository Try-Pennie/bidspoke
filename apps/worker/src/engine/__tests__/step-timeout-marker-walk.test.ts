/**
 * The walk marks a step row that hit a deadline (#3047, L35).
 *
 * Both step loops (the walk's own and a parallel child's) run a step through
 * withRetry, whose withTimeout rejects with a StepTimeoutError when the step's
 * own deadline passes. The step row records that as `timeout_kind: 'step'` and
 * the deadline in `timed_out_after_ms`, so a reader no longer matches the error
 * text. A parallel block that stops waiting for a child writes that child's row
 * itself, marked `parallel_block` with the block's deadline (what that row
 * records as input is tested in parallel-timeout-input.test.ts, #3064).
 *
 * What must NOT change: the message, the error type (`transient`) and the
 * retries a timed out step uses. A step that failed any other way carries no
 * marker at all, not even a null, so an ordinary step write never names the new
 * columns (the step logger inserts rows as they are queued).
 *
 * The deadline is driven through the context's injectable step deadline, never
 * a real wait: `fireAtOnce` passes the deadline the moment it is set, `never`
 * only when the attempt answers. A parallel block's own timer is a real
 * setTimeout of a few milliseconds, the block's own configured length.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'
import { stepTimeoutMessage } from '../step-timeout'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'

const EXEC = 'exec-3047'
const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as SupabaseClient

type Deadline = NonNullable<ExecutionContext['stepDeadline']>
/** The step's deadline passes the moment it is set. */
const fireAtOnce: Deadline = () => Promise.resolve()
/** The step's deadline never passes: it ends only when the attempt answers. */
const never: Deadline = (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))

function ctxWith(stepDeadline: Deadline): ExecutionContext {
  const ctx = buildContext({ lead: 1 }, 'website_form', 'wf-3047', 'trace-3047', {}, 'org-1', EXEC)
  ctx.retrySleep = async () => {}
  ctx.stepDeadline = stepDeadline
  return ctx
}

const webhook = (namespace: string, config: Record<string, unknown> = {}): NodeDefinition => ({
  id: namespace,
  namespace,
  type: 'webhook',
  config: { url: `https://partner.test/${namespace}`, method: 'POST', body: { a: 1 }, retries: 0, timeout_ms: 4_500, ...config },
})
const edge = (source: string, target: string, source_handle?: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target, ...(source_handle ? { source_handle } : {}) })

/** A fetch that never answers, and gives up only when its request is aborted. */
function hangUntilAborted(_url: string, init?: { signal?: AbortSignal }): Promise<unknown> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
  })
}

async function walk(ctx: ExecutionContext, nodes: NodeDefinition[], edges: EdgeDefinition[] = []) {
  const queue: StepLogEntry[] = []
  const ending = await walkGraph(ctx, { nodes, edges }, EXEC, '2026-10-29T12:00:00.000Z', supabase, env, 'money', 'v1', queue, () => {})
    .then(() => null, (e: Error) => e)
  return { queue, ending, row: (ns: string) => queue.find((s) => s.step_namespace === ns) as (StepLogEntry & Record<string, unknown>) | undefined }
}

let fetchMock: FetchMock
beforeEach(() => {
  fetchMock = stubFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a step stopped by its own deadline is marked on its row', () => {
  it('in the walk: marked, and its message, error type and retries are as they always were', async () => {
    fetchMock.mockImplementation(hangUntilAborted)
    const { row, ending } = await walk(ctxWith(fireAtOnce), [webhook('slow', { retries: 1 })])
    expect(ending?.message).toBe(stepTimeoutMessage(4_500))
    expect(row('slow')).toMatchObject({
      status: 'failed',
      error_message: stepTimeoutMessage(4_500),
      error_type: 'transient',
      retries_used: 1,
      timeout_kind: 'step',
      timed_out_after_ms: 4_500,
    })
    // Retried as a transient failure always was: two attempts went out.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('in the walk, under on_error skip: the skipped row still says the step timed out', async () => {
    fetchMock.mockImplementation(hangUntilAborted)
    const { row, ending } = await walk(ctxWith(fireAtOnce), [webhook('slow', { on_error: 'skip' })])
    expect(ending).toBeNull()
    expect(row('slow')).toMatchObject({ status: 'skipped', timeout_kind: 'step', timed_out_after_ms: 4_500 })
  })

  it('in the walk, under on_error fallback: the row that hands over to the fallback is marked', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { signal?: AbortSignal }) =>
      String(url).endsWith('/slow') ? hangUntilAborted(url, init) : new Response('{}', { status: 200 }))
    // Only the slow step's 4.5 s deadline passes; the fallback's 9 s one never does.
    const ctx = ctxWith((ms, signal) => (ms === 4_500 ? fireAtOnce(ms, signal) : never(ms, signal)))
    const { row } = await walk(ctx, [webhook('slow', { on_error: 'fallback', fallback_node: 'rescue' }), webhook('rescue', { timeout_ms: 9_000 })])
    expect(row('slow')).toMatchObject({ status: 'failed_with_fallback', timeout_kind: 'step', timed_out_after_ms: 4_500 })
    expect(row('rescue')).not.toHaveProperty('timeout_kind')
  })

  it('in a parallel child: marked the same way, with its own deadline', async () => {
    fetchMock.mockImplementation(hangUntilAborted)
    const { row } = await walk(ctxWith(fireAtOnce), [
      { id: 'fan', namespace: 'fan', type: 'parallel', config: { wait_for: 'all', on_child_error: 'continue', on_timeout: 'partial', timeout_ms: 30_000, children: [{ id: 'child-0' }] } },
      webhook('child_slow', { timeout_ms: 3_750 }),
    ], [edge('fan', 'child_slow', 'child-0')])
    expect(row('child_slow')).toMatchObject({
      status: 'failed',
      error_message: stepTimeoutMessage(3_750),
      error_type: 'transient',
      timeout_kind: 'step',
      timed_out_after_ms: 3_750,
    })
  })
})

describe('a parallel block that stops waiting for a child marks the row it writes for it', () => {
  it('as the block\'s deadline, not the step\'s', async () => {
    fetchMock.mockImplementation(hangUntilAborted)
    const { row } = await walk(ctxWith(never), [
      { id: 'fan', namespace: 'fan', type: 'parallel', config: { wait_for: 'all', on_child_error: 'continue', on_timeout: 'partial', timeout_ms: 5, children: [{ id: 'child-0' }] } },
      webhook('child_late'),
    ], [edge('fan', 'child_late', 'child-0')])
    expect(row('child_late')).toMatchObject({
      status: 'failed',
      error_message: 'Parallel group timed out after 5ms before this child completed',
      error_type: 'transient',
      timeout_kind: 'parallel_block',
      timed_out_after_ms: 5,
    })
  })
})

describe('a step that failed any other way carries no marker, not even an empty one', () => {
  it('a refused request', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'bad lead' }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const { row } = await walk(ctxWith(never), [webhook('refused')])
    expect(row('refused')?.status).toBe('failed')
    expect(row('refused')).not.toHaveProperty('timeout_kind')
    expect(row('refused')).not.toHaveProperty('timed_out_after_ms')
  })

  it('an error whose text reads exactly like the step deadline\'s, thrown by something else', async () => {
    fetchMock.mockRejectedValue(new Error(stepTimeoutMessage(4_500)))
    const { row } = await walk(ctxWith(never), [webhook('lookalike')])
    expect(row('lookalike')).toMatchObject({ status: 'failed', error_message: stepTimeoutMessage(4_500) })
    expect(row('lookalike')).not.toHaveProperty('timeout_kind')
    expect(row('lookalike')).not.toHaveProperty('timed_out_after_ms')
  })

  it('a step that completed', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const { row } = await walk(ctxWith(never), [webhook('fine')])
    expect(row('fine')?.status).toBe('completed')
    expect(row('fine')).not.toHaveProperty('timeout_kind')
    expect(row('fine')).not.toHaveProperty('timed_out_after_ms')
  })
})
