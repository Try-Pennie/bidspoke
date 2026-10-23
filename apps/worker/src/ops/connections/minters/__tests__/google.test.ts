import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import type { ServiceSchema } from '@bidspoke/service-catalogue/schema'
import type { OrganizationId } from '../../../ops-db'
import type { DelegationCheckOutcome } from '../../../run-vocabulary'
import { connectionFetch, type ConnectionCall } from '../../connection-fetch'
import { ConnectionRefusal, RequeueAt } from '../../refusals'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type Recorder, type TestKeys } from '../../__tests__/harness'
import { GOOGLE_TOKEN_URI, googleDelegationAuth } from '../google'
import { makeSigningKey, readJwt, rulesOf, tokenEndpoint, type SigningKey, type TokenEndpoint } from './minter-harness'

/**
 * The Google domain wide delegation minter (#2335, PR 4 of phase 5; finding
 * F129; Dan's decision 11). The ops service account may act as any mailbox in
 * the Workspace for the granted scopes, so before any token is minted or
 * reused the connection's mailbox and drives must be on the organization's own
 * allowlist (google_delegation_check), and the scopes asked for are only those
 * the catalogue's Google actions declare.
 *
 * The service account's key is the ops Worker's own secret (GOOGLE_DELEGATION_KEY,
 * #2337), never a connection's login: the key can act as anyone in the
 * Workspace, so it is not handed to whoever adds a connection, and the settled
 * form asks only for the mailbox (D16). A Google connection's sealed login is
 * empty, and anything in it is never read.
 */

const SHEETS = 'https://www.googleapis.com/auth/spreadsheets'
const DRIVE = 'https://www.googleapis.com/auth/drive'
/** A catalogue with Google actions narrower than the shipped one, so the scope list is the catalogue's and nobody else's. */
const CATALOGUE: readonly ServiceSchema[] = [
  {
    key: 'google_sheets',
    name: 'Google Sheets',
    actions: [
      { key: 'google_sheets.append', name: 'Append', version: 1, arguments: [], sideEffect: true, idempotent: false, idempotentBecause: 'appends', googleScopes: [SHEETS] },
      { key: 'google_sheets.read', name: 'Read', version: 1, arguments: [], sideEffect: false, idempotent: true, idempotentBecause: 'a read', googleScopes: [SHEETS, DRIVE] },
    ],
    // Only the scopes are read here; the Google connection is declared when Google ships (#2337).
    connection: { tile: 'A test Google service', auth: 'service_account_delegation', fields: [] },
  },
]
const TARGET = { subject: 'Ops@Example.invalid', drives: ['0AbCdEfGhIjKlMnOpQ'] }
const URL_ = 'https://sheets.googleapis.com/v4/spreadsheets/abc/values/A1:append'

let keys: TestKeys
let signing: SigningKey
let envelope: SealedEnvelope
let serviceAccount: Record<string, string>

beforeAll(async () => {
  keys = await makeKeys()
  signing = await makeSigningKey()
  serviceAccount = {
    type: 'service_account',
    client_email: 'bidspoke-ops@ops-project.iam.gserviceaccount.com',
    private_key_id: 'canary-key-id-0001',
    private_key: signing.pem,
    token_uri: 'https://oauth2.googleapis.com/token',
  }
  // A Google connection's sealed login is empty: the key is the ops Worker's secret.
  envelope = await sealLogin(keys, { service: 'google_sheets', plaintext: '{}' })
}, 120_000)

interface Setup {
  allowed?: (mailbox: string, drives: readonly string[]) => DelegationCheckOutcome | Error
  login?: SealedEnvelope
  target?: unknown
  catalogue?: readonly ServiceSchema[] | 'shipped'
  tokenTimeoutMs?: number
  /** The ops Worker's GOOGLE_DELEGATION_KEY, as its text; null for unset. The account's key unless a test says. */
  key?: string | null
}

