/**
 * Bidspoke access control — allowed user list.
 * Only these accounts may sign in. Any @trypennie.com address NOT on this list
 * is blocked. All non-@trypennie.com addresses are unconditionally blocked.
 *
 * To grant access: add the email here and redeploy.
 * To revoke access: remove the email here and redeploy.
 */

export const ALLOWED_EMAILS = new Set([
  'sam@trypennie.com',
  'geoff@trypennie.com',
  'dwright@trypennie.com',
  'bnelms@trypennie.com',
  'nmogil@trypennie.com',
])

export function isAllowed(email: string | undefined | null): boolean {
  if (!email) return false
  // Require @trypennie.com domain unconditionally
  if (!email.toLowerCase().endsWith('@trypennie.com')) return false
  return ALLOWED_EMAILS.has(email.toLowerCase())
}
