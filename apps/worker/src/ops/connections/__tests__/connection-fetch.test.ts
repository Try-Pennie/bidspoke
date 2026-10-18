import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import {
  CONNECTION_FETCH_DEADLINE_MS, RATE_LIMIT_DEFAULT_MS, RETRY_AFTER_MAX_MS, SF_INTERACTIVE_WAIT_MS, SF_LEASE_TTL_SECONDS, STEP_LEASE_REQUEUE_MS,
  connectionFetch, type ConnectionCall,
} from '../connection-fetch'
import { ConnectionRefusal, LoginMintError, RequeueAt } from '../refusals'
import type { RecordedRequest } from '../sanitise'
import {
  ACCESS_TOKEN, CONN, ORG, OTHER_ORG, RENEWED_TOKEN, T0, exampleRules, makeDoubles, makeKeys, salesforceRules, sealLogin, usableCopy,
  type Recorder, type TestKeys,
} from './harness'

/**
 * connectionFetch (#2335, phase 5 of #1689): the one path for every connection
 * bound request on the ops Worker. Called by nothing in the deploy that adds
 * it; these tests are its whole proof until the OpsConnections entrypoint and
 * the ops executor call it.
 */

let keys: TestKeys
let envelope: SealedEnvelope
let sfEnvelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys)
  sfEnvelope = await sealLogin(keys, { service: 'salesforce' })
}, 120_000)

const SF_TARGET = { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'ops-client-id' }

function call(rec: Recorder, overrides: Partial<ConnectionCall> = {}): ConnectionCall {
  return {
    organizationId: ORG,
    connectionId: CONN,
    source: { kind: 'copy' },
    purpose: 'lookup',
    record: async (r: RecordedRequest) => {
      rec.events.push('record')
      rec.recorded.push(r)
    },
    ...overrides,
  }
}

async function refusal(promise: Promise<unknown>): Promise<ConnectionRefusal> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ConnectionRefusal) return err
    throw new Error(`expected a ConnectionRefusal, got ${String(err)}`, { cause: err })
  }
  throw new Error('expected a ConnectionRefusal, and the call answered')
}

describe('a usable copy', () => {
  it('records the sanitised request, then authorizes, then sends, and answers the response', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('{"ok":true}', { status: 200 }))
    const res = await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/v1/items?q=open', { method: 'GET' })
    expect(res).toBeInstanceOf(Response)
    expect(await (res as Response).json()).toEqual({ ok: true })
    expect(d.rec.events).toEqual(['record', 'authorize', 'send'])
    expect(d.rec.sent).toHaveLength(1)
    expect(new Headers(d.rec.sent[0].init.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(d.rec.sent[0].init.redirect).toBe('manual')
    expect(d.rec.recorded).toEqual([{ method: 'GET', url: 'https://api.example.test/v1/items?q=open', headers: {}, body: null, attempt: 1 }])
  })

  it('hands the auth the opened login, the copy\'s generation and target, as the committed credential', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x')
    const input = d.rec.authorizeCalls[0]
    expect(JSON.parse(input.login.plaintext)).toEqual({ api_key: expect.any(String) })
    expect(input).toMatchObject({ organizationId: ORG, connectionId: CONN, service: 'example', generation: 1, candidate: false, renew: null, target: { host: 'api.example.test' } })
  })

  it('never sends or records a credential header the caller set, and sends the connection\'s own', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x', {
      method: 'POST', headers: { Authorization: 'Bearer caller-held-token-123', 'x-api-key': 'caller-key-12345', 'content-type': 'application/json' }, body: '{}',
    })
    const sent = new Headers(d.rec.sent[0].init.headers)
    expect(sent.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(sent.get('x-api-key')).toBeNull()
    expect(sent.get('content-type')).toBe('application/json')
    expect(JSON.stringify(d.rec.recorded)).not.toContain('caller-held-token-123')
    expect(JSON.stringify(d.rec.recorded)).not.toContain('caller-key-12345')
  })

  it('declares that a scheduled read records nothing, and still sends', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    await connectionFetch(d.deps, call(d.rec, { purpose: 'connection_check', record: { recordsNothing: 'the still valid check stores only its outcome' } }), 'https://api.example.test/x')
    expect(d.rec.events).toEqual(['authorize', 'send'])
  })
})

