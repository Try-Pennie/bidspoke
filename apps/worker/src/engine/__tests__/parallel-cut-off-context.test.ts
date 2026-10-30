/**
 * What a later step reads of a slot its parallel block cut off (#3082).
 *
 * When a block carries on past its timeout, it records each slot still running
 * as failed in the run's step outputs (`ctx.steps`). It used to record that
 * failure under the slot's FIRST step, even when the slot had finished that step
 * and was cut off on a later one. The first step's real output was then
 * overwritten with null, so a step after the block reading
 * `{{steps.<first>.output...}}` sent a blank built from a step that finished.
 *
 * #3071 moved the cut-off ROW to the step that was running. This moves the
 * cut-off in `ctx.steps` to that same step: the finished step keeps its output,
 * and the running step is the one recorded as cut off.
 *
 * Driven through the real walk, with the block set as Main Flow's is
 * (wait_for all, on_timeout partial, on_child_error fail, the slot marked
 * on_failure continue) and with on_child_error continue. The slot's first step
 * is a transform, which needs no request; its second posts to a relay whose
 * answer is held, so only the block's own timer can cut it off.
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

const EXEC = 'exec-3082'
const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as SupabaseClient

const RELAY_URL = 'https://relay.example.test/hook'
const AFTER_URL = 'https://after.example.test/hook'
const BLOCK_TIMEOUT_MS = 5
const CUT_OFF_MESSAGE = `Parallel group timed out after ${BLOCK_TIMEOUT_MS}ms before this child completed`

type Deadline = NonNullable<ExecutionContext['stepDeadline']>
/** The step's own deadline never passes: only the block can cut the slot off. */
const never: Deadline = (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))

function ctx(): ExecutionContext {
  const c = buildContext({ submission_id: 'sub-3082' }, 'website_form', 'wf-3082', 'trace-3082', {}, 'org-1', EXEC)
  c.retrySleep = async () => {}
  c.stepDeadline = never
  return c
}

const edge = (source: string, target: string, source_handle?: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target, ...(source_handle ? { source_handle } : {}) })

/** The slot's first step: builds the body from the trigger, with no request. */
const bodyStep: NodeDefinition = {
  id: 'collections_body',
  namespace: 'collections_body',
  type: 'transform',
  config: { mappings: [{ source: 'trigger.payload.submission_id', target: 'lead_id' }] },
}

function post(namespace: string, url: string, body: Record<string, unknown>): NodeDefinition {
  return { id: namespace, namespace, type: 'webhook', config: { url, method: 'POST', body, retries: 0, timeout_ms: 3750 } }
}

/** The slot's second step: posts the body to a relay whose answer the test holds. */
const relayStep = post('collections_apex', RELAY_URL, { lead_id: '{{steps.collections_body.output.lead_id}}' })

/** A step after the block that reads the slot's FIRST step. */
const afterStep = post('after_post', AFTER_URL, { lead_id: '{{steps.collections_body.output.lead_id}}' })

const MAIN_FLOW_SETTINGS = { on_child_error: 'fail', on_timeout: 'partial', children: [{ id: 'child-0', on_failure: 'continue' }] }
const CONTINUE_SETTINGS = { on_child_error: 'continue', on_timeout: 'partial', children: [{ id: 'child-0' }] }

/** A block of one slot (`slot`, a chain), cut off after BLOCK_TIMEOUT_MS, then `afterStep`. */
function blockThenAfter(settings: Record<string, unknown>, slot: NodeDefinition[]) {
  const nodes: NodeDefinition[] = [
    { id: 'fan', namespace: 'fan', type: 'parallel', config: { wait_for: 'all', timeout_ms: BLOCK_TIMEOUT_MS, ...settings } },
    ...slot,
    { id: 'fan_end', namespace: 'fan_end', type: 'parallel_end', config: {} },
    afterStep,
    { id: 'done', namespace: 'done', type: 'exit', config: {} },
  ]
  const edges = [edge('fan', 'fan_end', 'output'), edge('fan', slot[0].id, 'child-0'), edge(slot[slot.length - 1].id, 'fan_end'), edge('fan_end', 'after_post'), edge('after_post', 'done')]
  slot.slice(1).forEach((n, i) => edges.push(edge(slot[i].id, n.id)))
  return { nodes, edges }
}

interface HeldCall { answer: (r: Response) => void; fail: (e: unknown) => void }

