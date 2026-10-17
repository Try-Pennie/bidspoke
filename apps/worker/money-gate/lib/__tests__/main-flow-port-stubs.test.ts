/**
 * The money gate's answers for the Main Flow relay port (#2171, #1680 plan point 13).
 *
 * Every Salesforce request the ported definition can make must reach a rule that
 * names it, with a success and a failing answer, so a fixture replayed through
 * the port after a PUT is answered rather than falling to the 599 catch all. The
 * requests are built from the ported definition itself (the transform over the
 * production Main Flow from before the port), not written out here. And the inquiry failure variant
 * must fail the inquiry post both before the port (the Pipedream relay) and after
 * it (the credit-inquiries Apex call).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stubAnswer, type StubRequest } from '../stub-rules'
import { resolveVariant, type VariantFile } from '../../harness/replay-env'
import { MAIN_FLOW_WORKFLOW_ID, PORT_STAGES, portMainFlow, type Definition } from '../../../src/lib/main-flow-port/transform'
import { runCanvasScript } from '../../../src/engine/scripts/__tests__/canvas-script'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', 'fixtures')
// The definition before any stage, the port tests' own copy of version 169 (#2173):
// the gate's Main Flow fixture is part ported once a stage is live, and these
// requests are those of the whole port, nine updates and nine Apex calls. The
// gate's fixture is held to the transform of this copy by gate-fixture.test.ts.
const prePortFile = join(here, '..', '..', '..', 'src', 'lib', 'main-flow-port', '__tests__', 'fixtures', 'main-flow-v169.json')
const prePort = JSON.parse(readFileSync(prePortFile, 'utf8')) as { id: string; definition: Definition }
if (prePort.id !== MAIN_FLOW_WORKFLOW_ID) throw new Error(`the pre-port Main Flow copy names workflow ${prePort.id}`)
const production = prePort.definition
const ported = portMainFlow(structuredClone(production), PORT_STAGES.inquiry)
const variants = JSON.parse(readFileSync(join(fixtures, 'variants', 'main-flow.json'), 'utf8')) as VariantFile

const INSTANCE = 'https://salesforce-instance.placeholder.invalid'

/** The request a native Salesforce step of the ported definition sends, as the executor builds its URL. */
function requestOf(config: Record<string, unknown>): StubRequest {
  if (config.operation === 'apex') {
    return { method: 'POST', url: new URL(`${INSTANCE}${String(config.apex_path)}`), headers: {}, body: { submissionId: 'a0XGATE00000000001', inquiriesJson: '{"inquiries":[]}' } }
  }
  return { method: 'PATCH', url: new URL(`${INSTANCE}/services/data/v60.0/sobjects/${String(config.object)}/a0XGATE00000000001`), headers: {}, body: { ADV_SO__c: 2 } }
}

const portedSteps = ported.nodes.filter((n) => n.type === 'salesforce' && !production.nodes.some((p) => p.id === n.id && p.type === 'salesforce'))

describe('the native steps the port adds are answered by name', () => {
  it('finds the nine Submission updates and nine Apex calls in the ported definition', () => {
    expect(portedSteps.filter((n) => n.config.operation === 'update')).toHaveLength(9)
    expect(portedSteps.filter((n) => n.config.operation === 'apex')).toHaveLength(9)
  })

  it.each(portedSteps.map((n) => [n.namespace, n.config] as const))('%s', (_ns, config) => {
    const req = requestOf(config)
    const rule = config.operation === 'apex' ? 'salesforce_credit_inquiries' : 'salesforce_submission_update'
    const ok = stubAnswer(req, {})
    expect({ rule: ok?.rule, status: ok?.answer.status }).toEqual({ rule, status: config.operation === 'apex' ? 200 : 204 })
    const failed = stubAnswer(req, { [rule]: 'failed' })
    expect(failed!.answer.status).toBeGreaterThanOrEqual(400)
  })

  it('a successful Apex answer is the one the endpoint gives', () => {
    expect(stubAnswer(requestOf(portedSteps.find((n) => n.config.operation === 'apex')!.config), {})?.answer.body).toMatchObject({ message: 'Inquiries inserted successfully', statusCode: 200 })
  })

  it('leaves every other object update to the general rule', () => {
    const prospect = stubAnswer(requestOf({ operation: 'update', object: 'Prospect__c' }), { salesforce_submission_update: 'failed' })
    expect({ rule: prospect?.rule, status: prospect?.answer.status }).toEqual({ rule: 'salesforce_update', status: 204 })
  })
})

describe('salesforce_inquiry_post_fails fails the inquiry post before and after the port', () => {
  const variant = resolveVariant(variants, variants.variants.find((v) => v.name === 'salesforce_inquiry_post_fails')!)
  const stubs = variant.stubs ?? {}

  it('before: the Pipedream inquiry relay answers a failure', () => {
    const relay = production.nodes.find((n) => n.namespace === 'send_salesforce_inquiry')!
    const answer = stubAnswer({ method: 'POST', url: new URL(String(relay.config.url)), headers: {}, body: {} }, stubs)
    expect({ rule: answer?.rule, failed: (answer?.answer.status ?? 0) >= 400 }).toEqual({ rule: 'pipedream', failed: true })
  })

  it('its credit report carries inquiries, so after the port the body step builds a body and the Apex call is made, not skipped', async () => {
    const report = stubAnswer({ method: 'POST', url: new URL('https://api.equifax.com/business/consumer-credit/v1/reports/credit-report'), headers: {}, body: {} }, stubs)
    expect(report?.rule).toBe('equifax_report')
    const script = String(ported.nodes.find((n) => n.namespace === 'inquiry_body_tripoint_sf_post')!.config.script)
    const body = await runCanvasScript(script, {
      payload: { Submission__c: 'a0XGATE00000000001' },
      steps: { equifax_debt: { output: { _route: 'trades_present' } }, equifax_credit_report: { output: { data: report!.answer.body } } },
    })
    expect(body).toMatchObject({ submissionId: 'a0XGATE00000000001', inquiriesJson: expect.stringContaining('GATE BANK') })
  })

  it('after: the credit-inquiries Apex call answers a failure, and the outcome write still succeeds', () => {
    const apex = stubAnswer(requestOf(portedSteps.find((n) => n.config.operation === 'apex')!.config), stubs)
    expect({ rule: apex?.rule, failed: (apex?.answer.status ?? 0) >= 400 }).toEqual({ rule: 'salesforce_credit_inquiries', failed: true })
    const write = stubAnswer(requestOf(portedSteps.find((n) => n.config.operation === 'update')!.config), stubs)
    expect(write?.answer.status).toBe(204)
  })
})
