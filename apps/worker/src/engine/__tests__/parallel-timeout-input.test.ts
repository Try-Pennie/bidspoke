/**
 * A parallel child cut off by its block's timeout records what it sent (#3064).
 *
 * When a parallel block stops waiting for a child still running, the block
 * writes that child's step row itself, marked `parallel_block` (#3047). #3057
 * made a step that fails on its own keep the request it noted; this row comes
 * from the block, not the child, so it recorded no input at all. Now it carries
 * the last request the child's running step noted (`noteStepInput`), the same
 * masked object a completed or failed step stores, never a second capture.
 *
 * The race: the child keeps running after the block gives up. Its late finish,
 * a success, a failure or a retry that notes a new request, must neither write
 * a second row nor change what this one records (#63).
 *
 * Driven through the real walk with a held fetch. The block's own timer is a
 * real setTimeout of a few milliseconds, its configured length; the step's own
 * deadline never passes, so only the block can cut the child off.
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

import { walkGraph } from '../index'
import { buildContext } from '../context'

const EXEC = 'exec-3064'
const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as SupabaseClient

// Plainly fake credentials. Each must never appear in a stored input.
const FAKE_BEARER = 'fake-bearer-token-1'
const FAKE_API_KEY = 'fake-api-key-1'
const FAKE_HEADER_AUTH = 'fake-header-auth-1'
const SECRETS = [FAKE_BEARER, FAKE_API_KEY, FAKE_HEADER_AUTH]

const RELAY_URL = 'https://relay.example.test/hook'
const BLOCK_TIMEOUT_MS = 5
const CUT_OFF_MESSAGE = `Parallel group timed out after ${BLOCK_TIMEOUT_MS}ms before this child completed`

type Deadline = NonNullable<ExecutionContext['stepDeadline']>
/** The step's own deadline never passes: only the block can cut the child off. */
const never: Deadline = (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))

function relayPost(namespace: string, auth: Record<string, unknown> = { type: 'bearer', token: '{{env.RELAY_TOKEN}}' }): NodeDefinition {
  return {
    id: namespace,
    namespace,
    type: 'webhook',
    config: {
      url: RELAY_URL,
      method: 'POST',
      headers: { 'X-Lead-Source': 'website_form', Authorization: '{{env.RELAY_HEADER_AUTH}}' },
      body: { submission_id: '{{trigger.payload.submission_id}}', amount: 12000 },
      auth,
      retries: 0,
      timeout_ms: 3750,
    },
  }
}

function ctx(): ExecutionContext {
  const c = buildContext({ submission_id: 'sub-3064', score: 700 }, 'website_form', 'wf-3064', 'trace-3064', {
    RELAY_TOKEN: FAKE_BEARER,
    RELAY_KEY: FAKE_API_KEY,
    RELAY_HEADER_AUTH: FAKE_HEADER_AUTH,
  }, 'org-1', EXEC)
  c.retrySleep = async () => {}
  c.stepDeadline = never
  return c
}

const edge = (source: string, target: string, source_handle?: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target, ...(source_handle ? { source_handle } : {}) })

/** A block of one slot, the slot a chain of `slot` steps, cut off after BLOCK_TIMEOUT_MS. */
function inParallel(...slot: NodeDefinition[]) {
  const nodes: NodeDefinition[] = [
    { id: 'fan', namespace: 'fan', type: 'parallel', config: { wait_for: 'all', on_child_error: 'continue', on_timeout: 'partial', timeout_ms: BLOCK_TIMEOUT_MS, children: [{ id: 'child-0' }] } },
    ...slot,
    { id: 'fan_end', namespace: 'fan_end', type: 'parallel_end', config: {} },
    { id: 'done', namespace: 'done', type: 'exit', config: {} },
  ]
  const chain = slot.slice(1).map((n, i) => edge(slot[i].id, n.id))
  const edges = [edge('fan', slot[0].id, 'child-0'), edge('fan', 'fan_end', 'output'), ...chain, edge(slot[slot.length - 1].id, 'fan_end'), edge('fan_end', 'done')]
  return { nodes, edges }
}

