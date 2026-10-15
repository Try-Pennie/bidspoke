/**
 * The write options the Pipedream Submission relay gave Main Flow's posts, taught
 * to the native Salesforce step (#2170, phase 1 of #1680).
 *
 * The relay received a rendered text body, sent only the keys it named (two of
 * them renamed), and wrote nothing when the body carried no submissionId. Each
 * test here pins one of those behaviours on the executor, with the fetch
 * recorded, so "no Salesforce call" means no request left at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeSalesforceNode } from '../salesforce'
import { stubFetch, type FetchMock } from '../../../__tests__/helpers/fetch-mock'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { Env } from '../../../index'

const INSTANCE = 'https://trypennie.my.salesforce.com'
const SUBMISSION_URL = `${INSTANCE}/services/data/v60.0/sobjects/Submission__c/a0X1`

function makeNode(config: Record<string, unknown>): NodeDefinition {
  return { id: 'sf1', namespace: 'invalid_state_sf_post', type: 'salesforce', config }
}

function makeCtx(payload: Record<string, unknown> = {}, steps: Record<string, unknown> = {}): ExecutionContext {
  const stepMap: ExecutionContext['steps'] = {}
  for (const [ns, output] of Object.entries(steps)) stepMap[ns] = { output, status: 'completed' }
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf-1', org_id: 'org-1', trace_id: 'tr-1', execution_id: 'exec-1' },
    steps: stepMap,
    env: {
      SALESFORCE_CLIENT_ID: 'client-id',
      SALESFORCE_CLIENT_SECRET: 'client-secret',
      SALESFORCE_INSTANCE_URL: INSTANCE,
    },
    execution: { workflow_id: 'wf-1', trace_id: 'tr-1', execution_id: 'exec-1', bidspoke_link: 'https://bidspoke.trypennie.dev/workflows/wf-1?execution=exec-1' },
  } as unknown as ExecutionContext
}

/** A cached token, so the only fetch a sent write makes is the write itself. */
function makeEnv(): Env {
  return {
    WORKFLOW_CACHE: {
      get: vi.fn().mockResolvedValue('tok'),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
  } as unknown as Env
}

const noContent = () => ({ ok: true, status: 204, text: () => Promise.resolve(''), headers: new Headers() })

/** The body the one write sent, as Salesforce received it. */
function sentBody(fetchMock: FetchMock): unknown {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  return JSON.parse(fetchMock.mock.calls[0][1].body as string)
}

const update = (config: Record<string, unknown>) =>
  makeNode({ operation: 'update', object: 'Submission__c', record_id: 'a0X1', ...config })

describe('a JSON text body is rendered then parsed, byte for byte what the relay received (#2170)', () => {
  let fetchMock: FetchMock
  beforeEach(() => {
    fetchMock = stubFetch()
    fetchMock.mockResolvedValue(noContent())
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('a missing reference inside quotes is sent as an empty string, not dropped', async () => {
    await executeSalesforceNode(
      update({ body: '{"TripointLeadID__c": "{{trigger.payload.tripoint_id}}", "LeadSaleType__c": "{{trigger.payload.sale}}"}' }),
      makeCtx({ sale: 'Offer Wall' }),
      makeEnv(),
    )
    expect(fetchMock.mock.calls[0][0]).toBe(SUBMISSION_URL)
    expect(sentBody(fetchMock)).toEqual({ TripointLeadID__c: '', LeadSaleType__c: 'Offer Wall' })
  })

  it('a null inside quotes is sent as the string "null", as the relay received it', async () => {
    await executeSalesforceNode(
      update({ body: '{"VantageScore__c": "{{trigger.payload.score}}"}' }),
      makeCtx({ score: null }),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ VantageScore__c: 'null' })
  })

  it('a number keeps the type its quoting gives it: quoted is a string, bare is a number', async () => {
    await executeSalesforceNode(
      update({ body: '{"ADV_SO__c": "{{trigger.payload.adv}}", "InternalDebtRouting__c": {{trigger.payload.adv}}}' }),
      makeCtx({ adv: 42 }),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ ADV_SO__c: '42', InternalDebtRouting__c: 42 })
  })

  it('a rendered text that is not valid JSON fails the step by name, permanently, and sends nothing', async () => {
    const err = await executeSalesforceNode(
      update({ body: '{"InternalDebtRouting__c": {{trigger.payload.missing}}}' }),
      makeCtx(),
      makeEnv(),
    ).then(() => null, (e: Error & { permanent?: boolean; resolvedInput?: { resolved: { body: unknown } } }) => e)
    expect(err?.message).toMatch(/^Salesforce body text is not valid JSON once its references are filled in/)
    expect(err?.permanent).toBe(true)
    // The rendered text is what the Results panel shows, so the broken spot can be found.
    expect(err?.resolvedInput?.resolved.body).toBe('{"InternalDebtRouting__c": }')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a rendered text that is JSON but not an object fails by name and sends nothing', async () => {
    const err = await executeSalesforceNode(update({ body: '["{{trigger.payload.a}}"]' }), makeCtx({ a: 'x' }), makeEnv())
      .then(() => null, (e: Error & { permanent?: boolean }) => e)
    expect(err?.message).toBe('Salesforce body text rendered to JSON that is not an object (an array), so there is no record to write')
    expect(err?.permanent).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a reference that resolves to JSON text is parsed too', async () => {
    await executeSalesforceNode(
      update({ body: '{{steps.build.output.sfText}}' }),
      makeCtx({}, { build: { sfText: '{"A__c": "x"}' } }),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ A__c: 'x' })
  })

  it('a reference that resolves to an object is sent as before (control)', async () => {
    await executeSalesforceNode(
      update({ body: '{{steps.build.output.sfBody}}' }),
      makeCtx({}, { build: { sfBody: { A__c: 'x', N__c: 3 } } }),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ A__c: 'x', N__c: 3 })
  })

  it.each([
    ['create', { operation: 'create', object: 'Prospect__c' }],
    ['upsert', { operation: 'upsert', object: 'Prospect__c', external_id_field: 'Ext__c', external_id_value: 'E1' }],
  ])('%s shares the text body rule, since it writes a record from the same body', async (_op, base) => {
    await executeSalesforceNode(
      makeNode({ ...base, body: '{"Name__c": "{{trigger.payload.name}}", "Gone__c": "{{trigger.payload.gone}}"}' }),
      makeCtx({ name: 'Ann' }),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ Name__c: 'Ann', Gone__c: '' })
  })

  it('apex keeps its body as configured: a text body resolving to text is not parsed', async () => {
    await executeSalesforceNode(
      makeNode({ operation: 'apex', apex_path: '/services/apexrest/credit-inquiries', body: '{{steps.build.output.text}}' }),
      makeCtx({}, { build: { text: '{"a":1}' } }),
      makeEnv(),
    )
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify('{"a":1}'))
  })
})

