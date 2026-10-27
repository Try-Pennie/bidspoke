/**
 * The credit posts, walked by the real engine over the ported Main Flow (#2171,
 * the lessons review on #2197, then #2832).
 *
 * After the answer: docs/main-flow-relay-port.md says that once the inquiry moves
 * after the answer, a failed inquiry call ends the walk: the lead is still
 * answered, the call is made once and never resent, and the branch's Achieve step
 * does not run. This walks the Tripoint win branch of the ported production
 * definition, from its response to its Achieve step.
 *
 * Before the answer: the collections post (#2832) is a slot of parallel_1 marked
 * on_failure: 'continue'. Over live Main Flow (the money gate's version 175) with
 * the collections stage applied, this walks parallel_1 and its three slots (the
 * trades chain, the inquiry relay, the collections pair) into its join and on to
 * an answer: the lead is answered whether the collections call succeeds, fails or
 * times out; a failed or timed out call is left for finalize to raise (the
 * engine's own test of that, post-response-budget-engine.test.ts, "a failed
 * marked slot of a parallel block BEFORE the answer", proves it is degraded and
 * dead lettered); the other slots run as they do today; and a failed trades chain
 * still fails the run before any answer.
 *
 * Nodes and edges are exactly as the transform builds them, through the real
 * walkGraph and the real Salesforce and webhook executors. The steps before are
 * given as context, and each code node runs its real script in place of the
 * sandbox dispatch (canvas-script.ts builds the same function the deployer does).
 * Only fetch is a recorder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../../index'
import type { EdgeDefinition, NodeDefinition } from '../../../types'
import type { StepLogEntry } from '../../../engine/step-logger'
import { stubFetch, type FetchMock } from '../../../__tests__/helpers/fetch-mock'
import { fakeBulkheads } from '../../../__tests__/helpers/fake-bulkheads'
import { SALESFORCE_BULKHEAD_KEY, SALESFORCE_COLLECTIONS_BULKHEAD_KEY, SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT } from '../../bulkhead-client'
import { runCanvasScript } from '../../../engine/scripts/__tests__/canvas-script'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import GATE_MAIN_FLOW_RAW from '../../../../money-gate/fixtures/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json?raw'

vi.mock('../../../engine/step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))

// The sandbox dispatch stands in as the script itself, run on the steps the
// engine holds; everything else in the code node module is the real one.
vi.mock('../../../engine/nodes/code', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../engine/nodes/code')>()
  return {
    ...real,
    executeCodeNode: async (node: NodeDefinition, ctx: { trigger: { payload: unknown }; steps: Record<string, { output: unknown } | undefined>; env: Record<string, unknown>; execution: Record<string, unknown> }) => ({
      output: await runCanvasScript(String(node.config.script), { payload: ctx.trigger.payload, steps: ctx.steps, env: ctx.env, execution: ctx.execution }),
    }),
  }
})

import { walkGraph, type WalkGraphResult } from '../../../engine/index'
import { buildContext } from '../../../engine/context'
import { COLLECTIONS_APEX, COLLECTIONS_BODY, PORT_STAGES, portMainFlow, type Definition, type PortOptions } from '../transform'
import { productionMainFlow } from './production-fixture'

const INSTANCE = 'https://example.my.salesforce.com'
const APEX_URL = `${INSTANCE}/services/apexrest/credit-inquiries`
const COLLECTIONS_URL = `${INSTANCE}/services/apexrest/credit-collections`
const TRADES_URL = `${INSTANCE}/services/apexrest/credit-trades`
const SUBMISSION = 'a0XGATE00000000001'
const FULL: PortOptions = { posts: 'all', moveInquiry: true, collections: true }

const env = {
  PII_REDACTION_FIELDS: '',
  WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('tok'), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
} as unknown as Env
const supabase = {} as SupabaseClient

/** The nodes named and every edge between them, as built. */
function slice(def: Definition, namespaces: string[]) {
  const nodes = def.nodes.filter((n) => namespaces.includes(n.namespace)) as unknown as NodeDefinition[]
  expect(nodes.map((n) => n.namespace).sort()).toEqual([...namespaces].sort())
  const ids = new Set(nodes.map((n) => n.id))
  const edges = def.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) as EdgeDefinition[]
  return { nodes, edges }
}

