/**
 * The credit inquiry post through the REAL walk and the real Salesforce node
 * (#2172, Dan's D5 on #1680, 2026-10-15): never resend an inquiry post blind.
 *
 *  - The intent record is in KV BEFORE the call goes out, so an isolate cancelled
 *    mid call still leaves it, before or after the answer.
 *  - A confirmed answer clears it; a timeout, a 5xx or no answer keeps it for the
 *    read-back; a definite refusal (a 404, no Lead) clears it.
 *  - A post that cannot write anything is never sent: an empty list (answered 200,
 *    nothing written) or a missing one (answered 500 before any write, about 11.7%
 *    of live posts in #2169). A body the endpoint cannot read fails the step by name.
 *
 * Only fetch is a recorder and KV is a map; the watch's clock is virtual and the
 * step deadline is the call's own 1 ms timeout, so nothing waits in real time (L524).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, NodeDefinition } from '../../types'
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
import { CREDIT_INQUIRY_APEX_PATH } from '../inquiry-post'
import { decryptSecret } from '../../lib/secret-crypto'

const INSTANCE = 'https://trypennie.my.salesforce.com'
const APEX_URL = `${INSTANCE}${CREDIT_INQUIRY_APEX_PATH}`
const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 71)).toString('base64')
const SUB = 'a0XUi00000AbCdEFGH'
const EXEC = 'exec-2172'
const STEP = 'inquiry_apex_send_salesforce'
const HELD = atRiskKey(EXEC, STEP)

const env = {
  PII_REDACTION_FIELDS: '',
  WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('tok'), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
} as unknown as Env
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
let watched = true
const ctxFor = (payload: Record<string, unknown>) => {
  const ctx = buildContext(payload, 'website_form', 'wf-1', 'trace-1', {
    SALESFORCE_CLIENT_ID: 'client-id',
    SALESFORCE_CLIENT_SECRET: 'client-secret',
    SALESFORCE_INSTANCE_URL: INSTANCE,
  }, 'org-1', EXEC)
  ctx.retrySleep = async () => {}
  if (watched) {
    ctx.startAtRiskWatch = (stepNamespace) =>
      startAtRiskWatch({ kv, keys: KEY, clock: new VirtualClock(), run: { orgId: 'org-1', workflowId: 'wf-1', executionId: EXEC }, stepNamespace })
  }
  return ctx
}

const edge = (source: string, target: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target })

const inquiriesBody = (inquiriesJson: string) => ({ submissionId: '{{trigger.payload.Submission__c}}', inquiriesJson })
const WITH_INQUIRIES = inquiriesBody('{"inquiries":[{"type":"H","customerName":"BANK"}]}')

/** The inquiry post, optionally after an answer that lets the walk continue. */
function line(opts: { afterAnswer?: boolean; body?: unknown; timeoutMs?: number } = {}) {
  const apex: NodeDefinition = {
    id: 'n-apex',
    namespace: STEP,
    type: 'salesforce',
    config: { operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH, body: opts.body ?? WITH_INQUIRIES, retries: 0, timeout_ms: opts.timeoutMs ?? 30_000 },
  }
  const done: NodeDefinition = { id: 'n-done', namespace: 'done', type: 'exit', config: {} }
  if (!opts.afterAnswer) return { nodes: [apex, done], edges: [edge('n-apex', 'n-done')] }
  const answer: NodeDefinition = { id: 'n-answer', namespace: 'offer_response', type: 'response', config: { continue_after_response: true, status: 200, body: { ok: true } } }
  return { nodes: [answer, apex, done], edges: [edge('n-answer', 'n-apex'), edge('n-apex', 'n-done')] }
}

async function walk(def: ReturnType<typeof line>, queue: StepLogEntry[] = []) {
  return walkGraph(ctxFor({ Submission__c: SUB }), def, EXEC, '2027-10-15T12:00:00.000Z', supabase, env, 'money', 'v1', queue)
    .then(() => null, (e: Error) => e)
}

const apexCalls = (fetchMock: FetchMock) => fetchMock.mock.calls.filter((c) => c[0] === APEX_URL)
const answer = (status: number, body: unknown) => Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(body)), headers: new Headers() })
function hangUntilAborted(_url: string, init: { signal?: AbortSignal }): Promise<unknown> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true })
  })
}

let fetchMock: FetchMock
beforeEach(() => {
  fetchMock = stubFetch()
  kv = makeKv()
  watched = true
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the intent record is written before the post goes out', () => {
  for (const afterAnswer of [false, true]) {
    it(`${afterAnswer ? 'after' : 'before'} the answer: the record is in KV when the call is made, holding the post`, async () => {
      let heldAtCall: string | undefined
      fetchMock.mockImplementation((url: string, init: { signal?: AbortSignal }) => {
        if (url === APEX_URL) heldAtCall = kv.store.get(HELD)
        return hangUntilAborted(url, init)
      })
      await walk(line({ afterAnswer, timeoutMs: 1 }))
      expect(apexCalls(fetchMock)).toHaveLength(1)
      const entry = parseAtRiskEntry(heldAtCall ?? null)
      expect(entry).toMatchObject({ sf_operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH, sf_object: 'Submission__c', sf_record_id: SUB, step_namespace: STEP, execution_id: EXEC })
      expect(JSON.parse(await decryptSecret(entry!.body_encrypted, KEY))).toEqual({ submissionId: SUB, inquiriesJson: '{"inquiries":[{"type":"H","customerName":"BANK"}]}' })
      // Cut off by the step's own deadline: unknown, so it stays for the read-back.
      expect(kv.store.has(HELD)).toBe(true)
    })
  }

  it('an isolate cancelled mid call leaves it: the call never answers and the walk is never finished', async () => {
    let called = false
    fetchMock.mockImplementation(() => {
      called = true
      return new Promise(() => {})
    })
    void walk(line({ afterAnswer: true }))
    await vi.waitFor(() => expect(called).toBe(true))
    expect(parseAtRiskEntry(kv.store.get(HELD) ?? null)).toMatchObject({ sf_operation: 'apex', sf_record_id: SUB })
  })
})