function setup(endpoint: TokenEndpoint, opts: Setup = {}) {
  let now = T0
  const checks: Array<{ organizationId: OrganizationId; mailbox: string; drives: readonly string[] }> = []
  const allowed = { fn: opts.allowed ?? ((mailbox: string) => (mailbox === 'ops@example.invalid' ? 'allowed' : 'mailbox_not_allowed')) }
  const auth = googleDelegationAuth({
    now: () => now,
    tokenTimeoutMs: opts.tokenTimeoutMs,
    serviceAccountKey: () => (opts.key === undefined ? JSON.stringify(serviceAccount) : opts.key ?? undefined),
    ...(opts.catalogue === 'shipped' ? {} : { catalogue: opts.catalogue ?? CATALOGUE }),
    checkDelegation: async (organizationId, mailbox, drives) => {
      checks.push({ organizationId, mailbox, drives })
      const answer = allowed.fn(mailbox, drives)
      if (answer instanceof Error) throw answer
      return answer
    },
  })
  // The grant goes through connectionFetch's fetch (#2337), so the entry declares Google's token host beside the API's.
  const d = makeDoubles(keys, usableCopy(opts.login ?? envelope, { service: 'google_sheets', target: opts.target ?? TARGET }), () => [
    rulesOf('google_sheets', auth, () => ['sheets.googleapis.com', 'oauth2.googleapis.com']),
  ], endpoint.fetch)
  return { d, checks, allowed, advance: (ms: number) => { now += ms; d.now.value = now } }
}