function sequential(node: NodeDefinition) {
  return { nodes: [node, { id: 'done', namespace: 'done', type: 'exit', config: {} } as NodeDefinition], edges: [edge(node.id, 'done')] }
}

interface HeldCall { answer: (r: Response) => void; fail: (e: unknown) => void }

/** Every fetch is held until the test answers or fails it. */
function holdFetch(fetchMock: FetchMock): HeldCall[] {
  const calls: HeldCall[] = []
  fetchMock.mockImplementation(() => new Promise((resolve, reject) => { calls.push({ answer: resolve, fail: reject }) }))
  return calls
}

async function walk(c: ExecutionContext, def: { nodes: NodeDefinition[]; edges: EdgeDefinition[] }): Promise<StepLogEntry[]> {
  const queue: StepLogEntry[] = []
  await walkGraph(c, def, EXEC, '2026-10-29T12:00:00.000Z', supabase, env, 'money', 'v1', queue, () => {}).catch(() => null)
  return queue
}

function rowsOf(queue: StepLogEntry[], ns: string): StepLogEntry[] {
  return queue.filter((r) => r.step_namespace === ns)
}

function cutOffRow(queue: StepLogEntry[], ns: string): StepLogEntry & Record<string, unknown> {
  const rows = rowsOf(queue, ns).filter((r) => (r as unknown as Record<string, unknown>).timeout_kind === 'parallel_block')
  if (rows.length !== 1) throw new Error(`expected one cut-off row for ${ns}, found ${rows.length}: ${queue.map((r) => r.step_namespace).join(', ')}`)
  return rows[0] as StepLogEntry & Record<string, unknown>
}

interface StoredRequest { method: string; url: string; headers: Record<string, string>; body: unknown }
const resolvedOf = (row: StepLogEntry): StoredRequest => (row.input as { resolved: StoredRequest }).resolved

function expectTheRequestSent(row: StepLogEntry, submissionId = 'sub-3064'): void {
  const sent = resolvedOf(row)
  expect(sent.method).toBe('POST')
  expect(sent.url).toBe(RELAY_URL)
  expect(sent.body).toEqual({ submission_id: submissionId, amount: 12000 })
  expect(sent.headers['X-Lead-Source']).toBe('website_form')
}

function expectNoSecret(row: StepLogEntry): void {
  const stored = JSON.stringify(row.input)
  for (const secret of SECRETS) expect({ secret, inStoredInput: stored.includes(secret) }).toEqual({ secret, inStoredInput: false })
  for (const secret of SECRETS) expect(String(row.error_message ?? '')).not.toContain(secret)
}

/** Waits until the late child's step has ended (its step_complete or step_error line), which is just before it would record. */
async function lateStepEnded(ns: string, event: 'step_complete' | 'step_error', times = 1): Promise<void> {
  await vi.waitFor(() => {
    const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes(`"event":"${event}"`) && line.includes(`"step_namespace":"${ns}"`))
    expect(lines.length).toBeGreaterThanOrEqual(times)
  })
}

let fetchMock: FetchMock
beforeEach(() => {
  fetchMock = stubFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a parallel child the block cut off records the request it sent (#3064)', () => {
  it('the row the block writes carries the request on the wire, marked as the block\'s deadline', async () => {
    const held = holdFetch(fetchMock)
    const queue = await walk(ctx(), inParallel(relayPost('tripoint_sf_post')))
    const row = cutOffRow(queue, 'tripoint_sf_post')
    expect(row).toMatchObject({ status: 'failed', error_message: CUT_OFF_MESSAGE, error_type: 'transient', timeout_kind: 'parallel_block', timed_out_after_ms: BLOCK_TIMEOUT_MS })
    expectTheRequestSent(row)
    // Let the abandoned child end, so nothing outlives the test.
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })

  it('it is exactly the input a completed step of the same request stores', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const done = rowsOf(await walk(ctx(), sequential(relayPost('tripoint_sf_post'))), 'tripoint_sf_post')[0]
    expect(done.status).toBe('completed')
    fetchMock.mockReset()
    const held = holdFetch(fetchMock)
    const row = cutOffRow(await walk(ctx(), inParallel(relayPost('tripoint_sf_post'))), 'tripoint_sf_post')
    expect(row.input).toEqual(done.input)
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })

  it('a step the slot reached before the cut-off keeps its own row, and the cut-off row is not given a later step\'s request', async () => {
    const held = holdFetch(fetchMock)
    const gate: NodeDefinition = { id: 'gate', namespace: 'gate', type: 'filter', config: { operation: 'continue_if', condition: { field: 'trigger.payload.score', operator: 'gt', value: '600' } } }
    const queue = await walk(ctx(), inParallel(gate, relayPost('tripoint_sf_post')))
    // The block names the slot by its first step, which had already finished:
    // the request noted by the step after it is not that step's request.
    const row = cutOffRow(queue, 'gate')
    expect(row.input).toBeNull()
    expect(held).toHaveLength(1)
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })
})

