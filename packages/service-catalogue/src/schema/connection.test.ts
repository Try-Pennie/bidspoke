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
  connectionSecretLabel,
  isListInput,
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

  // Its actions arrived with #2337's Salesforce pull request: runtime/salesforce/__tests__/actions.test.ts names them.
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

describe("HTTP's connection (#2337)", () => {
  it('is a static key on one declared host, sent in a declared header, proven by a declared check path', () => {
    const c = service('http').connection
    expect(c.auth).toBe('static_key')
    expect(c.tile).toBe('Any web API that takes a key')
    expect(connectionFormLabels(c)).toEqual(['Name', 'Host', 'Header', 'Check path', 'Header value'])
    expect(loginFieldNames(c)).toEqual(['api_key'])
    expect(targetFieldNames(c)).toEqual(['host', 'header', 'check_path'])
    expect(c.fields.every((f) => f.required)).toBe(true)
  })

  it('masks the header value, which is the only secret, and keeps it out of the public target', () => {
    const c = service('http').connection
    expect(c.fields.filter((f) => f.input === 'secret').map((f) => f.key)).toEqual(['api_key'])
    expect(connectionParts(c, { host: 'https://api.regal.io/v1', header: 'Authorization', check_path: '/v1/me', api_key: 'Bearer abc' })).toEqual({
      ok: true,
      login: { api_key: 'Bearer abc' },
      target: { host: 'https://api.regal.io/v1', header: 'Authorization', check_path: '/v1/me' },
    })
  })
})

describe("Supabase's connection (#2337)", () => {
  it('is a static service key for one project, named by its Project URL', () => {
    const c = service('supabase').connection
    expect(c.auth).toBe('static_key')
    expect(c.tile).toBe('A project\'s service key')
    expect(connectionFormLabels(c)).toEqual(['Name', 'Project URL', 'Service key'])
    expect(loginFieldNames(c)).toEqual(['service_key'])
    expect(targetFieldNames(c)).toEqual(['project_url'])
    expect(connectionSecretLabel(c)).toBe('service key')
  })
})

