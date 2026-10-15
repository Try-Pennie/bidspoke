import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult, ResolvedStepInput } from '../../types'
import type { Env } from '../../index'
import { loadPartnerConstants, type PartnerConstants } from '../../lib/partner-constants-loader'

/**
 * The partner values the Constants node emits under a name built from the
 * partner's slug (#2142): `<Cap>ClickUrl`, `<Cap>SellOffOfferTitle`,
 * `<Cap>SellOffOfferDetails` and the per slug map `<Cap>SubAccountMinBids`.
 * The executor builds every name through `partnerConstantName`, whose `kind`
 * is typed by this list, and the workflow values scanner
 * (lib/partner-workflow-values.ts) searches for every kind in it. A test fails
 * when the executor emits a partner key the scanner does not search for.
 */
export const PARTNER_CONSTANT_KINDS = ['ClickUrl', 'SellOffOfferTitle', 'SellOffOfferDetails', 'SubAccountMinBids'] as const
export type PartnerConstantKind = (typeof PARTNER_CONSTANT_KINDS)[number]

/**
 * The two maps the node emits holding every partner's entry: `subAccountIdsMap`
 * (sub-account id to partner slug) and `activeBidding` (partner slug to whether
 * it bids).
 */
export const PARTNER_CONSTANT_MAPS = ['subAccountIdsMap', 'activeBidding'] as const
export type PartnerConstantMap = (typeof PARTNER_CONSTANT_MAPS)[number]

/** The name a partner's value is emitted under: the slug with its first letter capitalised, then the kind. */
export function partnerConstantName(slug: string, kind: PartnerConstantKind): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1) + kind
}

/**
 * The partner derived part of the node's output, from the loaded partner data.
 * The workflow level `data` keys are spread BEFORE this, so a data key with the
 * same name as a partner key is shadowed by it.
 */
export function partnerConstantOutput(partnerData: PartnerConstants): Record<string, unknown> {
  const partnerFlat: Record<string, string> = {}
  for (const [slug, copy] of Object.entries(partnerData.sellOff)) {
    partnerFlat[partnerConstantName(slug, 'SellOffOfferTitle')] = copy.title
    partnerFlat[partnerConstantName(slug, 'SellOffOfferDetails')] = copy.details
  }
  for (const [slug, url] of Object.entries(partnerData.clickUrls)) {
    partnerFlat[partnerConstantName(slug, 'ClickUrl')] = url
  }
  const partnerMaps: Record<string, Record<string, number>> = {}
  for (const [slug, bids] of Object.entries(partnerData.subAccountMinBids ?? {})) {
    partnerMaps[partnerConstantName(slug, 'SubAccountMinBids')] = bids
  }
  return {
    subAccountIdsMap: partnerData.subAccountIdsMap,
    activeBidding: partnerData.activeBidding,
    ...partnerFlat,
    ...partnerMaps,
  }
}

/**
 * Every partner derived key the node emits for this partner data (#2142): the
 * flat names and per slug maps of the partners that have a value, and the two
 * maps. A partner with no click URL emits no `<Cap>ClickUrl`; a test holds the
 * executor's output to this list.
 */
export function partnerConstantOutputKeys(partnerData: PartnerConstants): string[] {
  const keys: string[] = []
  for (const slug of Object.keys(partnerData.sellOff)) {
    keys.push(partnerConstantName(slug, 'SellOffOfferTitle'), partnerConstantName(slug, 'SellOffOfferDetails'))
  }
  for (const slug of Object.keys(partnerData.clickUrls)) keys.push(partnerConstantName(slug, 'ClickUrl'))
  for (const slug of Object.keys(partnerData.subAccountMinBids ?? {})) keys.push(partnerConstantName(slug, 'SubAccountMinBids'))
  keys.push(...PARTNER_CONSTANT_MAPS)
  return keys
}

export async function executeConstantsNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  supabase: SupabaseClient
): Promise<StepExecutionResult> {
  const data = (node.config.data ?? {}) as Record<string, unknown>
  const partnerData = await loadPartnerConstants(ctx.trigger.org_id, env.WORKFLOW_CACHE, supabase)

  const resolvedInput: ResolvedStepInput = {
    template: { data: node.config.data },
    resolved: { data, partner_constants_keys: partnerConstantOutputKeys(partnerData), partner_count: Object.keys(partnerData.subAccountIdsMap ?? {}).length },
  }

  return {
    output: {
      ...data,
      ...partnerConstantOutput(partnerData),
    },
    resolvedInput,
  }
}
