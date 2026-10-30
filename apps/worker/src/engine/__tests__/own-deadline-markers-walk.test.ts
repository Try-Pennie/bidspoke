/**
 * Our own deadlines other than the step's are marked on the step row (#3068).
 *
 * #3047 marked a step its own deadline stopped ('step') and a child its parallel
 * block cut off ('parallel_block'). These deadlines still said so only in their
 * text, so a reader of the marker could not see them:
 *
 *   - a node's own request timer: the webhook node's and the Salesforce node's
 *     (its call, its query pages and its token fetch). The aborted fetch fails
 *     with "The operation was aborted", which was 41 runs in the 7 days to
 *     2026-10-29, the same words any other abort produces;
 *   - the partner bid's timer on its bid request;
 *   - a code chain's own deadline.
 *
 * These run the REAL walk and the real executors; only fetch (or the code
 * bundle binding) is a stand in, and the clock is faked so a 15 s timer fires
 * at once. Each marked case has a control: an abort our timer did not cause is
 * left unmarked, and the retry count is what it was before the marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))

import { walkGraph, executeCodeChain } from '../index'
import { buildContext } from '../context'
import { stepTimeoutMarkerOf, stepTimedOut } from '../step-timeout'
import { getSalesforceToken, SALESFORCE_TOKEN_TIMEOUT_MS } from '../nodes/salesforce'
import { resolveBid } from '../bid-resolver'
import { executePartnerBidNode } from '../nodes/partner-bid'
import { ACHIEVE_FETCH_TIMEOUT_MS } from '../nodes/achieve-offers'

const INSTANCE = 'https://trypennie.my.salesforce.com'
const RELAY_URL = 'https://relay.example.test/hook'
const supabase = {} as SupabaseClient

/** A cached Salesforce token unless a test says otherwise, so the first fetch is the call itself. */
function envWith(over: Record<string, unknown> = {}): Env {
  return {
    PII_REDACTION_FIELDS: '',
    WORKFLOW_CACHE: {
      get: vi.fn().mockResolvedValue('tok'),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    ...over,
  } as unknown as Env
}

function ctx(): ExecutionContext {
  const c = buildContext({ Submission__c: 'a0XUi00000AbCdEFGH' }, 'website_form', 'wf-1', 'trace-3068', {
    SALESFORCE_CLIENT_ID: 'client-id',
    SALESFORCE_CLIENT_SECRET: 'client-secret',
    SALESFORCE_INSTANCE_URL: INSTANCE,
  }, 'org-1', 'exec-3068')
  c.retrySleep = async () => {}
  // The step's own deadline never passes here, so any timeout is the node's own.
  c.stepDeadline = (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  return c
}

const edge = (source: string, target: string, source_handle?: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target, ...(source_handle ? { source_handle } : {}) })

function sequential(...steps: NodeDefinition[]) {
  const nodes = [...steps, { id: 'done', namespace: 'done', type: 'exit', config: {} } as NodeDefinition]
  const edges = nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id))
  return { nodes, edges }
}

function inParallel(node: NodeDefinition) {
  const nodes: NodeDefinition[] = [
    { id: 'fan', namespace: 'fan', type: 'parallel', config: { wait_for: 'all', on_child_error: 'continue', on_timeout: 'partial', timeout_ms: 60_000, children: [{ id: 'child-0' }] } },
    node,
    { id: 'fan_end', namespace: 'fan_end', type: 'parallel_end', config: {} },
    { id: 'done', namespace: 'done', type: 'exit', config: {} },
  ]
  return { nodes, edges: [edge('fan', node.id, 'child-0'), edge('fan', 'fan_end', 'output'), edge(node.id, 'fan_end'), edge('fan_end', 'done')] }
}

const relayPost = (over: Record<string, unknown> = {}): NodeDefinition => ({
  id: 'relay', namespace: 'relay', type: 'webhook',
  config: { url: RELAY_URL, method: 'POST', body: { submission_id: '{{trigger.payload.Submission__c}}' }, retries: 0, ...over },
})

const sfUpdate = (over: Record<string, unknown> = {}): NodeDefinition => ({
  id: 'sf', namespace: 'sf_update', type: 'salesforce',
  config: { operation: 'update', object: 'Prospect__c', record_id: 'SF-999', body: { Status__c: 'Active' }, retries: 0, ...over },
})

const platformAbort = () => new DOMException('The operation was aborted.', 'AbortError')

/** A fetch that never answers, and rejects the way the platform's does when its signal aborts. */
function hangUntilAborted(init: { signal?: AbortSignal } | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (init?.signal?.aborted) return reject(platformAbort())
    init?.signal?.addEventListener('abort', () => reject(platformAbort()), { once: true })
  })
}

