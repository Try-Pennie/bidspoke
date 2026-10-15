/**
 * The Forms <> Engine <> Data Store (Loan only) definition, walked by the real
 * engine (#2092).
 *
 * When Engine refuses a form lead, the flow posts the agent a Slack message with
 * a link to the person's submission, https://trypennie.com/submit?submission_id=<id>.
 * trypennie refuses that link for a submission created after its cutoff unless it
 * carries the link token, and a webhook node cannot sign, so the code node
 * sign_submission_link builds the signed link and the agent webhook sends that.
 *
 * The flow had no run in Bidspoke on 2026-10-15, so this walk is the proof: it
 * runs docs/workflows/forms-engine/definition.json through walkGraph with the
 * REAL branch, response, webhook and exit nodes and the REAL scripts (run the way
 * the sandbox runs them), doubling only Engine (through the script's fetch),
 * Salesforce, the data store and Slack (through the global fetch the webhook
 * node posts with), and reads the link out of the body Slack would receive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import workflowFile from '../../../../../docs/workflows/forms-engine/definition.json'
import { runCanvasScript, type CanvasRun } from '../scripts/__tests__/canvas-script'
import { KEPT_CANVAS_WORKFLOWS } from '../../lib/engine-script-drift'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/code', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/code')>()),
  executeCodeNode: vi.fn(),
}))
vi.mock('../nodes/salesforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/salesforce')>()),
  executeSalesforceNode: vi.fn(),
}))
vi.mock('../nodes/data-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/data-store')>()),
  executeDataStoreNode: vi.fn(),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'
import { codeSentinel, executeCodeNode } from '../nodes/code'
import { executeSalesforceNode } from '../nodes/salesforce'
import { executeDataStoreNode } from '../nodes/data-store'

type Rec = Record<string, unknown>
const definition = workflowFile.definition as unknown as { trigger: unknown; nodes: NodeDefinition[]; edges: EdgeDefinition[] }
const kept = KEPT_CANVAS_WORKFLOWS.find((w) => w.folder === 'forms-engine')!.scripts[0]

// The issue's worked example (link-token.test.ts): a made up secret and record id.
const SECRET = 'example-secret-for-testing-only'
const SUBMISSION_ID = 'a04Ui00000ABCDEFGH'
const WORKED_EXAMPLE_T = 'bbfRE5LpCpRlM6AY5qvdHVXEzAqsv1ZGRh8Oy0JTb7A'
const AGENT_HOOK = 'https://hooks.slack.com/triggers/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'
const GEOFF_HOOK = 'https://hooks.slack.com/triggers/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'

/** What Engine answers the send_request_to_engine script, per test. */
let engine: { status: number; body: unknown }
/** Every post to Slack the webhook nodes made: the URL and the parsed body. */
let slack: Array<{ url: string; body: Rec }>