describe('the order of checks: the copy first, then the envelope, then the host', () => {
  it.each([
    ['connection_removed', 'connection_removed'],
    ['connection_withdrawn', 'connection_withdrawn'],
    ['connection_copy_expired', 'connection_copy_expired'],
    ['not_found', 'connection_not_found'],
  ] as const)('a copy in state %s is refused as %s before anything is opened, recorded or sent', async (state, code) => {
    const d = makeDoubles(keys, usableCopy(envelope, { state, envelope: null }), (rec) => [exampleRules(rec)])
    const err = await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expect(err.code).toBe(code)
    expect(d.rec.events).toEqual([])
  })

  it('a copy the ops database cannot read is refused by name', async () => {
    const d = makeDoubles(keys, new Error('connection_copy failed (57014): canceling statement'), (rec) => [exampleRules(rec)])
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_copy_unreadable')
  })

  it('a service with no rules is refused by name', async () => {
    const d = makeDoubles(keys, usableCopy(envelope, { service: 'unlisted' }), (rec) => [exampleRules(rec)])
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_service_unknown')
  })

  it('an envelope sealed for another organization does not open (the AAD, not a filter)', async () => {
    const foreign = await sealLogin(keys, { organizationId: OTHER_ORG })
    const d = makeDoubles(keys, usableCopy(foreign), (rec) => [exampleRules(rec)])
    const err = await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expect(err.code).toBe('connection_seal_refused')
    expect(err.message).toMatch(/seal_unwrap_failed|seal_decrypt_failed/)
    expect(d.rec.events).toEqual([])
  })

  it('an envelope sealed for another generation does not open', async () => {
    const d = makeDoubles(keys, usableCopy(envelope, { generation: 2 }), (rec) => [exampleRules(rec)])
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_seal_refused')
  })

  it('a request to an undeclared host is refused by name, naming the host, before anything is recorded or sent', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    const err = await refusal(connectionFetch(d.deps, call(d.rec), 'https://evil.example.test/collect'))
    expect(err.code).toBe('connection_host_not_declared')
    expect(err.message).toContain('evil.example.test')
    expect(d.rec.events).toEqual([])
  })

  it('a look alike host is not the declared one', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    for (const url of ['https://api.example.test.evil.test/x', 'https://evil.test/api.example.test', 'https://api.example.test@evil.test/x']) {
      expect((await refusal(connectionFetch(d.deps, call(d.rec), url))).code).toBe('connection_host_not_declared')
    }
    expect(d.rec.sent).toEqual([])
  })

  it('refuses anything but https, and a URL that does not parse', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'http://api.example.test/x'))).code).toBe('connection_url_invalid')
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'not a url'))).code).toBe('connection_url_invalid')
  })

  it('a target the service cannot read its hosts from is refused by name', async () => {
    const d = makeDoubles(keys, usableCopy(envelope, { target: null }), (rec) => [exampleRules(rec)])
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_target_invalid')
  })

  it('refuses an organization that is not a uuid, and a step with no workflow', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    expect((await refusal(connectionFetch(d.deps, call(d.rec, { organizationId: 'nope' as typeof ORG }), 'https://api.example.test/x'))).code).toBe('connection_call_invalid')
    expect((await refusal(connectionFetch(d.deps, call(d.rec, { purpose: 'step' }), 'https://api.example.test/x'))).code).toBe('connection_call_invalid')
    expect((await refusal(connectionFetch(d.deps, call(d.rec, { purpose: 'lookup', workflowId: 'w' }), 'https://api.example.test/x'))).code).toBe('connection_call_invalid')
  })

  it('a recorder that fails stops the request before anything is sent (record first)', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    const err = await refusal(connectionFetch(d.deps, call(d.rec, { record: async () => { throw new Error('ledger down') } }), 'https://api.example.test/x'))
    expect(err.code).toBe('connection_record_failed')
    expect(d.rec.sent).toEqual([])
    expect(d.rec.authorizeCalls).toEqual([])
  })
})

