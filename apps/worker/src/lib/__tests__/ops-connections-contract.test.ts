/**
 * What crosses the OPS_CONNECTIONS binding (#2335, PR 8 of phase 5 of #1689):
 * each request is parsed on ops before anything is read or opened (L50), and a
 * malformed one is refused by name, naming a field and never a value.
 */
import { describe, expect, it } from 'vitest'
import {
  LOOKUP_RATE_PER_MINUTE, OPS_CONNECTIONS_CEILINGS_MS, OPS_CONNECTIONS_METHODS, OPS_DELEGATION_METHODS, OpsConnectionsContractError,
  parseAddDelegationSubjectRequest, parseClearReauthRequest, parseExchangeOAuthCodeRequest, parseHealthRequest, parseListDelegationSubjectsRequest,
  parseLookupRequest, parseRemoveDelegationSubjectRequest, parseRevokeRequest, parseVerifyRequest,
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
    expect([...OPS_CONNECTIONS_METHODS].sort()).toEqual([
      'addDelegationSubject', 'clearReauth', 'exchangeOAuthCode', 'health', 'listDelegationSubjects', 'lookup', 'removeDelegationSubject', 'revoke', 'verify',
    ])
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

describe('the Google mailboxes and drives list (#2338, PR 2)', () => {
  const ACTOR = { user_id: 'cccccccc-0000-4000-8000-000000002338', email: 'dan@example.invalid', name: 'Dan Wright' }

  it('its three methods are OpsConnections methods bidding calls, each with a ceiling, now that the ops deploy carries them (build PR 6)', () => {
    expect(OPS_DELEGATION_METHODS.filter((m) => !(OPS_CONNECTIONS_METHODS as readonly string[]).includes(m))).toEqual([])
    expect([...OPS_DELEGATION_METHODS].sort()).toEqual(['addDelegationSubject', 'listDelegationSubjects', 'removeDelegationSubject'])
    for (const m of OPS_DELEGATION_METHODS) expect(OPS_CONNECTIONS_CEILINGS_MS[m]).toBe(10_000)
  })

  it('an add names the organization, who is adding, the kind, the entry and a drive\'s name', () => {
    expect(parseAddDelegationSubjectRequest({ organization_id: ORG.toUpperCase(), actor: ACTOR, kind: 'drive', subject: '0AbCdEfGhIjKlMnOpQ', display_name: 'Partner reports' }))
      .toEqual({ organization_id: ORG, actor: ACTOR, kind: 'drive', subject: '0AbCdEfGhIjKlMnOpQ', display_name: 'Partner reports' })
    expect(parseAddDelegationSubjectRequest({ organization_id: ORG, actor: { ...ACTOR, name: null }, kind: 'mailbox', subject: 'Ops@Example.invalid' }))
      .toEqual({ organization_id: ORG, actor: { ...ACTOR, name: null }, kind: 'mailbox', subject: 'Ops@Example.invalid', display_name: null })
  })

  it('refuses an add with no actor, an actor with neither a name nor an email, an unknown kind or an entry that is not text, by the field', () => {
    const ok = { organization_id: ORG, actor: ACTOR, kind: 'mailbox', subject: 'ops@example.invalid' }
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, actor: undefined }))).toMatch(/actor/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, actor: { ...ACTOR, user_id: 'dan' } }))).toMatch(/actor/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, actor: { user_id: ACTOR.user_id, email: null, name: ' ' } }))).toMatch(/actor/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, kind: 'calendar' }))).toMatch(/kind/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, subject: 7 }))).toMatch(/subject/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, subject: 'x'.repeat(321) }))).toMatch(/subject/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, display_name: 7 }))).toMatch(/display_name/)
    expect(refused(() => parseAddDelegationSubjectRequest({ ...ok, organization_id: 'acme' }))).toMatch(/organization_id/)
  })

  it('a remove names who is removing, the kind and the entry; a list names only the organization', () => {
    expect(parseRemoveDelegationSubjectRequest({ organization_id: ORG, actor: ACTOR, kind: 'mailbox', subject: 'ops@example.invalid' }))
      .toEqual({ organization_id: ORG, actor: ACTOR, kind: 'mailbox', subject: 'ops@example.invalid' })
    expect(refused(() => parseRemoveDelegationSubjectRequest({ organization_id: ORG, kind: 'mailbox', subject: 'ops@example.invalid' }))).toMatch(/actor/)
    expect(parseListDelegationSubjectsRequest({ organization_id: ORG.toUpperCase() })).toEqual({ organization_id: ORG })
    expect(refused(() => parseListDelegationSubjectsRequest({}))).toMatch(/organization_id/)
  })
})