/** The relay's answer is held until the test gives it; every other request is answered at once. */
function holdRelay(fetchMock: FetchMock): HeldCall[] {
  const held: HeldCall[] = []
  fetchMock.mockImplementation((url: unknown) => {
    if (String(url) === RELAY_URL) return new Promise((resolve, reject) => { held.push({ answer: resolve, fail: reject }) })
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }))
  })
  return held
}

async function walk(c: ExecutionContext, def: { nodes: NodeDefinition[]; edges: EdgeDefinition[] }): Promise<StepLogEntry[]> {
  const queue: StepLogEntry[] = []
  await walkGraph(c, def, EXEC, '2026-10-30T12:00:00.000Z', supabase, env, 'money', 'v1', queue, () => {}).catch(() => null)
  return queue
}

/** The body the step after the block sent. */
function sentAfter(fetchMock: FetchMock): Record<string, unknown> {
  const calls = fetchMock.mock.calls.filter((call) => String(call[0]) === AFTER_URL)
  if (calls.length !== 1) throw new Error(`expected one request after the block, found ${calls.length}`)
  return JSON.parse(String((calls[0][1] as { body: string }).body)) as Record<string, unknown>
}

/** Waits until the late step has ended (its step_complete or step_error line), which is just before it would record. */
async function lateStepEnded(ns: string, event: 'step_complete' | 'step_error'): Promise<void> {
  await vi.waitFor(() => {
    const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes(`"event":"${event}"`) && line.includes(`"step_namespace":"${ns}"`))
    expect(lines.length).toBeGreaterThanOrEqual(1)
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

for (const [name, settings] of [['set as Main Flow\'s is', MAIN_FLOW_SETTINGS], ['with on_child_error continue', CONTINUE_SETTINGS]] as const) {
  describe(`a block ${name}, its slot cut off on a later step (#3082)`, () => {
    it('a step after the block sends the output of the step the slot finished, never a blank', async () => {
      const held = holdRelay(fetchMock)
      await walk(ctx(), blockThenAfter(settings, [bodyStep, relayStep]))
      expect(held).toHaveLength(1)
      expect(sentAfter(fetchMock)).toEqual({ lead_id: 'sub-3082' })
      held[0].fail(new TypeError('Network connection lost.'))
      await lateStepEnded('collections_apex', 'step_error')
    })

    it('the finished step keeps its output, and the step it was running is the one recorded as cut off', async () => {
      const held = holdRelay(fetchMock)
      const c = ctx()
      await walk(c, blockThenAfter(settings, [bodyStep, relayStep]))
      expect(c.steps.collections_body).toMatchObject({ output: { lead_id: 'sub-3082' }, status: 'completed' })
      expect(c.steps.collections_body.error).toBeUndefined()
      expect(c.steps.collections_apex).toEqual({ output: null, status: 'failed', error: CUT_OFF_MESSAGE, error_type: 'transient' })
      held[0].fail(new TypeError('Network connection lost.'))
      await lateStepEnded('collections_apex', 'step_error')
    })

    it('a late success of the step it was running changes neither record', async () => {
      const held = holdRelay(fetchMock)
      const c = ctx()
      await walk(c, blockThenAfter(settings, [bodyStep, relayStep]))
      held[0].answer(new Response('{"ok":true}', { status: 200 }))
      await lateStepEnded('collections_apex', 'step_complete')
      expect(c.steps.collections_body).toMatchObject({ output: { lead_id: 'sub-3082' }, status: 'completed' })
      expect(c.steps.collections_body.error).toBeUndefined()
      expect(c.steps.collections_apex).toEqual({ output: null, status: 'failed', error: CUT_OFF_MESSAGE, error_type: 'transient' })
    })
  })

  describe(`a block ${name}, its slot cut off on its first step`, () => {
    it('that first step is recorded as cut off, as before, so a step after the block reads nothing from it', async () => {
      const held = holdRelay(fetchMock)
      const c = ctx()
      const firstIsRelay = post('collections_body', RELAY_URL, { lead_id: '{{trigger.payload.submission_id}}' })
      await walk(c, blockThenAfter(settings, [firstIsRelay]))
      expect(c.steps.collections_body).toEqual({ output: null, status: 'failed', error: CUT_OFF_MESSAGE, error_type: 'transient' })
      expect(sentAfter(fetchMock).lead_id ?? '').toBe('')
      held[0].fail(new TypeError('Network connection lost.'))
      await lateStepEnded('collections_body', 'step_error')
    })
  })
}
