import { beforeAll, describe, expect, it } from 'vitest'
import {
  CATALOGUE,
  connectionParts,
  type ConnectionAuthKind,
  type ConnectionDeclaration,
  type ServiceSchema,
} from '@bidspoke/service-catalogue/schema'
import { snowflakeTargetOf } from '@bidspoke/service-catalogue/runtime'
import { LoginMintError } from '../refusals'
import type { Authorization, AuthorizeInput } from '../service-rules'
import { opsServiceEntry } from '../services'
import { makeSigningKey } from '../minters/__tests__/minter-harness'
import { ORG } from './harness'

/**
 * The catalogue's connection declarations against the ops minters (#2338, PR 1
 * of its build plan, holding the contract #2411 set): a login and a target
 * built from a service's declared fields, by the one builder the save route
 * uses (connectionParts), must be exactly what that service's registered ops
 * entry reads. So a field renamed in the catalogue, or a read renamed in a
 * minter, fails here: the built login or target then lacks what the minter
 * asks for, and the minter refuses it.
 *
 * The values are per field key, chosen to pass each service's own rules (an
 * https Salesforce instance, a Snowflake account locator, a real PKCS#8 key).
 */

let pem: string
beforeAll(async () => {
  pem = (await makeSigningKey()).pem
}, 120_000)

const SAMPLES: Readonly<Record<string, () => Readonly<Record<string, string>>>> = {
  salesforce: () => ({
    instance_url: 'https://trypennie.my.salesforce.com',
    client_id: 'ops-client-id-3MVG',
    client_secret: 'canary-sf-client-secret-2338',
  }),
  snowflake: () => ({
    account: 'ab12345.us-east-1',
    user: 'OPS_READER',
    private_key: pem,
    warehouse: 'OPS_WH',
    role: 'OPS_ROLE',
    database: 'OPS_DB',
    schema: 'OPS_SCHEMA',
  }),
}

/**
 * Where a service's target is read beyond its minter: the fields a step's
 * client uses for the session. An optional target field must be read by one
 * of these, since the minter does not require it.
 */
const TARGET_READERS: Readonly<Record<string, (target: unknown) => Readonly<Record<string, unknown>>>> = {
  snowflake: (target) => ({ ...snowflakeTargetOf(target) }),
}

interface TokenRequest {
  url: string
  body: URLSearchParams
}

/** Drives the registered ops entry's auth once, as verify does: a candidate, so no memo is read or filled. */
async function mint(serviceKey: string, login: unknown, target: unknown): Promise<{ auth: Authorization; tokenRequests: TokenRequest[] }> {
  const entry = opsServiceEntry(serviceKey)
  if (!entry) throw new Error(`ops registers no ${serviceKey} service`)
  const tokenRequests: TokenRequest[] = []
  const input: AuthorizeInput = {
    organizationId: ORG,
    connectionId: crypto.randomUUID(),
    service: serviceKey,
    generation: 1,
    target,
    publicConfig: {},
    envelope: null,
    login: { plaintext: JSON.stringify(login) },
    candidate: true,
    renew: null,
    noteMint: () => undefined,
    fetch: async (url, init) => {
      tokenRequests.push({ url, body: new URLSearchParams(String(init?.body ?? '')) })
      return Response.json({ access_token: 'canary-access-token-2338', instance_url: 'https://trypennie.my.salesforce.com' })
    },
  }
  return { auth: await entry.rules.authorize(input), tokenRequests }
}

async function mintRefusal(serviceKey: string, login: unknown, target: unknown): Promise<LoginMintError> {
  try {
    await mint(serviceKey, login, target)
  } catch (err) {
    if (err instanceof LoginMintError) return err
    throw err
  }
  throw new Error('expected the minter to refuse, and it minted')
}

function partsOf(service: ServiceSchema): { login: Record<string, string>; target: Record<string, string> } {
  const sample = SAMPLES[service.key]
  if (!sample) throw new Error(`no sample values for ${service.key}: add them to SAMPLES`)
  const parts = connectionParts(service.connection, sample())
  if (!parts.ok) throw new Error(`the ${service.key} samples do not fit its declaration: missing ${parts.missing.join(', ')}; unknown ${parts.unknown.join(', ')}`)
  return { login: parts.login, target: parts.target }
}

