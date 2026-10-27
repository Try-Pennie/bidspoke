/**
 * The Main Flow collections post takes its own share of the Salesforce bulkhead
 * (#2847).
 *
 * The collections call (#2832) runs before the answer, beside the trades call
 * the lead's answer waits on, about 3,250 times a day. With only the main
 * `salesforce` key it would compete with the trades call for freed slots on a
 * Salesforce slowdown day. It now takes a `salesforce-collections` slot first,
 * capped at SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT, then a main slot, and waits at
 * most SALESFORCE_COLLECTIONS_BULKHEAD_WAIT_MS for both, so it holds at most its
 * share of the main cap and gives up long before the trades call does. The call
 * is recognised by the endpoint it posts to (`isCreditCollectionsPost`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeSalesforceNode } from '../salesforce'
import { stubFetch, type FetchMock } from '../../../__tests__/helpers/fetch-mock'
import { fakeBulkheads } from '../../../__tests__/helpers/fake-bulkheads'
import {
  SALESFORCE_BULKHEAD_KEY,
  SALESFORCE_COLLECTIONS_BULKHEAD_KEY,
  SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT,
  SALESFORCE_COLLECTIONS_BULKHEAD_WAIT_MS,
  SALESFORCE_POST_ANSWER_BULKHEAD_KEY,
} from '../../../lib/bulkhead-client'
import { COLLECTIONS_APEX_TIMEOUT_MS } from '../../../lib/main-flow-port/transform'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { Env } from '../../../index'

const INSTANCE = 'https://trypennie.my.salesforce.com'
const MAIN = SALESFORCE_BULKHEAD_KEY
const SHARE = SALESFORCE_COLLECTIONS_BULKHEAD_KEY
const SUB = 'a0XUi00000AbCdEFGH'

const apex = (namespace: string, path: string): NodeDefinition => ({
  id: namespace,
  namespace,
  type: 'salesforce',
  config: { operation: 'apex', apex_path: path, body: { submissionId: SUB, json: '{}' }, retries: 0, timeout_ms: COLLECTIONS_APEX_TIMEOUT_MS },
}) as NodeDefinition
const collections = apex('collections_apex', '/services/apexrest/credit-collections')
const trades = apex('trades_request', '/services/apexrest/credit-trades')
// Recognised by its endpoint, not its name: a collections call under another name still takes the share.
const renamed = apex('anything_else', 'services/apexrest/credit-collections/')

/** A clock that moves only when the bulkhead wait sleeps, so waits cost nothing and are measured exactly. */
function virtualClock() {
  let t = 0
  return { now: () => t, sleep: (ms: number) => { t += ms; return Promise.resolve() } }
}

function makeCtx(opts: { afterAnswer?: boolean; clock?: ReturnType<typeof virtualClock> } = {}): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'test', workflow_id: 'wf-1', org_id: 'org-1', trace_id: 'tr-1', execution_id: 'exec-1' },
    steps: {},
    env: { SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret', SALESFORCE_INSTANCE_URL: INSTANCE },
    execution: { workflow_id: 'wf-1', trace_id: 'tr-1', execution_id: 'exec-1' },
    ...(opts.afterAnswer ? { afterAnswer: true } : {}),
    ...(opts.clock ? { retryTiming: { clock: opts.clock } } : {}),
  } as unknown as ExecutionContext
}

function makeEnv(bulkheads: DurableObjectNamespace, extra: Record<string, string> = {}): Env {
  return {
    WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('cached-token'), put: vi.fn(), delete: vi.fn() } as unknown as KVNamespace,
    SALESFORCE_BULKHEAD: bulkheads,
    APP_URL: 'https://bidspoke.trypennie.dev',
    ...extra,
  } as unknown as Env
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

