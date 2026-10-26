/**
 * A failed credit post, walked by the real engine over the ported Main Flow
 * (#2171, the lessons review on #2197, then #2832).
 *
 * docs/main-flow-relay-port.md says that once the inquiry moves after the answer,
 * a failed inquiry call ends the walk: the lead is still answered, the call is
 * made once and never resent, and the branch's Achieve step does not run. A
 * failed collections call, beside it in the same block, is recorded for the
 * failure alert and the walk goes on to Achieve. This walks the Tripoint win
 * branch of the ported production definition, from its response to its Achieve
 * step, with the nodes and edges exactly as the transform builds them, through
 * the real walkGraph and the real Salesforce executor. The steps
 * before the answer are given as context, and the inquiry body code node runs its
 * real script in place of the sandbox dispatch (canvas-script.ts builds the same
 * function the deployer does). Only fetch is a recorder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../../index'
import type { EdgeDefinition, NodeDefinition } from '../../../types'
import type { StepLogEntry } from '../../../engine/step-logger'
import { stubFetch, type FetchMock } from '../../../__tests__/helpers/fetch-mock'
import { runCanvasScript } from '../../../engine/scripts/__tests__/canvas-script'

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
import { PORT_STAGES, portMainFlow } from '../transform'
import { productionMainFlow } from './production-fixture'

const INSTANCE = 'https://example.my.salesforce.com'
const APEX_URL = `${INSTANCE}/services/apexrest/credit-inquiries`
const COLLECTIONS_URL = `${INSTANCE}/services/apexrest/credit-collections`
const SUBMISSION = 'a0XGATE00000000001'

const env = {
  PII_REDACTION_FIELDS: '',
  WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('tok'), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
} as unknown as Env
const supabase = {} as SupabaseClient

/** The Tripoint win branch of the ported definition, its response to its Achieve step, nodes and edges as built. */
function tripointBranch() {
  const ported = portMainFlow(productionMainFlow(), PORT_STAGES.collections)
  const slice = [
    'tripoint_response', 'tripoint_sf_post', 'credit_posts_tripoint_sf_post', 'inquiry_body_tripoint_sf_post', 'inquiry_apex_tripoint_sf_post',
    'collections_body_tripoint_sf_post', 'collections_apex_tripoint_sf_post', 'credit_posts_end_tripoint_sf_post', 'achieve_tripoint_win',
  ]
  const nodes = ported.nodes.filter((n) => slice.includes(n.namespace)) as unknown as NodeDefinition[]
  expect(nodes.map((n) => n.namespace).sort()).toEqual([...slice].sort())
  const ids = new Set(nodes.map((n) => n.id))
  const edges = ported.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) as EdgeDefinition[]
  return { nodes, edges }
}

/** Where the walk stands after the bid race: a Tripoint win on the trades present route, with inquiries on the report. */
function contextAtTheAnswer() {
  const ctx = buildContext({ Submission__c: SUBMISSION }, 'mainflow', 'wf-gate', 'trace-gate', {
    SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret', SALESFORCE_INSTANCE_URL: INSTANCE,
  }, 'org-gate', 'exec-gate', 'https://app.example.test')
  ctx.retrySleep = async () => {}
  const steps: Record<string, unknown> = {
    equifax_debt: { matched_branch: 'trades_present', _route: 'trades_present' },
    equifax_credit_report: { data: { consumers: { equifaxUSConsumerCreditReport: [{ trades: [{}], inquiries: [{ industryCode: 'BB', inquiryDate: '2026-09-01' }], collections: [{ industryCode: 'YC', balance: 412 }] }] } } },
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

async function walkWithAnswers(inquiryStatus: number, collectionsStatus = 200) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === APEX_URL) return new Response(JSON.stringify({ message: 'money gate: inquiry answer', statusCode: inquiryStatus }), { status: inquiryStatus })
    if (url === COLLECTIONS_URL) return new Response(JSON.stringify({ message: 'money gate: collections answer', statusCode: collectionsStatus }), { status: collectionsStatus })
    if (url.startsWith(`${INSTANCE}/services/data/`)) return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ response: 'accepted', offers: [] }), { status: 200 })
  })
  const queue: StepLogEntry[] = []
  const answered: WalkGraphResult[] = []
  const ctx = contextAtTheAnswer()
  const ending = await walkGraph(ctx, tripointBranch(), 'exec-gate', '2026-10-15T12:00:00.000Z', supabase, env, 'money', 'v1', queue, (r) => { answered.push(r) })
    .then(() => null, (e: Error) => e)
  const calls = fetchMock.mock.calls.map((c) => `${(c[1] as { method?: string } | undefined)?.method ?? 'GET'} ${String(c[0])}`)
  const statusOf = (ns: string) => queue.find((r) => r.step_namespace === ns)?.status
  return { ending, answered, queue, calls, statusOf, continued: (ctx.continuedFailures ?? []) as Array<Error & { stepNamespace?: string }> }
}