/** Where the walk stands: a Tripoint win on the trades present route, with inquiries and collections on the report. */
function context() {
  const ctx = buildContext({ Submission__c: SUBMISSION }, 'mainflow', 'wf-gate', 'trace-gate', {
    SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret', SALESFORCE_INSTANCE_URL: INSTANCE,
  }, 'org-gate', 'exec-gate', 'https://app.example.test')
  ctx.retrySleep = async () => {}
  const steps: Record<string, unknown> = {
    equifax_debt: { matched_branch: 'trades_present', _route: 'trades_present' },
    equifax_credit_report: { data: { consumers: { equifaxUSConsumerCreditReport: [{ trades: [{ industryCode: 'BC', balance: 5000 }], inquiries: [{ industryCode: 'BB', inquiryDate: '2026-09-01' }], collections: [{ industryCode: 'YC', balance: 412, accountNumber: '9988776655' }] }] } } },
    tripoint_win_body: {
      clientBody: { routingPartner: 2, tripointLeadId: 'TP-GATE-0001' },
      sfBody: { submissionId: SUBMISSION, executionId: 'exec-gate', External_Partner_Name__c: 'Tripoint', External_Routing_Code__c: 2, Tripoint_Response__c: 'Success' },
    },
  }
  for (const [ns, output] of Object.entries(steps)) ctx.steps[ns] = { output } as never
  return ctx
}

let fetchMock: FetchMock
beforeEach(() => {
  fetchMock = stubFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Answer = number | 'hang'
const answer = (status: Answer, message: string, url: string, init?: { signal?: AbortSignal }) =>
  status === 'hang'
    ? new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error(`aborted ${url}`), { name: 'AbortError' }))))
    : Promise.resolve(new Response(JSON.stringify({ message, statusCode: status }), { status }))

async function walk(graph: { nodes: NodeDefinition[]; edges: EdgeDefinition[] }, answers: { inquiry?: Answer; collections?: Answer; trades?: Answer }, envExtra: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (url: string, init?: { signal?: AbortSignal }) => {
    if (url === APEX_URL) return answer(answers.inquiry ?? 200, 'money gate: inquiry answer', url, init)
    if (url === COLLECTIONS_URL) return answer(answers.collections ?? 200, 'money gate: collections answer', url, init)
    if (url === TRADES_URL) {
      const status = answers.trades ?? 200
      if (status !== 200) return answer(status, 'money gate: trades answer', url, init)
      return new Response(JSON.stringify({ pennieLeadCalculations: [{ EngineDebt__c: 12000, BESOverwrite__c: false, EnrolledPennieDebt__c: 11000 }] }), { status: 200 })
    }
    if (url.startsWith(`${INSTANCE}/services/data/`)) return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ response: 'accepted', offers: [] }), { status: 200 })
  })
  const queue: StepLogEntry[] = []
  const answered: WalkGraphResult[] = []
  const ctx = context()
  const ending = await walkGraph(ctx, graph, 'exec-gate', '2026-10-27T12:00:00.000Z', supabase, { ...env, ...envExtra } as Env, 'money', 'v1', queue, (r) => { answered.push(r) })
    .then(() => null, (e: Error) => e)
  const calls = fetchMock.mock.calls.map((c) => `${(c[1] as { method?: string } | undefined)?.method ?? 'GET'} ${String(c[0])}`)
  const statusOf = (ns: string) => queue.find((r) => r.step_namespace === ns)?.status
  return { ending, answered, queue, calls, statusOf, continued: (ctx.continuedFailures ?? []) as Array<Error & { stepNamespace?: string }> }
}

