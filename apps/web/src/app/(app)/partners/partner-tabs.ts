/**
 * Which tabs a partner shows, which one it opens on, and where its problems are
 * (#2137, PM-1, PM-12). Pure, so every rule is tested without the form.
 *
 * Only the tabs that apply (docs/design/partners-page.html, "Only tabs that
 * apply"): Partner always; Buyer profile for every buyer, profile or not;
 * Bid Group when a workflow's Bid Group or Partner Bid step names the partner,
 * any Bid Group setting is filled in, the person pressed Set up for Bid Group,
 * or the buyer is sold on the offer (buyer selection calls an offer buyer with
 * these settings, so they apply to it whoever else does); Workflow values
 * always; History once the partner exists.
 *
 * A field's tab comes from the field registry (partner-draft.ts), so a problem,
 * a merge question and the control itself all name the same tab.
 */
import type { PartnerBody, PartnerUsage } from '@/lib/api'
import { registryPathOf, type SoldOn } from '@bidspoke/buyer-profile'
import { buildPartnerBody, PARTNER_FIELD_REGISTRY, registryEntriesFor, snapshotOf, type PartnerTab } from './partner-draft'

/** Every tab in the order the page draws them. */
export const TAB_ORDER: readonly PartnerTab[] = ['partner', 'buyer_profile', 'bid_group', 'workflow_values', 'history']

export const TAB_LABELS: Readonly<Record<PartnerTab, string>> = {
  partner: 'Partner',
  buyer_profile: 'Buyer profile',
  bid_group: 'Bid Group',
  workflow_values: 'Workflow values',
  history: 'History',
}

/** A tab as the URL spells it (`?tab=buyer-profile`). */
export const TAB_PARAMS: Readonly<Record<PartnerTab, string>> = {
  partner: 'partner',
  buyer_profile: 'buyer-profile',
  bid_group: 'bid-group',
  workflow_values: 'workflow-values',
  history: 'history',
}

/** The tab a URL names, or null when it names none of them. */
export function tabFromParam(param: string | null): PartnerTab | null {
  if (param === null) return null
  return TAB_ORDER.find((t) => TAB_PARAMS[t] === param) ?? null
}

/**
 * The one URL of the partners page (#2137): which partner is open and on which
 * tab. Every navigation the page makes builds its URL here, so choosing a
 * partner can never drop the tab or the other way round.
 */
export function partnersUrl({ selected, tab }: { selected: string | null; tab: PartnerTab | null }): string {
  const params = new URLSearchParams()
  if (selected) params.set('selected', selected)
  if (selected && tab) params.set('tab', TAB_PARAMS[tab])
  const q = params.toString()
  return q ? `/partners?${q}` : '/partners'
}

/** The usage read's three states, each drawn differently (L530): never "none" before it answers. */
export type UsageState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'found'; usage: PartnerUsage }

const BLANK = buildPartnerBody(snapshotOf(undefined), { slug: '', isExisting: true })
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The response classification as the Bid Group tab owns it: the retry and
 * never retry rules. The decline rules (rejection_signals) are edited on the
 * Buyer profile tab beside the accept rules, so they do not make Bid Group apply.
 */
function bidGroupClassification(v: unknown): unknown {
  if (!v || typeof v !== 'object') return null
  const { rejection_signals: _decline, ...rest } = v as Record<string, unknown>
  return Object.keys(rest).length > 0 ? rest : null
}

/** True when any setting the Bid Group tab holds differs from a new partner's. */
export function bidGroupSettingsSet(body: PartnerBody): boolean {
  return PARTNER_FIELD_REGISTRY.some((e) => {
    if (e.tab !== 'bid_group') return false
    const key = e.pattern as keyof PartnerBody
    if (key === 'response_classification') return bidGroupClassification(body[key]) !== null
    return !sameJson(body[key], BLANK[key])
  })
}

export interface TabInputs {
  isBuyer: boolean
  isNew: boolean
  /** The partner's Bid Group settings as on screen. */
  body: PartnerBody
  /** How the buyer is sold, as on screen; null when there is no profile or it is not chosen. */
  soldOn: SoldOn | null
  usage: UsageState
  /** The person pressed Set up for Bid Group. */
  bidGroupAdded: boolean
  /** A problem lives on the Bid Group tab, or the URL asks for it: never hidden from under either. */
  bidGroupNeeded: boolean
}