describe('omit_fields and rename_fields shape what is sent (#2170)', () => {
  let fetchMock: FetchMock
  beforeEach(() => {
    fetchMock = stubFetch()
    fetchMock.mockResolvedValue(noContent())
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const sfBody = { submissionId: 'a0X1', executionId: 'exec-9', UUID: 'u-1', leadUUID: 'l-1', ADV_SO__c: 5 }

  it('omit_fields removes the named keys before sending', async () => {
    await executeSalesforceNode(
      update({ body: '{{steps.build.output.sfBody}}', omit_fields: ['submissionId', 'executionId'] }),
      makeCtx({}, { build: { sfBody } }),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ UUID: 'u-1', leadUUID: 'l-1', ADV_SO__c: 5 })
  })

  it('rename_fields sends a key under its new name and not its old one', async () => {
    await executeSalesforceNode(
      update({
        body: '{{steps.build.output.sfBody}}',
        omit_fields: ['submissionId', 'executionId'],
        rename_fields: { UUID: 'Engine_UUID_SO__c', leadUUID: 'Engine_Lead_UUID_SO__c' },
      }),
      makeCtx({}, { build: { sfBody } }),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ Engine_UUID_SO__c: 'u-1', Engine_Lead_UUID_SO__c: 'l-1', ADV_SO__c: 5 })
  })

  it('a rename whose source key is absent sends nothing under either name', async () => {
    await executeSalesforceNode(
      update({ body: { ADV_SO__c: 5 }, rename_fields: { UUID: 'Engine_UUID_SO__c' } }),
      makeCtx(),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ ADV_SO__c: 5 })
  })

  it('a rename onto a key the body already holds sends the renamed value, as the relay did, and says so on the step', async () => {
    const result = await executeSalesforceNode(
      update({ body: { UUID: 'u-1', Engine_UUID_SO__c: 'stale', ADV_SO__c: 5 }, rename_fields: { UUID: 'Engine_UUID_SO__c' } }),
      makeCtx(),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ Engine_UUID_SO__c: 'u-1', ADV_SO__c: 5 })
    expect(result.logs?.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      'rename_fields wrote UUID onto Engine_UUID_SO__c, replacing the value the body already held for Engine_UUID_SO__c.',
    ])
  })

  it('a rename that collides with nothing adds no warning (control)', async () => {
    const result = await executeSalesforceNode(
      update({ body: { UUID: 'u-1' }, rename_fields: { UUID: 'Engine_UUID_SO__c' } }),
      makeCtx(),
      makeEnv(),
    )
    expect(result.logs ?? []).toEqual([])
  })

  it('injected_fields still win over a renamed key on collision', async () => {
    await executeSalesforceNode(
      update({
        body: { UUID: 'u-1' },
        rename_fields: { UUID: 'PDFlow_4__c' },
        injected_fields: { PDFlow_4__c: '{{execution.bidspoke_link}}' },
      }),
      makeCtx(),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ PDFlow_4__c: 'https://bidspoke.trypennie.dev/workflows/wf-1?execution=exec-1' })
  })

  it('omit and rename apply to a text body after it is parsed', async () => {
    await executeSalesforceNode(
      update({
        body: '{"submissionId": "{{trigger.payload.sub}}", "UUID": "{{trigger.payload.uuid}}"}',
        omit_fields: ['submissionId'],
        rename_fields: { UUID: 'Engine_UUID_SO__c' },
      }),
      makeCtx({ sub: 'a0X1', uuid: 'u-7' }),
      makeEnv(),
    )
    expect(sentBody(fetchMock)).toEqual({ Engine_UUID_SO__c: 'u-7' })
  })

  it('the run is told the body as sent, after omission and rename, for the at risk record (#2022)', async () => {
    const ctx = makeCtx({}, { build: { sfBody } })
    const notes: unknown[] = []
    ctx.noteSalesforceRequest = (req) => { notes.push(req) }
    await executeSalesforceNode(
      update({ body: '{{steps.build.output.sfBody}}', omit_fields: ['submissionId', 'executionId', 'leadUUID'], rename_fields: { UUID: 'Engine_UUID_SO__c' } }),
      ctx,
      makeEnv(),
    )
    expect(notes).toEqual([{ object: 'Submission__c', record_id: 'a0X1', operation: 'update', body: { Engine_UUID_SO__c: 'u-1', ADV_SO__c: 5 } }])
  })

  it('a malformed option on a definition that skipped save validation fails by name and sends nothing', async () => {
    const err = await executeSalesforceNode(update({ body: { A: 1 }, omit_fields: 'submissionId' }), makeCtx(), makeEnv())
      .then(() => null, (e: Error & { permanent?: boolean }) => e)
    expect(err?.message).toBe('Salesforce step misconfigured: omit_fields must be a list of field names')
    expect(err?.permanent).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('skip_when_empty: nothing to write, or no record, skips the write as the relay filter did (#2170)', () => {
  let fetchMock: FetchMock
  beforeEach(() => {
    fetchMock = stubFetch()
    fetchMock.mockResolvedValue(noContent())
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const skipped = (reason: string) => ({ skipped: true, skip_reason: reason })

  it('a body that resolves to null skips with nothing_to_write and makes no Salesforce call', async () => {
    const env = makeEnv()
    const result = await executeSalesforceNode(
      update({ body: '{{steps.build.output.sfBody}}', skip_when_empty: true }),
      makeCtx({}, { build: { sfBody: null } }),
      env,
    )
    expect(result.output).toEqual(skipped('nothing_to_write'))
    expect(result.resolvedInput?.resolved).toMatchObject({ skip_reason: 'nothing_to_write' })
    expect(fetchMock).not.toHaveBeenCalled()
    // Not even a token is asked for.
    expect(env.WORKFLOW_CACHE.get).not.toHaveBeenCalled()
  })

  it('a body whose reference is missing altogether skips with nothing_to_write', async () => {
    const result = await executeSalesforceNode(
      update({ body: '{{steps.build.output.sfBody}}', skip_when_empty: true }),
      makeCtx({}, { build: {} }),
      makeEnv(),
    )
    expect(result.output).toEqual(skipped('nothing_to_write'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a text body rendering to null skips with nothing_to_write', async () => {
    const result = await executeSalesforceNode(update({ body: ' null ', skip_when_empty: true }), makeCtx(), makeEnv())
    expect(result.output).toEqual(skipped('nothing_to_write'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a body left empty by omission skips with nothing_to_write, even with injected fields to stamp', async () => {
    const result = await executeSalesforceNode(
      update({
        body: '{{steps.build.output.sfBody}}',
        omit_fields: ['submissionId', 'executionId'],
        injected_fields: { PDFlow_4__c: '{{execution.bidspoke_link}}' },
        skip_when_empty: true,
      }),
      makeCtx({}, { build: { sfBody: { submissionId: 'a0X1', executionId: 'e-1' } } }),
      makeEnv(),
    )
    expect(result.output).toEqual(skipped('nothing_to_write'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a record id that resolves empty skips with no_record_id and makes no Salesforce call', async () => {
    const ctx = makeCtx({}, { build: { sfBody: { ADV_SO__c: 5 } } })
    const notes: unknown[] = []
    ctx.noteSalesforceRequest = (req) => { notes.push(req) }
    const result = await executeSalesforceNode(
      update({ record_id: '{{steps.build.output.sfBody.submissionId}}', body: '{{steps.build.output.sfBody}}', skip_when_empty: true }),
      ctx,
      makeEnv(),
    )
    expect(result.output).toEqual(skipped('no_record_id'))
    expect(fetchMock).not.toHaveBeenCalled()
    // A write never sent is never recorded as at risk.
    expect(notes).toEqual([])
  })

  it('a body with something to write and a record id is sent (control)', async () => {
    const result = await executeSalesforceNode(
      update({ record_id: '{{steps.build.output.sfBody.submissionId}}', body: '{{steps.build.output.sfBody}}', omit_fields: ['submissionId'], skip_when_empty: true }),
      makeCtx({}, { build: { sfBody: { submissionId: 'a0X1', ADV_SO__c: 5 } } }),
      makeEnv(),
    )
    expect(result.output).toEqual({ status: 204, body: null })
    expect(fetchMock.mock.calls[0][0]).toBe(SUBMISSION_URL)
    expect(sentBody(fetchMock)).toEqual({ ADV_SO__c: 5 })
  })

  // The credit-inquiries Apex endpoint answers 500 when `inquiries` is missing and
  // writes nothing on an empty list, so its body code node returns null when there
  // is nothing to send, and the step must skip rather than post (#2170, #2181).
  const apex = (config: Record<string, unknown>) =>
    makeNode({ operation: 'apex', apex_path: '/services/apexrest/credit-inquiries', ...config })

  it('an Apex POST whose body resolves to null skips with nothing_to_write and makes no call', async () => {
    const env = makeEnv()
    const result = await executeSalesforceNode(
      apex({ body: '{{steps.inquiry_body.output}}', skip_when_empty: true }),
      makeCtx({}, { inquiry_body: null }),
      env,
    )
    expect(result.output).toEqual(skipped('nothing_to_write'))
    expect(result.resolvedInput?.resolved).toMatchObject({ skip_reason: 'nothing_to_write' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(env.WORKFLOW_CACHE.get).not.toHaveBeenCalled()
  })

  it('an Apex POST whose body reference is missing altogether skips with nothing_to_write', async () => {
    const result = await executeSalesforceNode(
      apex({ body: '{{steps.inquiry_body.output.payload}}', skip_when_empty: true }),
      makeCtx({}, { inquiry_body: {} }),
      makeEnv(),
    )
    expect(result.output).toEqual(skipped('nothing_to_write'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an Apex POST with a body is sent as configured (control)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{"statusCode":200}'), headers: new Headers() })
    const body = { submissionId: 'a0X1', inquiriesJson: '{"inquiries":[]}' }
    await executeSalesforceNode(
      apex({ body: '{{steps.inquiry_body.output}}', skip_when_empty: true }),
      makeCtx({}, { inquiry_body: body }),
      makeEnv(),
    )
    expect(fetchMock.mock.calls[0][0]).toBe(`${INSTANCE}/services/apexrest/credit-inquiries`)
    expect(sentBody(fetchMock)).toEqual(body)
  })

  it('without the flag, an Apex POST with a null body still sends it as it always has', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}'), headers: new Headers() })
    await executeSalesforceNode(apex({ body: '{{steps.inquiry_body.output}}' }), makeCtx({}, { inquiry_body: null }), makeEnv())
    expect(fetchMock.mock.calls[0][1].body).toBe('null')
  })

  it('without the flag, a missing record id still fails as it always has', async () => {
    await expect(
      executeSalesforceNode(update({ record_id: '{{trigger.payload.none}}', body: { A: 1 } }), makeCtx(), makeEnv()),
    ).rejects.toThrow('Salesforce update requires record_id')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('without the flag, a null body still sends an empty object as it always has', async () => {
    await executeSalesforceNode(update({ body: '{{steps.build.output.sfBody}}' }), makeCtx({}, { build: { sfBody: null } }), makeEnv())
    expect(sentBody(fetchMock)).toEqual({})
  })
})
