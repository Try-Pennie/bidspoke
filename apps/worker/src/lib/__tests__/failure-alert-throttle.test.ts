import { describe, it, expect, vi } from 'vitest'
import {
  failureAlertSignature,
  failureAlertSuppressed,
  markFailureAlertSent,
  FAILURE_ALERT_COOLDOWN_SECONDS,
} from '../failure-alert-throttle'

type Kv = {
  get(k: string): Promise<string | null>
  put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>
}
function kvDouble(seed: Record<string, string> = {}): Kv & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => {
      store.set(k, v)
    },
  }
}

describe('failureAlertSignature', () => {
  it('collapses a per-lead error flood that differs only by ids into one signature', () => {
    const a = failureAlertSignature('wf1', 'ping_lendswift', 'Code returned error response for 11111111-2222-3333-4444-555555555555 (500)')
    const b = failureAlertSignature('wf1', 'ping_lendswift', 'Code returned error response for 99999999-8888-7777-6666-555555555555 (500)')
    expect(a).toBe(b)
  })

  it('keeps distinct status codes apart, since a 500 and a 403 are different diagnoses', () => {
    expect(failureAlertSignature('wf1', 'ping', 'HTTP error (500)')).not.toBe(
      failureAlertSignature('wf1', 'ping', 'HTTP error (403)'),
    )
  })

  it('keeps different workflows and failed steps apart', () => {
    expect(failureAlertSignature('wf1', 's', 'e')).not.toBe(failureAlertSignature('wf2', 's', 'e'))
    expect(failureAlertSignature('wf1', 's1', 'e')).not.toBe(failureAlertSignature('wf1', 's2', 'e'))
  })

  it('bounds the signature to its byte budget (and the key under 512) for a huge non-ASCII error', () => {
    const sig = failureAlertSignature('a'.repeat(36), 's'.repeat(300), '語'.repeat(5000))
    expect(new TextEncoder().encode(sig).length).toBeLessThanOrEqual(450)
    expect(new TextEncoder().encode(`failure-alert-cooldown:${sig}`).length).toBeLessThan(512)
  })
})

describe('failureAlertSuppressed', () => {
  const sig = 'wf1|step|shape'

  it('is false when no alert for the signature has gone out', async () => {
    expect(await failureAlertSuppressed(kvDouble(), sig)).toBe(false)
  })

  it('is true once the signature window is open', async () => {
    const kv = kvDouble({ 'failure-alert-cooldown:wf1|step|shape': '1' })
    expect(await failureAlertSuppressed(kv, sig)).toBe(true)
  })

  it('fails open (not suppressed) when the KV read throws', async () => {
    const kv = { get: async () => { throw new Error('kv down') }, put: async () => undefined }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await failureAlertSuppressed(kv, sig)).toBe(false)
    vi.restoreAllMocks()
  })
})

describe('markFailureAlertSent', () => {
  const sig = 'wf1|step|shape'

  it('opens the window with the cooldown ttl', async () => {
    const kv = kvDouble()
    const put = vi.spyOn(kv, 'put')
    await markFailureAlertSent(kv, sig)
    expect(put).toHaveBeenCalledWith('failure-alert-cooldown:wf1|step|shape', '1', { expirationTtl: FAILURE_ALERT_COOLDOWN_SECONDS })
    // and a subsequent read is now suppressed
    expect(await failureAlertSuppressed(kv, sig)).toBe(true)
  })

  it('does not throw when the KV write fails', async () => {
    const kv = { get: async () => null, put: async () => { throw new Error('kv down') } }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(markFailureAlertSent(kv, sig)).resolves.toBeUndefined()
    vi.restoreAllMocks()
  })
})
