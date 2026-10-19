/**
 * The bidding Worker's replaceConnectionEnvelope (#2333, the reseal): the
 * compare and set by which the ops Worker's resealConnections moves one ops
 * connection's sealed login from an old kid to the current one, at the same
 * generation, during a rotation of the ops key.
 *
 * Both sides parse what crosses the binding (L50): this Worker the request,
 * before anything reaches the database; the ops Worker the answer. The SQL it
 * calls is proven in supabase/tests/replace_connection_envelope.test.sql.
 */
import { createClient } from '@supabase/supabase-js'
import { CURRENT_OPS_KID } from '@bidspoke/connection-seal'
import { describe, expect, it } from 'vitest'
import { replaceConnectionEnvelope } from '../ops-gateway'
import {
  OpsGatewayContractError, parseReplaceConnectionEnvelopeAnswer, parseReplaceConnectionEnvelopeRequest, REPLACE_CONNECTION_ENVELOPE_OUTCOMES,
} from '../ops-gateway-contract'
import readOnlyRpcs from '../read-only-rpcs.json'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const CONN = '00000000-0000-4000-8000-000000002333'
const OLD_KID = 'ops-2025-01'
// The envelope names whatever kid is committed as current, never a copy of it,
// so moving CURRENT_OPS_KID in a rotation leaves these tests asking the same thing.
if (typeof CURRENT_OPS_KID !== 'string') throw new Error('these tests need a committed current kid')
const ENVELOPE = { v: 1, kid: CURRENT_OPS_KID, wrapped_key: 'd3JhcHBlZA==', iv: 'aXYtNDI=', ct: 'Y3QtNDI=' }

