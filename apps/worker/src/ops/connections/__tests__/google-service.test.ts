/**
 * The ops Google service (#2337): a company mailbox on the organization's
 * list, acted as through domain wide delegation by the ops service account,
 * whose key is the ops Worker's own secret. Driven through the real verify,
 * connectionFetch, seal and delegation minter, with the ops database, the
 * token endpoint and Google as doubles.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { connectionFetch, type ConnectionCall } from '../connection-fetch'
import { GOOGLE_HOSTS, GOOGLE_OWN_ACCOUNT_TARGET, googleIdentity, googleOwnAccount, googleServiceEntry } from '../google-service'
import { GOOGLE_TOKEN_URI, googleTokenMemo } from '../minters/google'
import type { TokenObjects } from '../minters/oauth-user'
import type { OpsConnectionsDeps } from '../ops-connections'
import { exchangeConnectionCode, verifyConnection } from '../ops-connections'
import type { AccessTokenRequest, ExchangeRequest } from '../token-object-contract'
import type { Authorization } from '../service-rules'
import { opsServiceRegistry, registeredOpsServices } from '../services'
import type { DelegationCheckOutcome } from '../../run-vocabulary'
import { makeSigningKey, tokenEndpoint, type SigningKey, type TokenEndpoint } from '../minters/__tests__/minter-harness'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type Doubles, type TestKeys } from './harness'

const MAILBOX = 'ops@trypennie.example'
const TARGET = { subject: 'Ops@TryPennie.example' }

/** A person bound login's token objects: every access token request answered in order (the last repeats). */
function tokenObjects(...tokens: string[]): TokenObjects & { access: AccessTokenRequest[]; exchanges: ExchangeRequest[] } {
  const access: AccessTokenRequest[] = []
  const exchanges: ExchangeRequest[] = []
  return {
    access,
    exchanges,
    get: () => ({
      accessToken: async (request) => {
        access.push(request)
        const value = tokens.length > 1 ? tokens.shift()! : tokens[0]
        return { ok: true, token: value, tokenId: `id-of-${value}`, expiresAtMs: T0 + 3_600_000, minted: true }
      },
      exchange: async (request) => {
        exchanges.push(request)
        return { ok: true, generation: 2, account: 'dan@trypennie.example' }
      },
    }),
  }
}

const noTokenObjects: TokenObjects = { get: () => { throw new Error('a company mailbox never asks a token object') } }

let keys: TestKeys
let signing: SigningKey
let envelope: SealedEnvelope
let key: string

beforeAll(async () => {
  keys = await makeKeys()
  signing = await makeSigningKey()
  key = JSON.stringify({ type: 'service_account', client_email: 'bidspoke-ops@ops.iam.gserviceaccount.com', private_key: signing.pem, token_uri: 'https://oauth2.googleapis.com/token' })
  // A Google connection's sealed login is empty: the key is the ops Worker's secret.
  envelope = await sealLogin(keys, { service: 'google', plaintext: '{}' })
}, 120_000)

const profile = (emailAddress: string) => Response.json({ emailAddress, messagesTotal: 12, threadsTotal: 9, historyId: '1' })

interface World { d: Doubles; deps: OpsConnectionsDeps; endpoint: TokenEndpoint; checks: string[] }

function world(opts: { allowed?: DelegationCheckOutcome; key?: string | undefined; target?: unknown; tokens?: TokenObjects } = {}): World {
  const checks: string[] = []
  const endpoint = tokenEndpoint(Response.json({ access_token: 'ya29.canary-google-2337', expires_in: 3599 }))
  const tokens = opts.tokens ?? noTokenObjects
  const entry = googleServiceEntry({
    now: () => T0,
    checkDelegation: async (_org, mailbox) => {
      checks.push(mailbox)
      return opts.allowed ?? 'allowed'
    },
    serviceAccountKey: () => ('key' in opts ? opts.key : key),
    memo: googleTokenMemo({ now: () => T0 }),
    tokens,
  })
  const d = makeDoubles(keys, usableCopy(envelope, { service: 'google', target: opts.target ?? TARGET }), () => [entry.rules], endpoint.fetch)
  const deps: OpsConnectionsDeps = {
    connection: d.deps,
    services: (service) => (service === 'google' ? entry : undefined),
    moneyIdentities: async () => {
      throw new Error('a Google verify never asks for money\'s Salesforce identity')
    },
    recordMeasuredIdentity: async () => {
      throw new Error('a Google verify records nothing')
    },
    recordReauthCleared: async () => 'recorded',
    recordTombstone: async () => ({ outcome: 'recorded', copiesRemoved: 1 }),
    readStatus: async () => ({ connections: [], reachedLimit: false }),
    takeLookupAllowance: async () => ({ outcome: 'allowed', used: 1, retryAt: null }),
    tokens,
    now: () => d.now.value,
  }
  return { d, deps, endpoint, checks }
}

