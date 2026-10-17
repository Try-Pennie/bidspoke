import type { Partner } from '@/lib/api'
import { isBuyerPartner, isSourcePartner } from '@/lib/partner-roles'

/**
 * The list as the settled design groups it (#2137, PM-1): Buyers, then Sources,
 * each alphabetical, name only. A partner that does both is listed under both,
 * since it is found by either. List order (priority) left the page; it stays in
 * the data.
 */
export function groupPartners(partners: readonly Partner[]): Array<{ title: 'Buyers' | 'Sources'; members: Partner[] }> {
  const byName = (a: Partner, b: Partner) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.slug.localeCompare(b.slug)
  return [
    { title: 'Buyers' as const, members: partners.filter((p) => isBuyerPartner(p.partner_type ?? 'buyer')).sort(byName) },
    { title: 'Sources' as const, members: partners.filter((p) => isSourcePartner(p.partner_type ?? 'buyer')).sort(byName) },
  ].filter((g) => g.members.length > 0)
}

/**
 * Why the list could not be loaded, as the page says it (#2321, PM-18, design
 * frame 4): the cause in words, then that nothing has changed. The server's own
 * error text is never shown, since it is a code ("Internal error") and not a
 * reason a person can act on (L11). Read by shape rather than class, because
 * the tests that mock '@/lib/api' whole have no TimeoutError.
 */
export function loadFailureSentence(err: unknown): string {
  const e = (err ?? {}) as { timedOut?: unknown; timeoutMs?: unknown; status?: unknown }
  const cause = e.timedOut === true && typeof e.timeoutMs === 'number'
    ? `The server did not answer within ${Math.round(e.timeoutMs / 1000)} seconds.`
    : typeof e.status === 'number'
      ? `The server answered with an error (HTTP ${e.status}).`
      : err instanceof TypeError
        ? 'The server could not be reached.'
        : 'The list could not be read.'
  return `${cause} Nothing has changed.`
}
