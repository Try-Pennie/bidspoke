/**
 * The Workflow values tab's sections and words (#2142, PM-15), from the
 * workflow values answer (GET /api/partners/:id/workflow-values). Pure, so
 * every wording is tested.
 *
 * The settled design (docs/design/partners-page.html, Workflow values) draws a
 * section per value: its control, the exact name workflows read it by, and
 * which workflows read it.
 */
import type { PartnerValueKind, PartnerWorkflowValue, PartnerWorkflowValues } from '@/lib/api'
import { joinNames, workflowLabel } from './bid-group-usage-text'

/** Every kind the answer can carry, in the answer's order. A test holds it equal to the answer type. */
export const PARTNER_VALUE_KINDS = ['ClickUrl', 'SellOffOfferTitle', 'SellOffOfferDetails', 'SubAccountMinBids', 'subAccountIdsMap', 'activeBidding'] as const satisfies readonly PartnerValueKind[]

/** A section of the tab: the sell-off offer's title and details share one, every other value has its own. */
export type SectionKey = 'click_url' | 'sell_off' | 'min_bids' | 'sub_account_ids' | 'active' | 'other'

const SECTION_OF: Readonly<Record<PartnerValueKind, Exclude<SectionKey, 'other'>>> = {
  ClickUrl: 'click_url',
  SellOffOfferTitle: 'sell_off',
  SellOffOfferDetails: 'sell_off',
  SubAccountMinBids: 'min_bids',
  subAccountIdsMap: 'sub_account_ids',
  activeBidding: 'active',
}

export const SECTION_TITLES: Readonly<Record<Exclude<SectionKey, 'other'>, string>> = {
  click_url: 'Click URL',
  sell_off: 'Sell-off offer',
  min_bids: 'Sub-account minimum bids',
  sub_account_ids: 'Sub-account IDs',
  active: 'Active',
}

/** The sections a partner of each type edits here, in the answer's order. */
const EDITED_BY: Readonly<Record<Exclude<SectionKey, 'other'>, 'buyer' | 'source' | null>> = {
  click_url: 'buyer',
  sell_off: 'source',
  min_bids: 'buyer',
  sub_account_ids: 'source',
  // Set by Active on the Partner tab; every partner carries an entry, so the answer always shows it.
  active: null,
}
const ORDER: readonly Exclude<SectionKey, 'other'>[] = ['click_url', 'sell_off', 'min_bids', 'sub_account_ids', 'active']

export interface ValueSection {
  key: SectionKey
  title: string
  values: PartnerWorkflowValue[]
}

/** Whether the value is there for a workflow to read now, named by one, or replacing a workflow's own key. */
function inUse(v: PartnerWorkflowValue): boolean {
  return v.emitted || v.readers.some((r) => r.reads === 'by_name') || v.shadowed_data_keys.length > 0
}

/**
 * The sections the tab shows, in the answer's order: those the partner's type
 * edits, and any other value in use (set, named by a workflow, or replacing a
 * workflow data key), so nothing a workflow reads of this partner is hidden.
 * A value read only for every partner, with nothing set, is left off a partner
 * it does not apply to. With no answer (a new partner, the read running or
 * failed) the type alone decides, and the page says why the readers are missing.
 * A kind this page does not know yet is shown under its own name.
 */
