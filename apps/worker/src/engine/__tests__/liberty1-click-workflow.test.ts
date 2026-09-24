/**
 * The Liberty1 click workflow definition (#1545), walked by the real engine.
 *
 * docs/workflows/liberty1-click/definition.json is what gets built on the
 * canvas. This walks it through walkGraph with the REAL branch and response
 * nodes and the REAL kept scripts (run the way the sandbox runs them), and
 * doubles only what reaches outside: Salesforce (a fake org holding one
 * prospect, one submission and one lead) and buyer_click_send (which answers
 * the route a test names; its own behaviour is nodes/__tests__/buyer-click-send.test.ts).
 *
 * What it proves: an unusable body is refused with a 400 and nothing is read
 * or sent; a prospect without the Liberty1 offer on record is refused and never
 * sent; a Completed one is answered already sent and never sent; the request
 * posted is Brian's body to his route; Completed is written only on `sent`
 * and Fail only on `refused`, to exactly the records the click resolves to; and
 * every other route answers and writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import type { BuyerClickSendOutput, BuyerClickSendReason, BuyerClickSendRoute } from '../nodes/buyer-click-send'
import workflowFile from '../../../../../docs/workflows/liberty1-click/definition.json'
import fixtures from '../scripts/__tests__/fixtures/liberty1-prospects.json'
import { runCanvasScript } from '../scripts/__tests__/canvas-script'
import { ROUTES, buildPayload, pickRoute, updateBodies } from '../scripts/__tests__/liberty1-pipedream-oracle'
import { KEPT_LIBERTY1_CLICK_SCRIPTS } from '../../lib/engine-script-drift'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/buyer-click-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/buyer-click-send')>()),
  executeBuyerClickSendNode: vi.fn(),
  productionDeps: vi.fn(() => ({})),
}))
vi.mock('../nodes/code', () => ({ executeCodeNode: vi.fn() }))
vi.mock('../nodes/salesforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/salesforce')>()),
  executeSalesforceNode: vi.fn(),
}))

import { walkGraph } from '../index'
import { buildContext, resolveValue } from '../context'
import { executeBuyerClickSendNode } from '../nodes/buyer-click-send'
import { executeCodeNode } from '../nodes/code'
import { executeSalesforceNode } from '../nodes/salesforce'

type Rec = Record<string, unknown>
const definition = workflowFile.definition as unknown as { trigger: unknown; nodes: NodeDefinition[]; edges: EdgeDefinition[] }
const RECORD = fixtures.records.dv1_state_plain as Rec
const PROSPECT_ID = RECORD.Id as string
const SUBMISSION_ID = 'a0S5f00000TestZAAA'
const LEAD_ID = '00Q5f00000TestLAAA'
const L1_LEAD = '00QUy00000gtlZBMAY'
const NOW = '2026-09-29T16:04:05.000Z'
/** A stand in for the Liberty1 partner row, which does not exist yet. */
const LIBERTY1_PARTNER_ID = '0192a4f0-0000-7000-8000-00000000a1b1'
const LINK = 'https://app.test/workflows/wf-l1/executions/exec-1'

/** The reason the node gives with each route (docs/nodes/buyer-click-send.md). */
const REASON: Record<BuyerClickSendRoute, BuyerClickSendReason> = {
  sent: 'sent', refused: 'refused_by_buyer', unknown: 'outcome_unknown', already_sent: 'already_sent',
  in_progress: 'claim_in_progress', needs_review: 'claim_in_doubt', not_sent: 'report_only',
}

/** Every Salesforce call the walk made, in order. */
let sfCalls: Array<{ namespace: string; operation: string; object?: string; record_id?: string; soql?: string; body?: unknown }>
/** What the fake org holds; tests change it. */
let org: { prospect: Rec | null; submissionProspect: string | null; submissionLead: string | null }
let clickRoute: BuyerClickSendRoute
let clickInputs: Array<{ prospect_id: unknown; request_url: unknown; request_body: unknown; partner: unknown }>

