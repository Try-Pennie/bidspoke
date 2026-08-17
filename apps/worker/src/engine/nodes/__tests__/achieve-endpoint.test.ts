import { describe, it, expect } from 'vitest'
import { resolveAchieveEndpoint, PROD_BASE_URL, STAGING_BASE_URL } from '../achieve-endpoint'

// One setting picks which Achieve environment we talk to, and the credentials travel WITH it.
// Before this existed, testing against staging meant hand-editing the live URL and the live
// password and remembering to undo both, and a forgotten revert left production pointed at a
// sandbox that declines every lead, which reads exactly like the partner rejecting our traffic.

const PROD_CREDS = {
  ACHIEVE_USERNAME: 'pennie_financial',
  ACHIEVE_PASSWORD: 'live-secret',
}
const BOTH = {
  ...PROD_CREDS,
  ACHIEVE_STAGING_USERNAME: 'pennie_staging',
  ACHIEVE_STAGING_PASSWORD: 'stg-secret',
}

describe('resolveAchieveEndpoint', () => {
  // Fails safe: with nothing set we must NOT reach production. Anything we cannot prove is
  // production is treated as a sandbox, which is also what makes the node swap in the seeded
  // showroom identity rather than sending a real person's details somewhere they are discarded.
  it('defaults to staging when nothing is configured', () => {
    const e = resolveAchieveEndpoint({})
    expect(e.baseUrl).toBe(STAGING_BASE_URL)
    expect(e.production).toBe(false)
  })

  it('reaches production only when explicitly asked', () => {
    const e = resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_ENV: 'production' })
    expect(e.baseUrl).toBe(PROD_BASE_URL)
    expect(e.production).toBe(true)
    expect(e.username).toBe('pennie_financial')
    expect(e.password).toBe('live-secret')
  })

  // The whole point: switching environment must carry the credentials with it, or the test
  // authenticates against staging with the production password and fails as a 401 that looks
  // like a credential problem rather than a configuration one.
  it('uses the staging credentials when pointed at staging', () => {
    const e = resolveAchieveEndpoint({ ...BOTH, ACHIEVE_ENV: 'staging' })
    expect(e.baseUrl).toBe(STAGING_BASE_URL)
    expect(e.production).toBe(false)
    expect(e.username).toBe('pennie_staging')
    expect(e.password).toBe('stg-secret')
  })

  // Achieve said the existing credentials work for staging too. So a missing staging credential
  // falls back to the main one rather than refusing, but ONLY per credential.
  it('falls back to the main credentials when no staging pair is stored', () => {
    const e = resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_ENV: 'staging' })
    expect(e.username).toBe('pennie_financial')
    expect(e.password).toBe('live-secret')
    expect(e.production).toBe(false)
  })

  it('treats a blank staging credential as absent rather than as an empty password', () => {
    const e = resolveAchieveEndpoint({
      ...PROD_CREDS,
      ACHIEVE_STAGING_PASSWORD: '   ',
      ACHIEVE_ENV: 'staging',
    })
    expect(e.password).toBe('live-secret')
  })

  it('accepts the environment name in any casing or with stray spacing', () => {
    for (const value of ['production', 'PRODUCTION', ' Production ']) {
      expect(resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_ENV: value }).production).toBe(true)
    }
  })

  // A typo must not silently reach production. It lands on staging, where the worst case is a
  // test that goes to a sandbox, rather than real leads going somewhere unintended.
  it('sends an unrecognised environment name to staging, not production', () => {
    const e = resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_ENV: 'prod' })
    expect(e.production).toBe(false)
    expect(e.baseUrl).toBe(STAGING_BASE_URL)
  })

  // The pre-existing ACHIEVE_API_URL is still honoured so nothing breaks on the day this ships,
  // and it still decides production by matching the real production host exactly.
  it('still honours an explicit API URL, and only the real production host counts as production', () => {
    expect(resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_API_URL: PROD_BASE_URL }).production).toBe(true)
    expect(resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_API_URL: `${PROD_BASE_URL}/` }).production).toBe(true)
    const other = resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_API_URL: 'https://evil.example.com' })
    expect(other.production).toBe(false)
    expect(other.baseUrl).toBe('https://evil.example.com')
  })

  // ACHIEVE_ENV is the newer, clearer control, so it wins over a stale URL left behind. Without
  // this, setting the switch to staging would appear to work while still hitting production.
  it('lets the environment switch override a leftover API URL', () => {
    const e = resolveAchieveEndpoint({
      ...BOTH,
      ACHIEVE_API_URL: PROD_BASE_URL,
      ACHIEVE_ENV: 'staging',
    })
    expect(e.production).toBe(false)
    expect(e.baseUrl).toBe(STAGING_BASE_URL)
    expect(e.password).toBe('stg-secret')
  })
})
