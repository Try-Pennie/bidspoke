/**
 * The phase 5 canary of #1680 (#2174): `send_salesforce`, the busiest outcome
 * post and a JSON text body, ported on its own over the LIVE Main Flow.
 *
 * transform.test.ts proves the transform on version 169, the definition the
 * port started from. The stage Dan applies runs on whatever the canvas holds at
 * the apply, so these run it on the money gate's Main Flow, which the runbook's
 * step 5 refreshes from production after every save (version 174 on
 * 2026-10-26, read back from workflow_versions that day: the live version). A
 * canvas edit that would make the apply refuse, or port more than the one post,
 * fails here on the next fixture refresh rather than in Dan's tab.
 *
 * Then the ported post is walked by the real engine over its branch as built
 * (the answer, calculate_internal_debt, the write, exit_1), and every way the
 * write can fail is held to what phase 4's `invalid_state_sf_post` does with the
 * same answer, walked the same way: the canary passed on that behaviour, so this
 * one must not differ from it. Only fetch is a recorder, and the code node runs
 * its real script in place of the sandbox dispatch, as in ported-walk.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findSalesforceConfigProblems, findWorkflowCycle, validateDefinitionReferences, validateWorkflowDef } from '@bidspoke/workflow-definition'
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

vi.mock('../../../engine/nodes/code', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../engine/nodes/code')>()
  return {
    ...real,
    executeCodeNode: async (node: NodeDefinition, ctx: { trigger: { payload: unknown }; steps: Record<string, { output: unknown } | undefined>; env: Record<string, unknown>; execution: Record<string, unknown> }) => ({
      output: await runCanvasScript(String(node.config.script), { payload: ctx.trigger.payload, steps: ctx.steps, env: ctx.env, execution: ctx.execution }),
    }),
  }
})

import { walkGraph } from '../../../engine/index'
import { buildContext } from '../../../engine/context'
import { CONTINUATION_WINDOW_MS } from '../../post-response-budget'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import GATE_MAIN_FLOW_RAW from '../../../../money-gate/fixtures/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json?raw'
import { MAIN_FLOW_WORKFLOW_ID, OUTCOME_POSTS, OUTCOME_WRITE_TIMEOUT_MS, PORT_STAGES, portMainFlow, portStatus, sameJson, type Definition } from '../transform'
import { nextOf, nodeByNamespace } from './production-fixture'

const gate = JSON.parse(GATE_MAIN_FLOW_RAW as string) as { id: string; definition: Definition }
const live = (): Definition => structuredClone(gate.definition)
const canary = (): Definition => portMainFlow(live(), PORT_STAGES.canary_send_salesforce)

describe('the send_salesforce canary stage over the live Main Flow', () => {
  it('starts from the live state: invalid_state_sf_post native, the other eight on the relay', () => {
    expect(gate.id).toBe(MAIN_FLOW_WORKFLOW_ID)
    expect(portStatus(live())).toEqual({ ported: ['invalid_state_sf_post'], relay: OUTCOME_POSTS.filter((p) => p !== 'invalid_state_sf_post'), inquiryMoved: false })
  })

  it('ports send_salesforce and nothing else: no node added or removed, the inquiry relay left where it is', () => {
    const before = live()
    const after = canary()
    expect(portStatus(after)).toEqual({
      ported: ['send_salesforce', 'invalid_state_sf_post'],
      relay: OUTCOME_POSTS.filter((p) => p !== 'invalid_state_sf_post' && p !== 'send_salesforce'),
      inquiryMoved: false,
    })
    expect(after.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort())
    expect(after.edges).toEqual(before.edges)
    expect(after.trigger).toEqual(before.trigger)
    const changed = after.nodes.filter((n) => !sameJson(n, before.nodes.find((b) => b.id === n.id))).map((n) => n.namespace)
    expect(changed).toEqual(['send_salesforce'])
    expect(nodeByNamespace(after, 'send_salesforce_inquiry').type).toBe('webhook')
  })

  it('keeps the text body exactly, takes the record id from the template its submissionId key holds, and still goes on to exit_1', () => {
    const before = nodeByNamespace(live(), 'send_salesforce')
    const after = nodeByNamespace(canary(), 'send_salesforce')
    expect(typeof after.config.body).toBe('string')
    expect(after.config.body).toBe(before.config.body)
    // Where the relay read the record id: the body's own submissionId.
    expect(after.config.body).toMatch(/"submissionId":\s*"\{\{trigger\.payload\.Submission__c\}\}"/)
    expect({ id: after.id, label: after.label, position: after.position }).toEqual({ id: before.id, label: before.label, position: before.position })
    expect(after.config).toMatchObject({
      operation: 'update',
      object: 'Submission__c',
      record_id: '{{trigger.payload.Submission__c}}',
      omit_fields: ['executionId', 'submissionId'],
      rename_fields: { UUID: 'Engine_UUID_SO__c', leadUUID: 'Engine_Lead_UUID_SO__c' },
      injected_fields: { PDFlow_4__c: '{{execution.bidspoke_link}}' },
      skip_when_empty: true,
      retries: 0,
      timeout_ms: OUTCOME_WRITE_TIMEOUT_MS,
    })
    expect(nextOf(canary(), 'send_salesforce')).toEqual(['output:exit_1'])
  })

  it('has the same write settings as the invalid state post the first canary passed on, apart from its body and record id', () => {
    const settings = (ns: string) => {
      const { body: _b, record_id: _r, ...rest } = nodeByNamespace(canary(), ns).config
      return rest
    }
    expect(settings('send_salesforce')).toEqual(settings('invalid_state_sf_post'))
  })

  it('applying it again changes nothing', () => {
    const once = canary()
    expect(portMainFlow(once, PORT_STAGES.canary_send_salesforce)).toEqual(once)
  })

  it('passes the save route and adds no canvas validation problem', () => {
    const before = live()
    const after = canary()
    expect(findWorkflowCycle(after.nodes, after.edges)).toBeNull()
    expect(findSalesforceConfigProblems(after.nodes)).toEqual([])
    const key = (p: { namespace?: string; message: string }) => `${p.namespace}: ${p.message}`
    const baseConfig = new Set(validateWorkflowDef(before.nodes, before.edges).map(key))
    expect(validateWorkflowDef(after.nodes, after.edges).map(key).filter((k) => !baseConfig.has(k))).toEqual([])
    const baseRefs = new Set(validateDefinitionReferences(before.nodes, before.edges).map(key))
    expect(validateDefinitionReferences(after.nodes, after.edges).map(key).filter((k) => !baseRefs.has(k))).toEqual([])
  })

  it('the worst case from the answer to the end of the write fits the 12 s window', () => {
    // calculate_internal_debt: three 150 ms attempts and 1.5 s of backoff; the write: one 4.5 s attempt.
    const debt = nodeByNamespace(canary(), 'calculate_internal_debt').config
    expect({ retries: debt.retries, timeout_ms: debt.timeout_ms }).toEqual({ retries: 2, timeout_ms: 150 })
    const worst = 3 * 150 + 500 + 1000 + OUTCOME_WRITE_TIMEOUT_MS
    expect(worst).toBe(6_450)
    expect(worst).toBeLessThanOrEqual(CONTINUATION_WINDOW_MS)
  })
})

// ── Walked by the real engine ──

const INSTANCE = 'https://example.my.salesforce.com'
const SUBMISSION = 'a0XGATE00000000001'
const PATCH_URL = `${INSTANCE}/services/data/v60.0/sobjects/Submission__c/${SUBMISSION}`

const env = {
  PII_REDACTION_FIELDS: '',
  WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('tok'), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
} as unknown as Env
const supabase = {} as SupabaseClient

type Branch = 'send_salesforce' | 'invalid_state_sf_post'

/** Each branch from its answer, as the canary stage builds it, up to the step after the write (left out, so the walk ends there). */
const SLICES: Record<Branch, string[]> = {
  send_salesforce: ['return_response_20k', 'calculate_internal_debt', 'send_salesforce', 'exit_1'],
  invalid_state_sf_post: ['invalid_state_response', 'invalid_state_sf_post'],
}

