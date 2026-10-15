/**
 * Salesforce node: malformed-email recovery (#723)
 *
 * Three lost leads in the 30 days to 2026-08-01, each one a bidding run that
 * died at create_prospect because Salesforce answered INVALID_EMAIL_ADDRESS on
 * an email carrying a stray character, while the lead's phone number was fine.
 * A cosmetically broken email must never cost us a lead we can still reach.
 *
 * The contract:
 *   repairable damage is fixed before the call ever goes out;
 *   unrepairable damage is BLANKED on the error path and the call retried once;
 *   a lead with nothing reachable left fails with a reason that says so;
 *   and the retry is narrow, so it cannot make any other failure worse.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeSalesforceNode, salesforceAnswerOf } from '../salesforce'
import { classifyStepError } from '../../error-classifier'
import { stubFetch, type FetchMock } from '../../../__tests__/helpers/fetch-mock'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { Env } from '../../../index'

const INSTANCE = 'https://trypennie.my.salesforce.com'

/** The three real lost-lead addresses, as they arrived from the partner. */
const CURLY_EMAIL = 'tre’nae.ci@gmail.com'
const ACCENTED_EMAIL = 'ángel.bautista97.ab@gmail.com'
const GOOD_PHONE = '(574) 210-1143'

const INVALID_EMAIL_400 = JSON.stringify([
  { message: `Email: invalid email address: ${ACCENTED_EMAIL}`, errorCode: 'INVALID_EMAIL_ADDRESS', fields: ['Email__c'] },
])

function makeNode(config: Record<string, unknown>): NodeDefinition {
  return { id: 'sf1', namespace: 'create_prospect', type: 'salesforce', config }
}

function makeCtx(): ExecutionContext {
  return {
    trigger: {
      payload: {},
      source: 'test',
      workflow_id: 'wf-1',
      org_id: 'org-1',
      trace_id: 'tr-1',
      execution_id: 'exec-1',
    },
    steps: {},
    env: {
      SALESFORCE_CLIENT_ID: 'client-id',
      SALESFORCE_CLIENT_SECRET: 'client-secret',
      SALESFORCE_INSTANCE_URL: INSTANCE,
    },
    execution: { workflow_id: 'wf-1', trace_id: 'tr-1', execution_id: 'exec-1' },
  } as unknown as ExecutionContext
}

function makeEnv(secrets: Record<string, string> = {}): Env {
  return {
    WORKFLOW_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    SALESFORCE_CLIENT_ID: 'client-id',
    SALESFORCE_CLIENT_SECRET: 'client-secret',
    SALESFORCE_INSTANCE_URL: INSTANCE,
    ...secrets,
  } as unknown as Env
}

function mockResponse(status: number, body: string) {
  let parsed: unknown = null
  if (body) {
    try { parsed = JSON.parse(body) } catch { parsed = body }
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(parsed),
    headers: new Headers({ 'content-type': 'application/json' }),
  }
}

function mockTokenResponse() {
  return mockResponse(200, JSON.stringify({ access_token: 'sf-token-abc' }))
}

/** Body of the nth fetch call (0-based), parsed. */
function sentBody(fetchMock: FetchMock, n: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[n][1] as { body?: string }
  return JSON.parse(init.body ?? '{}') as Record<string, unknown>
}

