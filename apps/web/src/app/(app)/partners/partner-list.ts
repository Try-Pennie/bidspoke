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