function branch(post: Branch, writeTimeoutMs?: number) {
  const def = canary()
  const nodes = def.nodes.filter((n) => SLICES[post].includes(n.namespace)).map((n) => structuredClone(n)) as unknown as NodeDefinition[]
  expect(nodes.map((n) => n.namespace).sort()).toEqual([...SLICES[post]].sort())
  if (writeTimeoutMs !== undefined) {
    const write = nodes.find((n) => n.namespace === post)!
    write.config = { ...write.config, timeout_ms: writeTimeoutMs }
  }
  const ids = new Set(nodes.map((n) => n.id))
  return { nodes, edges: def.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) as EdgeDefinition[] }
}

/** Where each branch stands at its answer. The send_salesforce inputs are the relay parity fixture's common shape. */
function contextAt(post: Branch) {
  const ctx = buildContext({ Submission__c: SUBMISSION, LEG: 0 }, 'mainflow', 'wf-gate', 'trace-gate', {
    SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret', SALESFORCE_INSTANCE_URL: INSTANCE,
  }, 'org-gate', 'exec-gate', 'https://app.example.test')
  ctx.retrySleep = async () => {}
  const steps: Record<string, unknown> =
    post === 'send_salesforce'
      ? {
          mutate_adv: 2,
          mutate_bes: 3,
          gen_vantage_score: 702,
          calculate_pull_result_no_debt: { equifaxPull: 'Success', creditFreeze: false },
          timestamps: { completedDate: '2026-10-15T12:00:05', submissionDate: '2026-10-15T12:00:00' },
          pennie_or_eligibility: { equifax: 25000, eligibility: 0, final: 25000 },
        }
      : {
          fallback_invalid_state: {
            clientBody: { accepted: false },
            sfBody: { submissionId: SUBMISSION, executionId: 'exec-gate', ADV_SO__c: 2, External_Partner_Name__c: 'Engine', UUID: 'engine-gate-uuid', leadUUID: 'engine-gate-lead' },
          },
        }
  for (const [ns, output] of Object.entries(steps)) ctx.steps[ns] = { output } as never
  return ctx
}