describe('how the post settles its record', () => {
  it('a confirmed 200 clears it, and the step completes', async () => {
    fetchMock.mockImplementation(() => answer(200, { message: 'ok', statusCode: '200', leadId: '00QUi00000XyZaBCDE' }))
    const queue: StepLogEntry[] = []
    expect(await walk(line({ afterAnswer: true }), queue)).toBeNull()
    expect(apexCalls(fetchMock)).toHaveLength(1)
    expect(kv.store.has(HELD)).toBe(false)
    expect(queue.find((r) => r.step_namespace === STEP)?.status).toBe('completed')
  })

  it('a 500 keeps it: the class does not roll back, so rows may be written without the file', async () => {
    fetchMock.mockImplementation(() => answer(500, { error: 'Error: insert failed', statusCode: '500' }))
    await walk(line({ afterAnswer: true }))
    expect(apexCalls(fetchMock)).toHaveLength(1)
    expect(kv.store.has(HELD)).toBe(true)
  })

  it('a 404 (no Lead for the Submission) clears it: Salesforce wrote nothing and says so', async () => {
    fetchMock.mockImplementation(() => answer(404, { error: 'no connected Lead found', statusCode: '404' }))
    await walk(line({ afterAnswer: true }))
    expect(kv.store.has(HELD)).toBe(false)
  })

  // The hook is one slot on the run: a post inside a parallel node is not watched,
  // and must not be recorded through the slot a finished step left behind.
  it('leaves no record hook behind once the step settles, so a later unwatched post records nothing under its name', async () => {
    fetchMock.mockImplementation((url: string, init: { signal?: AbortSignal }) =>
      apexCalls(fetchMock).length === 1 ? answer(200, { statusCode: '200' }) : hangUntilAborted(url, init))
    const first = line({ afterAnswer: true }).nodes
    const child: NodeDefinition = { ...first[1], id: 'n-child', namespace: 'inquiry_in_parallel', config: { ...first[1].config, timeout_ms: 1 } }
    const def = {
      nodes: [
        first[0],
        first[1],
        { id: 'n-par', namespace: 'par', type: 'parallel', config: { wait_for: 'all', on_child_error: 'continue', timeout_ms: 60_000, children: [{ id: 'child-0', label: 'inquiry_in_parallel' }] } },
        child,
        { id: 'n-end', namespace: 'par_end', type: 'parallel_end', config: { pair_id: 'n-par' } },
        first[2],
      ] as NodeDefinition[],
      edges: [
        edge('n-answer', 'n-apex'),
        edge('n-apex', 'n-par'),
        { id: 'e-c', source: 'n-par', target: 'n-child', source_handle: 'child-0' },
        edge('n-child', 'n-end'),
        edge('n-par', 'n-end'),
        edge('n-end', 'n-done'),
      ],
    }
    await walk(def)
    expect(apexCalls(fetchMock)).toHaveLength(2)
    expect([...kv.store.keys()]).toEqual([])
  })

  it('a test run, which has no watch, records nothing and still makes its one call', async () => {
    watched = false
    fetchMock.mockImplementation(() => answer(500, { error: 'x', statusCode: '500' }))
    await walk(line({ afterAnswer: true }))
    expect(apexCalls(fetchMock)).toHaveLength(1)
    expect(kv.put).not.toHaveBeenCalled()
  })
})

describe('a post that can write nothing is never sent, and holds no record', () => {
  it('an empty list: skipped with its reason, the run carries on', async () => {
    const queue: StepLogEntry[] = []
    expect(await walk(line({ afterAnswer: true, body: inquiriesBody('{"inquiries":[]}') }), queue)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
    expect(queue.find((r) => r.step_namespace === STEP)).toMatchObject({ status: 'completed', output: { skipped: true, skip_reason: 'nothing_to_write' } })
  })

  it('a missing list, which Salesforce answers 500 before any write: skipped the same way, never sent to be refused', async () => {
    const queue: StepLogEntry[] = []
    expect(await walk(line({ afterAnswer: true, body: inquiriesBody('{}') }), queue)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
    expect(queue.find((r) => r.step_namespace === STEP)).toMatchObject({ status: 'completed', output: { skipped: true, skip_reason: 'nothing_to_write' } })
  })

  it('a body the endpoint cannot read fails the step by name, permanent, before any call', async () => {
    const queue: StepLogEntry[] = []
    const err = await walk(line({ afterAnswer: true, body: { submissionId: '{{trigger.payload.Submission__c}}' } }), queue)
    expect(err?.message).toMatch(/credit inquiry post.*inquiriesJson/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
    expect(queue.find((r) => r.step_namespace === STEP)).toMatchObject({ status: 'failed', error_type: 'permanent', retries_used: 0 })
  })
})
