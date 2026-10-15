/**
 * Post-answer Salesforce calls take their own share of the bulkhead (#2170,
 * phase 1 of #1680).
 *
 * One `salesforce` bulkhead of 20 slots served every call, before and after the
 * answer alike, and the Main Flow port adds about 9,500 post-answer calls a day.
 * A post-answer call now also takes a `salesforce-post-answer` slot, capped at
 * SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT, so in a slowdown post-answer work can
 * hold at most that many of the 20 and a pre-answer call always finds the rest.
 * The step is told it runs after the answer by the walk (`ctx.afterAnswer`), the
 * one fact the at-risk watch reads too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeSalesforceNode } from '../salesforce'
import { stubFetch, type FetchMock } from '../../../__tests__/helpers/fetch-mock'
import { fakeBulkheads } from '../../../__tests__/helpers/fake-bulkheads'
import {
  SALESFORCE_BULKHEAD_KEY,
  SALESFORCE_POST_ANSWER_BULKHEAD_KEY,
  SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT,
} from '../../../lib/bulkhead-client'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { Env } from '../../../index'

const INSTANCE = 'https://trypennie.my.salesforce.com'
const MAIN = SALESFORCE_BULKHEAD_KEY
const POST = SALESFORCE_POST_ANSWER_BULKHEAD_KEY

const node: NodeDefinition = {
  id: 'sf1',
  namespace: 'patch_submission',
  type: 'salesforce',
  config: { operation: 'update', object: 'Submission__c', record_id: 'a04XX0000000001', body: { Status__c: 'Done' } },
} as NodeDefinition

function makeCtx(afterAnswer: boolean): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'test', workflow_id: 'wf-1', org_id: 'org-1', trace_id: 'tr-1', execution_id: 'exec-1' },
    steps: {},
    env: { SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret', SALESFORCE_INSTANCE_URL: INSTANCE },
    execution: { workflow_id: 'wf-1', trace_id: 'tr-1', execution_id: 'exec-1' },
    ...(afterAnswer ? { afterAnswer: true } : {}),
  } as unknown as ExecutionContext
}

function makeEnv(bulkheads: DurableObjectNamespace, extra: Record<string, string> = {}): Env {
  return {
    WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('cached-token'), put: vi.fn(), delete: vi.fn() } as unknown as KVNamespace,
    SALESFORCE_BULKHEAD: bulkheads,
    APP_URL: 'https://bidspoke.trypennie.dev',
    // No waiting: a full key sheds on its first refusal, so no test here sleeps.
    SALESFORCE_BULKHEAD_WAIT_MS: '0',
    ...extra,
  } as unknown as Env
}

const noContent = () => ({ ok: true, status: 204, text: () => Promise.resolve(''), headers: new Headers() })

describe('the post-answer share of the Salesforce bulkhead (#2170)', () => {
  let fetchMock: FetchMock
  let logs: string[]

  beforeEach(() => {
    fetchMock = stubFetch()
    fetchMock.mockImplementation(() => Promise.resolve(noContent()))
    logs = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a pre-answer call still gets a salesforce slot while the post-answer share is full', async () => {
    // Post-answer calls hold their own slot and one of the 20, so a full share
    // is LIMIT of each.
    const fake = fakeBulkheads({ seed: { [POST]: SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT, [MAIN]: SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT } })

    const pre = await executeSalesforceNode(node, makeCtx(false), makeEnv(fake.namespace))
    expect(pre.output).toMatchObject({ status: 204 })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The same share refuses one more post-answer call, which never reaches Salesforce.
    const post = await executeSalesforceNode(node, makeCtx(true), makeEnv(fake.namespace)).catch((e: Error) => e)
    expect(post).toBeInstanceOf(Error)
    expect((post as Error).message).toMatch(/^Salesforce bulkhead: at capacity \(salesforce-post-answer, 6\/6 inflight/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes(`event=salesforce_bulkhead_shed key=${POST}`))).toBe(true)
  })

  it('a post-answer call takes the post-answer key then the main key; a pre-answer call only the main key', async () => {
    const fake = fakeBulkheads()
    await executeSalesforceNode(node, makeCtx(true), makeEnv(fake.namespace))
    expect(fake.acquires).toEqual([POST, MAIN])
    expect(fake.releases.sort()).toEqual([MAIN, POST].sort())
    expect(fake.inflight(POST)).toBe(0)
    expect(fake.inflight(MAIN)).toBe(0)

    const fake2 = fakeBulkheads()
    await executeSalesforceNode(node, makeCtx(false), makeEnv(fake2.namespace))
    expect(fake2.acquires).toEqual([MAIN])
  })

  it('post-answer calls never hold more of Salesforce than today: a full main bulkhead refuses them too, and their share is handed back', async () => {
    // Twenty pre-answer calls in flight, the cap the governor is sized against.
    const fake = fakeBulkheads({ seed: { [MAIN]: 20 } })
    const post = await executeSalesforceNode(node, makeCtx(true), makeEnv(fake.namespace)).catch((e: Error) => e)
    expect((post as Error).message).toMatch(/^Salesforce bulkhead: at capacity \(salesforce, 20\/20 inflight/)
    expect(fetchMock).not.toHaveBeenCalled()
    // The share slot it took first is released, not left to expire.
    expect(fake.inflight(POST)).toBe(0)
  })

  describe('when the bulkhead object itself errors, every key fails open the same way and says which', () => {
    it.each([
      { broken: MAIN, afterAnswer: false },
      { broken: POST, afterAnswer: true },
      { broken: MAIN, afterAnswer: true },
    ])('$broken broken, after the answer: $afterAnswer', async ({ broken, afterAnswer }) => {
      const fake = fakeBulkheads({ broken: [broken] })
      const result = await executeSalesforceNode(node, makeCtx(afterAnswer), makeEnv(fake.namespace))
      // The call goes ahead without that slot, as it always has.
      expect(result.output).toMatchObject({ status: 204 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const line = logs.find((l) => l.includes('event=salesforce_bulkhead_failed_open'))
      expect(line).toContain(`key=${broken}`)
      expect(line).toContain('trace=tr-1')
      // Whatever slot the other key did grant is handed back.
      expect(fake.inflight(MAIN)).toBe(0)
      expect(fake.inflight(POST)).toBe(0)
    })
  })
})
