/**
 * Test doubles for connectionFetch (#2335): a sealed connection under an
 * in-memory ops key pair, an ops database double that holds one copy, a
 * recording fetch, and service rules for a plain service and a Salesforce like
 * one. No key is ever committed: the pair is generated on every run, as
 * packages/connection-seal's own tests do.
 */
import { seal, type KeyRing, type SealedEnvelope } from '@bidspoke/connection-seal'
import type { OrganizationId } from '../../ops-db'
import type { ConnectionCopy, SfLeaseAnswer } from '../../ops-writes'
import type { RefreshOutcome } from '../../run-vocabulary'
import type { ConnectionFetchDeps } from '../connection-fetch'
import type { Authorization, AuthorizeInput, ServiceRules } from '../service-rules'

export const ORG = '11111111-1111-4111-8111-111111111111' as OrganizationId
export const OTHER_ORG = '22222222-2222-4222-8222-222222222222' as OrganizationId
export const CONN = '33333333-3333-4333-8333-333333333333'
export const KID = 'ops-test-1'
export const T0 = Date.parse('2026-10-18T09:00:00.000Z')

/** The canary: the login every test seals, and the access token its auth mints. */
export const LOGIN_SECRET = 'canary-login-secret-7f3a9c1e5b'
export const ACCESS_TOKEN = 'canary-access-token-4d8b2e6a0f'
export const RENEWED_TOKEN = 'canary-renewed-token-9c1f7a3e5d'

function base64(bytes: ArrayBuffer): string {
  let binary = ''
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b)
  return btoa(binary)
}

function toPem(der: ArrayBuffer, label: string): string {
  return `-----BEGIN ${label}-----\n${base64(der).match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`
}

export interface TestKeys {
  publicKeys: KeyRing
  privateKeys: KeyRing
}