describe('after the answer: the ported Tripoint win branch and its inquiry post', () => {
  const branch = () => slice(portMainFlow(productionMainFlow(), FULL), [
    'tripoint_response', 'tripoint_sf_post', 'inquiry_body_tripoint_sf_post', 'inquiry_apex_tripoint_sf_post', 'achieve_tripoint_win',
  ])

  it('the inquiry call failing: answers the lead, writes the Submission, calls credit-inquiries once, and stops before Achieve', async () => {
    const { ending, answered, queue, calls, statusOf } = await walk(branch(), { inquiry: 500 })
    expect(answered).toEqual([expect.objectContaining({ status: 200, body: { routingPartner: 2, tripointLeadId: 'TP-GATE-0001' } })])
    expect(calls).toEqual([`PATCH ${INSTANCE}/services/data/v60.0/sobjects/Submission__c/${SUBMISSION}`, `POST ${APEX_URL}`])
    expect(ending?.message).toMatch(/Salesforce API error \(500\)/)
    expect({ inquiry: statusOf('inquiry_apex_tripoint_sf_post'), achieve: statusOf('achieve_tripoint_win') }).toEqual({ inquiry: 'failed', achieve: undefined })
    expect(queue.find((r) => r.step_namespace === 'inquiry_apex_tripoint_sf_post')?.retries_used).toBe(0)
  })

  it('control: when the inquiry call succeeds the walk goes on to Achieve', async () => {
    const { ending, calls, statusOf } = await walk(branch(), { inquiry: 200 })
    expect(calls.filter((c) => c === `POST ${APEX_URL}`)).toHaveLength(1)
    expect(calls.filter((c) => c === `POST ${COLLECTIONS_URL}`)).toEqual([])
    expect(statusOf('achieve_tripoint_win')).toBeDefined()
    expect(ending === null || !/inquiry/.test(ending.message)).toBe(true)
  })
})

