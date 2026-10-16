/**
 * A credit inquiry post on a recovery run checks first and sends only if missing
 * (#2176, Dan, 2026-10-15), through the REAL walk and the real Salesforce node.
 *
 * Before it posts, a replay or a resume reads the Submission's Lead and looks for
 * the Lead's `Inquiries_<leadId>` file created since the original run began, less
 * 2 s: the marker the read-back judges a held post by (#2212), read by the same
 * code (lookupInquiryMarker).
 *  - The file is there: nothing is sent, the step completes as skipped, already
 *    landed, and says which Lead and since when.
 *  - It is not: the post goes out exactly as on a normal run, intent record first.
 *  - The check cannot be answered: nothing is sent and the step fails, saying
 *    whether the file landed is unknown. Fail closed: a second post attaches a
 *    second file, a missing one is said and can be run again.
 *  - A normal run makes no check at all.
 *
 * Only fetch is a recorder and KV is a map; the watch's clock is virtual, so
 * nothing waits in real time (L524).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'
import { VirtualClock } from '../../lib/__tests__/_virtual-clock'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'
import { startAtRiskWatch, atRiskKey, parseAtRiskEntry } from '../at-risk-writes'
import { CREDIT_INQUIRY_APEX_PATH, inquiryMarkerQuery } from '../inquiry-post'

const INSTANCE = 'https://trypennie.my.salesforce.com'
const DATA = `${INSTANCE}/services/data/v60.0`
const APEX_URL = `${INSTANCE}${CREDIT_INQUIRY_APEX_PATH}`
const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 71)).toString('base64')
const SUB = 'a0XUi00000AbCdEFGH'
const LEAD = '00QUi00000XyZaBCDE'
const EXEC = 'exec-2176'
const ORIGINAL = 'orig-2176'
const ORIGINAL_START = Date.parse('2027-10-15T11:00:00.000Z')
const STEP = 'inquiry_apex_send_salesforce'
const HELD = atRiskKey(EXEC, STEP)
const SUB_URL = `${DATA}/sobjects/Submission__c/${SUB}?fields=Lead__c`
const MARKER_URL = `${DATA}/query?q=${encodeURIComponent(inquiryMarkerQuery(LEAD, ORIGINAL_START))}`

const cache = { get: vi.fn(), put: vi.fn(), delete: vi.fn() }
const env = { PII_REDACTION_FIELDS: '', WORKFLOW_CACHE: cache } as unknown as Env
const supabase = {} as SupabaseClient

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

let kv: ReturnType<typeof makeKv>
type Recovery = Pick<ExecutionContext, 'recovery' | 'recoveryOrigin'>
const replay = (): Recovery => ({ recovery: 'replay', recoveryOrigin: async () => ({ executionId: ORIGINAL, startedAtMs: ORIGINAL_START }) })
const resume = (): Recovery => ({ recovery: 'resume', recoveryOrigin: async () => ({ executionId: ORIGINAL, startedAtMs: ORIGINAL_START }) })

const edge = (source: string, target: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target })
/** The answer, then the inquiry post, then an exit: Main Flow posts after its answer. */
function line() {
  const answer: NodeDefinition = { id: 'n-answer', namespace: 'offer_response', type: 'response', config: { continue_after_response: true, status: 200, body: { ok: true } } }
  const apex: NodeDefinition = {
    id: 'n-apex',
    namespace: STEP,
    type: 'salesforce',
    config: {
      operation: 'apex',
      apex_path: CREDIT_INQUIRY_APEX_PATH,
      body: { submissionId: '{{trigger.payload.Submission__c}}', inquiriesJson: '{"inquiries":[{"type":"H","customerName":"BANK"}]}' },
      retries: 0,
    },
  }
  const done: NodeDefinition = { id: 'n-done', namespace: 'done', type: 'exit', config: {} }
  return { nodes: [answer, apex, done], edges: [edge('n-answer', 'n-apex'), edge('n-apex', 'n-done')] }
}

