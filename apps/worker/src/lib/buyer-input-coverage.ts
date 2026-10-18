/**
 * Which live buyer steps cannot read a buyer profile's rules (#2149).
 *
 * On 2026-10-13 15:30 UTC Tripoint's profile gained a 2,000 loan_amount_min on
 * the partners page while the Engine buyer_select node had no loan amount
 * template, so the box refused every live share lead as missing_lead_field for
 * about 45 hours (60 leads, roughly 20 sales lost) and nothing paged. Either
 * side of the pair can break it: a profile gaining a rule, or a canvas edit
 * dropping a template. So the same finder is asked from both saves:
 *
 *   - a buyer profile save (PUT /partners/:id/page and the legacy
 *     PUT /partners/:id/buyer-profile) refuses an enabled profile that a live
 *     workflow's step cannot read, naming the workflow, the step and the
 *     missing template, on the profile field whose rule needs it;
 *   - a live workflow save (PUT, the switch on, a restore of an active
 *     workflow) refuses a definition whose buyer steps cannot read an enabled
 *     profile they judge, naming the buyer and the rule.
 *
 * Checking only one side would leave the other route to the same state (L247).
 *
 * Which buyers a step judges follows the nodes: buyer_select set to sell live
 * (a decide_only step rehearses and never sells, so it is left out) judges every
 * enabled profile sold on the offer and priced for its population (pricedFor,
 * the rule evaluateEligibility refuses by), and leaves click buyers out;
 * buyer_click_check judges the one buyer its partner_id names, when that buyer
 * is sold on the click (it refuses an offer buyer before any lead). The partner's
 * own on switch is NOT consulted: a partner switched back on is judged at
 * once, and that switch is a partner save that checks nothing here, so an
 * enabled profile is held to its live steps whatever the partner's switch says.
 * The fields each profile needs come from @bidspoke/buyer-profile
 * (unreadLeadFields), the same list the box refuses by (L370).
 *
 * A template that is set but points somewhere the lead does not carry cannot
 * be judged at save time; the live share refusal check
 * (live-share-refusals.ts) is the backstop for that.
 */
import {
  LEAD_FIELD_LABELS,
  LEAD_FIELD_PROFILE_PATHS,
  pricedFor,
  unreadLeadFields,
  unreadRuleSentence,
  type BuyerProfile,
  type LeadField,
} from '@bidspoke/buyer-profile'

/** A buyer as the checks need it: its id, the name people know it by, and its profile. */
export interface CoverageBuyer {
  partnerId: string
  name: string
  profile: BuyerProfile
}

export interface CoverageWorkflow {
  id: string
  name: string
  is_active?: boolean | null
  definition: unknown
}

export type BuyerStepType = 'buyer_select' | 'buyer_click_check'

export interface InputGap {
  workflowId: string
  workflowName: string
  nodeNamespace: string
  /** The step's label when it has one, else its namespace: what the canvas shows. */
  nodeName: string
  nodeType: BuyerStepType
  partnerId: string
  buyerName: string
  /** The fields the profile needs that the step has no template for, in LEAD_FIELDS order. */
  fields: LeadField[]
  profile: BuyerProfile
}

interface DefNode {
  type?: unknown
  namespace?: unknown
  label?: unknown
  config?: Record<string, unknown> | null
}

function nodesOf(definition: unknown): DefNode[] {
  const nodes = (definition as { nodes?: unknown } | null | undefined)?.nodes
  return Array.isArray(nodes) ? nodes.filter((n): n is DefNode => typeof n === 'object' && n !== null) : []
}

/** The buyers a buyer step judges, as the node itself chooses them. */
function buyersJudgedBy(node: DefNode, buyers: readonly CoverageBuyer[]): CoverageBuyer[] {
  const config = node.config ?? {}
  const enabled = buyers.filter((b) => b.profile.isEnabled)
  if (node.type === 'buyer_select') {
    // Only a step selling live loses a lead to an unread rule; decide_only rehearses and never sells.
    if (config.mode !== 'live') return []
    const population = config.population
    if (typeof population !== 'string') return []
    // A click sold buyer is offered by buyer_click_check, never by buyer_select (#1543).
    return enabled.filter((b) => b.profile.soldOn !== 'click' && pricedFor(b.profile, population))
  }
  if (node.type === 'buyer_click_check') {
    // The check refuses an offer buyer by name (partner_not_click) before judging any lead.
    return enabled.filter((b) => b.partnerId === config.partner_id && b.profile.soldOn === 'click')
  }
  return []
}

