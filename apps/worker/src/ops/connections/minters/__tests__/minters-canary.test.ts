import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceSchema } from '@bidspoke/service-catalogue/schema'
import { connectionFetch, type ConnectionCall } from '../../connection-fetch'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, visibleText, type Doubles, type Recorder, type TestKeys } from '../../__tests__/harness'
import { googleDelegationAuth } from '../google'
import { salesforceClientCredentialsAuth } from '../salesforce'
import { makeSigningKey, rulesOf, type SigningKey } from './minter-harness'

/**
 * The canary through the real minters (#2335, finding F120). A token endpoint
 * that echoes everything it was sent (the client secret, the signed
 * assertion, a token) must not get any of it out: not in the thrown refusal,
 * not in the console, the recorded request, the needs_reauth cause, the
 * refresh streak or the reports. The minters' errors are LoginMintErrors built
 * from names only, and connectionFetch forwards none of them anyway.
 */

const SF_SECRET = 'canary-salesforce-client-credential'
const ECHOED_TOKEN = 'canary-echoed-access-token'
const SHEETS = 'https://www.googleapis.com/auth/spreadsheets'
const CATALOGUE: readonly ServiceSchema[] = [{
  key: 'google_sheets', name: 'Sheets',
  actions: [{ key: 'google_sheets.read', name: 'Read', version: 1, arguments: [], sideEffect: false, idempotent: true, idempotentBecause: 'a read', googleScopes: [SHEETS] }],
}]

let keys: TestKeys
let signing: SigningKey
const consoleLines: string[] = []

beforeAll(async () => {
  keys = await makeKeys()
  signing = await makeSigningKey()
}, 120_000)

beforeEach(() => {
  consoleLines.length = 0
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (a instanceof Error ? visibleText(a) : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

function call(rec: Recorder, overrides: Partial<ConnectionCall> = {}): ConnectionCall {
  return { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'lookup', record: async (r) => { rec.recorded.push(r) }, ...overrides }
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected the call to throw')
}

function everythingThatLeaves(d: Doubles, err: unknown): string {
  return [
    visibleText(err), consoleLines.join('\n'), JSON.stringify(d.rec.recorded), JSON.stringify(d.rec.needsReauth), JSON.stringify(d.rec.refreshes),
    JSON.stringify(d.rec.reports),
  ].join('\n')
}

/** A token endpoint that answers with everything it was sent, and a token, in its error. */
function echoing(status: number) {
  return async (_input: string, init?: RequestInit) => new Response(
    JSON.stringify({ error: 'invalid_client', error_description: `you sent ${String(init?.body)}; try ${ECHOED_TOKEN}` }),
    { status },
  )
}

describe('the canary never leaves through a minter (F120)', () => {
  it.each([401, 400, 503])('Salesforce: a token endpoint answering %i with the request echoed back', async (status) => {
    const envelope = await sealLogin(keys, { service: 'salesforce', plaintext: JSON.stringify({ client_id: 'ops-client', client_secret: SF_SECRET }) })
    const auth = salesforceClientCredentialsAuth({ now: () => T0 })
    const d = makeDoubles(keys, usableCopy(envelope, { service: 'salesforce', target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'ops-client' } }), () => [
      rulesOf('salesforce', auth, () => ['trypennie.my.salesforce.com']),
    ], echoing(status))
    const err = await caught(connectionFetch(d.deps, call(d.rec), 'https://trypennie.my.salesforce.com/services/data/v60.0/limits'))
    const text = everythingThatLeaves(d, err)
    for (const secret of [SF_SECRET, ECHOED_TOKEN]) {
      expect(text).not.toContain(secret)
      expect(text).not.toContain(encodeURIComponent(secret))
    }
  })

  it('Google: a token endpoint echoing the signed assertion and a token', async () => {
    const envelope = await sealLogin(keys, {
      service: 'google_sheets',
      plaintext: JSON.stringify({ type: 'service_account', client_email: 'ops@ops-project.iam.gserviceaccount.com', private_key: signing.pem, token_uri: 'https://oauth2.googleapis.com/token' }),
    })
    const sentAssertions: string[] = []
    const auth = googleDelegationAuth({
      now: () => T0,
      catalogue: CATALOGUE,
      checkDelegation: async () => 'allowed',
    })
    const echoingGoogle = async (input: string, init?: RequestInit) => {
      sentAssertions.push(new URLSearchParams(String(init?.body)).get('assertion') ?? '')
      return echoing(400)(input, init)
    }
    // A Google entry declares its token host beside the API host: the grant goes through connectionFetch's fetch (#2337).
    const d = makeDoubles(keys, usableCopy(envelope, { service: 'google_sheets', target: { subject: 'ops@example.invalid' } }), () => [
      rulesOf('google_sheets', auth, () => ['sheets.googleapis.com', 'oauth2.googleapis.com']),
    ], echoingGoogle)
    const err = await caught(connectionFetch(d.deps, call(d.rec), 'https://sheets.googleapis.com/v4/spreadsheets/x'))
    expect(sentAssertions[0].length).toBeGreaterThan(100)
    const text = everythingThatLeaves(d, err)
    for (const secret of [sentAssertions[0], ECHOED_TOKEN, signing.pem.split('\n')[1]]) expect(text).not.toContain(secret)
  })
})
