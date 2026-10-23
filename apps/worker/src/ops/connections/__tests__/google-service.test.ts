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
import { GOOGLE_HOSTS, googleIdentity, googleServiceEntry } from '../google-service'
import { googleTokenMemo } from '../minters/google'
import type { OpsConnectionsDeps } from '../ops-connections'
import { verifyConnection } from '../ops-connections'
import { opsServiceRegistry, registeredOpsServices } from '../services'
import type { DelegationCheckOutcome } from '../../run-vocabulary'
import { makeSigningKey, tokenEndpoint, type SigningKey, type TokenEndpoint } from '../minters/__tests__/minter-harness'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type Doubles, type TestKeys } from './harness'

const MAILBOX = 'ops@trypennie.example'
const TARGET = { subject: 'Ops@TryPennie.example' }

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

function world(opts: { allowed?: DelegationCheckOutcome; key?: string | undefined; target?: unknown } = {}): World {
  const checks: string[] = []
  const endpoint = tokenEndpoint(Response.json({ access_token: 'ya29.canary-google-2337', expires_in: 3599 }))
  const entry = googleServiceEntry({
    now: () => T0,
    checkDelegation: async (_org, mailbox) => {
      checks.push(mailbox)
      return opts.allowed ?? 'allowed'
    },
    serviceAccountKey: () => ('key' in opts ? opts.key : key),
    memo: googleTokenMemo({ now: () => T0 }),
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
    tokens: { get: () => { throw new Error('no token objects in this test') } },
    now: () => d.now.value,
  }
  return { d, deps, endpoint, checks }
}

const verify = (w: World) => verifyConnection(w.deps, { organization_id: ORG, connection_id: CONN, candidate: null })

describe('the Google entry', () => {
  it('declares Google\'s token host beside every API host its actions call, so a mint is never refused token_host_not_declared', () => {
    expect([...GOOGLE_HOSTS].sort()).toEqual(['gmail.googleapis.com', 'oauth2.googleapis.com', 'sheets.googleapis.com', 'www.googleapis.com'])
    const entry = googleServiceEntry({ now: () => T0, checkDelegation: async () => 'allowed', serviceAccountKey: () => key })
    expect(entry.rules.declaredHosts(TARGET, {})).toEqual(GOOGLE_HOSTS)
    expect(entry.identity).toBe(googleIdentity)
  })

  it('is registered on the ops Worker, built with the isolate\'s delegation check and key', () => {
    expect(registeredOpsServices()).toContain('google')
    const services = opsServiceRegistry({ google: { checkDelegation: async () => 'allowed', serviceAccountKey: () => undefined } })
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
