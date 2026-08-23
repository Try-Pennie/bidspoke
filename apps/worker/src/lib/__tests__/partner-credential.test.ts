import { describe, it, expect } from 'vitest'
import type { Env } from '../../index'
import { partnerCredentialValue, partnerCredentialMissing } from '../partner-credential'

// #416. The runtime bid path already refuses to call a partner whose declared
// credential resolves empty (#411, bid-resolver.ts). The save-time warning has to
// judge by the SAME predicate, or the two disagree exactly when it matters: a
// settings page saying the credential is fine while every live lead is refused,
// or a warning nobody can clear because the bid path is happy. So both callers
// share these two functions rather than each writing `if (secretValue)`.
function envWith(vars: Record<string, string>): Env {
  return vars as unknown as Env
}

describe('partnerCredentialValue (#416)', () => {
  it('returns null when the partner declares no credential', () => {
    expect(partnerCredentialValue(envWith({}), null)).toBeNull()
  })

  it('returns the secret value when the declared key resolves', () => {
    expect(partnerCredentialValue(envWith({ PARTNER_SECRET: 'sk-live' }), 'PARTNER_SECRET')).toBe('sk-live')
  })

  it('returns null when the declared key is absent from the environment', () => {
    expect(partnerCredentialValue(envWith({}), 'PARTNER_SECRET')).toBeNull()
  })

  it('returns null when the declared key resolves to an empty string', () => {
    // A blank secret is the reported shape of #411: the binding exists, so a
    // presence check on the key name alone reads as configured.
    expect(partnerCredentialValue(envWith({ PARTNER_SECRET: '' }), 'PARTNER_SECRET')).toBeNull()
  })
})

describe('partnerCredentialMissing (#416)', () => {
  it('is false when no credential is declared, because none is owed', () => {
    expect(partnerCredentialMissing(envWith({}), null)).toBe(false)
    expect(partnerCredentialMissing(envWith({}), '')).toBe(false)
  })

  it('is false when the declared credential resolves', () => {
    expect(partnerCredentialMissing(envWith({ PARTNER_SECRET: 'sk-live' }), 'PARTNER_SECRET')).toBe(false)
  })

  it('is true when the declared credential is unset', () => {
    expect(partnerCredentialMissing(envWith({}), 'PARTNER_SECRET')).toBe(true)
  })

  it('is true when the declared credential is blank', () => {
    expect(partnerCredentialMissing(envWith({ PARTNER_SECRET: '' }), 'PARTNER_SECRET')).toBe(true)
  })

  it('agrees with partnerCredentialValue on every case', () => {
    // The two are one rule stated twice; a drift between them is the L144 defect
    // this module exists to prevent.
    const cases: Array<[Record<string, string>, string | null]> = [
      [{}, null],
      [{}, 'PARTNER_SECRET'],
      [{ PARTNER_SECRET: '' }, 'PARTNER_SECRET'],
      [{ PARTNER_SECRET: 'sk-live' }, 'PARTNER_SECRET'],
    ]
    for (const [vars, key] of cases) {
      const env = envWith(vars)
      const declared = Boolean(key)
      expect(partnerCredentialMissing(env, key)).toBe(declared && partnerCredentialValue(env, key) === null)
    }
  })
})
