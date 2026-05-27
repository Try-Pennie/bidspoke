import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult, ResolvedStepInput } from '../../types'
import type { Env } from '../../index'
import { loadPartnerConstants } from '../../lib/partner-constants-loader'

export async function executeConstantsNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  supabase: SupabaseClient
): Promise<StepExecutionResult> {
  const data = (node.config.data ?? {}) as Record<string, unknown>
  const partnerData = await loadPartnerConstants(ctx.trigger.org_id, env.WORKFLOW_CACHE, supabase)

  const partnerFlat: Record<string, string> = {}
  for (const [slug, copy] of Object.entries(partnerData.sellOff)) {
    const cap = slug.charAt(0).toUpperCase() + slug.slice(1)
    partnerFlat[`${cap}SellOffOfferTitle`] = copy.title
    partnerFlat[`${cap}SellOffOfferDetails`] = copy.details
  }
  for (const [slug, url] of Object.entries(partnerData.clickUrls)) {
    const cap = slug.charAt(0).toUpperCase() + slug.slice(1)
    partnerFlat[`${cap}ClickUrl`] = url
  }
  const partnerMaps: Record<string, Record<string, number>> = {}
  for (const [slug, bids] of Object.entries(partnerData.subAccountMinBids ?? {})) {
    const cap = slug.charAt(0).toUpperCase() + slug.slice(1)
    partnerMaps[`${cap}SubAccountMinBids`] = bids
  }

  const resolvedInput: ResolvedStepInput = {
    template: { data: node.config.data },
    resolved: { data, partner_constants_keys: [...Object.keys(partnerFlat), ...Object.keys(partnerMaps)], partner_count: Object.keys(partnerData.subAccountIdsMap ?? {}).length },
  }

  return {
    output: {
      ...data,
      subAccountIdsMap: partnerData.subAccountIdsMap,
      activeBidding: partnerData.activeBidding,
      ...partnerFlat,
      ...partnerMaps,
    },
    resolvedInput,
  }
}
