/**
 * Domain guard — the only rule that can never be relaxed via the UI.
 * Individual email access is managed in the user_allowlist Supabase table
 * (and via the /access page in the app).
 */

export function isPermittedDomain(email: string | undefined | null): boolean {
  if (!email) return false
  return email.toLowerCase().endsWith('@trypennie.com')
}
