/**
 * The account a person bound login signed in as (#2338, build PR 13; R17, "My
 * own Google account, Signed in as you"): the email of the OpenID id_token the
 * token endpoint answers a code exchange with, when the authorize link asked
 * for `openid email`.
 *
 * WHY THE SIGNATURE IS NOT CHECKED. The ConnectionTokenObject receives the
 * id_token directly from the token endpoint it posted the code to, over TLS,
 * at a URL the service's rules fixed. OpenID Connect Core 1.0, 3.1.3.7 item 6:
 * an ID Token received by direct communication with the token endpoint may be
 * validated by that TLS server validation in place of its signature. What is
 * checked is that it was issued for this client (aud) and that the provider
 * verified the address (email_verified); anything else answers null, so a
 * connection is saved naming no one rather than the wrong one.
 *
 * Reads names only: nothing here throws, and nothing of the token is kept.
 */

/** Past any real id_token: Google's are about 1 KB. */
const MAX_ID_TOKEN = 16_384
const ACCOUNT = /^[^\s@]{1,256}@[^\s@]{1,255}$/

function payloadOf(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.')
  if (parts.length !== 3 || parts[1] === '') return null
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))) as unknown
    return json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The verified email the id_token in a token endpoint's answer names for this client, lower cased, or null. */
export function idTokenAccount(json: Readonly<Record<string, unknown>>, clientId: string): string | null {
  const idToken = Object.hasOwn(json, 'id_token') ? json.id_token : undefined
  if (typeof idToken !== 'string' || idToken.length > MAX_ID_TOKEN) return null
  const claims = payloadOf(idToken)
  if (claims === null) return null
  const aud = claims.aud
  const forThisClient = aud === clientId || (Array.isArray(aud) && aud.includes(clientId))
  const verified = claims.email_verified === true || claims.email_verified === 'true'
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  if (!forThisClient || !verified || email.length > 320 || !ACCOUNT.test(email)) return null
  return email
}
