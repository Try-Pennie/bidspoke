import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
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

  // Flatten sell-off copy: slug 'sofi' → 'SofiSellOffOfferTitle' / 'SofiSellOffOfferDetails'
  const sellOffFlat: Record<string, string> = {}
  for (const [slug, copy] of Object.entries(partnerData.sellOff)) {
    const cap = slug.charAt(0).toUpperCase() + slug.slice(1)
    sellOffFlat[`${cap}SellOffOfferTitle`] = copy.title
    sellOffFlat[`${cap}SellOffOfferDetails`] = copy.details
  }

  return {
    output: {
      ...data,
      subAccountIdsMap: partnerData.subAccountIdsMap,
      ...sellOffFlat,
    },
  }
}