let fetchMock: FetchMock
beforeEach(() => {
  fetchMock = stubFetch()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type SalesforceAnswer = { status: number; body?: unknown } | 'never'

/** What Salesforce does with the PATCH, and every way the write ends up, from the step row the engine records. */
const ANSWERS: Record<string, SalesforceAnswer> = {
  landed: { status: 204 },
  'refused by a validation rule (400)': { status: 400, body: [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'refused', fields: [] }] },
  'a field it does not accept (400)': { status: 400, body: [{ errorCode: 'INVALID_FIELD', message: 'No such column', fields: [] }] },
  'record locked (400)': { status: 400, body: [{ errorCode: 'UNABLE_TO_LOCK_ROW', message: 'unable to obtain exclusive access to this record', fields: [] }] },
  'login refused (401)': { status: 401, body: [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }] },
  'server error (500)': { status: 500, body: [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'An unexpected error occurred' }] },
  'too many concurrent requests (403)': { status: 403, body: [{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'ConcurrentPerOrgLongTxn Limit exceeded' }] },
  'unavailable (503)': { status: 503, body: [{ errorCode: 'SERVER_UNAVAILABLE', message: 'unavailable' }] },
  'sent, then no answer before the step timeout': 'never',
}

async function walk(post: Branch, answer: SalesforceAnswer) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith(`${INSTANCE}/services/data/`)) {
      if (answer === 'never') return new Promise<Response>(() => {})
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status })
    }
    if (url.endsWith('/services/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok2', instance_url: INSTANCE }), { status: 200 })
    throw new Error(`unexpected call to ${url}`)
  })
  const queue: StepLogEntry[] = []
  const answered: unknown[] = []
  // A step timeout of 25 ms stands in for the 4.5 s one, so nothing waits (L524).
  const ending = await walkGraph(contextAt(post), branch(post, answer === 'never' ? 25 : undefined), 'exec-gate', '2026-10-15T12:00:00.000Z', supabase, env, 'money', 'v1', queue, (r) => { answered.push(r) })
    .then(() => null, (e: Error) => e)
  const writeCalls = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(`${INSTANCE}/services/data/`))
  const row = queue.find((r) => r.step_namespace === post)
  const firstBody = (writeCalls[0]?.[1] as { body?: string } | undefined)?.body
  return {
    answered: answered.length,
    ending,
    writeCalls: writeCalls.map((c) => `${(c[1] as { method?: string }).method} ${String(c[0])}`),
    sent: firstBody ? (JSON.parse(firstBody) as Record<string, unknown>) : null,
    row,
    steps: queue.map((r) => r.step_namespace),
  }
}