beforeEach(() => {
  engine = { status: 400, body: [{ message: 'loanInformation.loanAmount is required' }] }
  slack = []

  vi.mocked(executeCodeNode).mockImplementation(async (node: NodeDefinition, ctx: ExecutionContext) => {
    const engineFetch: CanvasRun['fetch'] = async () => ({ status: engine.status, text: async () => JSON.stringify(engine.body) })
    const output = await runCanvasScript(String((node.config as Rec).script), {
      payload: ctx.trigger.payload,
      steps: ctx.steps as Record<string, { output: unknown }>,
      env: ctx.env as Rec,
      execution: ctx.execution as Rec,
      fetch: engineFetch,
    })
    return { output, ...codeSentinel(output) }
  })
  vi.mocked(executeSalesforceNode).mockImplementation(async (node: NodeDefinition) => {
    if (node.namespace === 'get_lead_id') return { output: { status: 200, body: { totalSize: 1, done: true, records: [{ Lead__c: '00QUi00000LeadAAA' }] } } }
    if (node.namespace === 'get_lead_info') return { output: { status: 200, body: { totalSize: 1, done: true, records: [{ Record_Id__c: '00QUi00000LeadAAA', Regal_Assigned_Agent__c: 'agent@example.test' }] } } }
    if (node.namespace === 'soql_search') return { output: { status: 200, body: { totalSize: 1, done: true, records: [{ Submission_Object_ID_SO__c: SUBMISSION_ID }] } } }
    return { output: { status: 204, body: null } }
  })
  vi.mocked(executeDataStoreNode).mockResolvedValue({ output: { ok: true } })

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://hooks.slack.com/')) throw new Error(`the walk fetched ${url}, which this test does not answer`)
    slack.push({ url, body: JSON.parse(String(init?.body)) as Rec })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => vi.unstubAllGlobals())

const env = { PII_REDACTION_FIELDS: '', APP_URL: 'https://app.test' } as unknown as Env
const supabase = {} as SupabaseClient

async function submit(opts: { secret?: string | null } = {}) {
  const envVars: Record<string, string> = opts.secret === null ? {} : { LINK_TOKEN_SECRET: opts.secret ?? SECRET }
  const payload = { Submission__c: SUBMISSION_ID, personalInformation: { email: 'person@example.test' }, loanInformation: {} }
  const ctx = buildContext(payload, 'forms', 'ff1a9f52-7346-452a-bab7-af9f95d36dda', 'trace-1', envVars, 'org-1', 'exec-1', 'https://app.test')
  const queue: StepLogEntry[] = []
  const result = await walkGraph(ctx, definition, 'exec-1', '2026-10-15T15:00:00.000Z', supabase, env, 'money', 'v1', queue)
  return { result, ran: queue.map((r) => r.step_namespace) }
}

describe('the definition', () => {
  it('holds the kept sign_submission_link script byte for byte, so the paste and the tested script are one text', () => {
    const node = definition.nodes.find((n) => n.type === 'code' && n.namespace === 'sign_submission_link')
    expect(String((node?.config as Rec).script)).toBe(kept.script.replace(/[\r\n]+$/, ''))
  })

  it('sends the agent the signed link, and builds no unsigned submit link anywhere else', () => {
    const agent = definition.nodes.find((n) => n.namespace === 'send_to_slack_agent')
    expect(((agent?.config as Rec).body as Rec).submission_link).toBe('{{steps.sign_submission_link.output.url}}')
    const outsideTheScript = JSON.stringify({ ...definition, nodes: definition.nodes.filter((n) => n.namespace !== 'sign_submission_link') })
    expect(outsideTheScript).not.toContain('trypennie.com/submit')
  })

  it('signs only on the failure branch, between the two Slack posts', () => {
    const sign = definition.nodes.find((n) => n.namespace === 'sign_submission_link')!
    const geoff = definition.nodes.find((n) => n.namespace === 'send_to_slack_geoff')!
    const agent = definition.nodes.find((n) => n.namespace === 'send_to_slack_agent')!
    expect(definition.edges.filter((e) => e.target === sign.id).map((e) => e.source)).toEqual([geoff.id])
    expect(definition.edges.filter((e) => e.source === sign.id).map((e) => e.target)).toEqual([agent.id])
    expect(definition.edges.filter((e) => e.target === agent.id).map((e) => e.source)).toEqual([sign.id])
  })
})

describe('a lead Engine refuses', () => {
  it('posts the agent the submission link with the worked example token', async () => {
    const { ran } = await submit()
    expect(ran).toContain('sign_submission_link')
    const agent = slack.filter((s) => s.url === AGENT_HOOK)
    expect(agent).toHaveLength(1)
    expect(agent[0].body.submission_link).toBe(`https://trypennie.com/submit?submission_id=${SUBMISSION_ID}&t=${WORKED_EXAMPLE_T}`)
    expect(agent[0].body).toMatchObject({ user_email: 'person@example.test', owner_email: 'agent@example.test' })
  })

  it('still posts Geoff the same message as before, with no submit link', async () => {
    await submit()
    const geoff = slack.filter((s) => s.url === GEOFF_HOOK)
    expect(geoff).toHaveLength(1)
    expect(geoff[0].body).not.toHaveProperty('submission_link')
    expect(geoff[0].body.sfdc_link).toBe('https://trypennie.lightning.force.com/lightning/r/Lead/00QUi00000LeadAAA/view')
  })

  it('with no secret still posts the agent, with the link unsigned', async () => {
    const { ran } = await submit({ secret: null })
    expect(ran).toContain('end_workflow')
    const agent = slack.filter((s) => s.url === AGENT_HOOK)
    expect(agent).toHaveLength(1)
    expect(agent[0].body.submission_link).toBe(`https://trypennie.com/submit?submission_id=${SUBMISSION_ID}`)
  })
})

describe('a lead Engine accepts', () => {
  it('posts nothing to Slack and never signs a link', async () => {
    engine = { status: 200, body: { uuid: 'engine-uuid', leadUuid: 'engine-lead' } }
    const { ran } = await submit()
    expect(slack).toEqual([])
    expect(ran).not.toContain('sign_submission_link')
    expect(ran).toContain('update_submission_record')
  })
})
