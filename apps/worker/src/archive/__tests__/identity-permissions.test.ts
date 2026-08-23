/**
 * The archive identity decision, tested directly (#914 follow-up).
 *
 * The decision module had no test of its own: it was only ever exercised through
 * `archive-identity-check.test.ts`, whose fixtures spell "no secondary roles" as
 * an empty string because that is the shape somebody had in mind. The live
 * account spells it differently, so the check reported a false permission
 * concern on its first real run.
 *
 * The value in NO_SECONDARY_ROLES below is MEASURED, not chosen: it is what
 * `SELECT CURRENT_SECONDARY_ROLES()` returned for all three archive identities
 * on the live account on 2026-08-23 (L48).
 */
import { describe, it, expect } from 'vitest'
import { identityFindings, type IdentityObservation } from '../identity-permissions'

/** What the live account actually returns when no secondary roles are active. */
const NO_SECONDARY_ROLES = '{"roles":"","value":""}'

/** The same shape when roles ARE active, which must still be reported. */
const ACTIVE_SECONDARY_ROLES = '{"roles":"BIDSPOKE_ARCHIVE_ERASER","value":"ALL"}'

/** A correctly configured identity, so any finding is about the field under test. */
function healthy(overrides: Partial<IdentityObservation> = {}): IdentityObservation {
  return {
    identity: 'writer',
    tablePrivileges: ['SELECT', 'INSERT'],
    secondaryRoles: NO_SECONDARY_ROLES,
    deleteProbe: 'refused',
    unreadable: [],
    ...overrides,
  }
}

describe('secondary roles', () => {
  it('does not report a concern for the value the live account returns when none are active', () => {
    const findings = identityFindings([healthy()])

    expect(findings).toEqual([])
  })

  it('reports a concern when a secondary role is genuinely active', () => {
    const findings = identityFindings([healthy({ secondaryRoles: ACTIVE_SECONDARY_ROLES })])

    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('secondary-roles')
    expect(findings[0].message).toContain('BIDSPOKE_ARCHIVE_ERASER')
  })

  it('reports a concern when the value is a shape it cannot read, rather than assuming none', () => {
    // Fail safe. An unparseable answer must not read as "no roles active": the
    // whole point of the field is that it can quietly widen what an identity can
    // do, so an unreadable answer is a concern, not a pass.
    const findings = identityFindings([healthy({ secondaryRoles: 'something new from Snowflake' })])

    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe('secondary-roles')
  })
})
