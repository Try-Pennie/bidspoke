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
import { attributeOutageCause, failingStepDeadline, UPSTREAM_OUTAGE_CAUSES, type MarkedFailedStep } from '../../lib/upstream-outage'

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
  return inBlock({ on_child_error: 'continue', on_timeout: 'partial' }, slot)
}

/** A block with its own settings, each slot a chain of steps, cut off after BLOCK_TIMEOUT_MS. */
function inBlock(settings: Record<string, unknown>, ...slots: NodeDefinition[][]) {
  const nodes: NodeDefinition[] = [
    { id: 'fan', namespace: 'fan', type: 'parallel', config: { wait_for: 'all', timeout_ms: BLOCK_TIMEOUT_MS, ...settings, children: slots.map((_, i) => ({ id: `child-${i}` })) } },
    ...slots.flat(),
    { id: 'fan_end', namespace: 'fan_end', type: 'parallel_end', config: {} },
    { id: 'done', namespace: 'done', type: 'exit', config: {} },
  ]
  const edges = [edge('fan', 'fan_end', 'output'), edge('fan_end', 'done')]
  slots.forEach((slot, s) => {
    edges.push(edge('fan', slot[0].id, `child-${s}`), edge(slot[slot.length - 1].id, 'fan_end'))
    slot.slice(1).forEach((n, i) => edges.push(edge(slot[i].id, n.id)))
  })
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

/** The fields of the failure the run ends with, the ones its record and alerts are built from. */
interface RunFailure { message: string; stepNamespace: string; errorType: unknown; suppressAlert: boolean; childFailure: unknown; afterAnswer: unknown }

async function walkFailing(c: ExecutionContext, def: { nodes: NodeDefinition[]; edges: EdgeDefinition[] }): Promise<{ queue: StepLogEntry[]; failure: RunFailure }> {
  const queue: StepLogEntry[] = []
  const err = await walkGraph(c, def, EXEC, '2026-10-29T12:00:00.000Z', supabase, env, 'money', 'v1', queue, () => {}).then(() => null, (e: unknown) => e)
  if (!(err instanceof Error)) throw new Error('the walk did not fail')
  const f = err as Error & Omit<RunFailure, 'message'>
  return { queue, failure: { message: f.message, stepNamespace: f.stepNamespace, errorType: f.errorType, suppressAlert: f.suppressAlert, childFailure: f.childFailure, afterAnswer: f.afterAnswer } }
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

})

