/**
 * Salesforce writes inside a parallel block keep their at-risk watch (#2832).
 *
 * The inquiry post's record before it is sent (#2172), a post-answer update's
 * at-risk record (#2022) and its write marker (#2023) were hooks on ONE slot of
 * the run's context, which held only while the walk's own sequential loop ran
 * every watched step. A parallel block's children ran unwatched, so an inquiry
 * post placed in one went out with no record and nothing said so. Each step now
 * carries its own hooks with its call, so two children writing at once are each
 * recorded and settled on their own.
 *
 * This walks a parallel block after the answer through the real walk and the real
 * Salesforce node. Its three children are all in flight together before any is
 * answered (the fetch recorder holds every call until the third arrives), so a
 * shared slot would be overwritten by whichever child started last.
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

const INSTANCE = 'https://trypennie.my.salesforce.com'
const APEX_URL = `${INSTANCE}${CREDIT_INQUIRY_APEX_PATH}`
const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 71)).toString('base64')
const SUB_A = 'a0XUi00000AbCdEFGA'
const SUB_B = 'a0XUi00000AbCdEFGB'
const SUB_C = 'a0XUi00000AbCdEFGC'
const EXEC = 'exec-2832'

const env = {
  PII_REDACTION_FIELDS: '',
  WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('tok'), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
} as unknown as Env
const supabase = {} as SupabaseClient

const kvStore = new Map<string, string>()
const kv = {
  put: vi.fn(async (k: string, v: string) => { kvStore.set(k, v) }),
  delete: vi.fn(async (k: string) => { kvStore.delete(k) }),
}

function ctxAtTheAnswer() {
  const ctx = buildContext({}, 'website_form', 'wf-1', 'trace-1', {
    SALESFORCE_CLIENT_ID: 'client-id', SALESFORCE_CLIENT_SECRET: 'client-secret', SALESFORCE_INSTANCE_URL: INSTANCE,
  }, 'org-1', EXEC)
  ctx.retrySleep = async () => {}
  ctx.startAtRiskWatch = (stepNamespace) =>
    startAtRiskWatch({ kv, keys: KEY, clock: new VirtualClock(), run: { orgId: 'org-1', workflowId: 'wf-1', executionId: EXEC }, stepNamespace })
  return ctx
}

const edge = (source: string, target: string, source_handle?: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target, ...(source_handle ? { source_handle } : {}) })
const inquiry = (id: string, submissionId: string): NodeDefinition => ({
  id,
  namespace: id,
  type: 'salesforce',
  config: { operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH, body: { submissionId, inquiriesJson: '{"inquiries":[{"type":"H"}]}' }, retries: 0, timeout_ms: 30_000 },
})

/** The answer, then a parallel block of two inquiry posts and a Submission update, then the end. */
function definition() {
  const nodes: NodeDefinition[] = [
    { id: 'answer', namespace: 'answer', type: 'response', config: { continue_after_response: true, status: 200, body: { ok: true } } },
    { id: 'fan', namespace: 'fan', type: 'parallel', config: { wait_for: 'all', on_child_error: 'fail', on_timeout: 'partial', timeout_ms: 30_000, children: [{ id: 'child-0' }, { id: 'child-1' }, { id: 'child-2' }] } },
    inquiry('inquiry_a', SUB_A),
    inquiry('inquiry_b', SUB_B),
    { id: 'update_c', namespace: 'update_c', type: 'salesforce', config: { operation: 'update', object: 'Submission__c', record_id: SUB_C, body: { Status__c: 'Done' }, retries: 0, timeout_ms: 30_000 } },
    { id: 'fan_end', namespace: 'fan_end', type: 'parallel_end', config: {} },
    { id: 'done', namespace: 'done', type: 'exit', config: {} },
  ]
  const edges = [
    edge('answer', 'fan'),
    edge('fan', 'inquiry_a', 'child-0'), edge('fan', 'inquiry_b', 'child-1'), edge('fan', 'update_c', 'child-2'),
    edge('fan', 'fan_end', 'output'),
    edge('inquiry_a', 'fan_end'), edge('inquiry_b', 'fan_end'), edge('update_c', 'fan_end'),
    edge('fan_end', 'done'),
  ]
  return { nodes, edges }
}