/** The workflow steps that make the Bid Group tab apply. */
export const bidGroupSteps = (usage: PartnerUsage) => usage.bid_group.length + usage.partner_bid.length

export function bidGroupShown(i: TabInputs): boolean {
  if (i.bidGroupAdded || i.bidGroupNeeded || bidGroupSettingsSet(i.body)) return true
  if (i.isBuyer && i.soldOn === 'offer') return true
  // A failed read shows the tab with its error (L530); a read still running
  // shows it only for the reasons above, so a tab never appears and vanishes.
  if (i.usage.kind === 'failed') return true
  return i.usage.kind === 'found' && bidGroupSteps(i.usage.usage) > 0
}

export function visibleTabs(i: TabInputs): PartnerTab[] {
  const show: Record<PartnerTab, boolean> = {
    partner: true,
    buyer_profile: i.isBuyer,
    bid_group: bidGroupShown(i),
    workflow_values: true,
    history: !i.isNew,
  }
  return TAB_ORDER.filter((t) => show[t])
}

/** Set up for Bid Group is offered on the Partner tab to a buyer whose Bid Group tab is not shown. */
export const canAddBidGroup = (i: TabInputs): boolean => i.isBuyer && !bidGroupShown(i)

/** The confirmation window shows when a Latency Gate names the partner, it is set, or the person set it up; and whenever the read has not said no gate does. */
export function confirmationWindowShown(usage: UsageState, value: string, added: boolean): boolean {
  if (added || value.trim() !== '') return true
  if (usage.kind !== 'found') return true
  return usage.usage.latency_gate.length > 0
}

// ── Problems (PM-12) ─────────────────────────────────────────────────────────

/** One problem on the page: the registry field it is about, the tab holding it (null when no tab does), and what is wrong. */
export interface PageProblem {
  registryPath: string | null
  tab: PartnerTab | null
  message: string
}

/** A refused field as the save answers it, or the form's own check names it. */
export interface FieldErrorLike {
  path: string
  /** The registry path, when the server already named it. */
  field?: string | null
  message: string
}

/** The tab a registry path is drawn on; null for a path no registry entry matches. */
export function tabOfRegistryPath(path: string): PartnerTab | null {
  return registryEntriesFor(path)[0]?.tab ?? null
}

export function problemsOf({ credentialWarning, errors, routeNames = [] }: { credentialWarning: string | null | undefined; errors: readonly FieldErrorLike[]; routeNames?: readonly string[] }): PageProblem[] {
  const out: PageProblem[] = []
  // The missing credential is about the secret field (#416): the same predicate the bid path uses decided it.
  if (credentialWarning) out.push({ registryPath: 'cf_secret_key', tab: tabOfRegistryPath('cf_secret_key'), message: credentialWarning })
  for (const e of errors) {
    const registryPath = e.field ?? (e.path === '' ? null : registryPathOf(e.path, routeNames))
    const tab = registryPath === null ? null : tabOfRegistryPath(registryPath)
    out.push({ registryPath: tab === null ? null : registryPath, tab, message: e.message })
  }
  return out
}

/** The tabs holding a problem, in the page's order. */
export function problemTabs(problems: readonly PageProblem[]): PartnerTab[] {
  return TAB_ORDER.filter((t) => problems.some((p) => p.tab === t))
}

/**
 * The tab a partner opens on: the one the URL names when this partner shows
 * it; otherwise the first tab holding a problem; otherwise where its settings
 * live (a buyer's profile, a source's workflow values), as the settled design
 * opens them; a new partner on Partner. A tab the URL names that this partner
 * does not show falls back to the first tab, and the caller corrects the URL.
 */
export function openingTab({ requested, visible, problems, isBuyer, isNew }: { requested: PartnerTab | null; visible: readonly PartnerTab[]; problems: readonly PageProblem[]; isBuyer: boolean; isNew: boolean }): PartnerTab {
  if (requested !== null) return visible.includes(requested) ? requested : visible[0]
  const problem = problemTabs(problems).find((t) => visible.includes(t))
  if (problem) return problem
  if (isNew) return 'partner'
  const home: PartnerTab = isBuyer ? 'buyer_profile' : 'workflow_values'
  return visible.includes(home) ? home : visible[0]
}