describe("Google's connection (#2572)", () => {
  it('acts as one mailbox and names its shared drives as a list, both only in the target', () => {
    const c = service('google').connection
    expect(c.auth).toBe('service_account_delegation')
    expect(connectionFormLabels(c)).toEqual(['Name', 'Acts as', 'Shared drives'])
    expect(Object.fromEntries(c.fields.map((f) => [f.key, f.input]))).toEqual({ subject: 'google_subject', drives: 'google_drives' })
    expect(loginFieldNames(c)).toEqual([])
    // The minter reads target.drives (apps/worker/src/ops/connections/minters/google.ts); a connection may name none.
    expect(targetFieldNames(c)).toEqual(['subject', 'drives'])
    expect(c.fields.filter((f) => f.required).map((f) => f.key)).toEqual(['subject'])
  })

  it('builds the drives as an array, in the order given, each once', () => {
    expect(connectionParts(service('google').connection, { subject: 'ops@trypennie.com', drives: ['0AbcDriveOne1234', '0XyzDriveTwo5678', '0AbcDriveOne1234'] })).toEqual({
      ok: true,
      login: {},
      target: { subject: 'ops@trypennie.com', drives: ['0AbcDriveOne1234', '0XyzDriveTwo5678'] },
    })
  })

  it('leaves the drives out when none is named, or only blanks are', () => {
    const c = service('google').connection
    expect(connectionParts(c, { subject: 'ops@trypennie.com', drives: [] })).toEqual({ ok: true, login: {}, target: { subject: 'ops@trypennie.com' } })
    expect(connectionParts(c, { subject: 'ops@trypennie.com', drives: [' ', ''] })).toEqual({ ok: true, login: {}, target: { subject: 'ops@trypennie.com' } })
    expect(connectionParts(c, { subject: 'ops@trypennie.com' })).toEqual({ ok: true, login: {}, target: { subject: 'ops@trypennie.com' } })
  })

  it('names a list given as text, and text given as a list, rather than guessing either', () => {
    // One text value for the drives would reach the minter as a string, which it refuses at every mint (#2572).
    expect(connectionParts(service('google').connection, { subject: 'ops@trypennie.com', drives: '0AbcDriveOne1234' })).toEqual({ ok: false, missing: [], unknown: [], malformed: ['drives'] })
    expect(connectionParts(service('google').connection, { subject: ['ops@trypennie.com'] })).toEqual({ ok: false, missing: [], unknown: [], malformed: ['subject'] })
  })

  it('has the company list drive input as its one list input', () => {
    expect(CONNECTION_INPUTS.filter((i) => isListInput(i))).toEqual(['google_drives'])
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

  it("name the company list's dropdown as an input, so a Google entry can declare it (R16, build PR 10)", () => {
    expect(CONNECTION_INPUTS).toContain('google_subject')
    expect(codes(serviceWith({ auth: 'service_account_delegation', fields: [{ key: 'subject', label: 'Acts as', input: 'google_subject', required: true, target: 'subject' }] }))).toEqual([])
  })

  it('refuse a list written into the sealed login, which holds text only', () => {
    expect(codes(serviceWith({ fields: [
      { key: 'api_key', label: 'API key', input: 'secret', required: true, login: 'api_key' },
      { key: 'drives', label: 'Drives', input: 'google_drives', required: false, login: 'drives' },
    ] }))).toEqual(['list_in_login'])
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
      malformed: [],
    })
  })

  it('leaves an optional field out when it is blank, and keeps the value exactly as given otherwise', () => {
    const parts = connectionParts(service('snowflake').connection, { account: 'ab1.us-east-1', user: 'OPS', private_key: 'PEM\n', warehouse: '', role: 'R' })
    expect(parts).toEqual({ ok: true, login: { private_key: 'PEM\n' }, target: { account: 'ab1.us-east-1', user: 'OPS', role: 'R' } })
  })
})

describe('connectionSecretLabel (#2338)', () => {
  it("words each service's secret as its sentences name it, and a service with none as its login", () => {
    expect(connectionSecretLabel(service('salesforce').connection)).toBe('client secret')
    expect(connectionSecretLabel(service('snowflake').connection)).toBe('private key')
    expect(connectionSecretLabel({ tile: 't', auth: 'static_key', fields: [{ key: 'host', label: 'Host', input: 'text', required: true, target: 'host' }] })).toBe('login')
  })

  it("keeps a label's own capitals, lower casing only its ordinary words (#2889)", () => {
    expect(connectionSecretLabel(service('anthropic').connection)).toBe('API key')
    expect(connectionSecretLabel(service('openai').connection)).toBe('API key')
    expect(connectionSecretLabel(service('http').connection)).toBe('header value')
    expect(connectionSecretLabel(service('slack').connection)).toBe('bot token')
    const label = (l: string) => connectionSecretLabel({ tile: 't', auth: 'static_key', fields: [{ key: 'k', label: l, input: 'secret', required: true, login: 'k' }] })
    expect(label('JSON key')).toBe('JSON key')
    expect(label('OAuth client secret')).toBe('OAuth client secret')
    expect(label('Key for API')).toBe('key for API')
  })

  it("words every catalogue service's secret with each word holding more than one capital kept as written (#2889)", () => {
    let checked = 0
    for (const s of CATALOGUE) {
      const field = s.connection.fields.find((f) => f.input === 'secret' || f.input === 'secret_block')
      if (!field) continue
      checked++
      const words = connectionSecretLabel(s.connection).split(' ')
      field.label.split(' ').forEach((w, i) => {
        const kept = (w.match(/[A-Z]/g) ?? []).length > 1
        expect(words[i], `${s.key}: ${field.label}`).toBe(kept ? w : w.toLowerCase())
      })
    }
    expect(checked).toBeGreaterThan(5)
  })
})