describe('expiry: renew once, retry once, then needs_reauth', () => {
  it('a rejected token is renewed, naming the rejected authorization, and the request is retried once', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('expired', { status: 401 }), new Response('ok', { status: 200 }))
    const res = await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x', { method: 'POST', body: '{"a":1}' })
    expect((res as Response).status).toBe(200)
    expect(d.rec.events).toEqual(['record', 'authorize', 'send', 'record', 'renew', 'send'])
    expect(d.rec.authorizeCalls[1].renew).toEqual({ rejected: { headers: { authorization: `Bearer ${ACCESS_TOKEN}` }, secrets: [ACCESS_TOKEN] } })
    expect(new Headers(d.rec.sent[1].init.headers).get('authorization')).toBe(`Bearer ${RENEWED_TOKEN}`)
    expect(d.rec.sent[1].init.body).toBe('{"a":1}')
    expect((d.rec.recorded as RecordedRequest[]).map((r) => r.attempt)).toEqual([1, 2])
    expect(d.rec.needsReauth).toEqual([])
  })

  it('a second refusal is needs_reauth: recorded on the connection once, and two sends in all', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('expired', { status: 401 }))
    const err = await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expect(err.code).toBe('connection_needs_reauth')
    expect(d.rec.sent).toHaveLength(2)
    expect(d.rec.needsReauth).toEqual([{ organizationId: ORG, connectionId: CONN, cause: 'request_refused_after_renew' }])
  })

  it('a response the service does not declare as expiry is answered as is, however it looks', async () => {
    const d = makeDoubles(keys, usableCopy(sfEnvelope, { service: 'salesforce', target: SF_TARGET }), (rec) => [salesforceRules(rec)])
    d.respond(new Response('[{"errorCode":"INSUFFICIENT_ACCESS"}]', { status: 401 }))
    const res = await connectionFetch(d.deps, call(d.rec), 'https://trypennie.my.salesforce.com/services/data/v61.0/sobjects')
    expect((res as Response).status).toBe(401)
    expect(d.rec.sent).toHaveLength(1)
    expect(d.rec.needsReauth).toEqual([])
  })

  it('Salesforce INVALID_SESSION_ID renews once and retries once, with no needs_reauth', async () => {
    const d = makeDoubles(keys, usableCopy(sfEnvelope, { service: 'salesforce', target: SF_TARGET }), (rec) => [salesforceRules(rec)])
    d.respond(new Response('[{"errorCode":"INVALID_SESSION_ID","message":"Session expired or invalid"}]', { status: 401 }), new Response('{}', { status: 200 }))
    const res = await connectionFetch(d.deps, call(d.rec), 'https://trypennie.my.salesforce.com/services/data/v61.0/sobjects')
    expect((res as Response).status).toBe(200)
    expect(d.rec.authorizeCalls.map((c) => c.renew === null ? 'mint' : 'renew')).toEqual(['mint', 'renew'])
    expect(d.rec.needsReauth).toEqual([])
  })

  it('a single use body is never resent: an expiry with a stream body is refused by name after one send', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('expired', { status: 401 }))
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('row')); c.close() } })
    const err = await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/upload', { method: 'PUT', body }))
    expect(err.code).toBe('connection_body_not_resendable')
    expect(d.rec.sent).toHaveLength(1)
    expect(d.rec.needsReauth).toEqual([])
  })
})

