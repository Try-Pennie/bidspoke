/**
 * An Apex step set to `retries: 0` makes exactly one Salesforce call (#2170, #1680
 * plan point 3).
 *
 * The credit inquiry Apex endpoint replaces a Lead's inquiry rows and attaches a
 * file on every call, so a resend duplicates files. The engine's step default is
 * `retries ?? 2`, which resends a timed out or 5xx Apex call twice. These tests
 * run the REAL walk, the real Salesforce executor and the real withRetry and
 * withTimeout: only fetch is a recorder, and the backoff sleep is recorded rather
 * than waited out (L524). Each one is paired with the same step left at the
 * default, which makes three calls, so the assertion can fail.
 *
 * Also proves, through the same walk, that a skipped write (skip_when_empty)
 * logs a completed step with its reason and does not fail the run.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'

const INSTANCE = 'https://trypennie.my.salesforce.com'
const APEX_URL = `${INSTANCE}/services/apexrest/credit-inquiries`

// A cached token, so every fetch is the Apex call itself; no bulkhead binding.
const env = {
  PII_REDACTION_FIELDS: '',
  WORKFLOW_CACHE: {
    get: vi.fn().mockResolvedValue('tok'),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
} as unknown as Env
// Any read through it would throw, so the walk is seen touching no database.
const supabase = {} as SupabaseClient

let retryDelays: number[] = []
const ctxFor = () => {
  const ctx = buildContext({ Submission__c: 'a0X1' }, 'website_form', 'wf-1', 'trace-1', {
    SALESFORCE_CLIENT_ID: 'client-id',
    SALESFORCE_CLIENT_SECRET: 'client-secret',
    SALESFORCE_INSTANCE_URL: INSTANCE,
  }, 'org-1', 'exec-1')
  ctx.retrySleep = async (ms) => { retryDelays.push(ms) }
  return ctx
}

const edge = (source: string, target: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target })

/** An Apex step then an exit. `retries` is left out of the config when undefined. */
function apexLine(retries: number | undefined, timeoutMs: number) {
  const config: Record<string, unknown> = {
    operation: 'apex',
    apex_path: '/services/apexrest/credit-inquiries',
    body: { submissionId: '{{trigger.payload.Submission__c}}', inquiriesJson: '[]' },
    timeout_ms: timeoutMs,
  }
  if (retries !== undefined) config.retries = retries
  const nodes: NodeDefinition[] = [
    { id: 'n-apex', namespace: 'inquiry_apex', type: 'salesforce', config },
    { id: 'n-done', namespace: 'done', type: 'exit', config: {} },
  ]
  return { nodes, edges: [edge('n-apex', 'n-done')] }
}

async function walk(def: ReturnType<typeof apexLine>, queue: StepLogEntry[]) {
  return walkGraph(ctxFor(), def, 'exec-1', '2027-10-15T12:00:00.000Z', supabase, env, 'money', 'v1', queue)
    .then(() => null, (e: Error) => e)
}

const apexCalls = (fetchMock: FetchMock) => fetchMock.mock.calls.filter((c) => c[0] === APEX_URL).length

/** A call that never answers until the step's deadline aborts it. */
function hangUntilAborted(_url: string, init: { signal?: AbortSignal }): Promise<unknown> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true })
  })
}

const serverError = () => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('{"message":"unavailable"}'), headers: new Headers() })

let fetchMock: FetchMock
beforeEach(() => {
  fetchMock = stubFetch()
  retryDelays = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('an Apex step with retries: 0 makes exactly one Salesforce call (#2170)', () => {
  // The step deadline is 1 ms and the call never answers, so the deadline is what
  // ends each attempt: nothing here waits on a fixed delay.
  it('on a timeout', async () => {
    fetchMock.mockImplementation(hangUntilAborted)
    const queue: StepLogEntry[] = []
    const err = await walk(apexLine(0, 1), queue)
    expect(err?.message).toMatch(/Step timed out after 1ms/)
    expect(apexCalls(fetchMock)).toBe(1)
    expect(retryDelays).toEqual([])
    expect(queue.find((r) => r.step_namespace === 'inquiry_apex')).toMatchObject({ status: 'failed', retries_used: 0 })
  })

  it('on a 5xx', async () => {
    fetchMock.mockImplementation(serverError)
    const queue: StepLogEntry[] = []
    const err = await walk(apexLine(0, 30_000), queue)
    expect(err?.message).toMatch(/Salesforce API error \(503\)/)
    expect(apexCalls(fetchMock)).toBe(1)
    expect(retryDelays).toEqual([])
    expect(queue.find((r) => r.step_namespace === 'inquiry_apex')).toMatchObject({ status: 'failed', retries_used: 0 })
  })

  it('and once on success, the step completing', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{"statusCode":200}'), headers: new Headers() })
    const queue: StepLogEntry[] = []
    expect(await walk(apexLine(0, 30_000), queue)).toBeNull()
    expect(apexCalls(fetchMock)).toBe(1)
    expect(queue.find((r) => r.step_namespace === 'inquiry_apex')?.status).toBe('completed')
  })
})

describe('the same Apex step left at the engine default resends (control)', () => {
  it('three calls on a timeout, two backoffs asked for', async () => {
    fetchMock.mockImplementation(hangUntilAborted)
    await walk(apexLine(undefined, 1), [])
    expect(apexCalls(fetchMock)).toBe(3)
    expect(retryDelays).toEqual([500, 1000])
  })

  it('three calls on a 5xx', async () => {
    fetchMock.mockImplementation(serverError)
    await walk(apexLine(undefined, 30_000), [])
    expect(apexCalls(fetchMock)).toBe(3)
  })
})

describe('a skipped write through the walk (#2170)', () => {
  it('logs a completed step carrying its skip reason, sends nothing and the run continues', async () => {
    const def = {
      nodes: [
        {
          id: 'n-post', namespace: 'invalid_state_sf_post', type: 'salesforce',
          config: { operation: 'update', object: 'Submission__c', record_id: '{{steps.none.output.sfBody.submissionId}}', body: '{{steps.none.output.sfBody}}', skip_when_empty: true },
        },
        { id: 'n-done', namespace: 'done', type: 'exit', config: {} },
      ] as NodeDefinition[],
      edges: [edge('n-post', 'n-done')],
    }
    const queue: StepLogEntry[] = []
    expect(await walk(def, queue)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    const row = queue.find((r) => r.step_namespace === 'invalid_state_sf_post')
    expect(row).toMatchObject({ status: 'completed', output: { skipped: true, skip_reason: 'nothing_to_write' } })
    expect(queue.map((r) => [r.step_namespace, r.status])).toEqual([['invalid_state_sf_post', 'completed'], ['done', 'completed']])
  })
})
