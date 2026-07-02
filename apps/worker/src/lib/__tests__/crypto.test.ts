/**
 * deriveIdempotencyKey — idempotency key derivation (issue #476 / AUD-008).
 *
 * The historical bug: every configured field maps to '' when absent, so a
 * payload missing ALL derive fields hashes the constant string '|' * (n-1).
 * Two different malformed leads then share one idempotency entry and can
 * receive each other's cached response. The fix returns null (skip caching)
 * when every derived value is empty, while leaving all other hashes byte-for-
 * byte identical so live dedup keys never shift on deploy.
 */
import { describe, it, expect } from 'vitest'
import { deriveIdempotencyKey } from '../crypto'

describe('deriveIdempotencyKey', () => {
  it('hashes present fields to a stable 64-char hex digest', async () => {
    const a = await deriveIdempotencyKey({ email: 'lead@example.com' }, ['email'])
    const b = await deriveIdempotencyKey({ email: 'lead@example.com' }, ['email'])
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces distinct keys for distinct field values', async () => {
    const a = await deriveIdempotencyKey({ email: 'a@example.com' }, ['email'])
    const b = await deriveIdempotencyKey({ email: 'b@example.com' }, ['email'])
    expect(a).not.toBe(b)
  })

  it('returns null when every derive field is absent', async () => {
    expect(await deriveIdempotencyKey({}, ['email', 'ssn'])).toBeNull()
  })

  it('returns null when every derive field is present but empty', async () => {
    expect(await deriveIdempotencyKey({ email: '', ssn: '' }, ['email', 'ssn'])).toBeNull()
  })

  it('does not collapse two different all-empty payloads to a shared key', async () => {
    // Different leads, both missing all derive fields. Before the fix both
    // hashed the same constant; now both skip idempotency (null) so neither
    // can replay the other's cached response.
    const one = await deriveIdempotencyKey({ name: 'Alice' }, ['email', 'ssn'])
    const two = await deriveIdempotencyKey({ name: 'Bob' }, ['email', 'ssn'])
    expect(one).toBeNull()
    expect(two).toBeNull()
  })

  it('still derives a key when at least one field is present', async () => {
    const key = await deriveIdempotencyKey({ email: 'x@example.com' }, ['email', 'ssn'])
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('treats an absent field identically to a present empty string (hash unchanged)', async () => {
    // Locks the historical String() coercion: missing and '' both join to ''.
    const missing = await deriveIdempotencyKey({ email: 'x@example.com' }, ['email', 'ssn'])
    const empty = await deriveIdempotencyKey({ email: 'x@example.com', ssn: '' }, ['email', 'ssn'])
    expect(missing).toBe(empty)
  })
})
