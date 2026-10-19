/**
 * The ops Snowflake service (#2337): what verify measures a key pair login as,
 * driven through the real verify, connectionFetch, seal and key pair minter,
 * with the ops database and the bidding Worker as doubles. The probe sends its
 * statement through the catalogue's own Snowflake client, so verify and the
 * Snowflake actions read Snowflake one way.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import type { OpsConnectionsDeps, OpsServiceEntry } from '../ops-connections'
import { lookupConnection, verifyConnection } from '../ops-connections'
import { opsServiceEntry, registeredOpsServices } from '../services'
import { snowflakeIdentity, snowflakeSchemaTarget, snowflakeServiceEntry } from '../snowflake-service'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type Doubles, type TestKeys } from './harness'
import { makeSigningKey, readJwt, type SigningKey } from '../minters/__tests__/minter-harness'

const TARGET = { account: 'ab12345.us-east-1', user: 'ops_reader', role: 'ops_role' }
const STATEMENTS = 'https://ab12345.us-east-1.snowflakecomputing.com/api/v2/statements'
const COLUMNS = ['USER_NAME', 'ACCOUNT_LOCATOR', 'ACCOUNT_NAME', 'ORGANIZATION_NAME']

let keys: TestKeys
let signing: SigningKey
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  signing = await makeSigningKey()
  envelope = await sealLogin(keys, { service: 'snowflake', plaintext: JSON.stringify({ private_key: signing.pem }) })
}, 120_000)

/** Snowflake's answer to the probe's statement: one row of context functions. */
const identityRow = (user = 'OPS_READER', locator = 'AB12345', account: string | null = 'OPS', org: string | null = 'PENNIE') =>
  Response.json({
    statementHandle: '01b2c3d4-0000-0000-0000-000000000009',
    resultSetMetaData: { numRows: 1, rowType: COLUMNS.map((name) => ({ name, type: 'text', nullable: true })) },
    data: [[user, locator, account, org]],
  })

interface World {
  d: Doubles
  deps: OpsConnectionsDeps
  measured: unknown[]
  moneyAsks: string[]
}

function world(target: unknown = TARGET): World {
  const services: Record<string, OpsServiceEntry> = { snowflake: snowflakeServiceEntry({ now: () => T0 }) }
  const d = makeDoubles(keys, usableCopy(envelope, { service: 'snowflake', target }), () => [services.snowflake.rules])
  const measured: unknown[] = []
  const moneyAsks: string[] = []
  const deps: OpsConnectionsDeps = {
    connection: d.deps,
    services: (service) => (Object.hasOwn(services, service) ? services[service] : undefined),
    moneyIdentities: async (org) => {
      moneyAsks.push(org)
      throw new Error('a Snowflake verify never asks for money\'s Salesforce identity')
    },
    recordMeasuredIdentity: async (...args) => {
      measured.push(args)
      return 'recorded'
    },
    recordReauthCleared: async () => 'recorded',
    recordTombstone: async () => ({ outcome: 'recorded', copiesRemoved: 1 }),
    readStatus: async () => ({ connections: [], reachedLimit: false }),
    takeLookupAllowance: async () => ({ outcome: 'allowed', used: 1, retryAt: null }),
    tokens: { get: () => { throw new Error('no token objects in this test') } },
    now: () => d.now.value,
  }
  return { d, deps, measured, moneyAsks }
}

const verify = (w: World) => verifyConnection(w.deps, { organization_id: ORG, connection_id: CONN, candidate: null })

