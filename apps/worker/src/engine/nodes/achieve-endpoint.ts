/**
 * Which Achieve environment we talk to, and the credentials that go with it.
 *
 * One setting, `ACHIEVE_ENV`, is either `production` or `staging`. It selects BOTH the host and
 * the username and password pair, because those travel together: pointing at staging while still
 * sending the production password fails as a 401, which reads as a credential problem rather than
 * the configuration mistake it is.
 *
 * Before this existed, testing against staging meant hand-editing the live URL and the live
 * password and remembering to undo both. A forgotten revert left production pointed at a sandbox
 * that declines every lead, which is indistinguishable from the partner rejecting our traffic.
 * `ACHIEVE_STAGING_URL` and `ACHIEVE_STAGING_PASSWORD` had also been stored since June with
 * nothing in the code reading either of them.
 *
 * Fails safe in every direction: unset, blank, or an unrecognised value all resolve to STAGING,
 * never production. Only an explicit `production` (or the pre-existing `ACHIEVE_API_URL` pointing
 * exactly at the production host) counts. That matters beyond configuration hygiene, because the
 * node swaps in Achieve's seeded showroom identity whenever it is not on production, so anything
 * we cannot prove is production also stops a real person's details reaching a sandbox.
 */

export const PROD_BASE_URL = 'https://api.freedomfinancialnet.com'
export const STAGING_BASE_URL = 'https://api-stg.freedomfinancialnet.com'

export interface AchieveEndpoint {
  baseUrl: string
  production: boolean
  username: string | undefined
  password: string | undefined
}

/** Trimmed value, or undefined when absent or whitespace only. Blank is absent, never an empty credential. */
function present(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

function isProductionHost(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, '') === PROD_BASE_URL
}

export function resolveAchieveEndpoint(env: Record<string, string | undefined>): AchieveEndpoint {
  const mode = present(env.ACHIEVE_ENV)?.toLowerCase()
  const explicitUrl = present(env.ACHIEVE_API_URL)

  // The switch wins over a leftover URL: it is the clearer control, and without this precedence
  // setting it to staging would appear to work while still reaching production.
  let baseUrl: string
  if (mode === 'production') {
    baseUrl = PROD_BASE_URL
  } else if (mode === 'staging') {
    baseUrl = present(env.ACHIEVE_STAGING_URL) ?? STAGING_BASE_URL
  } else {
    baseUrl = explicitUrl ?? STAGING_BASE_URL
  }

  const production = isProductionHost(baseUrl)

  // Off production, prefer a stored staging credential and fall back PER CREDENTIAL to the main
  // one, because Achieve confirmed the existing credentials also work against staging.
  const username = production
    ? present(env.ACHIEVE_USERNAME)
    : present(env.ACHIEVE_STAGING_USERNAME) ?? present(env.ACHIEVE_USERNAME)
  const password = production
    ? present(env.ACHIEVE_PASSWORD)
    : present(env.ACHIEVE_STAGING_PASSWORD) ?? present(env.ACHIEVE_PASSWORD)

  return { baseUrl, production, username, password }
}
