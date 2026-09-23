/**
 * What the buyer_select exits that hand the lead back mean, in the node's
 * current mode (#1490). Deferred is how the cutover migrates: the node decided
 * but did not sell, so the rest of the workflow sells the lead as it does
 * today. The word reads as "postpone" to anyone who has not read
 * docs/nodes/buyer-select.md, so the card explains it on the term (L604).
 */
export type HandBackExit = 'not_applicable' | 'deferred'

export function handBackMeaning(exit: HandBackExit, config: Record<string, unknown>): string {
  if (exit === 'not_applicable') {
    return 'Not a sell off lead: the sell off condition is not true, or the bid is not positive. The node did nothing, and the rest of the workflow carries on as it does today.'
  }
  if (config.mode !== 'live') {
    return 'Hands the lead back. Decide only rehearses the sale and calls nobody, so every sell off lead takes this exit and the rest of the workflow sells it as it does today.'
  }
  const shareEnv = typeof config.live_percent_env === 'string' && config.live_percent_env ? config.live_percent_env : null
  if (shareEnv) {
    return `Hands the lead back, and the rest of the workflow sells it as it does today. Taken by sell off leads outside the live share in ${shareEnv}, by every lead while it is unset, and when the sell off condition cannot be read.`
  }
  return 'Hands the lead back, and the rest of the workflow sells it as it does today. Taken only when the sell off condition cannot be read.'
}