function fakeSoql(soql: string): Rec[] {
  const direct = soql.match(/FROM Prospect__c WHERE Id = '([A-Za-z0-9]+)'$/)
  if (direct) return org.prospect && org.prospect.Id === direct[1] ? [org.prospect] : []
  const viaSub = soql.match(/FROM Prospect__c WHERE Id IN \(SELECT Prospect__c FROM Submission__c WHERE Id = '([A-Za-z0-9]+)'\)$/)
  if (viaSub) return viaSub[1] === SUBMISSION_ID && org.prospect && org.submissionProspect === org.prospect.Id ? [org.prospect] : []
  const lead = soql.match(/^SELECT Id, Lead__c FROM Submission__c WHERE Id = '([A-Za-z0-9]+)'$/)
  if (lead) return lead[1] === SUBMISSION_ID ? [{ Id: SUBMISSION_ID, Lead__c: org.submissionLead }] : []
  throw new Error(`the fake org does not know this query: ${soql}`)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  sfCalls = []
  clickInputs = []
  clickRoute = 'sent'
  org = { prospect: { ...RECORD }, submissionProspect: PROSPECT_ID, submissionLead: LEAD_ID }

  vi.mocked(executeCodeNode).mockImplementation(async (node: NodeDefinition, ctx: ExecutionContext) => ({
    output: await runCanvasScript(String((node.config as Rec).script), {
      payload: ctx.trigger.payload,
      steps: ctx.steps as Record<string, { output: unknown }>,
      execution: ctx.execution as Rec,
    }),
  }))

  vi.mocked(executeSalesforceNode).mockImplementation(async (node: NodeDefinition, ctx: ExecutionContext) => {
    const c = node.config as Rec
    const operation = String(c.operation)
    if (operation === 'query') {
      const soql = String(resolveValue(c.soql, ctx))
      sfCalls.push({ namespace: node.namespace, operation, soql })
      const records = fakeSoql(soql)
      return { output: { status: 200, body: { totalSize: records.length, done: true, records } } }
    }
    const record_id = String(resolveValue(c.record_id, ctx))
    const body = resolveValue(c.body, ctx)
    sfCalls.push({ namespace: node.namespace, operation, object: String(c.object), record_id, body })
    return { output: { status: 204, body: null } }
  })

  vi.mocked(executeBuyerClickSendNode).mockImplementation(async (node: NodeDefinition, ctx: ExecutionContext) => {
    const c = node.config as Rec
    clickInputs.push({
      prospect_id: resolveValue(c.prospect_id, ctx),
      request_url: resolveValue(c.request_url, ctx),
      request_body: resolveValue(c.request_body, ctx),
      partner: c.partner_id,
    })
    const output: BuyerClickSendOutput = {
      _route: clickRoute, reason: REASON[clickRoute], mode_effective: 'live', partner_id: LIBERTY1_PARTNER_ID, partner_slug: 'liberty1', prospect_id: PROSPECT_ID,
      status: clickRoute === 'sent' ? 200 : 400, partner_lead_id: clickRoute === 'sent' ? L1_LEAD : null,
      count: null, counted: false, count_date: null, over_cap: null, daily_lead_cap: null, pages: [], duration_ms: 5,
    }
    return { output }
  })
})
afterEach(() => vi.useRealTimers())

const env = { PII_REDACTION_FIELDS: '', APP_URL: 'https://app.test' } as unknown as Env
const supabase = {} as SupabaseClient

async function click(payload: unknown) {
  const ctx = buildContext(payload, 'liberty1-proxy', 'wf-l1', 'trace-1', {}, 'org-1', 'exec-1')
  ctx.execution = { ...(ctx.execution ?? {}), bidspoke_link: LINK } as ExecutionContext['execution']
  const queue: StepLogEntry[] = []
  const early: Array<{ status: number; body: unknown }> = []
  const result = await walkGraph(ctx, definition, 'exec-1', NOW, supabase, env, 'v1', queue, (r) => early.push({ status: r.status, body: r.body }))
  const ran = queue.map((r) => r.step_namespace)
  return { status: result.status, body: result.body, early, ran, writes: sfCalls.filter((c) => c.operation === 'update') }
}

describe('the definition carries the kept scripts', () => {
  it('each code node holds its kept file byte for byte, so the paste and the tested script are one text (L41)', () => {
    for (const kept of KEPT_LIBERTY1_CLICK_SCRIPTS) {
      const node = definition.nodes.find((n) => n.type === 'code' && n.namespace === kept.namespace)
      expect(node, kept.namespace).toBeDefined()
      expect(String((node?.config as Rec).script)).toBe(kept.script.replace(/[\r\n]+$/, ''))
    }
    expect(definition.nodes.filter((n) => n.type === 'code')).toHaveLength(KEPT_LIBERTY1_CLICK_SCRIPTS.length)
  })

  it("wires every one of the send node's seven handles", () => {
    const send = definition.nodes.find((n) => n.type === 'buyer_click_send')
    const handles = definition.edges.filter((e) => e.source === send?.id).map((e) => e.source_handle).sort()
    expect(handles).toEqual(['already_sent', 'in_progress', 'needs_review', 'not_sent', 'refused', 'sent', 'unknown'])
  })
})

describe('an unusable body is refused before anything is read or sent', () => {
  for (const [name, payload, reason] of [
    ['no id', {}, 'no_id'],
    ['a malformed id', { Prospect__c: "x' OR Id != '" }, 'invalid_id'],
  ] as const) {
    it(`${name}: 400 ${reason}`, async () => {
      const r = await click(payload)
      expect(r.status).toBe(400)
      expect(r.body).toEqual({ success: false, outcome: 'invalid_request', reason })
      expect(sfCalls).toEqual([])
      expect(clickInputs).toEqual([])
    })
  }
})

