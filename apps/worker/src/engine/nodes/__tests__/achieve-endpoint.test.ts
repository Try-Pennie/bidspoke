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

  // A typo announces itself rather than being absorbed. Quietly using staging would look
  // identical to Achieve declining every lead, and whoever read that would go looking at the
  // partner instead of at the one setting that is wrong.
  it('refuses an unrecognised environment name instead of guessing one', () => {
    const e = resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_ENV: 'prod' })
    expect(e.invalidEnv).toBe('prod')
  })

  // Refusing still must not resolve towards production, so that every path which does not
  // consult invalidEnv is safe by construction rather than by remembering to check.
  it('never resolves an unrecognised name towards production', () => {
    const e = resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_ENV: 'prod' })
    expect(e.production).toBe(false)
    expect(e.baseUrl).toBe(STAGING_BASE_URL)
  })

  // The dangerous combination: a typo in the switch WHILE a production URL is still configured.
  // The typo must not inherit that host, because a production verdict makes the node build the
  // request with the real lead's identity instead of the seeded test one, so a misconfiguration
  // would put real personal details into the recorded request.
  it('does not let a typo inherit a leftover production URL', () => {
    const e = resolveAchieveEndpoint({
      ...PROD_CREDS,
      ACHIEVE_API_URL: PROD_BASE_URL,
      ACHIEVE_ENV: 'prod',
    })
    expect(e.invalidEnv).toBe('prod')
    expect(e.production).toBe(false)
    expect(e.baseUrl).toBe(STAGING_BASE_URL)
  })

  it('reports the offending value as written, so the fix is obvious from the message', () => {
    expect(resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_ENV: ' Prodction ' }).invalidEnv).toBe('Prodction')
  })

  // Absent is not a typo: an unset switch is the ordinary state for a workflow that has never
  // been pointed anywhere, and it stays a silent default to staging rather than a refusal.
  it('does not treat an absent or blank switch as invalid', () => {
    expect(resolveAchieveEndpoint({ ...PROD_CREDS }).invalidEnv).toBeUndefined()
    expect(resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_ENV: '  ' }).invalidEnv).toBeUndefined()
  })

  it('leaves the recognised names valid', () => {
    expect(resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_ENV: 'production' }).invalidEnv).toBeUndefined()
    expect(resolveAchieveEndpoint({ ...PROD_CREDS, ACHIEVE_ENV: 'staging' }).invalidEnv).toBeUndefined()
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
