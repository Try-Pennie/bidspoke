/**
 * What crosses the OPS_CONNECTIONS binding (#2335, PR 8 of phase 5 of #1689):
 * each request is parsed on ops before anything is read or opened (L50), and a
 * malformed one is refused by name, naming a field and never a value.
 */
import { describe, expect, it } from 'vitest'
import {
  LOOKUP_RATE_PER_MINUTE, OPS_CONNECTIONS_CEILINGS_MS, OPS_CONNECTIONS_METHODS, OpsConnectionsContractError, parseClearReauthRequest,
  parseExchangeOAuthCodeRequest, parseHealthRequest, parseLookupRequest, parseRevokeRequest, parseVerifyRequest,
} from '../ops-connections-contract'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const CONN = '0199f0a0-0000-7000-8000-000000000001'
const ENVELOPE = { v: 1, kid: 'ops-2026-10', wrapped_key: 'd3JhcHBlZA==', iv: 'aXY=', ct: 'Y3Q=' }
const CANDIDATE = {
  service: 'salesforce', generation: 2, envelope: ENVELOPE,
  target: { instance_url: 'https://ops.my.salesforce.com', client_id: 'ops-app' }, public_config: { name: 'ops salesforce' },
}

function refused(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof OpsConnectionsContractError) return err.message
    throw err
  }
  throw new Error('expected a refusal, and the request parsed')
}

describe('the OpsConnections contract', () => {
  it('names the methods the entrypoint answers, and a ceiling for each', () => {
    expect([...OPS_CONNECTIONS_METHODS].sort()).toEqual(['clearReauth', 'exchangeOAuthCode', 'health', 'lookup', 'revoke', 'verify'])
    expect(Object.keys(OPS_CONNECTIONS_CEILINGS_MS).sort()).toEqual([...OPS_CONNECTIONS_METHODS].sort())
    for (const ms of Object.values(OPS_CONNECTIONS_CEILINGS_MS)) expect(ms).toBeGreaterThan(0)
    expect(LOOKUP_RATE_PER_MINUTE).toBeGreaterThanOrEqual(1)
    expect(LOOKUP_RATE_PER_MINUTE).toBeLessThanOrEqual(600)
  })

  it('a verify names the organization and connection, with or without a candidate; ids are read lower case, as the seal binds them', () => {
    expect(parseVerifyRequest({ organization_id: ORG.toUpperCase(), connection_id: CONN, candidate: null }))
      .toEqual({ organization_id: ORG, connection_id: CONN, candidate: null })
    expect(parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: CANDIDATE }).candidate).toEqual(CANDIDATE)
    expect(parseVerifyRequest({ organization_id: ORG, connection_id: CONN }).candidate).toBeNull()
  })

  it('refuses a request with no organization or connection uuid, by the field', () => {
    expect(refused(() => parseVerifyRequest({ connection_id: CONN }))).toMatch(/organization_id/)
    expect(refused(() => parseVerifyRequest({ organization_id: 'acme', connection_id: CONN }))).toMatch(/organization_id/)
    expect(refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: 7 }))).toMatch(/connection_id/)
    expect(refused(() => parseVerifyRequest('verify me'))).toMatch(/not an object/)
    expect(refused(() => parseHealthRequest({}))).toMatch(/organization_id/)
  })

  it('refuses a candidate that is not ciphertext and public config only, naming the field and never the value', () => {
    const withSecret = { ...CANDIDATE, public_config: { client_secret: 'canary-client-credential-value' } }
    const message = refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: withSecret }))
    expect(message).toMatch(/client_secret/)
    expect(message).not.toContain('canary-client-credential-value')
    expect(refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: { ...CANDIDATE, envelope: { ...ENVELOPE, extra: 1 } } }))).toMatch(/envelope/)
    expect(refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: { ...CANDIDATE, generation: 0 } }))).toMatch(/generation/)
    expect(refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: { ...CANDIDATE, service: 'Sales Force' } }))).toMatch(/service/)
    expect(refused(() => parseVerifyRequest({ organization_id: ORG, connection_id: CONN, candidate: { ...CANDIDATE, target: 'x' } }))).toMatch(/target/)
  })

  it('clearReauth needs its candidate: it verifies the envelope passed in the call', () => {
    expect(parseClearReauthRequest({ organization_id: ORG, connection_id: CONN, candidate: CANDIDATE }).candidate).toEqual(CANDIDATE)
    expect(refused(() => parseClearReauthRequest({ organization_id: ORG, connection_id: CONN, candidate: null }))).toMatch(/candidate/)
  })

  it('revoke names the generation removed and when, on the bidding Worker\'s clock', () => {
    expect(parseRevokeRequest({ organization_id: ORG, connection_id: CONN, generation: 3, removed_at: '2026-10-19T10:00:00.000Z' }))
      .toEqual({ organization_id: ORG, connection_id: CONN, generation: 3, removed_at: '2026-10-19T10:00:00.000Z' })
    expect(refused(() => parseRevokeRequest({ organization_id: ORG, connection_id: CONN, generation: 1.5, removed_at: '2026-10-19T10:00:00.000Z' }))).toMatch(/generation/)
    expect(refused(() => parseRevokeRequest({ organization_id: ORG, connection_id: CONN, generation: 1, removed_at: 'yesterday' }))).toMatch(/removed_at/)
  })

  it('a lookup names a key and at most one parent', () => {
    expect(parseLookupRequest({ organization_id: ORG, connection_id: CONN, key: 'fields', parents: ['Submission__c'] }))
      .toEqual({ organization_id: ORG, connection_id: CONN, key: 'fields', parents: ['Submission__c'] })
    expect(parseLookupRequest({ organization_id: ORG, connection_id: CONN, key: 'objects' }).parents).toEqual([])
    expect(refused(() => parseLookupRequest({ organization_id: ORG, connection_id: CONN, key: '', parents: [] }))).toMatch(/key/)
    expect(refused(() => parseLookupRequest({ organization_id: ORG, connection_id: CONN, key: 'fields', parents: ['a', 'b'] }))).toMatch(/parents/)
    expect(refused(() => parseLookupRequest({ organization_id: ORG, connection_id: CONN, key: 'fields', parents: [3] }))).toMatch(/parents/)
  })

  it('an exchange carries the sealed app login as a candidate, the code, a PKCE verifier of 43 to 128 characters and the redirect URI', () => {
    const ok = { organization_id: ORG, connection_id: CONN, candidate: CANDIDATE, code: 'auth-code', verifier: 'v'.repeat(43), redirect_uri: 'https://bidspoke.trypennie.dev/callback' }
    expect(parseExchangeOAuthCodeRequest(ok)).toEqual(ok)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, verifier: 'v'.repeat(42) }))).toMatch(/verifier/)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, verifier: 'v'.repeat(129) }))).toMatch(/verifier/)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, code: '' }))).toMatch(/code/)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, redirect_uri: 7 }))).toMatch(/redirect_uri/)
    expect(refused(() => parseExchangeOAuthCodeRequest({ ...ok, candidate: null }))).toMatch(/candidate/)
  })
})
