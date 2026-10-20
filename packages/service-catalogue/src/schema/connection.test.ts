import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CATALOGUE,
  CONNECTION_AUTH_KINDS,
  CONNECTION_INPUTS,
  connectionFormLabels,
  connectionParts,
  connectionProblems,
  loginFieldNames,
  targetFieldNames,
  type ServiceSchema,
} from '.'

/**
 * The connection each catalogue service declares (#2338, PR 1 of its build
 * plan): the Add connection tile's one line, the auth kind, and the fields
 * that make the sealed login and the public target. That the login and target
 * names are the ones the ops minters read is proven on the worker side
 * (apps/worker/src/ops/connections/__tests__/catalogue-connection-fields.test.ts),
 * where the minters are.
 */
const SRC = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SRC, '../../../..')
const FIXTURE = path.join(REPO_ROOT, 'docs/design/connections-page.fixture.json')

const service = (key: string): ServiceSchema => {
  const found = CATALOGUE.find((s) => s.key === key)
  if (!found) throw new Error(`the catalogue has no ${key} service`)
  return found
}

describe('the Add connection tiles', () => {
  it("are the settled design's service list, in its order, for every service the catalogue ships (R12)", () => {
    const settled = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { services: [string, string][] }).services
    const shipped = CATALOGUE.map((s) => [s.name, s.connection.tile])
    const names = new Set(CATALOGUE.map((s) => s.name))
    // Every shipped service is drawn in the design, so none can appear with a line nobody settled.
    expect(CATALOGUE.map((s) => s.name).filter((n) => !settled.some(([name]) => name === n))).toEqual([])
    expect(shipped).toEqual(settled.filter(([name]) => names.has(name)))
  })

  it('reads the real fixture, so the comparison above is not over an empty list', () => {
    const settled = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { services: [string, string][] }).services
    expect(settled.length).toBeGreaterThanOrEqual(8)
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(2)
  })
})

describe("Salesforce's connection (D15, R15)", () => {
  it('asks for Name, Org, Client id and Client secret, and nothing about who it acts as', () => {
    // Who it acts as is read from Salesforce when the login is checked, never typed.
    expect(connectionFormLabels(service('salesforce').connection)).toEqual(['Name', 'Org', 'Client id', 'Client secret'])
  })

  it('masks the client secret, picks the org, and signs in by client credentials', () => {
    const c = service('salesforce').connection
    expect(c.auth).toBe('client_credentials')
    expect(Object.fromEntries(c.fields.map((f) => [f.label, f.input]))).toEqual({
      Org: 'salesforce_org',
      'Client id': 'text',
      'Client secret': 'secret',
    })
  })

  it('declares the client id in both the login and the target, which the minter compares', () => {
    const c = service('salesforce').connection
    expect(loginFieldNames(c)).toEqual(['client_id', 'client_secret'])
    expect(targetFieldNames(c)).toEqual(['instance_url', 'client_id'])
  })

  it('carries no actions yet: its entry is the connection only (#2337 ships them)', () => {
    expect(service('salesforce').actions).toEqual([])
  })
})

describe("Snowflake's connection", () => {
  it('is a key pair login for a declared account and user, with the session fields optional', () => {
    const c = service('snowflake').connection
    expect(c.auth).toBe('key_pair')
    expect(loginFieldNames(c)).toEqual(['private_key'])
    expect(targetFieldNames(c)).toEqual(['account', 'user', 'warehouse', 'role', 'database', 'schema'])
    expect(c.fields.filter((f) => f.required).map((f) => f.key)).toEqual(['account', 'user', 'private_key'])
  })
})

describe('every shipped connection', () => {
  it('passes the connection checks', () => {
    expect(CATALOGUE.flatMap((s) => connectionProblems(s))).toEqual([])
  })
})

/** A service with one connection, for the checks to be seen failing on. */
function serviceWith(connection: Partial<ServiceSchema['connection']>): ServiceSchema {
  return {
    key: 'probe',
    name: 'Probe',
    actions: [],
    connection: {
      tile: 'A probe',
      auth: 'static_key',
      fields: [{ key: 'api_key', label: 'API key', input: 'secret', required: true, login: 'api_key' }],
      ...connection,
    },
  }
}
const codes = (s: ServiceSchema) => connectionProblems(s).map((p) => p.code)

