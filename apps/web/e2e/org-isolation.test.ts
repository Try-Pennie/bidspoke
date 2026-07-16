import { describe, it, expect } from 'vitest'
import { assertIsolatedOrg, PRODUCTION_ORG_ID } from './org-isolation'

/**
 * The e2e suite authenticates as e2e-test@trypennie.com and drives the real
 * production Worker + Supabase. Isolation is a property of WHICH org that user
 * belongs to: once it has its own org (#664), the tenant model keeps the suite
 * away from Main Flow, Engine Bidding and Lead Economy. This guard fails the run
 * loudly if anyone ever moves the user back into the production org, rather than
 * letting a green suite quietly mutate live workflows again.
 */
describe('assertIsolatedOrg', () => {
  it('throws when the user is in the production org', () => {
    expect(() => assertIsolatedOrg(PRODUCTION_ORG_ID)).toThrow(/production organization/i)
  })

  it('throws when the org cannot be determined', () => {
    expect(() => assertIsolatedOrg(null)).toThrow(/could not determine/i)
    expect(() => assertIsolatedOrg(undefined)).toThrow(/could not determine/i)
    expect(() => assertIsolatedOrg('')).toThrow(/could not determine/i)
  })

  it('does not throw for a dedicated test org', () => {
    expect(() => assertIsolatedOrg('11111111-1111-1111-1111-111111111111')).not.toThrow()
  })

  it('honours a caller-supplied forbidden org id', () => {
    const forbidden = '22222222-2222-2222-2222-222222222222'
    expect(() => assertIsolatedOrg(forbidden, forbidden)).toThrow(/production organization/i)
    expect(() => assertIsolatedOrg(PRODUCTION_ORG_ID, forbidden)).not.toThrow()
  })
})