const without = (fields: Record<string, string>, name: string) => Object.fromEntries(Object.entries(fields).filter(([k]) => k !== name))

/** What each auth kind does when it mints, seen from the outside. A kind with no entry here fails, so a new kind brings its check. */
const AUTH_KIND_BEHAVIOUR: Readonly<Partial<Record<ConnectionAuthKind, (seen: { auth: Authorization; tokenRequests: TokenRequest[] }) => void>>> = {
  client_credentials: ({ tokenRequests }) => {
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0].body.get('grant_type')).toBe('client_credentials')
  },
  key_pair: ({ auth, tokenRequests }) => {
    // Signed locally with the connection's own key: no token endpoint is asked.
    expect(tokenRequests).toEqual([])
    expect(auth.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  },
}

const declared = (c: ConnectionDeclaration, where: 'login' | 'target') =>
  c.fields.flatMap((f) => (f[where] === undefined ? [] : [{ name: f[where] as string, required: f.required }]))

describe('the catalogue connection declarations, against the ops minters', () => {
  it('covers every shipped service, each registered on ops and given sample values', () => {
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(2)
    for (const service of CATALOGUE) {
      expect(opsServiceEntry(service.key), `${service.key} is not registered on ops`).toBeDefined()
      expect(SAMPLES[service.key], `${service.key} has no sample values`).toBeDefined()
    }
  })

  for (const service of CATALOGUE) {
    describe(service.name, () => {
      it('mints from a login and target built only from its declared fields', async () => {
        const { login, target } = partsOf(service)
        const seen = await mint(service.key, login, target)
        expect(Object.keys(seen.auth.headers).length).toBeGreaterThan(0)
      })

      it(`behaves as its declared auth kind (${service.connection.auth})`, async () => {
        const check = AUTH_KIND_BEHAVIOUR[service.connection.auth]
        expect(check, `no behaviour check for the auth kind ${service.connection.auth}`).toBeDefined()
        const { login, target } = partsOf(service)
        check!(await mint(service.key, login, target))
      })

      it('is refused without each required login field, so the minter reads every one by its declared name', async () => {
        const { login, target } = partsOf(service)
        const required = declared(service.connection, 'login').filter((f) => f.required)
        expect(required.length).toBeGreaterThan(0)
        for (const field of required) {
          const err = await mintRefusal(service.key, without(login, field.name), target)
          expect([err.kind, err.reason], `login without ${field.name}`).toEqual(['refused', 'login_malformed'])
        }
      })

      it('is refused without each required target field, so the minter reads every one by its declared name', async () => {
        const { login, target } = partsOf(service)
        const required = declared(service.connection, 'target').filter((f) => f.required)
        expect(required.length).toBeGreaterThan(0)
        for (const field of required) {
          const err = await mintRefusal(service.key, login, without(target, field.name))
          expect([err.kind, err.reason], `target without ${field.name}`).toEqual(['not_allowed', 'target_invalid'])
        }
      })

      it('has every optional target field read under its declared name', () => {
        const { target } = partsOf(service)
        const optional = declared(service.connection, 'target').filter((f) => !f.required)
        if (optional.length === 0) return
        const reader = TARGET_READERS[service.key]
        expect(reader, `${service.key} declares optional target fields and nothing reads them`).toBeDefined()
        const read = reader!(target)
        // The reader's own fields are exactly the declared ones, so neither side can carry a name the other lacks.
        expect(Object.keys(read).sort()).toEqual(declared(service.connection, 'target').map((f) => f.name).sort())
        for (const field of optional) expect(read[field.name], `target field ${field.name}`).toBe(target[field.name])
      })

      it('has no optional login field, which no minter reads', () => {
        expect(declared(service.connection, 'login').filter((f) => !f.required)).toEqual([])
      })
    })
  }
})