/** The parts of a write's outcome the two posts must share: what a reader of the run, or the read-back, sees. */
const outcomeOf = (w: Awaited<ReturnType<typeof walk>>) => ({
  answered: w.answered,
  patches: w.writeCalls.length,
  status: w.row?.status,
  retries_used: w.row?.retries_used,
  error: (w.row?.error_message ?? null)?.replace(/Submission__c\/[A-Za-z0-9]+/g, 'Submission__c/<id>') ?? null,
  walk_failed: w.ending !== null,
})

describe('the ported send_salesforce walked by the real engine', () => {
  it('answers the lead, PATCHes the Submission once with the rendered text body, and goes on to exit_1', async () => {
    const w = await walk('send_salesforce', { status: 204 })
    expect(w.answered).toBe(1)
    expect(w.writeCalls).toEqual([`PATCH ${PATCH_URL}`])
    expect(w.row?.status).toBe('completed')
    expect(w.steps).toEqual(['return_response_20k', 'calculate_internal_debt', 'send_salesforce', 'exit_1'])
    expect(w.sent).toMatchObject({
      ADV_SO__c: '2',
      XBC_SO__c: '230',
      VantageScore__c: '702',
      InternalDebtRouting__c: '25000',
      EQXCreditPullStatus__c: 'Success',
      Credit_Pull_Result_ES__c: '',
      CreditFreeze__c: false,
      PDFlow_1__c: 'https://app.example.test/workflows/wf-gate?execution=exec-gate',
      PDFlow_4__c: 'https://app.example.test/workflows/wf-gate?execution=exec-gate',
      Bidspoke_Write__c: 'exec-gate:send_salesforce:0',
    })
    expect(Object.keys(w.sent!)).not.toContain('executionId')
    expect(Object.keys(w.sent!)).not.toContain('submissionId')
  })

  it('login refused (401): sent again once with a fresh token, since a refused login wrote nothing, then the walk ends at the write', async () => {
    const w = await walk('send_salesforce', ANSWERS['login refused (401)'])
    expect(w.answered).toBe(1)
    expect(w.writeCalls).toEqual([`PATCH ${PATCH_URL}`, `PATCH ${PATCH_URL}`])
    expect(w.row?.status).toBe('failed')
    expect(w.row?.retries_used).toBe(0)
    expect(w.steps).not.toContain('exit_1')
  })

  it.each(Object.entries(ANSWERS).filter(([, a]) => a !== ANSWERS.landed && a !== ANSWERS['login refused (401)']))('%s: one PATCH, never resent, the walk ends at the write, the lead already answered', async (_name, answer) => {
    const w = await walk('send_salesforce', answer)
    expect(w.answered).toBe(1)
    expect(w.writeCalls).toEqual([`PATCH ${PATCH_URL}`])
    expect(w.row?.status).toBe('failed')
    expect(w.row?.retries_used).toBe(0)
    expect(w.steps).not.toContain('exit_1')
  })

  it.each(Object.entries(ANSWERS))('%s: ends the same way as the invalid state write the first canary passed on', async (_name, answer) => {
    const send = outcomeOf(await walk('send_salesforce', answer))
    vi.unstubAllGlobals()
    fetchMock = stubFetch()
    const invalid = outcomeOf(await walk('invalid_state_sf_post', answer))
    expect(send).toEqual(invalid)
  })
})