/** One 4096 bit pair (the seal's floor), made once per test file. */
export async function makeKeys(): Promise<TestKeys> {
  // Cast: the Workers types give generateKey and exportKey union results that the DOM types do not.
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair
  return {
    publicKeys: { [KID]: toPem((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer, 'PUBLIC KEY') },
    privateKeys: { [KID]: toPem((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer, 'PRIVATE KEY') },
  }
}

export async function sealLogin(keys: TestKeys, opts: { service?: string; generation?: number; organizationId?: string; plaintext?: string } = {}): Promise<SealedEnvelope> {
  return seal(keys.publicKeys, opts.plaintext ?? JSON.stringify({ api_key: LOGIN_SECRET }), {
    organization_id: opts.organizationId ?? ORG,
    connection_id: CONN,
    service: opts.service ?? 'example',
    generation: opts.generation ?? 1,
    kid: KID,
  })
}

export function usableCopy(envelope: SealedEnvelope, overrides: Partial<ConnectionCopy> = {}): ConnectionCopy {
  return {
    state: 'usable',
    connectionId: CONN,
    service: 'example',
    generation: 1,
    envelope,
    publicConfig: {},
    target: { host: 'api.example.test' },
    servedAt: new Date(T0 - 60_000).toISOString(),
    serveUntil: new Date(T0 + 6 * 3600_000).toISOString(),
    dbNow: new Date(T0).toISOString(),
    ...overrides,
  }
}

export interface Recorder {
  /** What happened, in order: open, record, authorize, send, release. */
  events: string[]
  authorizeCalls: AuthorizeInput[]
  sent: Array<{ url: string; init: RequestInit }>
  recorded: unknown[]
  needsReauth: Array<{ organizationId: string; connectionId: string; cause: string }>
  /** record_connection_refresh calls (Dan's decision 2), in order. */
  refreshes: Array<{ organizationId: string; connectionId: string; result: { ok: true } | { ok: false; cause: string } }>
  leases: Array<{ op: 'acquire'; purpose: string; holder: string; bootstrapHost?: string; workflowId?: string } | { op: 'release'; holder: string }>
  reports: unknown[]
  slept: number[]
}

export interface Doubles {
  rec: Recorder
  deps: ConnectionFetchDeps
  /** Replace what the next sends answer, in order; the last repeats. */
  respond: (...answers: Array<Response | (() => Response | Promise<Response>) | Error>) => void
  /** Replace what each acquire answers, in order; the last repeats. */
  leaseAnswers: (...answers: Array<SfLeaseAnswer | Error>) => void
  setCopy: (copy: ConnectionCopy | Error) => void
  /** What record_connection_refresh answers a failure (refresh_failing until set). */
  refreshAnswer: (outcome: RefreshOutcome) => void
  now: { value: number }
}

/** Plain bearer auth that mints ACCESS_TOKEN, then RENEWED_TOKEN on a renewal. */
export function bearerAuth(rec: Recorder, override?: (input: AuthorizeInput) => Promise<Authorization>) {
  return async (input: AuthorizeInput): Promise<Authorization> => {
    rec.authorizeCalls.push(input)
    rec.events.push(input.renew ? 'renew' : 'authorize')
    if (override) return override(input)
    const token = input.renew ? RENEWED_TOKEN : ACCESS_TOKEN
    return { headers: { authorization: `Bearer ${token}` }, secrets: [token] }
  }
}

export function exampleRules(rec: Recorder, auth?: (input: AuthorizeInput) => Promise<Authorization>): ServiceRules {
  return {
    service: 'example',
    declaredHosts(target) {
      const host = (target as { host?: unknown } | null)?.host
      if (typeof host !== 'string') throw new Error('target has no host')
      return [host]
    },
    expired: (response) => response.status === 401,
    authorize: auth ?? bearerAuth(rec),
  }
}

/** Salesforce like: a lease per request, and expiry only on INVALID_SESSION_ID. */
export function salesforceRules(rec: Recorder, auth?: (input: AuthorizeInput) => Promise<Authorization>): ServiceRules {
  return {
    service: 'salesforce',
    declaredHosts(target) {
      const url = (target as { instance_url?: unknown } | null)?.instance_url
      if (typeof url !== 'string') throw new Error('target has no instance_url')
      return [new URL(url).hostname]
    },
    salesforce: {
      instanceHost(target) {
        return new URL((target as { instance_url: string }).instance_url).hostname
      },
    },
    async expired(response) {
      if (response.status !== 401) return false
      return (await response.text()).includes('INVALID_SESSION_ID')
    },
    authorize: auth ?? bearerAuth(rec),
  }
}

/**
 * A minter's token request reaches the platform through connectionFetch's
 * fetch (AuthorizeInput.fetch, #2337). Given a token endpoint double, the
 * doubles' fetch hands it every request whose path ends in /token, so a test
 * reads the token requests from the endpoint and the service's own requests
 * from `rec.sent`. Without one, every request is the recorder's.
 */
export type TokenEndpointFetch = (url: string, init?: RequestInit) => Promise<Response>

const isTokenRequest = (url: string): boolean => {
  try {
    return new URL(url).pathname.endsWith('/token')
  } catch {
    return false
  }
}

export function makeDoubles(keys: TestKeys, copy: ConnectionCopy | Error, rules: (rec: Recorder) => ServiceRules[], tokenEndpoint?: TokenEndpointFetch): Doubles {
  const rec: Recorder = { events: [], authorizeCalls: [], sent: [], recorded: [], needsReauth: [], refreshes: [], leases: [], reports: [], slept: [] }
  const now = { value: T0 }
  let refreshAnswer: RefreshOutcome = 'refresh_failing'
  let answers: Array<Response | (() => Response | Promise<Response>) | Error> = [new Response('ok', { status: 200 })]
  let leaseAnswers: Array<SfLeaseAnswer | Error> = [{ outcome: 'granted', leaseId: 'lease-1', expiresAt: new Date(T0 + 90_000).toISOString(), pool: 'org' }]
  let current: ConnectionCopy | Error = copy
  let holder = 0
  const byService = new Map(rules(rec).map((r) => [r.service, r]))

  const deps: ConnectionFetchDeps = {
    privateKeys: keys.privateKeys,
    readCopy: async () => {
      if (current instanceof Error) throw current
      return current
    },
    rulesFor: (service) => byService.get(service),
    acquireSfLease: async (_org, ask) => {
      rec.events.push('acquire')
      rec.leases.push({ op: 'acquire', purpose: ask.purpose, holder: ask.holder, bootstrapHost: ask.bootstrapHost, workflowId: ask.workflowId })
      const answer = leaseAnswers.length > 1 ? leaseAnswers.shift()! : leaseAnswers[0]
      if (answer instanceof Error) throw answer
      return answer
    },
    releaseSfLease: async (_org, h) => {
      rec.events.push('release')
      rec.leases.push({ op: 'release', holder: h })
      return 'released'
    },
    recordNeedsReauth: async (organizationId, connectionId, cause) => {
      rec.needsReauth.push({ organizationId, connectionId, cause })
    },
    recordRefresh: async (organizationId, connectionId, result) => {
      rec.refreshes.push({ organizationId, connectionId, result })
      return result.ok ? 'recorded' : refreshAnswer
    },
    fetch: async (input, init) => {
      if (tokenEndpoint && isTokenRequest(String(input))) return tokenEndpoint(String(input), init)
      rec.events.push('send')
      rec.sent.push({ url: String(input), init: init ?? {} })
      const answer = answers.length > 1 ? answers.shift()! : answers[0]
      if (answer instanceof Error) throw answer
      const response = typeof answer === 'function' ? await answer() : answer
      return response.clone()
    },
    now: () => now.value,
    sleep: async (ms) => {
      rec.slept.push(ms)
      now.value += ms
    },
    newHolder: () => `holder-${++holder}`,
    report: (event) => {
      rec.reports.push(event)
    },
  }

  return {
    rec,
    deps,
    respond: (...a) => {
      answers = a
    },
    leaseAnswers: (...a) => {
      leaseAnswers = a
    },
    setCopy: (c) => {
      current = c
    },
    refreshAnswer: (outcome) => {
      refreshAnswer = outcome
    },
    now,
  }
}

/** Everything about an error that can leave the Worker: what the tail trace and Workers Logs carry, and more. */
export function visibleText(err: unknown): string {
  if (!(err instanceof Error)) return JSON.stringify(err)
  const own = Object.fromEntries(Object.getOwnPropertyNames(err).map((k) => [k, String((err as unknown as Record<string, unknown>)[k])]))
  return [err.name, err.message, err.stack ?? '', String((err as { cause?: unknown }).cause ?? ''), JSON.stringify(own)].join('\n')
}