function response(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text), json: () => Promise.resolve(body), headers: new Headers({ 'content-type': 'application/json' }) }
}

/** Walks the graph on the fake clock, moving it on until the walk settles. */
async function walk(def: { nodes: NodeDefinition[]; edges: EdgeDefinition[] }, env: Env = envWith(), c: ExecutionContext = ctx()): Promise<StepLogEntry[]> {
  const queue: StepLogEntry[] = []
  let settled = false
  const run = walkGraph(c, def, 'exec-3068', '2026-10-29T12:00:00.000Z', supabase, env, 'money', 'v1', queue, () => {})
    .catch(() => null)
    .finally(() => { settled = true })
  for (let i = 0; i < 40 && !settled; i++) await vi.advanceTimersByTimeAsync(5_000)
  await run
  return queue
}

function rowOf(queue: StepLogEntry[], ns: string): StepLogEntry {
  const row = queue.find((r) => r.step_namespace === ns)
  if (!row) throw new Error(`no step row for ${ns}: ${queue.map((r) => r.step_namespace).join(', ')}`)
  return row
}

let fetchMock: FetchMock
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fetchMock = stubFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the webhook node\'s own request timer (#3068)', () => {
  it('marks the failed step as stopped by its own request timer, at the timer\'s length', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const row = rowOf(await walk(sequential(relayPost())), 'relay')
    expect(row).toMatchObject({ status: 'failed', error_type: 'transient', timeout_kind: 'request', timed_out_after_ms: 15_000 })
    expect(row.error_message).toMatch(/aborted/i)
    // Not the step's own deadline: the audit and the daily report do not count it.
    expect(stepTimedOut(row)).toBe(false)
  })

  it('uses the node\'s configured timer length when it has one', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const row = rowOf(await walk(sequential(relayPost({ timeout_ms: 4_000 }))), 'relay')
    expect(row).toMatchObject({ timeout_kind: 'request', timed_out_after_ms: 4_000 })
  })

  it('retries exactly as before: the same number of sends, and the last attempt marks the row', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const row = rowOf(await walk(sequential(relayPost({ retries: 2 }))), 'relay')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(row).toMatchObject({ status: 'failed', retries_used: 2, error_type: 'transient', timeout_kind: 'request', timed_out_after_ms: 15_000 })
  })

  it('inside a parallel block: the child row is marked the same', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const row = rowOf(await walk(inParallel(relayPost())), 'relay')
    expect(row).toMatchObject({ status: 'failed', timeout_kind: 'request', timed_out_after_ms: 15_000 })
  })

  it('an abort our timer did not cause carries no marker, though it says the same words', async () => {
    fetchMock.mockRejectedValue(platformAbort())
    const row = rowOf(await walk(sequential(relayPost())), 'relay')
    expect(row.status).toBe('failed')
    expect(row.error_message).toMatch(/aborted/i)
    expect(row.error_type).toBe('transient')
    expect(row).not.toHaveProperty('timeout_kind')
    expect(row).not.toHaveProperty('timed_out_after_ms')
  })

  it('a step deadline that aborts the request first is the step\'s, never the request timer\'s', async () => {
    const c = ctx()
    let sent!: () => void
    const onWire = new Promise<void>((r) => { sent = r })
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => { sent(); return hangUntilAborted(init) })
    c.stepDeadline = (_ms, signal) => new Promise<void>((resolve) => {
      void onWire.then(resolve)
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    const row = rowOf(await walk(sequential(relayPost({ timeout_ms: 3_750 })), envWith(), c), 'relay')
    expect(row).toMatchObject({ timeout_kind: 'step', timed_out_after_ms: 3_750 })
  })

  it('a request that answers in time carries no marker', async () => {
    fetchMock.mockResolvedValue(response(200, { ok: true }))
    const row = rowOf(await walk(sequential(relayPost())), 'relay')
    expect(row.status).toBe('completed')
    expect(row).not.toHaveProperty('timeout_kind')
  })
})

