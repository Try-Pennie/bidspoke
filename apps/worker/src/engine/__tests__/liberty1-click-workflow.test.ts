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
 * What it proves: every answer is a 200 with the outcome in the body; an
 * unusable body is refused and nothing is read
 * or sent; a prospect without the Liberty1 offer on record is refused and never
 * sent; a Completed one is answered already sent and never sent; the request
 * posted is Brian's body to his route; Completed is written only on `sent`
 * and Fail only on `refused`, to exactly the records the click resolves to; and
 * every other route answers and writes nothing. A Submission with no Prospect
 * (2026-09-29) is sent from the submission with no offer check, keyed on the
 * submission, and writes the submission and its lead but no prospect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import type { BuyerClickSendOutput, BuyerClickSendReason, BuyerClickSendRoute } from '../nodes/buyer-click-send'
import workflowFile from '../../../../../docs/workflows/liberty1-click/definition.json'
import fixtures from '../scripts/__tests__/fixtures/liberty1-prospects.json'
import submissionFixtures from '../scripts/__tests__/fixtures/liberty1-submissions.json'
import { runCanvasScript } from '../scripts/__tests__/canvas-script'
import { buildPayload, pickRoute, ROUTES, submissionAsProspect, updateBodies } from '../scripts/__tests__/liberty1-pipedream-oracle'
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
vi.mock('../nodes/code', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/code')>()),
  executeCodeNode: vi.fn(),
}))
vi.mock('../nodes/salesforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/salesforce')>()),
  executeSalesforceNode: vi.fn(),
}))

import { walkGraph } from '../index'
import { buildContext, resolveValue } from '../context'
import { executeBuyerClickSendNode } from '../nodes/buyer-click-send'
import { codeSentinel, executeCodeNode } from '../nodes/code'
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
/** The submission row the fake org answers with, before the test's prospect and lead are set on it. */
const SUBMISSION_ROW: Rec = { ...(submissionFixtures.records.di4_lead_mobile as Rec), Id: SUBMISSION_ID }

/** What the fake org holds; tests change it. */
let org: { prospect: Rec | null; submission: Rec | null; submissionProspect: string | null; submissionLead: string | null }
let clickRoute: BuyerClickSendRoute
let clickInputs: Array<{ prospect_id: unknown; request_url: unknown; request_body: unknown; partner: unknown }>

function fakeSoql(soql: string): Rec[] {
  const direct = soql.match(/FROM Prospect__c WHERE Id = '([A-Za-z0-9]+)'$/)
  if (direct) return org.prospect && org.prospect.Id === direct[1] ? [org.prospect] : []
  const sub = soql.match(/^SELECT .*Prospect__r\.ExternalExchangeStatus__c FROM Submission__c WHERE Id = '([A-Za-z0-9]+)'$/)
  if (sub) {
    if (sub[1] !== SUBMISSION_ID || !org.submission) return []
    // Salesforce answers Prospect__r only when the linked prospect is readable.
    const linked = org.submissionProspect !== null && org.prospect && org.prospect.Id === org.submissionProspect ? org.prospect : null
    return [{ ...org.submission, Prospect__c: org.submissionProspect, Lead__c: org.submissionLead, Prospect__r: linked }]
  }
  throw new Error(`the fake org does not know this query: ${soql}`)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  sfCalls = []
  clickInputs = []
  clickRoute = 'sent'
  org = { prospect: { ...RECORD }, submission: { ...SUBMISSION_ROW }, submissionProspect: PROSPECT_ID, submissionLead: LEAD_ID }

  // The script runs as the sandbox runs it, and its result goes through the
  // engine's own sentinel rule (codeSentinel), so a script returning a field the
  // engine reads as "respond now and stop" fails here as it does live.
  vi.mocked(executeCodeNode).mockImplementation(async (node: NodeDefinition, ctx: ExecutionContext) => {
    const output = await runCanvasScript(String((node.config as Rec).script), {
      payload: ctx.trigger.payload,
      steps: ctx.steps as Record<string, { output: unknown }>,
      execution: ctx.execution as Rec,
    })
    return { output, ...codeSentinel(output) }
  })

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

describe('every answer to the portal is a 200', () => {
  // Denys's portal moves to the Liberty1 lander only on a 200 (Brian, 2026-09-29),
  // so the outcome travels in the body: success false and the outcome's name.
  it('no response node answers with anything but 200', () => {
    const responses = definition.nodes.filter((n) => n.type === 'response')
    expect(responses.length).toBeGreaterThan(0)
    expect(responses.map((n) => [n.namespace, (n.config as Rec).status_code])).toEqual(responses.map((n) => [n.namespace, 200]))
  })
})

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
    it(`${name}: refused as ${reason}`, async () => {
      const r = await click(payload)
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ success: false, outcome: 'invalid_request', reason })
      expect(sfCalls).toEqual([])
      expect(clickInputs).toEqual([])
    })
  }
})