export function sectionsOf(answer: PartnerWorkflowValues | null, role: { isBuyer: boolean; isSource: boolean }): ValueSection[] {
  const edits = (key: Exclude<SectionKey, 'other'>) => (EDITED_BY[key] === 'buyer' && role.isBuyer) || (EDITED_BY[key] === 'source' && role.isSource)
  if (!answer) return ORDER.filter(edits).map((key) => ({ key, title: SECTION_TITLES[key], values: [] }))
  const out: ValueSection[] = []
  for (const v of answer.values) {
    const key = SECTION_OF[v.kind] as Exclude<SectionKey, 'other'> | undefined
    if (!key) {
      out.push({ key: 'other', title: v.constant_name, values: [v] })
      continue
    }
    const existing = out.find((s) => s.key === key)
    if (existing) existing.values.push(v)
    else out.push({ key, title: SECTION_TITLES[key], values: [v] })
  }
  // A control the partner's type edits is never lost because the answer left its value out.
  for (const key of ORDER) if (edits(key) && !out.some((s) => s.key === key)) out.push({ key, title: SECTION_TITLES[key], values: [] })
  const rank = (s: ValueSection) => (s.key === 'other' ? ORDER.length : ORDER.indexOf(s.key))
  return out
    .filter((s) => s.key === 'other' || edits(s.key as Exclude<SectionKey, 'other'>) || s.values.some(inUse))
    .sort((a, b) => rank(a) - rank(b))
}

/** One way a value is read: `<lead> <code> in a Code node and <template> in a template<tail>`. */
export interface AccessLine {
  lead: string
  code: string
  template: string
  tail: string
}

const IDENT = /^[A-Za-z_$][\w$]*$/
const entry = (slug: string) => (IDENT.test(slug) ? `.${slug}` : `['${slug}']`)

/** How workflows read the section's values, in the form the Engine Bidding workflow writes them. */
export function accessLines(values: readonly PartnerWorkflowValue[], slug: string): AccessLine[] {
  return values.map((v) => {
    if (v.kind === 'activeBidding') {
      return { lead: 'Workflows read it as', code: `${v.access.code}${entry(slug)}`, template: `${v.access.template}${entry(slug)}`, tail: '' }
    }
    if (v.kind === 'subAccountIdsMap') {
      return { lead: 'Workflows read them in', code: v.access.code, template: v.access.template, tail: `, where each of these IDs maps to ${slug}.` }
    }
    const lead = v.kind === 'SellOffOfferTitle' ? 'Workflows read the title as' : v.kind === 'SellOffOfferDetails' ? 'Workflows read the details as' : 'Workflows read it as'
    return { lead, code: v.access.code, template: v.access.template, tail: '' }
  })
}

type Place = PartnerWorkflowValue['readers'][number]['places'][number]
const placeName = (p: Place) => (p.edge_id !== null ? 'an edge condition' : p.label || p.namespace || 'a step with no name')
const placesOf = (places: readonly Place[]) => joinNames([...new Set(places.map(placeName))])

/**
 * Who reads the value: one sentence per workflow (the steps naming it, or that
 * it reads the value for every partner), then, for the click URL, the readers
 * outside workflows in the answer's own words.
 */
export function readerSentences(v: PartnerWorkflowValue): string[] {
  const workflows = v.readers.map((r) => {
    const who = workflowLabel(r)
    const byName = r.places.filter((p) => p.reads === 'by_name')
    const every = r.places.filter((p) => p.reads === 'every_partner')
    if (byName.length === 0) return `${who} reads this value for every partner, in ${placesOf(every)}.`
    if (every.length === 0) return `${who}, in ${placesOf(byName)}.`
    return `${who}, in ${placesOf(byName)}; it reads this value for every partner in ${placesOf(every)}.`
  })
  return [...workflows, ...v.readers_outside_workflows.map((r) => r.description)]
}

/** An empty reader list, said as what was searched (L564). */
export function searchedSentence(searched: PartnerWorkflowValues['searched']): string {
  const n = searched.workflows
  const c = searched.with_constants_node
  return `No workflow names this value. Searched ${n} workflow${n === 1 ? '' : 's'}, ${c === 0 ? 'none' : c} of them with a Constants step.`
}

/** A workflow data key with this value's name, which the partner value replaces when the step runs. */
export function shadowSentences(v: PartnerWorkflowValue): string[] {
  return v.shadowed_data_keys.map((s) => `${workflowLabel(s)} also sets ${v.constant_name} in its Constants step (${s.namespace}), and this value replaces it there.`)
}
