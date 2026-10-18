/**
 * The lead fields a buyer profile's rules need a step to read (#2149).
 *
 * buyer_select and buyer_click_check each resolve the lead from four templates
 * of their own config (state, debt, loan_amount, collections). A profile rule
 * on a field the step has no template for refuses EVERY lead: the field
 * resolves to nothing, and the box answers missing_lead_field (or
 * collections_not_wired for a collections cap). On 2026-10-13 Tripoint's
 * profile gained a 2,000 loan_amount_min while the Engine buyer_select node had
 * no loan amount template, and every live share lead was refused for about 45
 * hours with nothing paged.
 *
 * So which fields a profile needs is decided here once: evaluateBox refuses by
 * leadFieldsNeeded, and the save checks (a profile save, a live workflow save)
 * refuse by unreadLeadFields, which applies the same list to a step's config.
 * The config keys are the field names, the same on both nodes.
 */
import type { BuyerProfile } from './eligibility'

export const LEAD_FIELDS = ['state', 'debt', 'loan_amount', 'collections'] as const
export type LeadField = (typeof LEAD_FIELDS)[number]

/** Each field as the canvas labels its template. */
export const LEAD_FIELD_LABELS: Record<LeadField, string> = {
  state: 'State',
  debt: 'Debt',
  loan_amount: 'Loan amount',
  collections: 'Collections',
}

/**
 * The profile field each need comes from, as validateProfile names its paths,
 * so a save refusal lands beside the control whose rule cannot be read.
 */
export const LEAD_FIELD_PROFILE_PATHS: Record<LeadField, string> = {
  state: 'allowedStates',
  debt: 'debtMin',
  loan_amount: 'loanAmountMin',
  collections: 'collectionsMaxPercent',
}

/**
 * The fields a lead must resolve for this profile to judge it, in LEAD_FIELDS
 * order. The state and the debt always (the allowed states, the debt range and
 * the price are judged on every lead); the loan amount only under a minimum;
 * collections only under a cap.
 */
export function leadFieldsNeeded(profile: BuyerProfile): LeadField[] {
  const out: LeadField[] = ['state', 'debt']
  if (profile.loanAmountMin !== null) out.push('loan_amount')
  if ((profile.collectionsMaxPercent ?? null) !== null) out.push('collections')
  return out
}

/**
 * Whether a step's config has a template for the field: text with something
 * other than spaces in it. The nodes read collectionsWired by this rule too.
 */
export function leadFieldWired(config: object | null | undefined, field: LeadField): boolean {
  const value = config ? (config as Record<string, unknown>)[field] : undefined
  return typeof value === 'string' && value.trim() !== ''
}

/** The fields this profile needs that the step's config has no template for. Empty means the step can judge every rule. */
export function unreadLeadFields(profile: BuyerProfile, config: object | null | undefined): LeadField[] {
  return leadFieldsNeeded(profile).filter((f) => !leadFieldWired(config, f))
}

const whole = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** The rule that needs the field, in the words the partners page uses, with the figure the profile holds. */
export function unreadRuleSentence(profile: BuyerProfile, field: LeadField): string {
  switch (field) {
    case 'state':
      return 'its allowed states'
    case 'debt':
      return 'its debt range and pricing'
    case 'loan_amount':
      return profile.loanAmountMin === null ? 'a minimum loan amount' : `a minimum loan amount of ${whole(profile.loanAmountMin)}`
    case 'collections': {
      const cap = profile.collectionsMaxPercent ?? null
      return cap === null ? 'a collections cap' : `a collections cap of ${whole(cap)} percent of debt`
    }
  }
}
