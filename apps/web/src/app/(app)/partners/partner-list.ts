import type { Partner } from '@/lib/api'
import { isBuyerPartner, isSourcePartner } from '@/lib/partner-roles'
import { causeAsSentence, requestFailureCause } from '@/lib/error-sentence'

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
 * frame 4): the cause in words (requestFailureCause, shared with the save bar),
 * then that nothing has changed.
 */
export function loadFailureSentence(err: unknown): string {
  return `${causeAsSentence(requestFailureCause(err, 'the list could not be read'))} Nothing has changed.`
}
