/**
 * Partner credential resolution (#411, #416).
 *
 * A partner may declare that its bid API needs a bearer credential by naming a
 * worker secret in `cf_secret_key`. The name is config; the value is a secret
 * binding that may not have been provisioned yet, or may have been provisioned
 * blank.
 *
 * TWO CALLERS, ONE RULE. The bid path refuses the call when a declared
 * credential resolves empty (#411), and the partner settings page warns about
 * the same condition at save time (#416). If each wrote its own truthiness check
 * they would disagree precisely where it matters: a settings page reporting the
 * credential fine while every live lead is refused, or a warning that cannot be
 * cleared because the bid path never had a problem (LESSONS L144). So both go
 * through here.
 *
 * Neither function ever returns or logs the secret VALUE to a caller that only
 * asked whether it exists: `partnerCredentialMissing` answers the presence
 * question on its own, so a warning path never has to hold the secret.
 */
import type { Env } from '../index'

/**
 * The usable credential for a partner, or null when the partner declares one
 * that is unset or blank (and also null when it declares none, which is not a
 * fault: ask `partnerCredentialMissing` to tell those two apart).
 */
export function partnerCredentialValue(env: Env, cfSecretKey: string | null): string | null {
  if (!cfSecretKey) return null
  const value = (env as unknown as Record<string, string | undefined>)[cfSecretKey]
  return value ? value : null
}

/** True when the partner declares a credential that the environment cannot supply. */
export function partnerCredentialMissing(env: Env, cfSecretKey: string | null): boolean {
  if (!cfSecretKey) return false
  return partnerCredentialValue(env, cfSecretKey) === null
}
