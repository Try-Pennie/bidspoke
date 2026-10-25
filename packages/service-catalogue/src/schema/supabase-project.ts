/**
 * The project a Supabase connection declares (#2337, phase 7 of #1689), read
 * in one place by the ops Supabase entry (its one declared host, and verify),
 * the Supabase actions (where they send) and the save's money check, which
 * compares the declared Project URL with the bidding project field by field
 * (apps/worker lib/connection-money-targets.ts).
 *
 * Taken: what a person copies from Supabase, the Project URL
 * (https://<ref>.supabase.co, a path after it allowed), or the bare project
 * ref. Refused: any other host (a subdomain of the project, a lookalike, a
 * custom domain), a scheme other than https, a port, a login, and a ref that is
 * not Supabase's twenty lower case letters and digits.
 */

const REF = /^[a-z0-9]{20}$/

/** The project ref a declared value names, or null. */
export function supabaseProjectRefOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (REF.test(trimmed)) return trimmed
  if (!trimmed.startsWith('https://')) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.port !== '' || url.username !== '' || url.password !== '') return null
  const labels = url.hostname.split('.')
  if (labels.length !== 3 || labels[1] !== 'supabase' || labels[2] !== 'co' || !REF.test(labels[0])) return null
  return labels[0]
}

/** The one host a project's API answers on. */
export function supabaseProjectHost(ref: string): string {
  return `${ref}.supabase.co`
}
