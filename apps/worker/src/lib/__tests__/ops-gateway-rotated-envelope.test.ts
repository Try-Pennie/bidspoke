/**
 * The bidding Worker's storeRotatedEnvelope (#2335, PR 5 of phase 5 of #1689):
 * the compare and set by which the ops ConnectionTokenObject hands a person
 * bound connection's rotated login back to service_connections, its one home.
 *
 * Both sides parse what crosses the binding (L50): this Worker the request,
 * before anything reaches the database; the ops Worker the answer. The SQL it
 * calls is proven in supabase/tests/store_rotated_envelope.test.sql.
 */
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { storeRotatedEnvelope } from '../ops-gateway'
import {
  OpsGatewayContractError, parseStoreRotatedEnvelopeAnswer, parseStoreRotatedEnvelopeRequest, STORE_ROTATED_ENVELOPE_OUTCOMES,
} from '../ops-gateway-contract'
import readOnlyRpcs from '../read-only-rpcs.json'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const CONN = '00000000-0000-4000-8000-000000002335'
const ENVELOPE = { v: 1, kid: 'ops-2026-10', wrapped_key: 'd3JhcHBlZA==', iv: 'aXYtNDI=', ct: 'Y3QtNDI=' }

const request = (over: Record<string, unknown> = {}) => ({
  organization_id: ORG,
  connection_id: CONN,
  expected_generation: 3,
  generation: 4,
  envelope: ENVELOPE,
  ...over,
})

/** PostgREST for the rpc, answering `body` at `status` and recording each call. */
function rpcDb(body: unknown, status = 200) {
  const calls: { url: URL; body: unknown }[] = []
  const fakeFetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    return Response.json(body, { status })
  }) as typeof globalThis.fetch
  return {
    client: createClient('https://xvrmivmpfykwwtriqwpg.supabase.co', 'sb_secret_test', { global: { fetch: fakeFetch }, auth: { persistSession: false }, db: { retry: false } } as never),
    calls,
  }
}

describe('parseStoreRotatedEnvelopeRequest', () => {
  it('reads a well formed request', () => {
    expect(parseStoreRotatedEnvelopeRequest(request())).toEqual(request())
  })

  it.each([
    ['a request that is not an object', 'not an object'],
    ['an organization that is not a uuid', request({ organization_id: 'org-1' })],
    ['a connection that is not a uuid', request({ connection_id: 42 })],
    ['an expected generation below 1', request({ expected_generation: 0 })],
    ['an expected generation that is not a whole number', request({ expected_generation: 1.5 })],
    ['a generation not above the expected one', request({ generation: 3 })],
    ['an envelope that is not an object', request({ envelope: 'sealed' })],
    ['an envelope of another version', request({ envelope: { ...ENVELOPE, v: 2 } })],
    ['an envelope with a field the seal has not', request({ envelope: { ...ENVELOPE, refresh_token: 'x' } })],
    ['an envelope missing its iv', request({ envelope: { v: 1, kid: 'ops-2026-10', wrapped_key: 'd3JhcHBlZA==', ct: 'Y3QtNDI=' } })],
    ['an envelope whose kid is not a kid', request({ envelope: { ...ENVELOPE, kid: 'has space' } })],
    ['an envelope whose ciphertext is not base64', request({ envelope: { ...ENVELOPE, ct: 'not base64!' } })],
    ['an envelope past the size the ops copy holds', request({ envelope: { ...ENVELOPE, ct: 'A'.repeat(70_000) } })],
  ])('refuses %s by name', (_what, raw) => {
    expect(() => parseStoreRotatedEnvelopeRequest(raw)).toThrow(OpsGatewayContractError)
  })
})