describe('the cut-off row never stores a credential (#3064)', () => {
  const auths: Array<[string, Record<string, unknown>, string]> = [
    ['a bearer token', { type: 'bearer', token: '{{env.RELAY_TOKEN}}' }, 'Authorization'],
    ['an api key in its own header', { type: 'api_key', header: 'X-Relay-Key', key: '{{env.RELAY_KEY}}' }, 'X-Relay-Key'],
  ]
  for (const [authName, auth, header] of auths) {
    it(`with ${authName}: the header is masked, as a completed step's is`, async () => {
      const held = holdFetch(fetchMock)
      const row = cutOffRow(await walk(ctx(), inParallel(relayPost('tripoint_sf_post', auth))), 'tripoint_sf_post')
      expectTheRequestSent(row)
      expect(resolvedOf(row).headers[header]).toBe('[redacted]')
      expectNoSecret(row)
      // The real credential still went on the wire.
      const sentHeaders = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
      expect(Object.values(sentHeaders).join(' ')).toContain(auth.type === 'bearer' ? FAKE_BEARER : FAKE_API_KEY)
      held[0].fail(new TypeError('Network connection lost.'))
      await lateStepEnded('tripoint_sf_post', 'step_error')
    })
  }
})

describe('the child finishing after the block gave up changes nothing the row records (#3064, #63)', () => {
  it('a late success writes no second row, and the cut-off row keeps its request', async () => {
    const held = holdFetch(fetchMock)
    const queue = await walk(ctx(), inParallel(relayPost('tripoint_sf_post')))
    held[0].answer(new Response('{"ok":true}', { status: 200 }))
    await lateStepEnded('tripoint_sf_post', 'step_complete')
    expect(rowsOf(queue, 'tripoint_sf_post')).toHaveLength(1)
    const row = cutOffRow(queue, 'tripoint_sf_post')
    expect(row.status).toBe('failed')
    expect(row.output).toBeNull()
    expectTheRequestSent(row)
  })

  it('a late failure writes no second row, and the cut-off row keeps its request', async () => {
    const held = holdFetch(fetchMock)
    const queue = await walk(ctx(), inParallel(relayPost('tripoint_sf_post')))
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
    expect(rowsOf(queue, 'tripoint_sf_post')).toHaveLength(1)
    const row = cutOffRow(queue, 'tripoint_sf_post')
    expect(row.error_message).toBe(CUT_OFF_MESSAGE)
    expectTheRequestSent(row)
  })

  it('a late retry that notes a different request does not change the request the row recorded', async () => {
    const held = holdFetch(fetchMock)
    const c = ctx()
    const node = relayPost('tripoint_sf_post')
    node.config.retries = 1
    const queue = await walk(c, inParallel(node))
    // The retry resolves its body afresh, so it notes a request the cut-off row never saw.
    ;(c.trigger.payload as Record<string, unknown>).submission_id = 'sub-after-cut-off'
    held[0].fail(new TypeError('Network connection lost.'))
    await vi.waitFor(() => expect(held).toHaveLength(2))
    expect((JSON.parse(String(fetchMock.mock.calls[1][1].body)) as { submission_id: string }).submission_id).toBe('sub-after-cut-off')
    held[1].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
    expect(rowsOf(queue, 'tripoint_sf_post')).toHaveLength(1)
    expectTheRequestSent(cutOffRow(queue, 'tripoint_sf_post'), 'sub-3064')
  })
})
