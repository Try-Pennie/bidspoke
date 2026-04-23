/**
 * Cost rate constants for estimating per-execution cost.
 *
 * Only USD. Update rates here when Cloudflare / Supabase / partner pricing
 * changes. All rates are in dollars (not cents), per unit as noted.
 *
 * Sources:
 *   - Cloudflare Workers: https://developers.cloudflare.com/workers/platform/pricing/
 *     Bundled / Paid plan — $0.30 per million requests, $12.50 per million
 *     CPU ms above the free tier. Simplified flat rates here because we're
 *     already on the paid tier and past the free-tier allotment.
 *   - Workers for Platforms (code nodes): same per-request + per-CPU-ms rates.
 *   - Supabase: rough per-run slice based on current Pro plan averages
 *     (aggregate DB compute + egress ÷ typical monthly execution volume).
 *     Refined later by the nightly apportionment job.
 *   - Partner rates: what we pay the partner per API call. Most of our bid
 *     partners charge only on accepted bids, not pings — see per-partner notes.
 */

export const CF_REQUEST_USD = 0.0000003        // $0.30 / 1M requests
export const CF_CPU_MS_USD = 0.0000000125      // $12.50 / 1M CPU-ms

export const WFP_REQUEST_USD = 0.0000003       // same as main worker
export const WFP_CPU_MS_USD = 0.0000000125

// Per-run flat estimate for Supabase DB compute + egress. Rough; the nightly
// apportionment job will replace this once row/byte share data exists.
export const SUPABASE_PER_RUN_USD = 0.00005

// Per-partner per-API-call cost (what Pennie pays the partner). Most bid
// partners charge only on accepted bids; we still log the call-level cost
// because some partners (dedup, soft ping) charge per ping.
export const PARTNER_API_CALL_USD: Record<string, number> = {
  // No per-call costs known yet. Populate as contracts are confirmed.
}

export function partnerCallCost(slug: string): number {
  return PARTNER_API_CALL_USD[slug] ?? 0
}

/**
 * Estimate the step-based slice of execution cost from the accumulated step
 * log queue: partner API calls, code-node WFP usage, and Supabase per-run.
 *
 * The main-Worker CF request + CPU slice is NOT included here — that's
 * added by the tail-consumer worker once Cloudflare reports true cpuTime.
 *
 * Code nodes dispatch to Workers-for-Platforms user workers; their CPU
 * isn't surfaced in the main worker's tail event, so we approximate using
 * the code step's duration_ms.
 */
export interface CostInputStep {
  step_type: string
  duration_ms: number
  output: unknown
}

export function estimateStepBasedCost(steps: CostInputStep[]): number {
  let cost = SUPABASE_PER_RUN_USD

  for (const s of steps) {
    if (s.step_type === 'code') {
      cost += WFP_REQUEST_USD
      cost += s.duration_ms * WFP_CPU_MS_USD
    } else if (s.step_type === 'partner_bid') {
      const out = s.output as { partner?: string; skipped?: boolean } | null
      if (out?.partner && !out.skipped) {
        cost += partnerCallCost(out.partner)
      }
    }
  }

  return cost
}