describe('the offer check', () => {
  const refused = async (outcome: string) => {
    const r = await click({ Prospect__c: PROSPECT_ID })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: false, outcome })
    expect(clickInputs).toEqual([])
    expect(r.writes).toEqual([])
  }

  it('a prospect Salesforce does not hold is refused as not found, never sent', async () => {
    org.prospect = null
    await refused('prospect_not_found')
  })

  it('a submission Salesforce does not hold is refused as a submission not found, never sent', async () => {
    org.submission = null
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: false, outcome: 'submission_not_found' })
    expect(clickInputs).toEqual([])
    expect(r.writes).toEqual([])
  })

  it('a submission naming a prospect Salesforce cannot return is refused as a prospect not found, never sent from the submission instead', async () => {
    org.submissionProspect = 'a0P5f00000GoneXAAA'
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ success: false, outcome: 'prospect_not_found' })
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
    it(`${name} is refused as no Liberty1 offer, never sent`, async () => {
      org.prospect = { ...RECORD, ExternalRoutingCode__c: code, ExternalExchangeStatus__c: status }
      await refused('no_liberty1_offer')
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
  it("posts Brian's body to the route the canvas names, keyed by the prospect, with the partner left for Dan to pick", async () => {
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

describe('a Submission with no Prospect (trusted, Dan 2026-09-29)', () => {
  beforeEach(() => { org.submissionProspect = null })

  it("is sent with no offer check: Brian's submission body to his route, keyed on the submission", async () => {
    await click({ Submission__c: SUBMISSION_ID })
    const body = buildPayload(submissionAsProspect({ ...SUBMISSION_ROW, Lead__c: LEAD_ID, Prospect__c: null }))
    expect(clickInputs).toHaveLength(1)
    expect(clickInputs[0].prospect_id).toBe(SUBMISSION_ID)
    expect(clickInputs[0].request_url).toBe(ROUTES[pickRoute(body.state)])
    expect(JSON.stringify(clickInputs[0].request_body)).toBe(JSON.stringify(body))
  })

  it('sent: writes Completed to the submission and its lead, and never touches a prospect', async () => {
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.body).toEqual({ success: true, outcome: 'sent' })
    const theirs = updateBodies({ ok: true, text: `Records created successfully : ${L1_LEAD}` }, NOW, LINK)
    expect(r.writes).toEqual([
      { namespace: 'update_submission', operation: 'update', object: 'Submission__c', record_id: SUBMISSION_ID, body: theirs.submission },
      { namespace: 'update_lead', operation: 'update', object: 'Lead', record_id: LEAD_ID, body: theirs.lead },
    ])
  })

  it('with no lead, writes the submission alone and stops cleanly', async () => {
    org.submissionLead = null
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.writes.map((w) => w.namespace)).toEqual(['update_submission'])
  })

  it('refused: writes Fail to the submission and its lead', async () => {
    clickRoute = 'refused'
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.writes.map((w) => [w.namespace, (w.body as Rec).External_Exchange_Status__c])).toEqual([['update_submission', 'Fail'], ['update_lead', 'Fail']])
  })

  it('already sold to Liberty1 (code 4, Completed) answers already sent and sends nothing', async () => {
    org.submission = { ...SUBMISSION_ROW, External_Routing_Code__c: '4', External_Exchange_Status__c: 'Completed' }
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r).toMatchObject({ status: 200, body: { success: true, outcome: 'already_sent' } })
    expect(clickInputs).toEqual([])
    expect(r.writes).toEqual([])
  })

  it('already sold to another buyer (Completed, another routing code) is refused as no Liberty1 offer and sends nothing', async () => {
    org.submission = { ...SUBMISSION_ROW, External_Routing_Code__c: '2', External_Exchange_Status__c: 'Completed' }
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r).toMatchObject({ status: 200, body: { success: false, outcome: 'no_liberty1_offer' } })
    expect(clickInputs).toEqual([])
    expect(r.writes).toEqual([])
  })

  it('an unknown outcome writes nothing', async () => {
    clickRoute = 'unknown'
    const r = await click({ Submission__c: SUBMISSION_ID })
    expect(r.body).toEqual({ success: false, outcome: 'unknown' })
    expect(r.writes).toEqual([])
  })
})

describe('the yes or no gates are filters', () => {
  // A one arm branch with no else and a filter whose exit is not wired both end
  // the run when their condition fails, so the walks above prove the swap kept
  // every outcome; a filter reads as the gate it is, with no nested branch box.
  // check_prospect alone wires exit too: a submission with no prospect skips the
  // prospect write and goes on to the submission's, where the others end the run.
  const GATES: Record<string, { field: string; operator: string; handles: string[] }> = {
    check_write: { field: 'steps.click_patch.output.write', operator: 'is_true', handles: ['pass'] },
    check_prospect: { field: 'steps.pick_record.output.prospect_id', operator: 'exists', handles: ['pass', 'exit'] },
    check_submission: { field: 'steps.pick_record.output.submission_id', operator: 'exists', handles: ['pass'] },
    check_lead: { field: 'steps.pick_record.output.lead_id', operator: 'exists', handles: ['pass'] },
  }

  it.each(Object.keys(GATES))('%s continues only when its condition holds, with the handles it needs wired', (ns) => {
    const node = definition.nodes.find((n) => n.namespace === ns)!
    expect(node.type).toBe('filter')
    const config = node.config as { operation?: string; condition?: { field: string; operator: string } }
    expect(config.operation).toBe('continue_if')
    expect({ field: config.condition?.field, operator: config.condition?.operator }).toEqual({ field: GATES[ns].field, operator: GATES[ns].operator })
    expect(definition.edges.filter((e) => e.source === node.id).map((e) => e.source_handle)).toEqual(GATES[ns].handles)
  })

  it("check_prospect's exit rejoins at check_submission, the node its pass reaches after the prospect write", () => {
    const gate = definition.nodes.find((n) => n.namespace === 'check_prospect')!
    const target = (id: string, handle: string) => definition.edges.find((e) => e.source === id && e.source_handle === handle)?.target
    const updateProspect = target(gate.id, 'pass')!
    expect(definition.nodes.find((n) => n.id === updateProspect)?.namespace).toBe('update_prospect')
    expect(target(gate.id, 'exit')).toBe(target(updateProspect, 'output'))
    expect(definition.nodes.find((n) => n.id === target(gate.id, 'exit'))?.namespace).toBe('check_submission')
  })
})
