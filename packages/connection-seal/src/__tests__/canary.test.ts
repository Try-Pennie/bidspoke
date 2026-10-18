import { beforeAll, describe, expect, it } from 'vitest'
import {
  canonicalAad,
  open,
  RESTORE_DRILL_CANARY,
  restoreDrillAad,
  seal,
  SealError,
  type ConnectionAad,
} from '../index'
import { KEYGEN_TIMEOUT_MS, rsaPair, type PemPair } from './fixtures'

/**
 * The restore drill's canary (#2333): the fixed text and binding that
 * POST /api/admin/seal-canary seals and scripts/restore-drill/open-seal-canary.ts
 * opens, so the escrowed private key is proven against an envelope production
 * actually made. Both sides take them from here, so they cannot drift apart.
 *
 * What matters is that a canary can never stand in for a login: its binding
 * names no real organization or connection and a service no login has, so the
 * cipher refuses to open it as anything else, and a login cannot be opened as a
 * canary.
 */

const KID = 'ops-2026-10'
let pair: PemPair

beforeAll(async () => {
  pair = await rsaPair(4096)
}, KEYGEN_TIMEOUT_MS)

const login = (): ConnectionAad => ({
  organization_id: '6f1c2c1e-0b7a-4d43-9b8f-2a8b8f0e6c11',
  connection_id: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
  service: 'salesforce',
  generation: 1,
  kid: KID,
})

describe('the restore drill canary (#2333)', () => {
  it('is fixed, non empty text that names itself, so a person reading it knows it is not a secret', () => {
    expect(RESTORE_DRILL_CANARY).toMatch(/restore drill canary/)
    expect(RESTORE_DRILL_CANARY).toMatch(/not a secret/)
  })

  it('binds no real organization or connection, under a service no login uses, for the kid asked', () => {
    expect(restoreDrillAad(KID)).toEqual({
      organization_id: '00000000-0000-0000-0000-000000000000',
      connection_id: '00000000-0000-0000-0000-000000000000',
      service: 'restore-drill-canary',
      generation: 1,
      kid: KID,
    })
    expect(restoreDrillAad('ops-2027-01').kid).toBe('ops-2027-01')
    // A well formed binding: the seal accepts it as it stands.
    expect(() => canonicalAad(restoreDrillAad(KID))).not.toThrow()
  })

  it('refuses a kid that is not a kid, by name, rather than binding to it', () => {
    expect(() => canonicalAad(restoreDrillAad('Not A Kid'))).toThrow(SealError)
  })

  it('opens under its own binding, and never under a login binding, nor a login under its binding', async () => {
    const ring = { [KID]: pair.publicPem }
    const priv = { [KID]: pair.privatePem }
    const canary = await seal(ring, RESTORE_DRILL_CANARY, restoreDrillAad(KID))
    expect(await open(priv, canary, restoreDrillAad(KID))).toBe(RESTORE_DRILL_CANARY)
    await expect(open(priv, canary, login())).rejects.toMatchObject({ code: 'seal_unwrap_failed' })

    const sealedLogin = await seal(ring, 'a login', login())
    await expect(open(priv, sealedLogin, restoreDrillAad(KID))).rejects.toMatchObject({ code: 'seal_unwrap_failed' })
  })
})