describe('a 429 or Retry-After is a RequeueAt, never a sleep', () => {
  it('a 429 with Retry-After in seconds requeues at that time, and is not retried', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }))
    const res = await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x')
    expect(res).toBeInstanceOf(RequeueAt)
    expect((res as RequeueAt).notBefore.getTime()).toBe(T0 + 30_000)
    expect((res as RequeueAt).cause).toBe('rate_limited')
    expect(d.rec.sent).toHaveLength(1)
    expect(d.rec.slept).toEqual([])
  })

  it('a 429 with no Retry-After requeues after the stated default', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('slow down', { status: 429 }))
    expect(((await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x')) as RequeueAt).notBefore.getTime()).toBe(T0 + RATE_LIMIT_DEFAULT_MS)
  })

  it('a 503 with a Retry-After date requeues at that date, and an absurd one is held to the ceiling', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('busy', { status: 503, headers: { 'retry-after': new Date(T0 + 120_000).toUTCString() } }))
    expect(((await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x')) as RequeueAt).notBefore.getTime()).toBe(T0 + 120_000)
    d.respond(new Response('busy', { status: 429, headers: { 'retry-after': '999999' } }))
    expect(((await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x')) as RequeueAt).notBefore.getTime()).toBe(T0 + RETRY_AFTER_MAX_MS)
  })

  it('a 503 with no Retry-After is the caller\'s to judge, answered as is', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('down', { status: 503 }))
    expect(((await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x')) as Response).status).toBe(503)
  })
})

describe('the login: a refused mint is needs_reauth at once; a failing token endpoint is refresh_failing first (decision 2)', () => {
  function minting(fail: Error) {
    return (rec: Recorder) => [exampleRules(rec, async () => { rec.events.push('authorize'); throw fail })]
  }
  /** An auth that asked a token endpoint and was answered a token. */
  const freshMint = (rec: Recorder) => [exampleRules(rec, async (input) => {
    input.noteMint()
    return { headers: { authorization: 'Bearer minted-token-0123' }, secrets: ['minted-token-0123'] }
  })]

  it('a login the provider refused (invalid_grant, invalid_client) records needs_reauth with its reason and sends nothing', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), minting(new LoginMintError('refused', 'invalid_client')))
    const err = await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expect(err.code).toBe('connection_needs_reauth')
    expect(d.rec.needsReauth).toEqual([{ organizationId: ORG, connectionId: CONN, cause: 'login_refused: invalid_client' }])
    expect(d.rec.refreshes).toEqual([])
    expect(d.rec.sent).toEqual([])
  })

  it('a token endpoint that timed out or answered 5xx adds to the refresh streak and is unavailable, not needs_reauth', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), minting(new LoginMintError('unavailable', 'token_endpoint_5xx')))
    const err = await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expect(err.code).toBe('connection_auth_unavailable')
    expect(err.message).toContain('refresh_failing')
    expect(d.rec.refreshes).toEqual([{ organizationId: ORG, connectionId: CONN, result: { ok: false, cause: 'token_endpoint_5xx' } }])
    expect(d.rec.needsReauth).toEqual([])
    expect(d.rec.sent).toEqual([])
  })

  it('the failure that takes the streak past its bound is needs_reauth, written by the database, not again here', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), minting(new LoginMintError('unavailable', 'token_endpoint_timeout')))
    d.refreshAnswer('needs_reauth')
    const err = await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expect(err.code).toBe('connection_needs_reauth')
    expect(err.message).toContain('refresh_failing_exhausted')
    expect(d.rec.refreshes).toHaveLength(1)
    expect(d.rec.needsReauth).toEqual([])
  })

  it('a streak that cannot be recorded is reported, and the call is still unavailable rather than needs_reauth', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), minting(new LoginMintError('unavailable', 'token_endpoint_unreachable')))
    d.deps.recordRefresh = async () => { throw new Error('ops database down') }
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_auth_unavailable')
    expect(d.rec.reports).toEqual([{ event: 'refresh_unrecorded', connection_id: CONN, purpose: 'lookup' }])
  })

  it('a login that a token endpoint answered ends the streak; one read from the memo writes nothing', async () => {
    const minted = makeDoubles(keys, usableCopy(envelope), freshMint)
    expect(((await connectionFetch(minted.deps, call(minted.rec), 'https://api.example.test/x')) as Response).status).toBe(200)
    expect(minted.rec.refreshes).toEqual([{ organizationId: ORG, connectionId: CONN, result: { ok: true } }])

    const reused = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    await connectionFetch(reused.deps, call(reused.rec), 'https://api.example.test/x')
    expect(reused.rec.refreshes).toEqual([])
  })

  it('a failure to end the streak is reported and never changes the answer', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), freshMint)
    d.deps.recordRefresh = async () => { throw new Error('ops database down') }
    expect(((await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x')) as Response).status).toBe(200)
    expect(d.rec.reports).toEqual([{ event: 'refresh_unrecorded', connection_id: CONN, purpose: 'lookup' }])
  })

  it('a token endpoint that rate limited the mint is a RequeueAt at its time, and no failure', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), minting(new LoginMintError('rate_limited', 'token_endpoint_rate_limited', new Date(T0 + 45_000))))
    const res = await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x')
    expect(res).toBeInstanceOf(RequeueAt)
    expect((res as RequeueAt).notBefore.getTime()).toBe(T0 + 45_000)
    expect(d.rec.refreshes).toEqual([])
  })

  it('a mint our own rule refuses (F129) is refused by name, and is neither needs_reauth nor a refresh failure', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), minting(new LoginMintError('not_allowed', 'mailbox_not_allowed')))
    const err = await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))
    expect(err.code).toBe('connection_not_allowed')
    expect(err.message).toContain('mailbox_not_allowed')
    expect(d.rec.needsReauth).toEqual([])
    expect(d.rec.refreshes).toEqual([])
    expect(d.rec.sent).toEqual([])
  })

  it('a rule that could not be checked is its own refusal, and is not a refresh failure', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), minting(new LoginMintError('check_unavailable', 'delegation_allowlist_unreadable')))
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_auth_check_unavailable')
    expect(d.rec.refreshes).toEqual([])
    expect(d.rec.needsReauth).toEqual([])
  })

  it('any other failure of the auth is named, and is not needs_reauth', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), minting(new TypeError('cannot read properties of undefined')))
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_auth_failed')
    expect(d.rec.needsReauth).toEqual([])
    expect(d.rec.refreshes).toEqual([])
  })

  it('a LoginMintError\'s message is its kind and reason alone, so nothing a provider said can ride on it (F120)', () => {
    const err = new LoginMintError('refused', 'invalid_grant')
    expect(err.message).toBe('refused: invalid_grant')
    expect(Object.keys(err).sort()).toEqual(['kind', 'name', 'reason', 'retryAt'])
    expect(err.name).toBe('LoginMintError')
  })

  it('a failure to record needs_reauth is reported, and the refusal still stands', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), minting(new LoginMintError('refused', 'invalid_grant')))
    d.deps.recordNeedsReauth = async () => { throw new Error('ops database down') }
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_needs_reauth')
    expect(d.rec.reports).toEqual([{ event: 'needs_reauth_unrecorded', connection_id: CONN, purpose: 'lookup' }])
  })
})