const request = (over: Record<string, unknown> = {}) => ({
  organization_id: ORG,
  connection_id: CONN,
  expected_kid: OLD_KID,
  expected_generation: 3,
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

describe('parseReplaceConnectionEnvelopeRequest', () => {
  it('reads a well formed request whose envelope names the committed current kid', () => {
    expect(parseReplaceConnectionEnvelopeRequest(request())).toEqual(request())
  })

  it.each([
    ['a request that is not an object', 'not an object'],
    ['an organization that is not a uuid', request({ organization_id: 'org-1' })],
    ['a connection that is not a uuid', request({ connection_id: 42 })],
    ['an expected kid that is not a kid', request({ expected_kid: 'Has Space' })],
    ['an expected generation below 1', request({ expected_generation: 0 })],
    ['an expected generation that is not a whole number', request({ expected_generation: 1.5 })],
    ['an envelope that is not an object', request({ envelope: 'sealed' })],
    ['an envelope with a field the seal has not', request({ envelope: { ...ENVELOPE, refresh_token: 'x' } })],
    ['an envelope whose ciphertext is not base64', request({ envelope: { ...ENVELOPE, ct: 'not base64!' } })],
    // Only the committed current kid: the ops Worker may move a login only to the key every new seal uses.
    ['an envelope sealed under a kid that is not the current one', request({ envelope: { ...ENVELOPE, kid: 'ops-2027-01' } })],
    ['an envelope naming the kid it replaces', request({ expected_kid: ENVELOPE.kid })],
  ])('refuses %s by name', (_what, raw) => {
    expect(() => parseReplaceConnectionEnvelopeRequest(raw)).toThrow(OpsGatewayContractError)
  })

  it('refuses every request while no kid is current, since nothing may be sealed then', () => {
    expect(() => parseReplaceConnectionEnvelopeRequest(request(), null)).toThrow(/no kid is current/)
  })
})

describe('parseReplaceConnectionEnvelopeAnswer (the ops side reads it)', () => {
  it('reads each outcome the function answers', () => {
    expect(REPLACE_CONNECTION_ENVELOPE_OUTCOMES).toEqual(['replaced', 'already_replaced', 'moved', 'not_found'])
    expect(parseReplaceConnectionEnvelopeAnswer({ outcome: 'replaced', current_generation: 3, current_kid: 'ops-2026-10' })).toEqual({ outcome: 'replaced', current_generation: 3, current_kid: 'ops-2026-10' })
    expect(parseReplaceConnectionEnvelopeAnswer({ outcome: 'moved', current_generation: 4, current_kid: null })).toEqual({ outcome: 'moved', current_generation: 4, current_kid: null })
    expect(parseReplaceConnectionEnvelopeAnswer({ outcome: 'not_found', current_generation: null, current_kid: null })).toEqual({ outcome: 'not_found', current_generation: null, current_kid: null })
  })

  it.each([
    ['an answer that is not an object', null],
    ['an outcome it does not know', { outcome: 'maybe', current_generation: 3, current_kid: 'ops-2026-10' }],
    ['replaced with no generation', { outcome: 'replaced', current_generation: null, current_kid: 'ops-2026-10' }],
    ['not_found naming a generation', { outcome: 'not_found', current_generation: 3, current_kid: null }],
    ['a kid that is not a string', { outcome: 'moved', current_generation: 3, current_kid: 7 }],
    ['a generation that is not a whole number', { outcome: 'moved', current_generation: '3', current_kid: null }],
  ])('refuses %s', (_what, raw) => {
    expect(() => parseReplaceConnectionEnvelopeAnswer(raw)).toThrow(OpsGatewayContractError)
  })
})

describe('replaceConnectionEnvelope on the bidding Worker', () => {
  it('calls replace_connection_envelope with the request and answers its one row', async () => {
    const db = rpcDb([{ outcome: 'replaced', current_generation: 3, current_kid: ENVELOPE.kid }])
    await expect(replaceConnectionEnvelope(db.client, request())).resolves.toEqual({ outcome: 'replaced', current_generation: 3, current_kid: ENVELOPE.kid })
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].url.pathname).toBe('/rest/v1/rpc/replace_connection_envelope')
    expect(db.calls[0].body).toEqual({
      p_organization_id: ORG,
      p_connection_id: CONN,
      p_expected_kid: OLD_KID,
      p_expected_generation: 3,
      p_envelope: ENVELOPE,
    })
  })

  it('answers moved with the row\'s generation and kid, so the reseal can say the row moved on', async () => {
    const db = rpcDb([{ outcome: 'moved', current_generation: 4, current_kid: 'ops-2026-10' }])
    await expect(replaceConnectionEnvelope(db.client, request())).resolves.toEqual({ outcome: 'moved', current_generation: 4, current_kid: 'ops-2026-10' })
  })

  it('refuses a malformed request by name without reaching the database', async () => {
    const db = rpcDb([])
    await expect(replaceConnectionEnvelope(db.client, request({ envelope: { ...ENVELOPE, kid: 'ops-2027-01' } }))).rejects.toThrow(OpsGatewayContractError)
    expect(db.calls).toHaveLength(0)
  })

  it('throws when the database refuses or fails, so the reseal reports the row as not written', async () => {
    const db = rpcDb({ code: '57014', message: 'canceling statement due to statement timeout' }, 500)
    await expect(replaceConnectionEnvelope(db.client, request())).rejects.toThrow(/replace_connection_envelope/)
  })

  it('throws on an answer of no row or of more than one', async () => {
    const none = rpcDb([])
    await expect(replaceConnectionEnvelope(none.client, request())).rejects.toThrow(OpsGatewayContractError)
    const two = [{ outcome: 'replaced', current_generation: 3, current_kid: ENVELOPE.kid }, { outcome: 'replaced', current_generation: 3, current_kid: ENVELOPE.kid }]
    const many = rpcDb(two)
    await expect(replaceConnectionEnvelope(many.client, request())).rejects.toThrow(OpsGatewayContractError)
    // Both reached the database, so the refusal is the answer's, not the request's.
    expect([none.calls.length, many.calls.length]).toEqual([1, 1])
  })

  it('is classified as a write, so a local dev run against production refuses it', () => {
    expect(readOnlyRpcs.mutating).toContain('replace_connection_envelope')
    expect(readOnlyRpcs.readOnly).not.toContain('replace_connection_envelope')
  })
})

describe('the OpsGateway entrypoint method', () => {
  it('reaches replace_connection_envelope through the service role client, retries off, and refuses a bad request before it', async () => {
    const { OpsGateway } = await import('../ops-gateway-entrypoint')
    const gw = new OpsGateway({} as ExecutionContext, { SUPABASE_URL: 'https://xvrmivmpfykwwtriqwpg.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' } as never)
    await expect(gw.replaceConnectionEnvelope(request({ connection_id: 'nope' }))).rejects.toThrow(OpsGatewayContractError)
  })
})