describe('the collections share of the Salesforce bulkhead (#2847)', () => {
  let fetchMock: FetchMock
  let logs: string[]

  beforeEach(() => {
    fetchMock = stubFetch()
    fetchMock.mockImplementation(() => Promise.resolve(ok()))
    logs = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('the collections call takes its share then a main slot, and hands both back', async () => {
    const fake = fakeBulkheads()
    await executeSalesforceNode(collections, makeCtx(), makeEnv(fake.namespace))
    expect(fake.acquires).toEqual([SHARE, MAIN])
    expect(fake.releases.sort()).toEqual([MAIN, SHARE].sort())
    expect(fake.inflight(SHARE)).toBe(0)
    expect(fake.inflight(MAIN)).toBe(0)

    const other = fakeBulkheads()
    await executeSalesforceNode(renamed, makeCtx(), makeEnv(other.namespace))
    expect(other.acquires).toEqual([SHARE, MAIN])
  })

  it('the trades call, and every other pre-answer call, takes the main key alone, as today', async () => {
    const fake = fakeBulkheads()
    await executeSalesforceNode(trades, makeCtx(), makeEnv(fake.namespace))
    expect(fake.acquires).toEqual([MAIN])
    const write = fakeBulkheads()
    const update = { id: 'u', namespace: 'patch_submission', type: 'salesforce', config: { operation: 'update', object: 'Submission__c', record_id: SUB, body: { Status__c: 'Done' } } } as NodeDefinition
    await executeSalesforceNode(update, makeCtx(), makeEnv(write.namespace))
    expect(write.acquires).toEqual([MAIN])
  })

  it('after the answer a collections call takes the post-answer share, not this one', async () => {
    const fake = fakeBulkheads()
    await executeSalesforceNode(collections, makeCtx({ afterAnswer: true }), makeEnv(fake.namespace))
    expect(fake.acquires).toEqual([SALESFORCE_POST_ANSWER_BULKHEAD_KEY, MAIN])
  })

  it('a full collections share sheds the collections call, never reaching Salesforce, while the trades call still gets a main slot', async () => {
    const fake = fakeBulkheads({ seed: { [SHARE]: SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT, [MAIN]: SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT } })
    const env = makeEnv(fake.namespace)
    const clock = virtualClock()

    const shed = await executeSalesforceNode(collections, makeCtx({ clock }), env).catch((e: Error) => e)
    expect(shed).toBeInstanceOf(Error)
    expect((shed as Error).message).toMatch(new RegExp(`^Salesforce bulkhead: at capacity \\(${SHARE}, ${SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT}/${SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT} inflight`))
    expect((shed as Error & { bulkheadShed?: boolean }).bulkheadShed).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    // It waited its short wait, and never asked the main key while its share was full.
    expect(clock.now()).toBe(SALESFORCE_COLLECTIONS_BULKHEAD_WAIT_MS)
    expect(fake.acquires.filter((k) => k === MAIN)).toEqual([])
    expect(logs.some((l) => l.includes(`event=salesforce_bulkhead_shed key=${SHARE}`))).toBe(true)

    const tradesResult = await executeSalesforceNode(trades, makeCtx({ clock: virtualClock() }), env)
    expect(tradesResult.output).toMatchObject({ status: 200 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${INSTANCE}/services/apexrest/credit-trades`)
  })

  it('on a full main bulkhead the collections call gives up at its short wait, well inside its 4.5 s attempt, while the trades call waits the full 15 s', async () => {
    const fake = fakeBulkheads({ seed: { [MAIN]: 20 } })
    const env = makeEnv(fake.namespace)

    const collectionsClock = virtualClock()
    const shed = await executeSalesforceNode(collections, makeCtx({ clock: collectionsClock }), env).catch((e: Error) => e)
    expect((shed as Error).message).toMatch(/^Salesforce bulkhead: at capacity \(salesforce, 20\/20 inflight/)
    expect(collectionsClock.now()).toBe(SALESFORCE_COLLECTIONS_BULKHEAD_WAIT_MS)
    expect(collectionsClock.now()).toBeLessThan(COLLECTIONS_APEX_TIMEOUT_MS / 4)
    // Its share slot is handed back, not left to expire.
    expect(fake.inflight(SHARE)).toBe(0)

    const tradesClock = virtualClock()
    await executeSalesforceNode(trades, makeCtx({ clock: tradesClock }), env).catch(() => {})
    expect(tradesClock.now()).toBe(15_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