describe('verify of a Snowflake key pair login', () => {
  it('asks Snowflake who the credential is, with the key pair JWT for the declared user, and passes when it is the declared one', async () => {
    const w = world()
    w.d.respond(identityRow())
    expect(await verify(w)).toEqual({
      ok: true, service: 'snowflake', generation: 1,
      identity: { kind: 'snowflake', account_locator: 'AB12345', organization_name: 'PENNIE', account_name: 'OPS', user: 'OPS_READER' },
    })
    expect(w.d.rec.sent).toHaveLength(1)
    const [sent] = w.d.rec.sent
    expect(sent.url.startsWith(`${STATEMENTS}?requestId=`)).toBe(true)
    const body = JSON.parse(String(sent.init.body)) as { statement: string; role?: string }
    expect(body.statement).toContain('CURRENT_USER()')
    expect(body.role).toBe('OPS_ROLE')
    const auth = new Headers(sent.init.headers).get('authorization') ?? ''
    const jwt = await readJwt(auth.replace(/^Bearer /, ''), signing.publicKey)
    expect(jwt.verified).toBe(true)
    expect(jwt.payload.sub).toBe('AB12345.OPS_READER')
  })

  it('records nothing and asks the bidding Worker nothing: a Snowflake identity is the declared one or it is refused', async () => {
    const w = world()
    w.d.respond(identityRow())
    await verify(w)
    expect(w.measured).toEqual([])
    expect(w.moneyAsks).toEqual([])
  })

  it('an account declared by its organization and name matches as well as its locator', async () => {
    const w = world({ account: 'pennie-ops', user: 'ops_reader' })
    // The org-account form is its own host, so the copy declares that one.
    w.d.respond(identityRow())
    expect(await verify(w)).toMatchObject({ ok: true })
    expect(w.d.rec.sent[0].url.startsWith('https://pennie-ops.snowflakecomputing.com/api/v2/statements?')).toBe(true)
  })

  it('refuses a credential measured as another user or another account, naming no value', async () => {
    const other = world()
    other.d.respond(identityRow('EXPORT_SERVICE'))
    const user = await verify(other)
    expect(user).toMatchObject({ ok: false, refused: 'verify_identity_mismatch' })
    expect(JSON.stringify(user)).not.toContain('EXPORT_SERVICE')

    const elsewhere = world()
    elsewhere.d.respond(identityRow('OPS_READER', 'ZZ99999', 'MONEY', 'ELSEWHERE'))
    expect(await verify(elsewhere)).toMatchObject({ ok: false, refused: 'verify_identity_mismatch' })
  })

  it('an identity query Snowflake refused, or an answer it cannot read, is unreadable by name', async () => {
    const refused = world()
    refused.d.respond(Response.json({ code: '390189', message: 'Role OPS_ROLE specified in the connect string does not exist or not authorized.' }, { status: 422 }))
    const answer = await verify(refused)
    expect(answer).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })
    expect(JSON.stringify(answer)).toContain('snowflake_statement_failed')

    const garbled = world()
    garbled.d.respond(new Response('<html>', { status: 200 }))
    expect(await verify(garbled)).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })

    const noRow = world()
    noRow.d.respond(Response.json({ resultSetMetaData: { numRows: 0, rowType: COLUMNS.map((name) => ({ name, type: 'text' })) }, data: [] }))
    expect(await verify(noRow)).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })
  })

  it('a 429 is connection_rate_limited with its time, and a JWT Snowflake refuses twice is needs_reauth, through connectionFetch', async () => {
    const limited = world()
    limited.d.respond(new Response('{}', { status: 429, headers: { 'retry-after': '30' } }))
    expect(await verify(limited)).toMatchObject({ ok: false, refused: 'connection_rate_limited' })

    const refused = world()
    const jwtRefused = () => Response.json({ code: '390144', message: 'JWT token is invalid.' }, { status: 401 })
    refused.d.respond(jwtRefused, jwtRefused)
    expect(await verify(refused)).toMatchObject({ ok: false, refused: 'connection_needs_reauth' })
  })

  it('a target that declares no account is refused before anything is sent', async () => {
    const w = world({ user: 'ops_reader' })
    expect(await verify(w)).toMatchObject({ ok: false })
    expect(w.d.rec.sent).toEqual([])
  })
})

describe('the Snowflake entry', () => {
  it('is registered on the ops Worker, with its identity measurement', () => {
    expect(registeredOpsServices()).toContain('snowflake')
    const entry = opsServiceEntry('snowflake')
    expect(entry?.identity).toBe(snowflakeIdentity)
    expect(entry?.rules.declaredHosts(TARGET, {})).toEqual(['ab12345.us-east-1.snowflakecomputing.com'])
  })

  it('answers lookups only for a target that declares its database', async () => {
    expect(snowflakeSchemaTarget({ ...TARGET, database: 'analytics', schema: 'enrollment' }, {})).toEqual({
      service: 'snowflake', account: 'ab12345.us-east-1', database: 'analytics', schema: 'enrollment',
    })
    expect(() => snowflakeSchemaTarget(TARGET, {})).toThrow()
    const w = world()
    expect(await lookupConnection(w.deps, { organization_id: ORG, connection_id: CONN, key: 'tables', parents: [] })).toMatchObject({
      ok: false, refused: 'connection_target_invalid',
    })
  })
})