describe('a slot cut off on a later step of its chain: the row is that step\'s (#3071)', () => {
  const gate: NodeDefinition = { id: 'gate', namespace: 'gate', type: 'filter', config: { operation: 'continue_if', condition: { field: 'trigger.payload.score', operator: 'gt', value: '600' } } }

  it('the step it was running gets the cut-off row with its request, and the step it finished keeps its one row', async () => {
    const held = holdFetch(fetchMock)
    const queue = await walk(ctx(), inParallel(gate, relayPost('tripoint_sf_post'), relayPost('follow_up_post')))
    expect(held).toHaveLength(1)
    // The step it finished: one row, completed, never a second one failed by the block.
    const gateRows = rowsOf(queue, 'gate')
    expect(gateRows).toHaveLength(1)
    expect(gateRows[0].status).toBe('completed')
    expect(gateRows[0]).not.toHaveProperty('timeout_kind')
    // The step it was on: the block's row, with what it sent, in its own place in the slot.
    const row = cutOffRow(queue, 'tripoint_sf_post')
    expect(row).toMatchObject({ status: 'failed', error_message: CUT_OFF_MESSAGE, error_type: 'transient', timeout_kind: 'parallel_block', timed_out_after_ms: BLOCK_TIMEOUT_MS, parallel_group_id: 'fan', step_order: gateRows[0].step_order + 1 })
    expectTheRequestSent(row)
    expectNoSecret(row)
    // It started when that step did, not when the block did.
    expect(Date.parse(row.started_at)).toBeGreaterThanOrEqual(Date.parse(gateRows[0].started_at))
    // The step after it never started, so it has no row.
    expect(rowsOf(queue, 'follow_up_post')).toHaveLength(0)
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })

  it('a late success of that step writes no second row and starts no further step', async () => {
    const held = holdFetch(fetchMock)
    const queue = await walk(ctx(), inParallel(gate, relayPost('tripoint_sf_post'), relayPost('follow_up_post')))
    held[0].answer(new Response('{"ok":true}', { status: 200 }))
    await lateStepEnded('tripoint_sf_post', 'step_complete')
    expect(rowsOf(queue, 'gate')).toHaveLength(1)
    expect(rowsOf(queue, 'tripoint_sf_post')).toHaveLength(1)
    expectTheRequestSent(cutOffRow(queue, 'tripoint_sf_post'))
    expect(rowsOf(queue, 'follow_up_post')).toHaveLength(0)
    expect(held).toHaveLength(1)
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

/** The marked failed rows of the run, as the upstream outage check reads them (readMarkedFailedSteps). */
function markedFailedRows(queue: StepLogEntry[]): MarkedFailedStep[] {
  return queue
    .map((r) => r as StepLogEntry & { timeout_kind?: unknown })
    .filter((r) => r.status === 'failed' && r.timeout_kind != null)
    .map((r) => ({ execution_id: r.execution_id, step_type: r.step_type, parallel_group_id: r.parallel_group_id ?? null, step_node_id: r.step_node_id, timeout_kind: r.timeout_kind }))
}

/** The outage bucket the run falls in with its rows, and with no marked row at all (how it was read before #3072). */
function bucketsOf(queue: StepLogEntry[], failure: RunFailure): { withRows: string | null; withoutRows: string | null } {
  const run = { id: EXEC, failed_step_type: 'parallel' }
  return {
    withRows: attributeOutageCause(failure.message, run.failed_step_type, UPSTREAM_OUTAGE_CAUSES, failingStepDeadline(run, markedFailedRows(queue)))?.key ?? null,
    withoutRows: attributeOutageCause(failure.message, run.failed_step_type, UPSTREAM_OUTAGE_CAUSES, null)?.key ?? null,
  }
}

describe('a block that fails on its own deadline records the slots it cut off (#3072)', () => {
  const failOnTimeout = { on_child_error: 'continue', on_timeout: 'fail' }

  it('on_timeout fail: the slot still running gets the block\'s row with its request, and the run fails as before', async () => {
    const held = holdFetch(fetchMock)
    const c = ctx()
    const { queue, failure } = await walkFailing(c, inBlock(failOnTimeout, [relayPost('tripoint_sf_post')]))
    // The run's failure is the block's, unchanged: its step, type, alert and child.
    expect(failure.message).toMatch(/^Parallel node timed out \u{2014} 1 child\(ren\) did not settle within 5ms$/u)
    expect(failure).toMatchObject({ stepNamespace: 'fan', errorType: 'transient', suppressAlert: false, childFailure: null, afterAnswer: false })
    expect(rowsOf(queue, 'fan')).toMatchObject([{ status: 'failed', error_message: failure.message }])
    expect(rowsOf(queue, 'fan')[0]).not.toHaveProperty('timeout_kind')
    // Only the row is written: what later steps would read of the slot is untouched.
    expect(c.steps.tripoint_sf_post).toBeUndefined()
    const row = cutOffRow(queue, 'tripoint_sf_post')
    expect(row).toMatchObject({ status: 'failed', error_message: CUT_OFF_MESSAGE, error_type: 'transient', timeout_kind: 'parallel_block', timed_out_after_ms: BLOCK_TIMEOUT_MS, parallel_group_id: 'fan' })
    expectTheRequestSent(row)
    expectNoSecret(row)
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })

  it('cut off on a later step of its chain: that step\'s row, and the step it finished keeps its one row', async () => {
    const held = holdFetch(fetchMock)
    const gate: NodeDefinition = { id: 'gate', namespace: 'gate', type: 'filter', config: { operation: 'continue_if', condition: { field: 'trigger.payload.score', operator: 'gt', value: '600' } } }
    const { queue } = await walkFailing(ctx(), inBlock(failOnTimeout, [gate, relayPost('tripoint_sf_post')]))
    expect(rowsOf(queue, 'gate')).toMatchObject([{ status: 'completed' }])
    expectTheRequestSent(cutOffRow(queue, 'tripoint_sf_post'))
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })

  it('the default settings (on_child_error fail, on_timeout partial) failing on the late slot write its row too', async () => {
    const held = holdFetch(fetchMock)
    const { queue, failure } = await walkFailing(ctx(), inBlock({}, [relayPost('tripoint_sf_post')]))
    expect(failure.message).toBe('Parallel failed: child "tripoint_sf_post" did not complete in time')
    expectTheRequestSent(cutOffRow(queue, 'tripoint_sf_post'))
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })

  it('a late success writes no second row', async () => {
    const held = holdFetch(fetchMock)
    const { queue } = await walkFailing(ctx(), inBlock(failOnTimeout, [relayPost('tripoint_sf_post')]))
    held[0].answer(new Response('{"ok":true}', { status: 200 }))
    await lateStepEnded('tripoint_sf_post', 'step_complete')
    expect(rowsOf(queue, 'tripoint_sf_post')).toHaveLength(1)
    expect(cutOffRow(queue, 'tripoint_sf_post').output).toBeNull()
  })

  it('a late failure writes no second row', async () => {
    const held = holdFetch(fetchMock)
    const { queue } = await walkFailing(ctx(), inBlock(failOnTimeout, [relayPost('tripoint_sf_post')]))
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
    expect(rowsOf(queue, 'tripoint_sf_post')).toHaveLength(1)
    expect(cutOffRow(queue, 'tripoint_sf_post').error_message).toBe(CUT_OFF_MESSAGE)
  })
})

describe('the rows a failed block now writes leave the run in the outage bucket it was in (#3072, #3069)', () => {
  it('on_timeout fail: the timeout bucket, by the marker now as by the text before', async () => {
    const held = holdFetch(fetchMock)
    const { queue, failure } = await walkFailing(ctx(), inBlock({ on_child_error: 'continue', on_timeout: 'fail' }, [relayPost('tripoint_sf_post')]))
    expect(markedFailedRows(queue)).toHaveLength(1)
    expect(bucketsOf(queue, failure)).toEqual({ withRows: 'timeout', withoutRows: 'timeout' })
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })

  it('failing on the late slot under the default settings: the timeout bucket either way', async () => {
    const held = holdFetch(fetchMock)
    const { queue, failure } = await walkFailing(ctx(), inBlock({}, [relayPost('tripoint_sf_post')]))
    expect(bucketsOf(queue, failure)).toEqual({ withRows: 'timeout', withoutRows: 'timeout' })
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })

  it('failing on a slot that was refused while another was still running: no failed cut-off row, so not read as a timeout', async () => {
    const held: HeldCall[] = []
    fetchMock.mockImplementation((url: unknown) => String(url).includes('refused')
      ? Promise.resolve(new Response('{"error":"bad lead"}', { status: 400 }))
      : new Promise((resolve, reject) => { held.push({ answer: resolve, fail: reject }) }))
    const { queue, failure } = await walkFailing(ctx(), inBlock({}, [refusedPost('lendswift_post')], [relayPost('tripoint_sf_post')]))
    expect(failure.message).toMatch(/^Parallel failed: child "lendswift_post" failed/)
    // The block failed on the refusal, not its deadline: the late slot's row
    // (#3083) is skipped, never failed, so the run is not bound to a deadline it
    // did not fail on.
    expect(rowsOf(queue, 'tripoint_sf_post')).toMatchObject([{ status: 'skipped' }])
    expect(markedFailedRows(queue)).toEqual([])
    expect(bucketsOf(queue, failure)).toEqual({ withRows: null, withoutRows: null })
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })
})

/** A relay post the partner refuses at once (400). */
function refusedPost(namespace: string): NodeDefinition {
  const node = relayPost(namespace)
  return { ...node, config: { ...node.config, url: 'https://refused.example.test/hook' } }
}

/** A relay post the partner answers at once (200). */
function answeredPost(namespace: string): NodeDefinition {
  const node = relayPost(namespace)
  return { ...node, config: { ...node.config, url: 'https://answered.example.test/hook' } }
}

/**
 * Refused and answered posts are answered, once `heldFirst` other fetches are
 * held (so the slot left running has sent, and noted, its request before the
 * block decides); every other fetch is held.
 */
function answerSomeHoldTheRest(heldFirst = 0): HeldCall[] {
  const held: HeldCall[] = []
  const once = (response: () => Response) => vi.waitFor(() => { if (held.length < heldFirst) throw new Error('not yet held') }, { interval: 1 }).then(response)
  fetchMock.mockImplementation((url: unknown) => String(url).includes('refused')
    ? once(() => new Response('{"error":"bad lead"}', { status: 400 }))
    : String(url).includes('answered')
      ? once(() => new Response('{"ok":true}', { status: 200 }))
      : new Promise((resolve, reject) => { held.push({ answer: resolve, fail: reject }) }))
  return held
}

/** Ends every held call, so nothing outlives the test. */
function failAll(held: HeldCall[]): void {
  for (const call of held) call.fail(new TypeError('Network connection lost.'))
}

/** The one row of `ns` the block wrote as skipped (#3083). */
function leftRow(queue: StepLogEntry[], ns: string): StepLogEntry & Record<string, unknown> {
  const rows = rowsOf(queue, ns)
  if (rows.length !== 1 || rows[0].status !== 'skipped') throw new Error(`expected one skipped row for ${ns}, found ${rows.map((r) => r.status).join(', ') || 'none'}`)
  return rows[0] as StepLogEntry & Record<string, unknown>
}

/** Long enough that only the slots, never the block's timer, decide a wait_for first or specific block. */
const NO_DEADLINE_MS = 60_000

describe('a slot still running when its block returns first or fails on another slot gets a row (#3083)', () => {
  it('wait_for first: the slot still running when the winner returned is recorded as skipped, with its request', async () => {
    const held = answerSomeHoldTheRest(1)
    const c = ctx()
    const queue = await walk(c, inBlock({ wait_for: 'first', timeout_ms: NO_DEADLINE_MS }, [answeredPost('amone_post')], [relayPost('tripoint_sf_post')]))
    expect(rowsOf(queue, 'amone_post')).toMatchObject([{ status: 'completed' }])
    expect(rowsOf(queue, 'fan')).toMatchObject([{ status: 'completed' }])
    const row = leftRow(queue, 'tripoint_sf_post')
    expect(row).toMatchObject({ status: 'skipped', error_message: 'Stopped waiting: branch amone_post finished first.', error_type: null, output: null, parallel_group_id: 'fan' })
    // No deadline stopped it, so it carries no deadline marker.
    expect(row).not.toHaveProperty('timeout_kind')
    expectTheRequestSent(row)
    expectNoSecret(row)
    // Only the row is written: what later steps read of the slot is untouched.
    expect(c.steps.tripoint_sf_post).toBeUndefined()
    held[0].answer(new Response('{"ok":true}', { status: 200 }))
    await lateStepEnded('tripoint_sf_post', 'step_complete')
    // Its late finish writes no second row (#63).
    expect(rowsOf(queue, 'tripoint_sf_post')).toHaveLength(1)
  })

  it('wait_for specific: a slot still running when the named slot failed is recorded as skipped, and the run is not read as a timeout', async () => {
    const held = answerSomeHoldTheRest(1)
    const c = ctx()
    const { queue, failure } = await walkFailing(c, inBlock({ wait_for: 'specific', wait_for_slot: 'child-0', timeout_ms: NO_DEADLINE_MS }, [refusedPost('lendswift_post')], [relayPost('tripoint_sf_post')]))
    // The run's failure is the block's, unchanged.
    expect(failure.message).toMatch(/^Parallel failed: slot "lendswift_post" failed/)
    expect(failure).toMatchObject({ stepNamespace: 'fan', afterAnswer: false })
    expect(rowsOf(queue, 'lendswift_post')).toMatchObject([{ status: 'failed' }])
    const row = leftRow(queue, 'tripoint_sf_post')
    expect(row).toMatchObject({ status: 'skipped', error_message: 'Stopped waiting: branch lendswift_post failed.', error_type: null, parallel_group_id: 'fan' })
    expect(row).not.toHaveProperty('timeout_kind')
    expectTheRequestSent(row)
    expect(c.steps.tripoint_sf_post).toBeUndefined()
    expect(markedFailedRows(queue)).toEqual([])
    expect(bucketsOf(queue, failure)).toEqual({ withRows: null, withoutRows: null })
    held[0].fail(new TypeError('Network connection lost.'))
    await lateStepEnded('tripoint_sf_post', 'step_error')
    expect(rowsOf(queue, 'tripoint_sf_post')).toHaveLength(1)
  })

  it('wait_for all, on_child_error fail: a slot still running at the deadline when the block fails on a refused slot is skipped, marked as the block\'s deadline', async () => {
    const held = answerSomeHoldTheRest()
    const c = ctx()
    const { queue, failure } = await walkFailing(c, inBlock({}, [refusedPost('lendswift_post')], [relayPost('tripoint_sf_post')]))
    expect(failure.message).toMatch(/^Parallel failed: child "lendswift_post" failed/)
    expect(failure).toMatchObject({ stepNamespace: 'fan', afterAnswer: false })
    const row = leftRow(queue, 'tripoint_sf_post')
    expect(row).toMatchObject({
      status: 'skipped',
      // The block's 5 ms limit, in seconds with one decimal (limitInSeconds).
      error_message: 'Stopped waiting at the 0.0 second limit, then branch lendswift_post failed.',
      error_type: null,
      timeout_kind: 'parallel_block',
      timed_out_after_ms: BLOCK_TIMEOUT_MS,
      parallel_group_id: 'fan',
    })
    expectTheRequestSent(row)
    expect(c.steps.tripoint_sf_post).toBeUndefined()
    expect(bucketsOf(queue, failure)).toEqual({ withRows: null, withoutRows: null })
    held[0].answer(new Response('{"ok":true}', { status: 200 }))
    await lateStepEnded('tripoint_sf_post', 'step_complete')
    expect(rowsOf(queue, 'tripoint_sf_post')).toHaveLength(1)
  })

  it('the outage rule still reads the slot the block failed on: its own step deadline, not the block\'s', async () => {
    const held = answerSomeHoldTheRest()
    const c = ctx()
    // The refused slot is stopped by its own step deadline at once; the other is held past the block's.
    const OWN_DEADLINE_MS = 1234
    c.stepDeadline = (ms, signal) => ms === OWN_DEADLINE_MS ? Promise.resolve() : never(ms, signal)
    const ownTimer = { ...relayPost('lendswift_post'), config: { ...relayPost('lendswift_post').config, timeout_ms: OWN_DEADLINE_MS } }
    const { queue, failure } = await walkFailing(c, inBlock({}, [ownTimer], [relayPost('tripoint_sf_post')]))
    expect(failure.message).toMatch(/^Parallel failed: child "lendswift_post" failed: Step timed out after 1234ms/)
    expect(rowsOf(queue, 'lendswift_post')).toMatchObject([{ status: 'failed', timeout_kind: 'step' }])
    expect(leftRow(queue, 'tripoint_sf_post')).toMatchObject({ status: 'skipped', timeout_kind: 'parallel_block' })
    // The only marked failed row is the slot the block failed on, so its own deadline names the run.
    expect(markedFailedRows(queue).map((r) => [r.step_type, r.timeout_kind])).toEqual([['webhook', 'step']])
    expect(failingStepDeadline({ id: EXEC, failed_step_type: 'parallel' }, markedFailedRows(queue))).toBe('step')
    failAll(held)
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })

  it('a slot that finished before the block stopped waiting keeps its own row and gets no second one', async () => {
    const held = answerSomeHoldTheRest(1)
    const queue = await walk(ctx(), inBlock({ wait_for: 'first', timeout_ms: NO_DEADLINE_MS }, [refusedPost('lendswift_post')], [answeredPost('amone_post')], [relayPost('tripoint_sf_post')]))
    expect(rowsOf(queue, 'lendswift_post')).toMatchObject([{ status: 'failed' }])
    expect(rowsOf(queue, 'amone_post')).toMatchObject([{ status: 'completed' }])
    expect(leftRow(queue, 'tripoint_sf_post').error_message).toBe('Stopped waiting: branch amone_post finished first.')
    failAll(held)
    await lateStepEnded('tripoint_sf_post', 'step_error')
  })
})