const verify = (w: World) => verifyConnection(w.deps, { organization_id: ORG, connection_id: CONN, candidate: null })

describe('the Google entry', () => {
  it('declares Google\'s token host beside every API host its actions call, so a mint is never refused token_host_not_declared', () => {
    expect([...GOOGLE_HOSTS].sort()).toEqual(['gmail.googleapis.com', 'oauth2.googleapis.com', 'sheets.googleapis.com', 'www.googleapis.com'])
    const entry = googleServiceEntry({ now: () => T0, checkDelegation: async () => 'allowed', serviceAccountKey: () => key, tokens: noTokenObjects })
    expect(entry.rules.declaredHosts(TARGET, {})).toEqual(GOOGLE_HOSTS)
    expect(entry.identity).toBe(googleIdentity)
  })

  it('is registered on the ops Worker, built with the isolate\'s delegation check and key', () => {
    expect(registeredOpsServices()).toContain('google')
    const services = opsServiceRegistry({ google: { checkDelegation: async () => 'allowed', serviceAccountKey: () => undefined, tokens: noTokenObjects } })
    expect(services('google')?.rules.service).toBe('google')
    expect(services('salesforce')?.rules.service).toBe('salesforce')
    expect(services('constructor')).toBeUndefined()
  })

  it('mints through connectionFetch\'s fetch at oauth2.googleapis.com, so a step request reaches Google with the delegated token', async () => {
    const w = world()
    const call: ConnectionCall = { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'step', workflowId: '44444444-4444-4444-8444-444444444444', record: async () => undefined }
    expect(((await connectionFetch(w.d.deps, call, 'https://sheets.googleapis.com/v4/spreadsheets/abc')) as Response).status).toBe(200)
    expect(w.endpoint.calls.map((c) => c.url)).toEqual(['https://oauth2.googleapis.com/token'])
    expect(new Headers(w.d.rec.sent[0].init.headers).get('authorization')).toBe('Bearer ya29.canary-google-2337')
  })
})

describe('verify of a Google company mailbox', () => {
  it('reads the mailbox\'s Gmail profile as the mailbox, and passes when Google answers the declared address', async () => {
    const w = world()
    w.d.respond(profile(MAILBOX))
    expect(await verify(w)).toEqual({ ok: true, service: 'google', generation: 1, identity: { kind: 'google', mailbox: MAILBOX } })
    expect(w.d.rec.sent.map((s) => s.url)).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/profile'])
    expect(w.checks).toEqual([MAILBOX])
  })

  it('refuses a mailbox Google answers as another address (an alias acting as its owner), naming no value', async () => {
    const w = world()
    w.d.respond(profile('someone.else@trypennie.example'))
    const answer = await verify(w)
    expect(answer).toMatchObject({ ok: false, refused: 'verify_google_mailbox_mismatch' })
    expect(JSON.stringify(answer)).not.toContain('someone.else')
  })

  it('a mailbox off the organization\'s list is refused before any token is asked for (F129)', async () => {
    const w = world({ allowed: 'mailbox_not_allowed' })
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'connection_not_allowed' })
    expect(w.endpoint.calls).toEqual([])
    expect(w.d.rec.sent).toEqual([])
  })

  it('with no delegation key on the ops Worker, verify is refused by name and nothing is sent', async () => {
    const w = world({ key: undefined })
    const answer = await verify(w)
    expect(answer).toMatchObject({ ok: false, refused: 'connection_not_allowed' })
    expect(JSON.stringify(answer)).toContain('delegation_key_unset')
    expect(w.endpoint.calls).toEqual([])
  })

  it('an answer it cannot read is verify_identity_unreadable', async () => {
    const w = world()
    w.d.respond(new Response('<html>no</html>', { status: 200 }))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })
  })
})