describe('the connection checks', () => {
  it('pass the probe as written, so each case below fails for its own reason', () => {
    expect(codes(serviceWith({}))).toEqual([])
  })

  it('refuse a blank tile line', () => {
    expect(codes(serviceWith({ tile: '  ' }))).toEqual(['tile_missing'])
  })

  it('refuse an auth kind and an input outside their vocabularies', () => {
    expect(codes(serviceWith({ auth: 'magic' as never }))).toEqual(['auth_kind_unknown'])
    expect(codes(serviceWith({ fields: [{ key: 'k', label: 'K', input: 'textarea' as never, required: true, login: 'k' }] }))).toEqual(['input_unknown'])
    expect(CONNECTION_AUTH_KINDS).toContain('client_credentials')
    expect(CONNECTION_INPUTS).toContain('secret')
  })

  it('refuse a field that goes into neither the login nor the target', () => {
    expect(codes(serviceWith({ fields: [{ key: 'k', label: 'K', input: 'text', required: true }] }))).toEqual(['field_not_placed'])
  })

  it('refuse a secret declared in the target, which is public, or kept out of the login', () => {
    expect(codes(serviceWith({ fields: [{ key: 'k', label: 'K', input: 'secret', required: true, login: 'k', target: 'k' }] }))).toEqual(['secret_in_target'])
    expect(codes(serviceWith({ fields: [{ key: 'k', label: 'K', input: 'secret_block', required: true, target: 'k' }] }))).toEqual(['secret_in_target', 'secret_not_in_login'])
  })

  it('refuse two fields with one key, one label, one login name or one target name', () => {
    const a = { key: 'a', label: 'A', input: 'text', required: true, login: 'a' } as const
    expect(codes(serviceWith({ fields: [a, { ...a, label: 'B', login: 'b' }] }))).toEqual(['field_key_duplicate'])
    expect(codes(serviceWith({ fields: [a, { ...a, key: 'b', login: 'b' }] }))).toEqual(['field_label_duplicate'])
    expect(codes(serviceWith({ fields: [a, { ...a, key: 'b', label: 'B' }] }))).toEqual(['login_field_duplicate'])
    const t = { key: 'a', label: 'A', input: 'text', required: true, target: 'a' } as const
    expect(codes(serviceWith({ fields: [t, { ...t, key: 'b', label: 'B' }] }))).toEqual(['target_field_duplicate'])
  })

  it("refuse a field labelled Name, which is the connection's own name on every form", () => {
    expect(codes(serviceWith({ fields: [{ key: 'name', label: 'Name', input: 'text', required: true, target: 'name' }] }))).toEqual(['field_label_duplicate'])
  })
})

describe('connectionParts: the login and target a form makes', () => {
  const salesforce = () => service('salesforce').connection

  it('puts each value under its login and target names, the client id in both', () => {
    expect(connectionParts(salesforce(), { instance_url: 'https://x.my.salesforce.com', client_id: 'cid', client_secret: 'shh' })).toEqual({
      ok: true,
      login: { client_id: 'cid', client_secret: 'shh' },
      target: { instance_url: 'https://x.my.salesforce.com', client_id: 'cid' },
    })
  })

  it('names every required field left blank, and every value no field declares', () => {
    expect(connectionParts(salesforce(), { instance_url: ' ', client_id: 'cid', acts_as: 'someone' })).toEqual({
      ok: false,
      missing: ['instance_url', 'client_secret'],
      unknown: ['acts_as'],
    })
  })

  it('leaves an optional field out when it is blank, and keeps the value exactly as given otherwise', () => {
    const parts = connectionParts(service('snowflake').connection, { account: 'ab1.us-east-1', user: 'OPS', private_key: 'PEM\n', warehouse: '', role: 'R' })
    expect(parts).toEqual({ ok: true, login: { private_key: 'PEM\n' }, target: { account: 'ab1.us-east-1', user: 'OPS', role: 'R' } })
  })
})