describe('the ported Tripoint win branch when the credit-inquiries call fails', () => {
  it('answers the lead, writes the Submission, calls each Apex endpoint once, and stops before Achieve', async () => {
    const { ending, answered, queue, calls, statusOf } = await walkWithAnswers(500)
    expect(answered).toEqual([expect.objectContaining({ status: 200, body: { routingPartner: 2, tripointLeadId: 'TP-GATE-0001' } })])
    expect(calls[0]).toBe(`PATCH ${INSTANCE}/services/data/v60.0/sobjects/Submission__c/${SUBMISSION}`)
    expect(calls.slice(1).sort()).toEqual([`POST ${APEX_URL}`, `POST ${COLLECTIONS_URL}`].sort())
    expect(ending?.message).toMatch(/Parallel failed: child "inquiry_body_tripoint_sf_post" failed: Salesforce API error \(500\)/)
    expect({
      inquiry: statusOf('inquiry_apex_tripoint_sf_post'), collections: statusOf('collections_apex_tripoint_sf_post'), block: statusOf('credit_posts_tripoint_sf_post'), achieve: statusOf('achieve_tripoint_win'),
    }).toEqual({ inquiry: 'failed', collections: 'completed', block: 'failed', achieve: undefined })
    expect(queue.find((r) => r.step_namespace === 'inquiry_apex_tripoint_sf_post')?.retries_used).toBe(0)
  })

  it('control: when both calls succeed the walk goes on to Achieve', async () => {
    const { ending, calls, statusOf, continued } = await walkWithAnswers(200)
    expect(calls.filter((c) => c === `POST ${APEX_URL}`)).toHaveLength(1)
    expect(calls.filter((c) => c === `POST ${COLLECTIONS_URL}`)).toHaveLength(1)
    expect(statusOf('achieve_tripoint_win')).toBeDefined()
    expect(ending === null || !/inquiry|collections/.test(ending.message)).toBe(true)
    expect(continued).toEqual([])
  })
})

describe('the ported Tripoint win branch when the credit-collections call fails (#2832)', () => {
  it('records the failed call for the failure alert, once, and the walk still goes on to Achieve', async () => {
    const { ending, calls, statusOf, continued, queue } = await walkWithAnswers(200, 500)
    expect(calls.filter((c) => c === `POST ${COLLECTIONS_URL}`)).toHaveLength(1)
    expect({ collections: statusOf('collections_apex_tripoint_sf_post'), block: statusOf('credit_posts_tripoint_sf_post') }).toEqual({ collections: 'failed', block: 'completed' })
    expect(statusOf('achieve_tripoint_win')).toBeDefined()
    expect(ending === null || !/collections/.test(ending.message)).toBe(true)
    expect(continued.map((f) => [f.stepNamespace, f.message])).toEqual([['collections_apex_tripoint_sf_post', expect.stringMatching(/Salesforce API error \(500\)/)]])
    expect(queue.find((r) => r.step_namespace === 'collections_apex_tripoint_sf_post')?.retries_used).toBe(0)
  })
})