describe('a person\'s own Google account (#2338, R17: Sign in with Google)', () => {
  const own = { own_account: true }
  const sheets = 'https://sheets.googleapis.com/v4/spreadsheets/abc'
  const stepCall = (): ConnectionCall => ({ organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'step', workflowId: '44444444-4444-4444-8444-444444444444', record: async () => undefined })

  it('the target a signed in connection declares is the one the entry reads as a person\'s own account', () => {
    expect(GOOGLE_OWN_ACCOUNT_TARGET).toEqual(own)
    expect(googleOwnAccount.covers?.(own)).toBe(true)
    expect(googleOwnAccount.covers?.(TARGET)).toBe(false)
    expect(googleOwnAccount.covers?.({ own_account: 'true' })).toBe(false)
  })

  it('declares Google\'s token host for it too, so its token request is to a declared host (#2337)', () => {
    const entry = googleServiceEntry({ now: () => T0, checkDelegation: async () => 'allowed', serviceAccountKey: () => key, tokens: noTokenObjects })
    const hosts = entry.rules.declaredHosts(own, {})
    expect(hosts).toEqual(GOOGLE_HOSTS)
    expect(googleOwnAccount.tokenUrl(own)).toBe(GOOGLE_TOKEN_URI)
    expect(hosts).toContain(new URL(googleOwnAccount.tokenUrl(own)).hostname)
  })

  it('signs in through the connection\'s token object: the company list is not checked, and the delegation key is not used', async () => {
    const tokens = tokenObjects('ya29.person-2338')
    const w = world({ target: own, key: undefined, tokens })
    expect(((await connectionFetch(w.d.deps, stepCall(), sheets)) as Response).status).toBe(200)
    expect(new Headers(w.d.rec.sent[0].init.headers).get('authorization')).toBe('Bearer ya29.person-2338')
    expect(tokens.access).toEqual([expect.objectContaining({ service: 'google', tokenUrl: GOOGLE_TOKEN_URI })])
    expect(w.checks).toEqual([])
    expect(w.endpoint.calls).toEqual([])
  })

  it('a company mailbox still goes through the list and the delegation key, never a token object', async () => {
    const w = world({ tokens: noTokenObjects })
    expect(((await connectionFetch(w.d.deps, stepCall(), sheets)) as Response).status).toBe(200)
    expect(w.checks).toEqual([MAILBOX])
    expect(w.endpoint.calls.map((c) => c.url)).toEqual([GOOGLE_TOKEN_URI])
  })

  it('verify of the committed copy reads its Gmail profile and names the account, with no list to compare against', async () => {
    const w = world({ target: own, tokens: tokenObjects('ya29.person-2338') })
    w.d.respond(profile('dan@trypennie.example'))
    expect(await verify(w)).toEqual({ ok: true, service: 'google', generation: 1, identity: { kind: 'google', mailbox: 'dan@trypennie.example' } })
  })

  it('verify of a candidate is refused: a person\'s login is proven by its code exchange, and no token is asked for', async () => {
    const tokens = tokenObjects('never')
    const w = world({ target: own, tokens })
    const answer = await verifyConnection(w.deps, { organization_id: ORG, connection_id: CONN, candidate: { service: 'google', generation: 2, envelope, target: own, public_config: {} } })
    expect(answer).toMatchObject({ ok: false, refused: 'candidate_not_refreshable' })
    expect(tokens.access).toEqual([])
  })

  it('a company mailbox candidate is still verified', async () => {
    const w = world()
    w.d.respond(profile(MAILBOX))
    const answer = await verifyConnection(w.deps, { organization_id: ORG, connection_id: CONN, candidate: { service: 'google', generation: 1, envelope, target: TARGET, public_config: {} } })
    expect(answer).toMatchObject({ ok: true, identity: { kind: 'google', mailbox: MAILBOX } })
  })

  it('a consent is exchanged for an own account target at Google\'s token endpoint, and refused for a company mailbox', async () => {
    const tokens = tokenObjects('unused')
    const w = world({ target: own, tokens })
    const exchange = (target: Record<string, unknown>) => exchangeConnectionCode(w.deps, {
      organization_id: ORG, connection_id: CONN, candidate: { service: 'google', generation: 1, envelope, target, public_config: {} },
      code: 'auth-code-2338', verifier: 'v'.repeat(43), redirect_uri: 'https://bidspoke.trypennie.dev/connections/google',
    })
    expect(await exchange(TARGET)).toMatchObject({ ok: false, refused: 'connection_target_invalid' })
    expect(tokens.exchanges).toEqual([])
    expect(await exchange(own)).toEqual({ ok: true, generation: 2, account: 'dan@trypennie.example' })
    expect(tokens.exchanges).toEqual([expect.objectContaining({ service: 'google', tokenUrl: GOOGLE_TOKEN_URI, code: 'auth-code-2338' })])
  })

  it('the registry keeps one person bound cache for the isolate: a renewal in a later request names the token an earlier one handed out', async () => {
    const tokens = tokenObjects('ya29.first', 'ya29.second')
    const registry = () => opsServiceRegistry({ google: { checkDelegation: async () => 'allowed', serviceAccountKey: () => undefined, tokens } })
    const authorizeInput = (renew: { rejected: Authorization } | null) => ({
      organizationId: ORG, connectionId: '55555555-5555-4555-8555-000000002338', service: 'google', generation: 1, target: own, publicConfig: {}, envelope,
      login: { plaintext: '{}' }, candidate: false, renew, noteMint: () => undefined, fetch: async (): Promise<Response> => { throw new Error('not asked') },
    })
    const first = await registry()('google')!.rules.authorize(authorizeInput(null))
    await registry()('google')!.rules.authorize(authorizeInput({ rejected: first }))
    expect(tokens.access.map((r) => r.rejectedTokenId)).toEqual([null, 'id-of-ya29.first'])
  })
})
