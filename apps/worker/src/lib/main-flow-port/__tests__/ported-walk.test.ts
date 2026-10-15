/**
 * A failed credit-inquiries call, walked by the real engine over the ported Main
 * Flow (#2171, the lessons review on #2197).
 *
 * docs/main-flow-relay-port.md says that once the inquiry moves after the answer,
 * a failed Apex call ends the walk: the lead is still answered, the call is made
 * once and never resent, and the branch's Achieve step does not run. This walks
 * the Tripoint win branch of the ported production definition, from its response
 * to its Achieve step, with the nodes and edges exactly as the transform builds
 * them, through the real walkGraph and the real Salesforce executor. The steps
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
const SUBMISSION = 'a0XGATE00000000001'

const env = {
  PII_REDACTION_FIELDS: '',
  WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('tok'), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
} as unknown as Env
const supabase = {} as SupabaseClient

/** The Tripoint win branch of the ported definition, its response to its Achieve step, nodes and edges as built. */
function tripointBranch() {
  const ported = portMainFlow(productionMainFlow(), PORT_STAGES.inquiry)
  const slice = ['tripoint_response', 'tripoint_sf_post', 'inquiry_body_tripoint_sf_post', 'inquiry_apex_tripoint_sf_post', 'achieve_tripoint_win']
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
    equifax_credit_report: { data: { consumers: { equifaxUSConsumerCreditReport: [{ trades: [{}], inquiries: [{ industryCode: 'BB', inquiryDate: '2026-09-01' }] }] } } },
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

async function walkWithApexAnswering(apexStatus: number) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === APEX_URL) return new Response(JSON.stringify({ message: 'money gate: refused', statusCode: apexStatus }), { status: apexStatus })
    if (url.startsWith(`${INSTANCE}/services/data/`)) return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ response: 'accepted', offers: [] }), { status: 200 })
  })
  const queue: StepLogEntry[] = []
  const answered: WalkGraphResult[] = []
  const ending = await walkGraph(contextAtTheAnswer(), tripointBranch(), 'exec-gate', '2026-10-15T12:00:00.000Z', supabase, env, 'money', 'v1', queue, (r) => { answered.push(r) })
    .then(() => null, (e: Error) => e)
  const calls = fetchMock.mock.calls.map((c) => `${(c[1] as { method?: string } | undefined)?.method ?? 'GET'} ${String(c[0])}`)
  return { ending, answered, queue, calls }
}

describe('the ported Tripoint win branch when the credit-inquiries call fails', () => {
  it('answers the lead, writes the Submission, calls the Apex endpoint once, and stops before Achieve', async () => {
    const { ending, answered, queue, calls } = await walkWithApexAnswering(500)
    expect(answered).toEqual([expect.objectContaining({ status: 200, body: { routingPartner: 2, tripointLeadId: 'TP-GATE-0001' } })])
    expect(calls).toEqual([`PATCH ${INSTANCE}/services/data/v60.0/sobjects/Submission__c/${SUBMISSION}`, `POST ${APEX_URL}`])
    expect(ending?.message).toMatch(/Salesforce API error \(500\)/)
    expect(queue.map((r) => [r.step_namespace, r.status])).toEqual([
      ['tripoint_response', 'completed'],
      ['tripoint_sf_post', 'completed'],
      ['inquiry_body_tripoint_sf_post', 'completed'],
      ['inquiry_apex_tripoint_sf_post', 'failed'],
    ])
    expect(queue.find((r) => r.step_namespace === 'inquiry_apex_tripoint_sf_post')?.retries_used).toBe(0)
  })

  it('control: when the call succeeds the walk goes on to Achieve', async () => {
    const { ending, queue, calls } = await walkWithApexAnswering(200)
    expect(calls.filter((c) => c === `POST ${APEX_URL}`)).toHaveLength(1)
    expect(queue.map((r) => r.step_namespace)).toContain('achieve_tripoint_win')
    expect(ending === null || !/inquiry/.test(ending.message)).toBe(true)
  })
})