async function walk(recovery: Recovery | null, queue: StepLogEntry[] = []) {
  const ctx = buildContext({ Submission__c: SUB }, 'website_form', 'wf-1', 'trace-1', {
    SALESFORCE_CLIENT_ID: 'client-id',
    SALESFORCE_CLIENT_SECRET: 'client-secret',
    SALESFORCE_INSTANCE_URL: INSTANCE,
  }, 'org-1', EXEC)
  ctx.retrySleep = async () => {}
  ctx.startAtRiskWatch = (stepNamespace) =>
    startAtRiskWatch({ kv, keys: KEY, clock: new VirtualClock(), run: { orgId: 'org-1', workflowId: 'wf-1', executionId: EXEC }, stepNamespace })
  if (recovery) Object.assign(ctx, recovery)
  return walkGraph(ctx, line(), EXEC, '2027-10-15T12:00:00.000Z', supabase, env, 'money', 'v1', queue)
    .then(() => null, (e: Error) => e)
}

const answer = (status: number, body: unknown) => Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)), headers: new Headers() })
type Route = (init: { headers?: Record<string, string> }) => Promise<unknown>
/** Salesforce by URL: each URL answers as given; anything else is a test fault. */
function salesforce(routes: Partial<Record<string, Route>>) {
  fetchMock.mockImplementation((url: string, init: { headers?: Record<string, string> }) => {
    const route = routes[url]
    if (!route) throw new Error(`unexpected call ${url}`)
    return route(init)
  })
}
const urls = () => fetchMock.mock.calls.map((c) => c[0] as string)
const apexCalls = () => urls().filter((u) => u === APEX_URL)
const stepRow = (queue: StepLogEntry[]) => queue.find((r) => r.step_namespace === STEP)

let fetchMock: FetchMock
beforeEach(() => {
  fetchMock = stubFetch()
  kv = makeKv()
  cache.get.mockReset().mockResolvedValue('tok')
  cache.put.mockReset().mockResolvedValue(undefined)
  cache.delete.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a recovery run whose original post landed', () => {
  for (const [name, recovery] of [['replay', replay], ['resume', resume]] as const) {
    it(`${name}: sends nothing, completes as skipped, already landed, and records no intent`, async () => {
      salesforce({
        [SUB_URL]: () => answer(200, { Lead__c: LEAD }),
        [MARKER_URL]: () => answer(200, { totalSize: 1, done: true, records: [{ Id: '06AUi0000000001AAA' }] }),
      })
      const queue: StepLogEntry[] = []
      expect(await walk(recovery(), queue)).toBeNull()
      expect(apexCalls()).toHaveLength(0)
      expect(urls()).toEqual([SUB_URL, MARKER_URL])
      expect(stepRow(queue)).toMatchObject({
        status: 'completed',
        output: { skipped: true, skip_reason: 'already_landed', lead_id: LEAD, recovered_from: ORIGINAL, marker_since: new Date(ORIGINAL_START - 2_000).toISOString() },
      })
      expect(kv.put).not.toHaveBeenCalled()
    })
  }
})

describe('a recovery run whose original post never landed', () => {
  for (const [name, recovery] of [['replay', replay], ['resume', resume]] as const) {
    it(`${name}: checks, then sends the post once, with the intent record written before it goes out`, async () => {
      let heldAtCall: string | undefined
      salesforce({
        [SUB_URL]: () => answer(200, { Lead__c: LEAD }),
        [MARKER_URL]: () => answer(200, { totalSize: 0, done: true, records: [] }),
        [APEX_URL]: () => {
          heldAtCall = kv.store.get(HELD)
          return answer(200, { message: 'ok', statusCode: '200', leadId: LEAD })
        },
      })
      const queue: StepLogEntry[] = []
      expect(await walk(recovery(), queue)).toBeNull()
      expect(urls()).toEqual([SUB_URL, MARKER_URL, APEX_URL])
      expect(parseAtRiskEntry(heldAtCall ?? null)).toMatchObject({ sf_operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH, sf_record_id: SUB })
      // Confirmed, so the record is cleared, as on a normal run.
      expect(kv.store.has(HELD)).toBe(false)
      expect(stepRow(queue)).toMatchObject({ status: 'completed', output: { status: 200 } })
    })
  }

  it('a revoked token on the check is refreshed once and the check goes on, as the post itself does (#1741)', async () => {
    let subReads = 0
    salesforce({
      [SUB_URL]: () => (++subReads === 1 ? answer(401, [{ errorCode: 'INVALID_SESSION_ID' }]) : answer(200, { Lead__c: LEAD })),
      [`${INSTANCE}/services/oauth2/token`]: () => answer(200, { access_token: 'fresh' }),
      [MARKER_URL]: () => answer(200, { totalSize: 0, records: [] }),
      [APEX_URL]: () => answer(200, { statusCode: '200' }),
    })
    cache.get.mockResolvedValueOnce('tok').mockResolvedValue(null)
    expect(await walk(replay())).toBeNull()
    expect(cache.delete).toHaveBeenCalledWith('sf-token-org-1')
    expect(apexCalls()).toHaveLength(1)
    const apexInit = fetchMock.mock.calls.find((c) => c[0] === APEX_URL)?.[1] as { headers: Record<string, string> }
    expect(apexInit.headers.Authorization).toBe('Bearer fresh')
  })
})