describe('the network and the deadline', () => {
  it('a network failure is refused by name', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new TypeError('fetch failed'))
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_network_error')
  })

  it('a send that never answers is refused at the deadline, not left hanging', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.deps.deadlineMs = 20
    d.deps.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_timeout')
  })

  it('a mint that never answers is refused at the deadline too', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec, () => new Promise(() => {}))])
    d.deps.deadlineMs = 20
    expect((await refusal(connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x'))).code).toBe('connection_timeout')
    expect(d.rec.sent).toEqual([])
  })

  it('a caller that gives up is answered as aborted, never as a timeout', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    const controller = new AbortController()
    d.deps.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      controller.abort()
    })
    expect((await refusal(connectionFetch(d.deps, call(d.rec, { signal: controller.signal }), 'https://api.example.test/x'))).code).toBe('connection_aborted')
  })

  it('states a deadline the Salesforce lease outlives', () => {
    expect(SF_LEASE_TTL_SECONDS * 1000).toBeGreaterThan(CONNECTION_FETCH_DEADLINE_MS)
  })
})

describe('a candidate: a credential bidding has not committed, verified in memory only (F116, F126)', () => {
  it('a reconnect\'s new generation is used from the call while the copy still holds the old one, and writes nothing on ops', async () => {
    const next = await sealLogin(keys, { generation: 2 })
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    const res = await connectionFetch(d.deps, call(d.rec, {
      purpose: 'reconnect',
      source: { kind: 'candidate', candidate: { service: 'example', generation: 2, envelope: next, target: { host: 'api.example.test' }, publicConfig: {} } },
    }), 'https://api.example.test/x')
    expect((res as Response).status).toBe(200)
    expect(d.rec.authorizeCalls[0]).toMatchObject({ generation: 2, candidate: true })
    // The deps carry no write to connection_copies at all: the type has none, and this is the only health write.
    expect(Object.keys(d.deps).filter((k) => /save|copies/i.test(k))).toEqual([])
  })

  it('a candidate that fails verify leaves the committed connection untouched: no needs_reauth on ops', async () => {
    const next = await sealLogin(keys, { generation: 2 })
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('bad credential', { status: 401 }))
    const err = await refusal(connectionFetch(d.deps, call(d.rec, {
      purpose: 'verify',
      source: { kind: 'candidate', candidate: { service: 'example', generation: 2, envelope: next, target: { host: 'api.example.test' }, publicConfig: {} } },
    }), 'https://api.example.test/x'))
    expect(err.code).toBe('connection_needs_reauth')
    expect(d.rec.needsReauth).toEqual([])
  })

  it('a candidate whose login the provider refuses writes no needs_reauth either', async () => {
    const next = await sealLogin(keys, { generation: 2 })
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec, async () => { throw new LoginMintError('refused', 'invalid_client') })])
    expect((await refusal(connectionFetch(d.deps, call(d.rec, {
      purpose: 'verify',
      source: { kind: 'candidate', candidate: { service: 'example', generation: 2, envelope: next, target: { host: 'api.example.test' }, publicConfig: {} } },
    }), 'https://api.example.test/x'))).code).toBe('connection_needs_reauth')
    expect(d.rec.needsReauth).toEqual([])
  })

  it('a candidate whose token endpoint fails, or works, writes nothing about the refresh streak', async () => {
    const next = await sealLogin(keys, { generation: 2 })
    const candidate = { kind: 'candidate' as const, candidate: { service: 'example', generation: 2, envelope: next, target: { host: 'api.example.test' }, publicConfig: {} } }
    const failing = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec, async () => { throw new LoginMintError('unavailable', 'token_endpoint_timeout') })])
    expect((await refusal(connectionFetch(failing.deps, call(failing.rec, { purpose: 'verify', source: candidate }), 'https://api.example.test/x'))).code)
      .toBe('connection_auth_unavailable')
    expect(failing.rec.refreshes).toEqual([])
    const working = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec, async (input) => {
      input.noteMint()
      return { headers: { authorization: 'Bearer minted-token-0123' }, secrets: ['minted-token-0123'] }
    })])
    await connectionFetch(working.deps, call(working.rec, { purpose: 'verify', source: candidate }), 'https://api.example.test/x')
    expect(working.rec.refreshes).toEqual([])
  })

  it('a create\'s first verify needs no copy at all', async () => {
    const d = makeDoubles(keys, usableCopy(envelope, { state: 'not_found', envelope: null, service: null, generation: null }), (rec) => [exampleRules(rec)])
    const res = await connectionFetch(d.deps, call(d.rec, {
      purpose: 'verify',
      source: { kind: 'candidate', candidate: { service: 'example', generation: 1, envelope, target: { host: 'api.example.test' }, publicConfig: {} } },
    }), 'https://api.example.test/x')
    expect((res as Response).status).toBe(200)
  })

  it('a candidate may replace a copy past serve_until or withdrawn', async () => {
    const next = await sealLogin(keys, { generation: 2 })
    for (const state of ['connection_copy_expired', 'connection_withdrawn'] as const) {
      const d = makeDoubles(keys, usableCopy(envelope, { state, envelope: null }), (rec) => [exampleRules(rec)])
      const res = await connectionFetch(d.deps, call(d.rec, {
        purpose: 'reconnect',
        source: { kind: 'candidate', candidate: { service: 'example', generation: 2, envelope: next, target: { host: 'api.example.test' }, publicConfig: {} } },
      }), 'https://api.example.test/x')
      expect((res as Response).status).toBe(200)
    }
  })

  it('refuses a generation older than the copy, a removed connection, another service, and any purpose but verify or reconnect', async () => {
    const d = makeDoubles(keys, usableCopy(envelope, { generation: 3 }), (rec) => [exampleRules(rec)])
    const candidate = { service: 'example', generation: 2, envelope, target: { host: 'api.example.test' }, publicConfig: {} }
    expect((await refusal(connectionFetch(d.deps, call(d.rec, { purpose: 'reconnect', source: { kind: 'candidate', candidate } }), 'https://api.example.test/x'))).code).toBe('connection_generation_older')
    d.setCopy(usableCopy(envelope, { state: 'connection_removed', envelope: null }))
    expect((await refusal(connectionFetch(d.deps, call(d.rec, { purpose: 'verify', source: { kind: 'candidate', candidate: { ...candidate, generation: 9 } } }), 'https://api.example.test/x'))).code).toBe('connection_removed')
    d.setCopy(usableCopy(envelope, { service: 'other' }))
    expect((await refusal(connectionFetch(d.deps, call(d.rec, { purpose: 'verify', source: { kind: 'candidate', candidate: { ...candidate, generation: 9 } } }), 'https://api.example.test/x'))).code).toBe('connection_service_mismatch')
    d.setCopy(usableCopy(envelope))
    for (const purpose of ['lookup', 'connection_check', 'sf_limits'] as const) {
      expect((await refusal(connectionFetch(d.deps, call(d.rec, { purpose, source: { kind: 'candidate', candidate } }), 'https://api.example.test/x'))).code).toBe('connection_candidate_not_allowed')
    }
    expect(d.rec.sent).toEqual([])
  })
})

