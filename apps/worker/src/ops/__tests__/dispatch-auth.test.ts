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