describe('the Salesforce node\'s own request timers (#3068)', () => {
  it('the call itself: marked at 15 s', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const row = rowOf(await walk(sequential(sfUpdate())), 'sf_update')
    expect(row).toMatchObject({ status: 'failed', error_type: 'transient', timeout_kind: 'request', timed_out_after_ms: 15_000 })
    expect(row.error_message).toMatch(/aborted/i)
  })

  it('retries exactly as before', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const row = rowOf(await walk(sequential(sfUpdate({ retries: 1 }))), 'sf_update')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(row).toMatchObject({ retries_used: 1, error_type: 'transient', timeout_kind: 'request' })
  })

  it('a query page after the first: marked at 15 s', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { totalSize: 4000, done: false, nextRecordsUrl: '/services/data/v60.0/query/01g-2000', records: [{ Id: 'SF-1' }] }))
      .mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const query: NodeDefinition = { id: 'sfq', namespace: 'sf_query', type: 'salesforce', config: { operation: 'query', soql: 'SELECT Id FROM Prospect__c', retries: 0 } }
    const row = rowOf(await walk(sequential(query)), 'sf_query')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(row).toMatchObject({ status: 'failed', timeout_kind: 'request', timed_out_after_ms: 15_000 })
  })

  it('the token fetch: marked at its own deadline', async () => {
    const env = envWith()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const row = rowOf(await walk(sequential(sfUpdate()), env), 'sf_update')
    expect(row.error_message).toBe(`Salesforce token fetch timed out after ${SALESFORCE_TOKEN_TIMEOUT_MS} ms`)
    expect(row).toMatchObject({ status: 'failed', timeout_kind: 'request', timed_out_after_ms: SALESFORCE_TOKEN_TIMEOUT_MS })
  })

  it('the token fetch stopped by the step, not its own timer, is not marked as the request timer', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const step = new AbortController()
    const run = getSalesforceToken(envWith({ WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue(null) } }), 'org-1', INSTANCE, 'id', 'secret', { signal: step.signal }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1)
    step.abort()
    const err = await run
    expect((err as Error).message).toBe('Salesforce token fetch stopped: the step ran out of time')
    await vi.advanceTimersByTimeAsync(SALESFORCE_TOKEN_TIMEOUT_MS)
    expect(stepTimeoutMarkerOf(err)).toBeNull()
  })

  it('a refused call is a failure, never a timeout', async () => {
    fetchMock.mockResolvedValue(response(400, '[{"errorCode":"INVALID_FIELD","message":"no"}]'))
    const row = rowOf(await walk(sequential(sfUpdate())), 'sf_update')
    expect(row.status).toBe('failed')
    expect(row).not.toHaveProperty('timeout_kind')
  })
})

describe('the partner bid\'s own timer on its bid request (#3068)', () => {
  const partner = { id: 'partner-1', slug: 'tripoint', bid_resolver_type: 'api', api_endpoint: 'https://partner.example/bid', cf_secret_key: null } as never

  it('the resolver marks the abort its own timer caused', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const run = resolveBid(partner, ctx(), envWith()).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(stepTimeoutMarkerOf(await run)).toEqual({ timeout_kind: 'partner_bid', timed_out_after_ms: 15_000 })
  })

  it('an abort from the step signal is not the partner bid\'s timer', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const step = new AbortController()
    const run = resolveBid(partner, ctx(), envWith(), undefined, step.signal).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1)
    step.abort()
    const err = await run
    await vi.advanceTimersByTimeAsync(15_000)
    expect(stepTimeoutMarkerOf(err)).toBeNull()
  })

  it('the node carries the marker onto the error it re-throws, which still says and classifies the same', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const partnerRow = { id: 'partner-1', slug: 'tripoint', bid_resolver_type: 'api', api_endpoint: 'https://partner.example/bid', cf_secret_key: null, daily_cap: null, min_bid: null, dedup_endpoint: null, circuit_enabled: false, is_active: true }
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'single') return () => Promise.resolve({ data: partnerRow, error: null })
        return () => chain
      },
    })
    const db = { from: () => chain } as unknown as SupabaseClient
    const node: NodeDefinition = { id: 'pb', namespace: 'tripoint_bid', type: 'partner_bid', config: { partner_id: 'partner-1' } }
    const run = executePartnerBidNode(node, ctx(), envWith({ WORKFLOW_CACHE: undefined }), db).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(15_000)
    const err = await run
    expect((err as Error).message).toMatch(/aborted/i)
    expect((err as { errorType?: unknown }).errorType).toBe('transient')
    expect(stepTimeoutMarkerOf(err)).toEqual({ timeout_kind: 'partner_bid', timed_out_after_ms: 15_000 })
  })
})