describe('parseStoreRotatedEnvelopeAnswer (the ops side reads it)', () => {
  it('reads each outcome the function answers', () => {
    expect(STORE_ROTATED_ENVELOPE_OUTCOMES).toEqual(['stored', 'already_stored', 'moved', 'not_found'])
    expect(parseStoreRotatedEnvelopeAnswer({ outcome: 'stored', current_generation: 4, current_iv: 'aXYtNDI=' })).toEqual({ outcome: 'stored', current_generation: 4, current_iv: 'aXYtNDI=' })
    expect(parseStoreRotatedEnvelopeAnswer({ outcome: 'moved', current_generation: 5, current_iv: null })).toEqual({ outcome: 'moved', current_generation: 5, current_iv: null })
    expect(parseStoreRotatedEnvelopeAnswer({ outcome: 'not_found', current_generation: null, current_iv: null })).toEqual({ outcome: 'not_found', current_generation: null, current_iv: null })
  })

  it.each([
    ['an answer that is not an object', null],
    ['an outcome it does not know', { outcome: 'maybe', current_generation: 4, current_iv: 'x' }],
    ['stored with no generation', { outcome: 'stored', current_generation: null, current_iv: 'x' }],
    ['moved with no generation', { outcome: 'moved', current_generation: null, current_iv: null }],
    ['not_found naming a generation', { outcome: 'not_found', current_generation: 3, current_iv: null }],
    ['a generation that is not a whole number', { outcome: 'moved', current_generation: '3', current_iv: null }],
  ])('refuses %s', (_what, raw) => {
    expect(() => parseStoreRotatedEnvelopeAnswer(raw)).toThrow(OpsGatewayContractError)
  })
})

describe('storeRotatedEnvelope on the bidding Worker', () => {
  it('calls store_rotated_envelope with the request and answers its one row', async () => {
    const db = rpcDb([{ outcome: 'stored', current_generation: 4, current_iv: 'aXYtNDI=' }])
    await expect(storeRotatedEnvelope(db.client, request())).resolves.toEqual({ outcome: 'stored', current_generation: 4, current_iv: 'aXYtNDI=' })
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].url.pathname).toBe('/rest/v1/rpc/store_rotated_envelope')
    expect(db.calls[0].body).toEqual({
      p_organization_id: ORG,
      p_connection_id: CONN,
      p_expected_generation: 3,
      p_new_generation: 4,
      p_envelope: ENVELOPE,
    })
  })

  it('answers moved with the row\'s generation and iv, so the object can tell its own write from a Reconnect', async () => {
    const db = rpcDb([{ outcome: 'moved', current_generation: 4, current_iv: 'b3RoZXI=' }])
    await expect(storeRotatedEnvelope(db.client, request())).resolves.toEqual({ outcome: 'moved', current_generation: 4, current_iv: 'b3RoZXI=' })
  })

  it('refuses a malformed request by name without reaching the database', async () => {
    const db = rpcDb([])
    await expect(storeRotatedEnvelope(db.client, request({ generation: 2 }))).rejects.toThrow(OpsGatewayContractError)
    expect(db.calls).toHaveLength(0)
  })

  it('throws when the database refuses or fails, so the object retries rather than reading a write that did not happen', async () => {
    const db = rpcDb({ code: '57014', message: 'canceling statement due to statement timeout' }, 500)
    await expect(storeRotatedEnvelope(db.client, request())).rejects.toThrow(/store_rotated_envelope/)
  })

  it('throws on an answer of no row or of more than one', async () => {
    await expect(storeRotatedEnvelope(rpcDb([]).client, request())).rejects.toThrow(OpsGatewayContractError)
    const two = [{ outcome: 'stored', current_generation: 4, current_iv: 'a' }, { outcome: 'stored', current_generation: 4, current_iv: 'a' }]
    await expect(storeRotatedEnvelope(rpcDb(two).client, request())).rejects.toThrow(OpsGatewayContractError)
  })

  it('is classified as a write, so a local dev run against production refuses it', () => {
    expect(readOnlyRpcs.mutating).toContain('store_rotated_envelope')
    expect(readOnlyRpcs.readOnly).not.toContain('store_rotated_envelope')
  })
})