function call(rec: Recorder, overrides: Partial<ConnectionCall> = {}): ConnectionCall {
  return { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'step', workflowId: '44444444-4444-4444-8444-444444444444', record: async (r) => { rec.recorded.push(r) }, ...overrides }
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

const tokenOk = (token: string, expiresIn = 3599) => Response.json({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' })
const bearer = (d: ReturnType<typeof setup>['d'], i: number) => new Headers(d.rec.sent[i].init.headers).get('authorization')

describe('the Google minter: domain wide delegation for an allowed mailbox', () => {
  it('checks the allowlist, then asks Google for a token acting as the mailbox with only the catalogue\'s scopes', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.canary-google-0001'))
    const { d, checks } = setup(endpoint)
    expect(((await connectionFetch(d.deps, call(d.rec), URL_, { method: 'POST', body: '{}' })) as Response).status).toBe(200)
    expect(checks).toEqual([{ organizationId: ORG, mailbox: 'ops@example.invalid', drives: ['0AbCdEfGhIjKlMnOpQ'] }])
    expect(endpoint.calls).toHaveLength(1)
    expect(endpoint.calls[0].url).toBe(GOOGLE_TOKEN_URI)
    expect(endpoint.calls[0].body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const assertion = await readJwt(endpoint.calls[0].body.get('assertion')!, signing.publicKey)
    expect(assertion.verified).toBe(true)
    expect(assertion.payload).toMatchObject({
      iss: 'bidspoke-ops@ops-project.iam.gserviceaccount.com',
      sub: 'ops@example.invalid',
      scope: `${DRIVE} ${SHEETS}`,
      aud: GOOGLE_TOKEN_URI,
      iat: T0 / 1000,
      exp: T0 / 1000 + 3600,
    })
    expect(bearer(d, 0)).toBe('Bearer ya29.canary-google-0001')
    expect(d.rec.refreshes).toEqual([{ organizationId: ORG, connectionId: CONN, result: { ok: true } }])
  })

  it('a mailbox outside the organization\'s allowlist is refused at mint by name: no token asked for, nothing sent (F129, attempted)', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.must-never-be-minted'))
    const { d, checks } = setup(endpoint, { target: { subject: 'ceo@example.invalid' } })
    const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect(err.code).toBe('connection_not_allowed')
    expect(err.message).toContain('mailbox_not_allowed')
    expect(checks).toEqual([{ organizationId: ORG, mailbox: 'ceo@example.invalid', drives: [] }])
    expect(endpoint.calls).toEqual([])
    expect(d.rec.sent).toEqual([])
    expect(d.rec.needsReauth).toEqual([])
    expect(d.rec.refreshes).toEqual([])
  })

  it('a save is refused the same way: verify passes the new credential as a candidate, and the check runs before its mint (F129)', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.must-never-be-minted'))
    const { d, checks } = setup(endpoint)
    const candidate = { service: 'google_sheets', generation: 1, envelope, target: { subject: 'ceo@example.invalid' }, publicConfig: {} }
    const err = await refusal(connectionFetch(d.deps, call(d.rec, { purpose: 'verify', workflowId: undefined, source: { kind: 'candidate', candidate } }), URL_))
    expect([err.code, err.message.includes('mailbox_not_allowed')]).toEqual(['connection_not_allowed', true])
    expect(checks.map((c) => c.mailbox)).toEqual(['ceo@example.invalid'])
    expect(endpoint.calls).toEqual([])
  })

  it('a drive outside the allowlist is refused by name too', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.must-never-be-minted'))
    const { d } = setup(endpoint, { allowed: () => 'drive_not_allowed' })
    const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect([err.code, err.message.includes('drive_not_allowed')]).toEqual(['connection_not_allowed', true])
    expect(endpoint.calls).toEqual([])
  })

  it('a mailbox taken off the list stops at once: the check comes before a held token is reused', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.canary-google-0001'))
    const { d, allowed } = setup(endpoint)
    await connectionFetch(d.deps, call(d.rec), URL_)
    allowed.fn = () => 'mailbox_not_allowed'
    expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_not_allowed')
    expect(d.rec.sent).toHaveLength(1)
  })

  it('an allowlist that cannot be read refuses the call by its own name, and is not a refresh failure', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.canary-google-0001'))
    const { d } = setup(endpoint, { allowed: () => new Error('ops database down') })
    expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_auth_check_unavailable')
    expect(endpoint.calls).toEqual([])
    expect(d.rec.refreshes).toEqual([])
  })

  it('with the shipped catalogue it asks Google for exactly the four granted scopes its Google actions declare (#2337)', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.canary-google-0001'))
    const { d } = setup(endpoint, { catalogue: 'shipped' })
    await connectionFetch(d.deps, call(d.rec), URL_)
    const assertion = await readJwt(endpoint.calls[0].body.get('assertion')!, signing.publicKey)
    expect(String(assertion.payload.scope).split(' ')).toEqual([
      'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/spreadsheets',
    ])
  })

  it('a catalogue with no Google scope refuses every mint by name', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.must-never-be-minted'))
    const { d } = setup(endpoint, { catalogue: [] })
    const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect(err.code).toBe('connection_not_allowed')
    expect(err.message).toContain('no_delegation_scopes')
    expect(endpoint.calls).toEqual([])
  })

  it('with no service account key set on the ops Worker, every mint is refused by name, and nothing is recorded against the connection', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.must-never-be-minted'))
    const { d } = setup(endpoint, { key: null })
    const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect([err.code, err.message.includes('delegation_key_unset')]).toEqual(['connection_not_allowed', true])
    expect(endpoint.calls).toEqual([])
    expect(d.rec.needsReauth).toEqual([])
    expect(d.rec.refreshes).toEqual([])
  })

  it('a service account key that is not one is refused by name, and is not the connection\'s fault', async () => {
    for (const key of ['not json', JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com' }), JSON.stringify({ ...serviceAccount, private_key: 'not a pem' })]) {
      const endpoint = tokenEndpoint(tokenOk('ya29.must-never-be-minted'))
      const { d } = setup(endpoint, { key })
      const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
      expect([err.code, err.message.includes('delegation_key_malformed')]).toEqual(['connection_not_allowed', true])
      expect(endpoint.calls).toEqual([])
      expect(d.rec.needsReauth).toEqual([])
    }
  })

  it('never reads a key from the connection\'s sealed login: only the ops Worker\'s key signs', async () => {
    const other = await makeSigningKey()
    const sealedKey = await sealLogin(keys, { service: 'google_sheets', plaintext: JSON.stringify({ ...serviceAccount, client_email: 'pasted@elsewhere.iam.gserviceaccount.com', private_key: other.pem }) })
    const endpoint = tokenEndpoint(tokenOk('ya29.canary-google-0001'))
    const { d } = setup(endpoint, { login: sealedKey })
    await connectionFetch(d.deps, call(d.rec), URL_)
    const assertion = await readJwt(endpoint.calls[0].body.get('assertion')!, signing.publicKey)
    expect([assertion.verified, assertion.payload.iss]).toEqual([true, 'bidspoke-ops@ops-project.iam.gserviceaccount.com'])
  })

  it('two mailboxes through one connection never share a token', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.for-ops-0001'), tokenOk('ya29.for-sales-0002'))
    const { d, allowed } = setup(endpoint)
    allowed.fn = () => 'allowed'
    await connectionFetch(d.deps, call(d.rec), URL_)
    d.setCopy(usableCopy(envelope, { service: 'google_sheets', target: { subject: 'sales@example.invalid' } }))
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect([bearer(d, 0), bearer(d, 1)]).toEqual(['Bearer ya29.for-ops-0001', 'Bearer ya29.for-sales-0002'])
    expect(endpoint.calls.map((c) => c.body.get('assertion')).every((a) => a !== null)).toBe(true)
  })

  it('reuses the token while it has life, and asks again once Google\'s expires_in has run out (the expired token)', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.first-0001', 600), tokenOk('ya29.second-0002'))
    const { d, advance } = setup(endpoint)
    await connectionFetch(d.deps, call(d.rec), URL_)
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect(endpoint.calls).toHaveLength(1)
    advance(600_000)
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect(endpoint.calls).toHaveLength(2)
    expect(bearer(d, 2)).toBe('Bearer ya29.second-0002')
  })

  it('a 401 on the request renews once and retries once', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.first-0001'), tokenOk('ya29.second-0002'))
    const { d } = setup(endpoint)
    d.respond(Response.json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, { status: 401 }), new Response('{}', { status: 200 }))
    expect(((await connectionFetch(d.deps, call(d.rec), URL_)) as Response).status).toBe(200)
    expect([bearer(d, 0), bearer(d, 1)]).toEqual(['Bearer ya29.first-0001', 'Bearer ya29.second-0002'])
    expect(d.rec.needsReauth).toEqual([])
  })

  it.each([
    ['unauthorized_client', Response.json({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' }, { status: 401 })],
    ['invalid_grant', Response.json({ error: 'invalid_grant', error_description: 'Invalid email or User ID' }, { status: 400 })],
  ] as const)('a refused login (%s) is needs_reauth at once', async (reason, answer) => {
    const { d } = setup(tokenEndpoint(answer))
    expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_needs_reauth')
    expect(d.rec.needsReauth).toEqual([{ organizationId: ORG, connectionId: CONN, cause: `login_refused: ${reason}` }])
    expect(d.rec.sent).toEqual([])
  })

  it('a token endpoint that times out is refresh_failing, not needs_reauth', async () => {
    const { d } = setup(tokenEndpoint('hang'), { tokenTimeoutMs: 10 })
    expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_auth_unavailable')
    expect(d.rec.refreshes).toEqual([{ organizationId: ORG, connectionId: CONN, result: { ok: false, cause: 'token_endpoint_timeout' } }])
    expect(d.rec.needsReauth).toEqual([])
  })

  it('a token endpoint answering 429 is a RequeueAt at its time', async () => {
    const { d } = setup(tokenEndpoint(new Response('rate', { status: 429, headers: { 'retry-after': '60' } })))
    const res = await connectionFetch(d.deps, call(d.rec), URL_)
    expect(res).toBeInstanceOf(RequeueAt)
    expect((res as RequeueAt).notBefore.getTime()).toBe(T0 + 60_000)
    expect(d.rec.refreshes).toEqual([])
  })

  it('a key whose token_uri is not Google\'s is refused before the signed assertion goes anywhere', async () => {
    const endpoint = tokenEndpoint(tokenOk('ya29.must-never-be-minted'))
    const { d } = setup(endpoint, { key: JSON.stringify({ ...serviceAccount, token_uri: 'https://collector.example.test/token' }) })
    const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect([err.code, err.message.includes('delegation_key_malformed')]).toEqual(['connection_not_allowed', true])
    expect(endpoint.calls).toEqual([])
    expect(d.rec.needsReauth).toEqual([])
  })

  it('a target that names no mailbox, or drives that are not a list, is refused by rule before the allowlist is read', async () => {
    for (const target of [{}, { subject: 'not-an-address' }, { subject: 'ops@example.invalid', drives: 'all' }]) {
      const endpoint = tokenEndpoint(tokenOk('ya29.must-never-be-minted'))
      const { d, checks } = setup(endpoint, { target })
      const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
      expect([err.code, err.message.includes('target_invalid')]).toEqual(['connection_not_allowed', true])
      expect(checks).toEqual([])
      expect(endpoint.calls).toEqual([])
    }
  })
})