describe('the Salesforce lease lives inside connectionFetch (L621)', () => {
  const sfCopy = () => usableCopy(sfEnvelope, { service: 'salesforce', target: SF_TARGET })
  const SF_URL = 'https://trypennie.my.salesforce.com/services/data/v61.0/sobjects'

  it('a lookup takes a lease before sending and releases it after', async () => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    await connectionFetch(d.deps, call(d.rec), SF_URL)
    expect(d.rec.events).toEqual(['acquire', 'record', 'authorize', 'send', 'release'])
    expect(d.rec.leases[0]).toEqual({ op: 'acquire', purpose: 'lookup', holder: 'holder-1', bootstrapHost: undefined, workflowId: undefined })
    expect(d.rec.leases[1]).toEqual({ op: 'release', holder: 'holder-1' })
  })

  it('verify names its declared instance host for the bootstrap slot; no other purpose does', async () => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    await connectionFetch(d.deps, call(d.rec, { purpose: 'verify' }), SF_URL)
    await connectionFetch(d.deps, call(d.rec, { purpose: 'connection_check', record: { recordsNothing: 'outcome only' } }), SF_URL)
    const acquires = d.rec.leases.filter((l) => l.op === 'acquire')
    expect(acquires.map((l) => [l.purpose, l.op === 'acquire' ? l.bootstrapHost : null])).toEqual([['verify', 'trypennie.my.salesforce.com'], ['connection_check', undefined]])
  })

  it('a step names its workflow, and one lease covers the renewal and the retry', async () => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    d.respond(new Response('[{"errorCode":"INVALID_SESSION_ID"}]', { status: 401 }), new Response('{}', { status: 200 }))
    await connectionFetch(d.deps, call(d.rec, { purpose: 'step', workflowId: 'wf-1' }), SF_URL)
    expect(d.rec.events.filter((e) => e === 'acquire' || e === 'release')).toEqual(['acquire', 'release'])
    expect(d.rec.leases[0]).toMatchObject({ purpose: 'step', workflowId: 'wf-1' })
    expect(d.rec.sent).toHaveLength(2)
  })

  it('releases the lease when the send fails', async () => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    d.respond(new TypeError('fetch failed'))
    await refusal(connectionFetch(d.deps, call(d.rec), SF_URL))
    expect(d.rec.events.at(-1)).toBe('release')
  })

  it('a non Salesforce service takes no lease', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    await connectionFetch(d.deps, call(d.rec), 'https://api.example.test/x')
    expect(d.rec.leases).toEqual([])
  })

  it.each(['lookup', 'verify', 'reconnect'] as const)('%s waits the stated time on a full pool, then is refused as sf_pool_busy, sending nothing', async (purpose) => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    const retryAt = new Date(T0 + 30_000).toISOString()
    d.leaseAnswers({ outcome: 'pool_full', retryAt })
    const err = await refusal(connectionFetch(d.deps, call(d.rec, { purpose }), SF_URL))
    expect(err.code).toBe('sf_pool_busy')
    expect(err.retryAt?.toISOString()).toBe(retryAt)
    expect(d.rec.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(SF_INTERACTIVE_WAIT_MS)
    expect(d.rec.sent).toEqual([])
    expect(d.rec.leases.filter((l) => l.op === 'release')).toEqual([])
  })

  it('an interactive call granted while it waits goes ahead', async () => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    d.leaseAnswers(
      { outcome: 'purpose_share_full', retryAt: new Date(T0 + 1_000).toISOString() },
      { outcome: 'granted', leaseId: 'l-2', expiresAt: new Date(T0 + 90_000).toISOString(), pool: 'org' },
    )
    expect(((await connectionFetch(d.deps, call(d.rec), SF_URL)) as Response).status).toBe(200)
    expect(d.rec.slept.length).toBe(1)
  })

  it.each(['sf_org_unmeasured', 'sf_cap_unset', 'sf_purpose_cap_unset', 'sf_budget_floor', 'sf_budget_unmeasured'] as const)(
    'an interactive call refused with %s is refused by that name at once', async (outcome) => {
      const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
      d.leaseAnswers({ outcome, retryAt: null })
      expect((await refusal(connectionFetch(d.deps, call(d.rec), SF_URL))).code).toBe(outcome)
      expect(d.rec.slept).toEqual([])
    },
  )

  it('a scheduled read is refused at once on a full pool, never waits', async () => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    d.leaseAnswers({ outcome: 'pool_full', retryAt: new Date(T0 + 5_000).toISOString() })
    expect((await refusal(connectionFetch(d.deps, call(d.rec, { purpose: 'sf_limits', record: { recordsNothing: 'writes only the reading' } }), SF_URL))).code).toBe('sf_pool_busy')
    expect(d.rec.slept).toEqual([])
  })

  it('a step refused a lease is a RequeueAt carrying the refusal and its time, never a wait', async () => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    d.leaseAnswers({ outcome: 'workflow_share_full', retryAt: new Date(T0 + 12_000).toISOString() })
    const res = await connectionFetch(d.deps, call(d.rec, { purpose: 'step', workflowId: 'wf-1' }), SF_URL)
    expect(res).toBeInstanceOf(RequeueAt)
    expect(res).toMatchObject({ cause: 'workflow_share_full' })
    expect((res as RequeueAt).notBefore.getTime()).toBe(T0 + 12_000)
    d.leaseAnswers({ outcome: 'sf_cap_unset', retryAt: null })
    const unset = await connectionFetch(d.deps, call(d.rec, { purpose: 'step', workflowId: 'wf-1' }), SF_URL)
    expect((unset as RequeueAt).notBefore.getTime()).toBe(T0 + STEP_LEASE_REQUEUE_MS)
    expect(d.rec.slept).toEqual([])
    expect(d.rec.sent).toEqual([])
  })

  it('an acquire that errors requeues a step (acquire_error) and refuses an interactive call by name', async () => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    d.leaseAnswers(new Error('acquire_sf_lease passed its 9000 ms deadline and may still have committed'))
    const res = await connectionFetch(d.deps, call(d.rec, { purpose: 'step', workflowId: 'wf-1' }), SF_URL)
    expect(res).toMatchObject({ cause: 'acquire_error' })
    expect((await refusal(connectionFetch(d.deps, call(d.rec), SF_URL))).code).toBe('sf_lease_unavailable')
  })

  it('a release that fails is reported, and the answer stands', async () => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    d.deps.releaseSfLease = async () => { throw new Error('release_sf_lease failed') }
    expect(((await connectionFetch(d.deps, call(d.rec), SF_URL)) as Response).status).toBe(200)
    expect(d.rec.reports).toEqual([{ event: 'sf_lease_release_failed', connection_id: CONN, purpose: 'lookup' }])
  })

  it('the lease is taken after the copy, the envelope and the host have all passed', async () => {
    const d = makeDoubles(keys, sfCopy(), (rec) => [salesforceRules(rec)])
    await refusal(connectionFetch(d.deps, call(d.rec), 'https://evil.example.test/x'))
    expect(d.rec.leases).toEqual([])
  })
})