describe('the offer check', () => {
  const refused = async (status: number, outcome: string) => {
    const r = await click({ Prospect__c: PROSPECT_ID })
    expect(r.status).toBe(status)
    expect(r.body).toEqual({ success: false, outcome })
    expect(clickInputs).toEqual([])
    expect(r.writes).toEqual([])
  }

  it('a prospect Salesforce does not hold is 404, never sent', async () => {
    org.prospect = null
    await refused(404, 'prospect_not_found')
  })

  it('a submission that points at no prospect is 404, never sent', async () => {
    org.submissionProspect = null
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.status).toBe(404)
    expect(clickInputs).toEqual([])
  })

  for (const [name, code, status] of [
    ['a Tripoint offer (routing code 2, Bid)', 2, 'Bid'],
    ['no routing code', null, 'Bid'],
    ['routing code 4 with no exchange status', 4, null],
    ['routing code 4 that already failed', 4, 'Fail'],
    ['routing code 4 as Success', 4, 'Success'],
    ['a Tripoint sale already completed (code 2, Completed)', 2, 'Completed'],
  ] as const) {
    it(`${name} is refused 409 as no Liberty1 offer, never sent`, async () => {
      org.prospect = { ...RECORD, ExternalRoutingCode__c: code, ExternalExchangeStatus__c: status }
      await refused(409, 'no_liberty1_offer')
    })
  }

  it('a Liberty1 offer already Completed answers already sent and sends nothing', async () => {
    org.prospect = { ...RECORD, ExternalExchangeStatus__c: 'Completed' }
    const r = await click({ Prospect__c: PROSPECT_ID })
    expect(r).toMatchObject({ status: 200, body: { success: true, outcome: 'already_sent' } })
    expect(clickInputs).toEqual([])
    expect(r.writes).toEqual([])
  })
})

describe('a Liberty1 offer that is still open', () => {
  it("posts Brian's body to his route, keyed by the prospect, with the partner left for Dan to pick", async () => {
    await click({ Prospect__c: PROSPECT_ID })
    const body = buildPayload(RECORD)
    expect(clickInputs).toHaveLength(1)
    expect(clickInputs[0].prospect_id).toBe(PROSPECT_ID)
    expect(clickInputs[0].request_url).toBe(ROUTES[pickRoute(body.state)])
    expect(JSON.stringify(clickInputs[0].request_body)).toBe(JSON.stringify(body))
    expect(clickInputs[0].partner).toBe('')
  })

  it('sent, from a Prospect__c: answers success, then writes Completed to the prospect alone (no submission to tie a lead to)', async () => {
    const r = await click({ Prospect__c: PROSPECT_ID })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: true, outcome: 'sent' })
    expect(r.early).toEqual([{ status: 200, body: { success: true, outcome: 'sent' } }])
    const theirs = updateBodies({ ok: true, text: `Records created successfully : ${L1_LEAD}` }, NOW, LINK)
    expect(r.writes).toEqual([{ namespace: 'update_prospect', operation: 'update', object: 'Prospect__c', record_id: PROSPECT_ID, body: theirs.prospect }])
  })

  it("sent, from a Submission__c: writes Completed to the prospect, the submission and the submission's lead", async () => {
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.body).toEqual({ success: true, outcome: 'sent' })
    const theirs = updateBodies({ ok: true, text: `Records created successfully : ${L1_LEAD}` }, NOW, LINK)
    expect(r.writes).toEqual([
      { namespace: 'update_prospect', operation: 'update', object: 'Prospect__c', record_id: PROSPECT_ID, body: theirs.prospect },
      { namespace: 'update_submission', operation: 'update', object: 'Submission__c', record_id: SUBMISSION_ID, body: theirs.submission },
      { namespace: 'update_lead', operation: 'update', object: 'Lead', record_id: LEAD_ID, body: theirs.lead },
    ])
  })

  it('a submission with no lead writes the prospect and the submission and stops cleanly', async () => {
    org.submissionLead = null
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.writes.map((w) => w.namespace)).toEqual(['update_prospect', 'update_submission'])
  })

  it('refused: answers not successful, then writes Fail with no partner lead id', async () => {
    clickRoute = 'refused'
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.body).toEqual({ success: false, outcome: 'refused' })
    const theirs = updateBodies({ ok: false, text: '{"error":"refused"}' }, NOW, LINK)
    expect(r.writes.map((w) => w.body)).toEqual([theirs.prospect, theirs.submission, theirs.lead])
    expect(r.writes.every((w) => (w.body as Rec).ExternalExchangeStatus__c === 'Fail' || (w.body as Rec).External_Exchange_Status__c === 'Fail')).toBe(true)
  })

  it('already_sent from the claim answers already sent and writes nothing', async () => {
    clickRoute = 'already_sent'
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.body).toEqual({ success: true, outcome: 'already_sent' })
    expect(r.writes).toEqual([])
  })

  for (const route of ['unknown', 'needs_review', 'in_progress', 'not_sent'] as const) {
    it(`${route}: answers not successful with the route named, writes neither Completed nor Fail, and runs no patch`, async () => {
      clickRoute = route
      const r = await click({ Submission__c: SUBMISSION_ID })
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ success: false, outcome: route })
      expect(r.writes).toEqual([])
      expect(r.ran).not.toContain('click_patch')
    })
  }
})