describe('a code chain\'s own deadline (#3068)', () => {
  const code = (id: string): NodeDefinition => ({ id, namespace: id, type: 'code', config: { script: 'return 1' } })

  function bundle(behaviour: 'hang' | 'abort-now') {
    const bundleFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (behaviour === 'abort-now') return Promise.reject(platformAbort())
      return hangUntilAborted(init as { signal?: AbortSignal })
    })
    return { DYNAMIC_WORKER_LOADER: { get: () => ({ fetch: bundleFetch }) } }
  }

  it('the chain result carries the marker when its own timer stopped the dispatch', async () => {
    const run = executeCodeChain([code('a'), code('b')], ctx(), envWith(bundle('hang')))
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await run
    expect(result.results[0]).toMatchObject({ status: 'failed', error: 'Code chain timed out after 60000ms' })
    expect(result.timeout).toEqual({ timeout_kind: 'code_chain', timed_out_after_ms: 60_000 })
  })

  it('an abort the chain\'s timer did not cause reads as before and carries no marker', async () => {
    const result = await executeCodeChain([code('a'), code('b')], ctx(), envWith(bundle('abort-now')))
    expect(result.results[0]).toMatchObject({ status: 'failed', error: 'Code chain timed out after 60000ms' })
    expect(result.timeout).toBeUndefined()
  })

  it('in the walk: the failed chain step row is marked, and no other row is', async () => {
    const queue = await walk(sequential(code('a'), code('b')), envWith(bundle('hang')))
    expect(rowOf(queue, 'a')).toMatchObject({ status: 'failed', error_type: 'transient', timeout_kind: 'code_chain', timed_out_after_ms: 60_000 })
    expect(stepTimedOut(rowOf(queue, 'a'))).toBe(false)
    expect(queue.filter((r) => r.timeout_kind !== undefined)).toHaveLength(1)
  })
})

/**
 * #3075: the achieve_offers node's own wait. It never fails the step: it records
 * the timeout in its output and the step completes. So the completed row is the
 * one the wait cut short, and it carries 'achieve_offers'. Only the walk's row
 * writing is new: the output, the status and the retry count are as before.
 */
describe('the achieve_offers node\'s own wait (#3075)', () => {
  const achieve = (over: Record<string, unknown> = {}): NodeDefinition => ({ id: 'ach', namespace: 'achieve', type: 'achieve_offers', config: { retries: 0, ...over } })
  // A lead with what the node needs to send (an email, a phone and a loan amount).
  const achieveCtx = () => {
    const c = buildContext({
      Submission__c: 'a0XUi00000AbCdEFGH',
      personalInformation: { email: 'lead@example.com', primaryPhone: '(646) 770-6541', firstName: 'Joseph', lastName: 'Guerrera', state: 'NY' },
      loanInformation: { purpose: 'debt_consolidation', loanAmount: 7500 },
    }, 'website_form', 'wf-1', 'trace-3075', { ACHIEVE_USERNAME: 'user', ACHIEVE_PASSWORD: 'pass' }, 'org-1', 'exec-3075')
    c.retrySleep = async () => {}
    c.stepDeadline = (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    return c
  }

  it('marks the completed row at the wait\'s length, and its output says what it said', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const row = rowOf(await walk(sequential(achieve()), envWith(), achieveCtx()), 'achieve')
    expect(row).toMatchObject({ status: 'completed', retries_used: 0, timeout_kind: 'achieve_offers', timed_out_after_ms: ACHIEVE_FETCH_TIMEOUT_MS })
    expect(row.output).toMatchObject({ ok: false, response_status: 'error', response_reason: `Achieve API timed out after ${ACHIEVE_FETCH_TIMEOUT_MS}ms` })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(stepTimedOut(row)).toBe(false)
  })

  it('inside a parallel block: the child row is marked the same', async () => {
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => hangUntilAborted(init))
    const row = rowOf(await walk(inParallel(achieve()), envWith(), achieveCtx()), 'achieve')
    expect(row).toMatchObject({ status: 'completed', timeout_kind: 'achieve_offers', timed_out_after_ms: ACHIEVE_FETCH_TIMEOUT_MS })
  })

  it('an abort the wait did not cause, though it reads as a timeout, leaves the row unmarked', async () => {
    fetchMock.mockRejectedValue(platformAbort())
    const row = rowOf(await walk(sequential(achieve()), envWith(), achieveCtx()), 'achieve')
    expect(row.status).toBe('completed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row.output).toMatchObject({ response_reason: `Achieve API timed out after ${ACHIEVE_FETCH_TIMEOUT_MS}ms` })
    expect(row).not.toHaveProperty('timeout_kind')
  })

  it('an answer in time leaves the row unmarked', async () => {
    fetchMock.mockResolvedValue(response(200, { response: 'accepted', offers: [] }))
    const row = rowOf(await walk(sequential(achieve()), envWith(), achieveCtx()), 'achieve')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(row.status).toBe('completed')
    expect(row.output).toMatchObject({ ok: true, response_status: 'accepted' })
    expect(row).not.toHaveProperty('timeout_kind')
  })
})