let fetchMock: FetchMock
beforeEach(() => {
  fetchMock = stubFetch()
  kvStore.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('two children of a parallel block writing at once are each watched on their own', () => {
  it('each inquiry post is recorded before it goes out, one landed clears, one unknown stays, and the update carries its own marker', async () => {
    const answers: Record<string, number> = { [SUB_A]: 200, [SUB_B]: 500, [SUB_C]: 204 }
    const heldAtCall: Record<string, string | undefined> = {}
    const sent: Array<{ url: string; body: Record<string, unknown> }> = []
    let release!: () => void
    const allInFlight = new Promise<void>((r) => { release = r })
    fetchMock.mockImplementation(async (url: string, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
      sent.push({ url, body })
      if (url === APEX_URL) {
        const ns = body.submissionId === SUB_A ? 'inquiry_a' : 'inquiry_b'
        heldAtCall[ns] = kvStore.get(atRiskKey(EXEC, ns))
      }
      if (sent.length === 3) release()
      await allInFlight
      const sub = url === APEX_URL ? String(body.submissionId) : SUB_C
      const status = answers[sub]
      return new Response(status === 204 ? null : JSON.stringify({ message: 'answer', statusCode: status }), { status })
    })
    const queue: StepLogEntry[] = []
    const ending = await walkGraph(ctxAtTheAnswer(), definition(), EXEC, '2027-10-15T12:00:00.000Z', supabase, env, 'money', 'v1', queue, () => {})
      .then(() => null, (e: Error) => e)

    expect(sent).toHaveLength(3)
    // Each post's own record was in KV when it went out, holding its own body.
    for (const [ns, sub] of [['inquiry_a', SUB_A], ['inquiry_b', SUB_B]] as const) {
      expect({ ns, held: parseAtRiskEntry(heldAtCall[ns] ?? null) }).toMatchObject({ ns, held: { step_namespace: ns, sf_record_id: sub, apex_path: CREDIT_INQUIRY_APEX_PATH } })
    }
    // Settled on their own: the landed one cleared, the unknown one kept for the read-back.
    expect(kvStore.has(atRiskKey(EXEC, 'inquiry_a'))).toBe(false)
    expect(kvStore.has(atRiskKey(EXEC, 'inquiry_b'))).toBe(true)
    // The update was stamped with its own marker while the posts ran beside it.
    const patch = sent.find((s) => s.url.includes('/sobjects/Submission__c/'))
    expect(patch?.body.Bidspoke_Write__c).toBe(`${EXEC}:update_c:0`)
    // The inquiry posts carry no marker: the Apex endpoint is not one of the stamped objects.
    expect(sent.filter((s) => s.url === APEX_URL).map((s) => s.body.Bidspoke_Write__c)).toEqual([undefined, undefined])
    // The failed post fails the block, as an unmarked child always has.
    expect(ending?.message).toMatch(/inquiry_b/)
  })

  it('names the steps a parallel block is on, for a cut-off to ask the read-back about', async () => {
    const ctx = ctxAtTheAnswer()
    let runningWhileInFlight: string[] = []
    let calls = 0
    let release!: () => void
    const allInFlight = new Promise<void>((r) => { release = r })
    fetchMock.mockImplementation(async () => {
      if (++calls === 3) { runningWhileInFlight = [...(ctx.runningNamespaces ?? [])]; release() }
      await allInFlight
      return new Response(JSON.stringify({ message: 'ok', statusCode: 200 }), { status: 200 })
    })
    await walkGraph(ctx, definition(), EXEC, '2027-10-15T12:00:00.000Z', supabase, env, 'money', 'v1', [], () => {}).catch(() => null)
    expect(runningWhileInFlight.sort()).toEqual(['inquiry_a', 'inquiry_b', 'update_c'])
  })
})