describe('before the answer: parallel_1 with the collections slot, over live Main Flow (#2832)', () => {
  /** parallel_1, its three slots and its join, from live Main Flow with the collections stage applied, then an answer. */
  function block(collectionsTimeoutMs?: number) {
    const live = (JSON.parse(GATE_MAIN_FLOW_RAW as string) as { definition: Definition }).definition
    const withSlot = portMainFlow(live, PORT_STAGES.collections)
    const graph = slice(withSlot, [
      'parallel_1', 'trades_body', 'trades_request', 'pennie_debt_calculation', 'send_salesforce_inquiry', COLLECTIONS_BODY, COLLECTIONS_APEX, 'parallel_end_1', 'tripoint_response',
    ])
    // What follows parallel_end_1 today (equifax_debt_end and the bid race) is not
    // changed by the stage; one of Main Flow's own answers stands in for it.
    const end = graph.nodes.find((n) => n.namespace === 'parallel_end_1')!
    const respond = graph.nodes.find((n) => n.namespace === 'tripoint_response')!
    graph.edges.push({ id: 'stand-in', source: end.id, target: respond.id, source_handle: 'output' } as EdgeDefinition)
    // The timeout case is walked at a short timeout; the 4.5 s itself is held by transform.test.ts.
    if (collectionsTimeoutMs !== undefined) {
      const apex = graph.nodes.find((n) => n.namespace === COLLECTIONS_APEX)!
      apex.config = { ...apex.config, timeout_ms: collectionsTimeoutMs }
    }
    return graph
  }
  const RELAY = `POST https://eo7mbko7xf69i3x.m.pipedream.net`

  it('the collections call succeeding: every slot completes, the lead is answered, nothing is left to raise', async () => {
    const { ending, answered, calls, statusOf, continued } = await walk(block(), {})
    expect(ending).toBeNull()
    expect(answered).toEqual([expect.objectContaining({ status: 200, body: { routingPartner: 2, tripointLeadId: 'TP-GATE-0001' } })])
    expect(calls.sort()).toEqual([`POST ${COLLECTIONS_URL}`, `POST ${TRADES_URL}`, RELAY].sort())
    expect({ trades: statusOf('pennie_debt_calculation'), inquiry: statusOf('send_salesforce_inquiry'), collections: statusOf(COLLECTIONS_APEX), block: statusOf('parallel_1') })
      .toEqual({ trades: 'completed', inquiry: 'completed', collections: 'completed', block: 'completed' })
    expect(continued).toEqual([])
  })

  it('sends the lead\'s collections whole, with collectionsJSON, beside the trades call', async () => {
    await walk(block(), {})
    const sent = fetchMock.mock.calls.find((c) => String(c[0]) === COLLECTIONS_URL)!
    expect(JSON.parse((sent[1] as { body: string }).body)).toEqual({
      submissionId: SUBMISSION,
      collectionsJSON: JSON.stringify({ collections: [{ industryCode: 'YC', balance: 412, accountNumber: '9988776655' }] }),
    })
  })

  it.each([
    ['fails', 500 as Answer, /Salesforce API error \(500\)/, undefined],
    ['times out', 'hang' as Answer, /timed out/i, 50],
  ] as const)('the collections call %s: called once, the lead still answered, the other slots unaffected, the failure left for finalize to raise', async (_how, collections, message, timeoutMs) => {
    const { ending, answered, calls, statusOf, continued, queue } = await walk(block(timeoutMs), { collections })
    expect(ending).toBeNull()
    expect(answered).toEqual([expect.objectContaining({ status: 200, body: { routingPartner: 2, tripointLeadId: 'TP-GATE-0001' } })])
    expect(calls.filter((c) => c === `POST ${COLLECTIONS_URL}`)).toHaveLength(1)
    expect(calls.filter((c) => c === `POST ${TRADES_URL}`)).toHaveLength(1)
    expect(calls.filter((c) => c === RELAY)).toHaveLength(1)
    expect({ trades: statusOf('pennie_debt_calculation'), inquiry: statusOf('send_salesforce_inquiry'), collections: statusOf(COLLECTIONS_APEX), block: statusOf('parallel_1') })
      .toEqual({ trades: 'completed', inquiry: 'completed', collections: 'failed', block: 'completed' })
    expect(continued.map((f) => f.stepNamespace)).toEqual([COLLECTIONS_APEX])
    expect(continued[0].message).toMatch(message)
    expect(queue.find((r) => r.step_namespace === COLLECTIONS_APEX)?.retries_used).toBe(0)
  })

  // #2847: on a Salesforce slowdown the collections share fills first. A shed
  // collections call fails its step like any shed; the slot's mark keeps the lead
  // answered, and the failure is left for finalize to raise (degraded, dead
  // lettered: post-response-budget-engine.test.ts proves that for a shed too).
  it('the collections share full: the collections call is shed without reaching Salesforce, the trades call still gets its main slot, and the lead is answered', async () => {
    const fake = fakeBulkheads({ seed: { [SALESFORCE_COLLECTIONS_BULKHEAD_KEY]: SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT } })
    // No real waiting here; the wait itself is held by salesforce-collections-bulkhead.test.ts.
    const { ending, answered, calls, statusOf, continued, queue } = await walk(block(), {}, { SALESFORCE_BULKHEAD: fake.namespace, SALESFORCE_BULKHEAD_WAIT_MS: '0' })
    expect(ending).toBeNull()
    expect(answered).toEqual([expect.objectContaining({ status: 200, body: { routingPartner: 2, tripointLeadId: 'TP-GATE-0001' } })])
    expect(calls.filter((c) => c === `POST ${COLLECTIONS_URL}`)).toEqual([])
    expect(calls.filter((c) => c === `POST ${TRADES_URL}`)).toHaveLength(1)
    expect({ trades: statusOf('pennie_debt_calculation'), collections: statusOf(COLLECTIONS_APEX), block: statusOf('parallel_1') })
      .toEqual({ trades: 'completed', collections: 'failed', block: 'completed' })
    expect(continued.map((f) => f.stepNamespace)).toEqual([COLLECTIONS_APEX])
    expect(continued[0].message).toMatch(new RegExp(`Salesforce bulkhead: at capacity \\(${SALESFORCE_COLLECTIONS_BULKHEAD_KEY}`))
    expect(queue.find((r) => r.step_namespace === COLLECTIONS_APEX)?.retries_used).toBe(0)
    // Only the trades call held a main slot, and it handed it back.
    expect(fake.acquires.filter((k) => k === SALESFORCE_BULKHEAD_KEY)).toHaveLength(1)
    expect(fake.inflight(SALESFORCE_BULKHEAD_KEY)).toBe(0)
  })

  it('the trades call failing still fails the block and the run before any answer, as today, the collections call made once all the same', async () => {
    const { ending, answered, calls, statusOf, continued } = await walk(block(), { trades: 500 })
    expect(answered).toEqual([])
    expect(ending?.message).toMatch(/Parallel failed: child "trades_body" failed/)
    expect(statusOf('parallel_1')).toBe('failed')
    expect(statusOf(COLLECTIONS_APEX)).toBe('completed')
    expect(calls.filter((c) => c === `POST ${COLLECTIONS_URL}`)).toHaveLength(1)
    expect(continued).toEqual([])
  })
})
