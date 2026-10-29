/**
 * The signature on every dispatch to OpsInternal (#1949; #1698 1.4, L19).
 *
 * Defence in depth behind the binding itself, which the public edge cannot reach
 * (spike P6): a call must carry an HMAC of its body under a key derived from the
 * Worker's master secret, checked by the one shared constant time verifier
 * (@bidspoke/porting-evidence verifyBodySignature), and a signing time inside
 * five minutes either way. Each refusal is by name, and nothing malformed throws
 * anything but a refusal, so a caller cannot fail open by catching.
 */
import { describe, expect, it } from 'vitest'
import { DISPATCH_MAX_SKEW_MS, dispatchKey, signDispatch, verifyDispatch } from '../dispatch-auth'
import { OpsInternalRefused } from '../internal'
import { organizationIdFrom } from '../ops-db'

const NOW = Date.parse('2026-10-17T10:02:31.000Z')
const envelope = { v: 1 as const, tick_id: 'tick-1', signed_at: new Date(NOW).toISOString(), item: { kind: 'probe' as const } }

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(OpsInternalRefused)
    return (err as OpsInternalRefused).reason
  }
  throw new Error('expected a refusal')
}

const RUN = {
  runRequestId: '0192f4a0-0000-7000-8000-000000000001', organizationId: organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'), workflowId: '00000000-0000-4000-8000-0000000019a1',
  workflowVersion: 3, triggerKind: 'schedule', claimToken: '11111111-2222-4333-8444-555555555555', claimExpiresAt: '2026-10-17T10:03:31.000Z', stateVersion: 2,
  attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null, executionChainId: '0192f4a0-0000-7000-9000-000000000001',
  resumedFromExecutionId: null, payload: { slot: '2026-10-17T10:00:00Z' }, payloadRef: null,
}

/** The variables the tick was served for the run (#2998), a planted secret value among them. */
const VARIABLES = {
  source: 'bidding' as const, servedAt: '2026-10-17T10:02:30.000Z', values: { API_BASE: 'https://api.example.test' }, secretValues: { API_TOKEN: 'sk_live_planted_dispatch' },
}

describe('a run dispatch (#1950)', () => {
  it('carries a claimed run and its variables (#2998), signed and verified whole', async () => {
    const key = await dispatchKey('master-secret')
    const runEnvelope = { ...envelope, item: { kind: 'run' as const, run: RUN, variables: VARIABLES } }
    expect(await verifyDispatch(key, await signDispatch(key, runEnvelope), NOW)).toEqual(runEnvelope)
  })

  it('refuses a run item missing its claim token, with a bad organization, or with a field of the wrong type', async () => {
    const key = await dispatchKey('master-secret')
    for (const run of [{ ...RUN, claimToken: undefined }, { ...RUN, organizationId: 'nope' }, { ...RUN, stateVersion: '2' }, { ...RUN, extra: 1 }]) {
      const signed = await signDispatch(key, { ...envelope, item: { kind: 'run', run, variables: VARIABLES } as never })
      expect(await refusal(verifyDispatch(key, signed, NOW))).toBe('malformed')
    }
  })

  it('refuses a run item without its variables or with variables of another shape (#2998)', async () => {
    const key = await dispatchKey('master-secret')
    const items: unknown[] = [
      { kind: 'run', run: RUN },
      { kind: 'run', run: RUN, variables: null },
      { kind: 'run', run: RUN, variables: { ...VARIABLES, secretValues: undefined } },
      { kind: 'run', run: RUN, variables: { ...VARIABLES, values: { API_BASE: 1 } } },
      { kind: 'run', run: RUN, variables: VARIABLES, extra: true },
    ]
    for (const item of items) {
      const signed = await signDispatch(key, { ...envelope, item: item as never })
      expect(await refusal(verifyDispatch(key, signed, NOW)), JSON.stringify(item)).toBe('malformed')
    }
  })
})

describe('dispatch signatures', () => {
  it('verifies what it signed', async () => {
    const key = await dispatchKey('master-secret')
    const signed = await signDispatch(key, envelope)
    expect(await verifyDispatch(key, signed, NOW)).toEqual(envelope)
  })

  it('refuses a tampered body, a wrong key and a missing signature', async () => {
    const key = await dispatchKey('master-secret')
    const signed = await signDispatch(key, envelope)
    expect(await refusal(verifyDispatch(key, { ...signed, body: signed.body.replace('probe', 'would_fire') }, NOW))).toBe('bad_signature')
    expect(await refusal(verifyDispatch(await dispatchKey('another-master'), signed, NOW))).toBe('bad_signature')
    expect(await refusal(verifyDispatch(key, { body: signed.body }, NOW))).toBe('bad_signature')
  })

  it('refuses a call signed too long ago or too far ahead', async () => {
    const key = await dispatchKey('master-secret')
    const old = await signDispatch(key, { ...envelope, signed_at: new Date(NOW - DISPATCH_MAX_SKEW_MS - 1).toISOString() })
    const ahead = await signDispatch(key, { ...envelope, signed_at: new Date(NOW + DISPATCH_MAX_SKEW_MS + 1).toISOString() })
    expect(await refusal(verifyDispatch(key, old, NOW))).toBe('stale')
    expect(await refusal(verifyDispatch(key, ahead, NOW))).toBe('stale')
  })

  it('refuses anything that is not a signed dispatch, as a refusal and never another error', async () => {
    const key = await dispatchKey('master-secret')
    for (const junk of [null, 'x', 1, [], { body: 1, signature: 'v1=00' }]) {
      expect(await refusal(verifyDispatch(key, junk, NOW))).toBe('malformed')
    }
    const notJson = { body: 'not json', signature: '' }
    expect(await refusal(verifyDispatch(key, notJson, NOW))).toBe('bad_signature')
  })

  it('refuses a signed body that is not an envelope', async () => {
    const key = await dispatchKey('master-secret')
    const signed = await signDispatch(key, { ...envelope, item: { kind: 'run_now' } } as never)
    expect(await refusal(verifyDispatch(key, signed, NOW))).toBe('malformed')
  })

  it('has no key without the master secret, by name', async () => {
    expect(await refusal(dispatchKey(undefined))).toBe('dispatch_key_unset')
    expect(await refusal(dispatchKey(''))).toBe('dispatch_key_unset')
  })
})
