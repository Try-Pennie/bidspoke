/**
 * Bid Evaluation node — PRD Section 5.8
 *
 * Receives results from a Parallel node's partner bid children and selects a winner.
 *
 * Config: { parallel_source, strategy, min_bid_threshold, tiebreaker, fallback_partner,
 *           no_winner_behavior, weight_bid, weight_acceptance, weight_speed }
 * Output: { winner, all_bids, excluded, reason, _route: 'winner' | 'no_winner' }
 * Routes:
 *   'winner'    — bid found, or fallback partner activated
 *   'no_winner' — no qualifying bids, no_winner_behavior = 'exit'
 *                 (if no_winner_behavior = 'fail', throws instead)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import type { ParallelChildResult } from './parallel'
import type { PartnerBidOutput } from './partner-bid'

// ── Config ────────────────────────────────────────────────────────────────────

interface BidEvaluationConfig {
  parallel_source: string
  strategy?: 'highest_bid' | 'weighted_score'
  min_bid_threshold?: number | null
  tiebreaker?: 'partner_priority' | 'fastest_response'
  fallback_partner?: string | null
  no_winner_behavior?: 'fail' | 'exit'
  // Weighted score multipliers (do not need to sum to 1)
  weight_bid?: number
  weight_acceptance?: number
  weight_speed?: number
}

// ── Output types ──────────────────────────────────────────────────────────────

export interface BidCandidate {
  partner: string
  bid: number | null
  namespace: string
  raw?: unknown
  score?: number
}

export interface BidEvaluationOutput {
  winner: (BidCandidate & { is_fallback?: boolean }) | null
  all_bids: BidCandidate[]
  excluded: BidCandidate[]
  reason: string
  _route: 'winner' | 'no_winner'
}

// ── Metrics for weighted scoring ──────────────────────────────────────────────

interface PartnerMetrics {
  acceptance_rate: number
  avg_response_ms: number
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function executeBidEvaluationNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  supabase?: SupabaseClient
): Promise<StepExecutionResult> {
  const config = node.config as unknown as BidEvaluationConfig
  const strategy = config.strategy ?? 'highest_bid'
  const tiebreaker = config.tiebreaker ?? 'partner_priority'
  const minThreshold = config.min_bid_threshold ?? null
  const fallbackPartner = config.fallback_partner ?? null
  const noWinnerBehavior = config.no_winner_behavior ?? 'exit'

  if (!config.parallel_source) {
    throw new Error('Bid Evaluation node requires config.parallel_source')
  }

  // Read parallel output from context
  const parallelStep = ctx.steps[config.parallel_source]
  if (!parallelStep || parallelStep.status !== 'completed') {
    throw new Error(`Bid Evaluation: parallel source "${config.parallel_source}" has no completed output`)
  }

  const parallelResults = (parallelStep.output ?? []) as ParallelChildResult[]

  // Extract candidates and excluded bids from fulfilled children
  const all_bids: BidCandidate[] = []
  const excluded: BidCandidate[] = []

  for (const child of parallelResults) {
    if (child.status !== 'fulfilled' || !child.output) {
      // Rejected or timed-out children are not candidates
      continue
    }
    const pbo = child.output as PartnerBidOutput
    const candidate: BidCandidate = {
      partner: pbo.partner,
      bid: pbo.bid,
      namespace: child.namespace,
      raw: pbo.raw_response,
    }
    if (pbo.skipped || !pbo.accepted || pbo.bid === null) {
      excluded.push(candidate)
    } else {
      all_bids.push(candidate)
    }
  }

  // Apply minimum bid threshold — move below-threshold bids to excluded
  const qualifying: BidCandidate[] = []
  for (const b of all_bids) {
    if (minThreshold !== null && b.bid !== null && b.bid < minThreshold) {
      excluded.push(b)
    } else {
      qualifying.push(b)
    }
  }

  if (qualifying.length === 0) {
    const reason = all_bids.length === 0 ? 'all_rejected' : 'all_below_threshold'

    if (fallbackPartner) {
      const output: BidEvaluationOutput = {
        winner: { partner: fallbackPartner, bid: null, namespace: '__fallback__', is_fallback: true },
        all_bids,
        excluded,
        reason: 'fallback',
        _route: 'winner',
      }
      return { output }
    }

    if (noWinnerBehavior === 'fail') {
      throw new Error(`Bid Evaluation: no qualifying bids (${reason})`)
    }

    const output: BidEvaluationOutput = {
      winner: null,
      all_bids,
      excluded,
      reason,
      _route: 'no_winner',
    }
    return { output }
  }

  // Select winner
  const { winner, reason } =
    strategy === 'weighted_score'
      ? await selectWeighted(qualifying, config, tiebreaker, supabase)
      : selectHighestBid(qualifying, tiebreaker)

  const output: BidEvaluationOutput = {
    winner,
    all_bids,
    excluded,
    reason,
    _route: 'winner',
  }
  return { output }
}

// ── Strategy: highest bid ─────────────────────────────────────────────────────

function selectHighestBid(
  candidates: BidCandidate[],
  tiebreaker: 'partner_priority' | 'fastest_response'
): { winner: BidCandidate; reason: string } {
  const sorted = [...candidates].sort((a, b) => {
    const diff = (b.bid ?? 0) - (a.bid ?? 0)
    if (diff !== 0) return diff
    // 'fastest_response' tiebreaker — without duration_ms in ParallelChildResult
    // we preserve insertion order (which reflects parallel node child order = implicit priority).
    // 'partner_priority' also preserves insertion order.
    return 0
  })
  return { winner: sorted[0], reason: tiebreaker === 'partner_priority' ? 'highest_bid' : 'highest_bid_fastest_response' }
}

// ── Strategy: weighted score ──────────────────────────────────────────────────

async function selectWeighted(
  candidates: BidCandidate[],
  config: BidEvaluationConfig,
  tiebreaker: 'partner_priority' | 'fastest_response',
  supabase?: SupabaseClient
): Promise<{ winner: BidCandidate; reason: string }> {
  const wBid = config.weight_bid ?? 1.0
  const wAcceptance = config.weight_acceptance ?? 0.5
  const wSpeed = config.weight_speed ?? 0.1

  const metrics = await fetchPartnerMetrics(candidates.map((c) => c.partner), supabase)

  const scored: BidCandidate[] = candidates.map((c) => {
    const m = metrics[c.partner] ?? { acceptance_rate: 0.5, avg_response_ms: 5000 }
    const score = (c.bid ?? 0) * wBid + m.acceptance_rate * wAcceptance - m.avg_response_ms * wSpeed
    return { ...c, score }
  })

  scored.sort((a, b) => {
    const diff = (b.score ?? 0) - (a.score ?? 0)
    return diff !== 0 ? diff : 0  // equal scores: preserve order (partner_priority)
  })

  return { winner: scored[0], reason: tiebreaker === 'partner_priority' ? 'weighted_score' : 'weighted_score_fastest_response' }
}

// ── Metrics fetching ──────────────────────────────────────────────────────────

async function fetchPartnerMetrics(
  partnerSlugs: string[],
  supabase?: SupabaseClient
): Promise<Record<string, PartnerMetrics>> {
  if (!supabase || partnerSlugs.length === 0) return {}

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  try {
    const { data: steps } = await supabase
      .from('execution_steps')
      .select('output, duration_ms')
      .eq('step_type', 'partner_bid')
      .gte('started_at', thirtyDaysAgo)

    if (!steps || steps.length === 0) return {}

    const groups: Record<string, { total: number; accepted: number; totalMs: number }> = {}

    for (const step of steps) {
      const out = step.output as PartnerBidOutput | null
      if (!out?.partner) continue
      const slug = out.partner
      if (!partnerSlugs.includes(slug)) continue
      if (!groups[slug]) groups[slug] = { total: 0, accepted: 0, totalMs: 0 }
      groups[slug].total++
      if (out.accepted) groups[slug].accepted++
      groups[slug].totalMs += step.duration_ms ?? 0
    }

    const result: Record<string, PartnerMetrics> = {}
    for (const [slug, g] of Object.entries(groups)) {
      // Minimum 10 bids for reliable metrics; use defaults below that threshold
      if (g.total < 10) continue
      result[slug] = {
        acceptance_rate: g.accepted / g.total,
        avg_response_ms: g.totalMs / g.total,
      }
    }
    return result
  } catch {
    // Metrics unavailable — callers fall back to defaults
    return {}
  }
}