describe('Salesforce node malformed-email recovery (#723)', () => {
  let fetchMock: FetchMock

  beforeEach(() => {
    fetchMock = stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // Dan's call, 2026-08-03 (#742): a damaged email is DROPPED, never rewritten.
  // Nothing is repaired on the way out, so the address the lead actually sent is
  // what Salesforce judges, and blanking happens only where Salesforce itself
  // names the field. That is the only point at which we know a field IS an email:
  // a value like Referrer__c "some@thing" is address-shaped and invalid too, and
  // blanking it on shape alone would destroy real data in a field we guessed at.
  it('sends a curly-apostrophe email exactly as it arrived, then drops it when Salesforce rejects it', async () => {
    const curlyRejection = JSON.stringify([
      { message: `Email: invalid email address: ${CURLY_EMAIL}`, errorCode: 'INVALID_EMAIL_ADDRESS', fields: ['Email__c'] },
    ])
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(400, curlyRejection))
      .mockResolvedValueOnce(mockResponse(201, '{"id":"SF-001"}'))

    const result = await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { Email__c: CURLY_EMAIL, Phone__c: GOOD_PHONE },
      }),
      makeCtx(),
      makeEnv(),
    )

    // Byte-identical on the wire: no quote rewriting, no trimming, no folding.
    expect(sentBody(fetchMock, 1).Email__c).toBe(CURLY_EMAIL)
    expect(sentBody(fetchMock, 2)).toEqual({ Email__c: '', Phone__c: GOOD_PHONE })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect((result.output as { status: number }).status).toBe(201)
    expect(result.logs?.some((l) => l.message.includes(CURLY_EMAIL))).toBe(true)
  })

  it('leaves a valid email untouched and makes exactly one call', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(201, '{"id":"SF-004"}'))

    const result = await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { Email__c: 'john@gmail.com', Phone__c: GOOD_PHONE },
      }),
      makeCtx(),
      makeEnv(),
    )

    expect(sentBody(fetchMock, 1).Email__c).toBe('john@gmail.com')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.logs ?? []).toEqual([])
    expect((result.output as { status: number }).status).toBe(201)
  })

  it('blanks an email Salesforce named, retries once, and keeps the lead', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(400, INVALID_EMAIL_400))
      .mockResolvedValueOnce(mockResponse(201, '{"id":"SF-002"}'))

    const result = await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { Email__c: ACCENTED_EMAIL, Phone__c: GOOD_PHONE, FirstName__c: 'Angel' },
      }),
      makeCtx(),
      makeEnv(),
    )

    // The retry blanks ONLY the field Salesforce named, and keeps everything else.
    expect(sentBody(fetchMock, 2)).toEqual({ Email__c: '', Phone__c: GOOD_PHONE, FirstName__c: 'Angel' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect((result.output as { status: number }).status).toBe(201)

    // The dropped address must be visible in the execution detail, naming both
    // the field and the original value, not silently swallowed.
    const warn = result.logs?.find((l) => l.message.includes('Email__c'))
    expect(warn?.level).toBe('warn')
    expect(warn?.message).toContain(ACCENTED_EMAIL)
  })

  // #2022: a recorded at-risk write must hold the body that is actually sent, so
  // an update the recovery blanks is reported again with the blanked body.
  it('reports the blanked body of an update it retries, so a recorded write matches what was sent', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(400, INVALID_EMAIL_400))
      .mockResolvedValueOnce(mockResponse(204, ''))
    const ctx = makeCtx()
    const notes: Array<{ body: Record<string, unknown> }> = []
    ctx.noteSalesforceRequest = (req) => { notes.push(req) }
    await executeSalesforceNode(
      makeNode({ operation: 'update', object: 'Prospect__c', record_id: 'SF-7', body: { Email__c: ACCENTED_EMAIL, Phone__c: GOOD_PHONE } }),
      ctx,
      makeEnv(),
    )
    expect(notes.map((n) => n.body)).toEqual([
      { Email__c: ACCENTED_EMAIL, Phone__c: GOOD_PHONE },
      { Email__c: '', Phone__c: GOOD_PHONE },
    ])
  })

  // #2022: the blanked resend may have landed when Salesforce answered it 5xx, so
  // the original 400 the node still throws must not read as a clean refusal.
  it('marks the error as possibly landed when the blanked resend got a transient answer', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(400, INVALID_EMAIL_400))
      .mockResolvedValueOnce(mockResponse(503, 'unavailable'))
    const err = await executeSalesforceNode(
      makeNode({ operation: 'update', object: 'Prospect__c', record_id: 'SF-7', body: { Email__c: ACCENTED_EMAIL, Phone__c: GOOD_PHONE } }),
      makeCtx(),
      makeEnv(),
    ).then(() => null, (e: Error & { status?: number; mayHaveLanded?: boolean }) => e)
    expect(err?.status).toBe(400)
    expect(err?.mayHaveLanded).toBe(true)
  })

  it('rejects with an explicit no-contact reason, and does not retry, when no phone survives', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(400, INVALID_EMAIL_400))

    let caught: (Error & { permanent?: boolean }) | undefined
    await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { Email__c: ACCENTED_EMAIL, Phone__c: '555-1143', FirstName__c: 'Angel' },
      }),
      makeCtx(),
      makeEnv(),
    ).catch((e: Error & { permanent?: boolean }) => { caught = e })

    expect(caught?.message).toContain('no usable contact method')
    expect(caught?.message).toContain(ACCENTED_EMAIL)
    expect(caught?.permanent).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2) // no pointless retry
    // Salesforce did answer the write, rejecting it, so the held write capture
    // stores it refused like any other rejection (#2054).
    expect(salesforceAnswerOf(caught)).toEqual({ status: 400, text: INVALID_EMAIL_400 })
  })

  it('throws the ORIGINAL Salesforce error when the retry also fails', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(400, INVALID_EMAIL_400))
      .mockResolvedValueOnce(mockResponse(400, '[{"message":"Required fields are missing: [LastName__c]","errorCode":"REQUIRED_FIELD_MISSING"}]'))

    let caught: (Error & { permanent?: boolean }) | undefined
    await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { Email__c: ACCENTED_EMAIL, Phone__c: GOOD_PHONE },
      }),
      makeCtx(),
      makeEnv(),
    ).catch((e: Error & { permanent?: boolean }) => { caught = e })

    // Diagnostics must not get worse than they were before this feature existed.
    expect(caught?.message).toContain('INVALID_EMAIL_ADDRESS')
    expect(caught?.permanent).toBe(true)
    expect(classifyStepError(caught)).toBe('permanent')
    expect(fetchMock).toHaveBeenCalledTimes(3) // exactly one retry, never two
  })

  it('leaves any other field-level rejection alone, so a clear error never becomes a confusing one', async () => {
    // A validation rule fired on the same field. Blanking it and retrying would
    // replace an accurate message with something that reads like a data bug, and
    // could even succeed by writing a record the rule exists to prevent.
    const validationError = JSON.stringify([
      { message: 'Email must be a company address', errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', fields: ['Email__c'] },
    ])
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(400, validationError))

    let caught: Error | undefined
    await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { Email__c: 'someone@gmail.com', Phone__c: GOOD_PHONE },
      }),
      makeCtx(),
      makeEnv(),
    ).catch((e: Error) => { caught = e })

    expect(caught?.message).toContain('FIELD_CUSTOM_VALIDATION_EXCEPTION')
    expect(fetchMock).toHaveBeenCalledTimes(2) // no blank-and-retry
  })

  it('never retries an apex call, whose side effects may already have fired', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(400, INVALID_EMAIL_400))

    let caught: Error | undefined
    await executeSalesforceNode(
      makeNode({
        operation: 'apex',
        apex_path: '/services/apexrest/prospect',
        body: { Email__c: ACCENTED_EMAIL, Phone__c: GOOD_PHONE },
      }),
      makeCtx(),
      makeEnv(),
    ).catch((e: Error) => { caught = e })

    expect(caught?.message).toContain('INVALID_EMAIL_ADDRESS')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('leaves a configured expected_errors rejection in charge, with no recovery attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(400, INVALID_EMAIL_400))

    const result = await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { Email__c: ACCENTED_EMAIL, Phone__c: GOOD_PHONE },
        expected_errors: [{ code: 'INVALID_EMAIL_ADDRESS' }],
      }),
      makeCtx(),
      makeEnv(),
    )

    expect(result.earlyExit).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('takes its own bulkhead slot for the retry, so it cannot slip past the concurrency cap', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(400, INVALID_EMAIL_400))
      .mockResolvedValueOnce(mockResponse(201, '{"id":"SF-003"}'))

    let acquires = 0
    let releases = 0
    const doFetch = vi.fn((url: string) => {
      const path = new URL(url).pathname
      if (path === '/acquire') {
        acquires++
        return Promise.resolve(new Response(JSON.stringify({ allowed: true, token: `t-${acquires}`, inflight: 1, limit: 20 })))
      }
      if (path === '/release') releases++
      return Promise.resolve(new Response(JSON.stringify({ ok: true })))
    })
    const env = makeEnv({ SALESFORCE_BULKHEAD_WAIT_MS: '0' })
    ;(env as unknown as { SALESFORCE_BULKHEAD: unknown }).SALESFORCE_BULKHEAD = {
      idFromName: vi.fn().mockReturnValue('id'),
      get: vi.fn().mockReturnValue({ fetch: doFetch }),
    }

    await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { Email__c: ACCENTED_EMAIL, Phone__c: GOOD_PHONE },
      }),
      makeCtx(),
      env,
    )

    expect(acquires).toBe(2)
    expect(releases).toBe(2)
  })
})