describe('a recovery run whose check cannot be answered sends nothing (fail closed)', () => {
  const cases: Array<[string, Partial<Record<string, Route>>]> = [
    ['the Submission read answers 503', { [SUB_URL]: () => answer(503, 'busy') }],
    ['the Submission read gets no answer', { [SUB_URL]: () => Promise.reject(new TypeError('fetch failed')) }],
    ['the file query answers 500', { [SUB_URL]: () => answer(200, { Lead__c: LEAD }), [MARKER_URL]: () => answer(500, [{ errorCode: 'UNKNOWN_EXCEPTION' }]) }],
    ['the file query answers something that is not a count', { [SUB_URL]: () => answer(200, { Lead__c: LEAD }), [MARKER_URL]: () => answer(200, '<html>maintenance</html>') }],
    ['the file query is refused', { [SUB_URL]: () => answer(200, { Lead__c: LEAD }), [MARKER_URL]: () => answer(400, [{ errorCode: 'MALFORMED_QUERY' }]) }],
  ]
  for (const [name, routes] of cases) {
    it(`${name}: the step fails as unknown, and no intent is recorded`, async () => {
      salesforce(routes)
      const queue: StepLogEntry[] = []
      const err = await walk(replay(), queue)
      expect(err?.message).toMatch(/credit inquiry post not sent.*replay.*whether .*Inquiries file.* landed is unknown/)
      expect(apexCalls()).toHaveLength(0)
      expect(stepRow(queue)).toMatchObject({ status: 'failed', retries_used: 0 })
      expect(kv.put).not.toHaveBeenCalled()
    })
  }

  it('the lineage of the run it recovers cannot be read: no Salesforce call at all', async () => {
    salesforce({})
    const queue: StepLogEntry[] = []
    const err = await walk({ recovery: 'replay', recoveryOrigin: async () => { throw new Error('execution x is no longer kept') } }, queue)
    expect(err?.message).toMatch(/credit inquiry post not sent.*replay.*no longer kept/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(stepRow(queue)).toMatchObject({ status: 'failed' })
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('a recovery run that does not say where its lineage began: nothing sent', async () => {
    salesforce({})
    const err = await walk({ recovery: 'resume' })
    expect(err?.message).toMatch(/credit inquiry post not sent.*resume/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a Submission with no Lead: not sent, permanent, since Salesforce refuses the post', async () => {
    salesforce({ [SUB_URL]: () => answer(200, { Lead__c: null }) })
    const queue: StepLogEntry[] = []
    const err = await walk(replay(), queue)
    expect(err?.message).toMatch(/credit inquiry post not sent.*no Lead/)
    expect(apexCalls()).toHaveLength(0)
    expect(stepRow(queue)).toMatchObject({ status: 'failed', error_type: 'permanent' })
  })
})

describe('a normal run is unchanged', () => {
  it('makes no check: the one call is the post itself', async () => {
    salesforce({ [APEX_URL]: () => answer(200, { statusCode: '200' }) })
    const queue: StepLogEntry[] = []
    expect(await walk(null, queue)).toBeNull()
    expect(urls()).toEqual([APEX_URL])
    expect(stepRow(queue)).toMatchObject({ status: 'completed', output: { status: 200 } })
  })
})