/** Every live buyer step that cannot read a rule of a buyer it judges. Switched off workflows judge no lead, so they are left out. */
export function findInputGaps(workflows: readonly CoverageWorkflow[], buyers: readonly CoverageBuyer[]): InputGap[] {
  const gaps: InputGap[] = []
  for (const w of workflows) {
    if (w.is_active !== true) continue
    for (const node of nodesOf(w.definition)) {
      if (node.type !== 'buyer_select' && node.type !== 'buyer_click_check') continue
      for (const buyer of buyersJudgedBy(node, buyers)) {
        const fields = unreadLeadFields(buyer.profile, node.config)
        if (fields.length === 0) continue
        const namespace = typeof node.namespace === 'string' ? node.namespace : String(node.type)
        const label = typeof node.label === 'string' && node.label.trim() !== '' ? node.label.trim() : namespace
        gaps.push({
          workflowId: w.id,
          workflowName: w.name,
          nodeNamespace: namespace,
          nodeName: label,
          nodeType: node.type,
          partnerId: buyer.partnerId,
          buyerName: buyer.name,
          fields,
          profile: buyer.profile,
        })
      }
    }
  }
  return gaps
}

/** A refusal in the profile validator's shape, so the partners page puts it beside the field whose rule cannot be read. */
export interface UnreadRuleError {
  code: 'rule_unread_by_live_workflow'
  path: string
  message: string
}

/** What clearing the rule means on the page, for the second remedy. */
function clearRule(field: LeadField): string {
  switch (field) {
    case 'loan_amount':
      return 'leave the minimum loan amount blank'
    case 'collections':
      return 'leave the collections cap blank'
    case 'state':
    case 'debt':
      return 'switch this buyer off'
  }
}

/**
 * The refusals of a profile save: one per live step and field. Empty means the
 * save may go ahead. The buyer is the profile as this save leaves it.
 */
export function inputGapsForProfileSave(workflows: readonly CoverageWorkflow[], buyer: CoverageBuyer): UnreadRuleError[] {
  return findInputGaps(workflows, [buyer]).flatMap((gap) =>
    gap.fields.map((field) => {
      const label = LEAD_FIELD_LABELS[field]
      return {
        code: 'rule_unread_by_live_workflow' as const,
        path: LEAD_FIELD_PROFILE_PATHS[field],
        message:
          `Nothing was saved. The live workflow ${gap.workflowName} judges this buyer in its step ${gap.nodeName}, which has no ${label} template, ` +
          `so ${unreadRuleSentence(gap.profile, field)} would refuse every lead it sends as missing a lead field. ` +
          `Add a ${label} template to that step first, or ${clearRule(field)}.`,
      }
    })
  )
}

/**
 * The refusals of a workflow save: one sentence per step, buyer and field.
 * Empty means the save may go ahead. The workflow is judged as live, because
 * the callers ask only about a workflow that is, or is being switched, on.
 */
export function inputGapsForWorkflowSave(workflow: Omit<CoverageWorkflow, 'is_active'>, buyers: readonly CoverageBuyer[]): string[] {
  return findInputGaps([{ ...workflow, is_active: true }], buyers).flatMap((gap) =>
    gap.fields.map((field) => {
      const label = LEAD_FIELD_LABELS[field]
      // Every buyer judges the state and the debt, so there is no rule to change, only the template to add.
      if (field === 'state' || field === 'debt') {
        return `Step ${gap.nodeName} has no ${label} template, so every lead it offers ${gap.buyerName} would be refused as missing a lead field. Add the template.`
      }
      return (
        `Step ${gap.nodeName} has no ${label} template, and ${gap.buyerName}'s buyer profile sets ${unreadRuleSentence(gap.profile, field)}, ` +
        `so every lead would be refused as missing a lead field. Add the template, or change the profile on the ${gap.buyerName} partner page first.`
      )
    })
  )
}

/** Whether a definition carries a buyer step at all, so a save without one never reads the profiles. */
export function hasBuyerStep(definition: unknown): boolean {
  return nodesOf(definition).some((n) => n.type === 'buyer_select' || n.type === 'buyer_click_check')
}
