/**
 * Bid Group node — wraps "send a lead to N partners and pick a winner".
 *
 * Three modes (all return the same output shape):
 *   cascade     — sequential; try partner 1, advance to 2 only if 1 doesn't win
 *   highest_bid — parallel fan-out, highest accepted bid wins
 *   tiered      — list of tiers (each cascade or highest_bid), advance between
 *                 tiers if no winner. Implemented in Slice 4b.
 *
 * BidGroup is a first-class engine executor (called from walkGraph, not the
 * simple executeNode switch) because it spans multiple synthesized step rows
 * — one parent 'bid_group' row plus one 'partner_bid' attempt row per partner
 * tried — linked via parallel_group_id (reused as a generic group id).
 *
 * Output: { winner, all_bids, mode, reason, _route: 'winner' | 'no_winner' }.
 * The two outgoing edges are picked by _route — same convention as
 * bid_evaluation and branch.
 */

import type { NodeDefinition, ExecutionContext } from '../../types'
import type { PartnerBidOutput } from './partner-bid'
import { executePartnerBidNode } from './partner-bid'
import { PartnerApiError } from '../partner-bid-error'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

export type BidGroupMode = 'cascade' | 'highest_bid' | 'tiered'

export interface BidGroupConfig {
  mode: BidGroupMode
  partner_ids?: string[]
  min_bid_threshold?: number | null
  fallback_partner_id?: string | null
  no_winner_behavior?: 'fail' | 'exit'
  cascade_total_timeout_ms?: number
  // tiered (4b):
  tiers?: BidGroupTier[]
}

export interface BidGroupTier {
  id: string
  label?: string
  mode: 'cascade' | 'highest_bid'
  partner_ids: string[]
  // advance_condition reuses the existing rule-builder shape from branch/filter (4b).
  advance_condition?: unknown
}

export interface BidGroupAttempt {
  /** Synthesized step namespace (`${groupNamespace}.${partner_slug}`) */
  namespace: string
  /** Partner UUID this attempt targeted */
  partner_id: string
  /** Output from executePartnerBidNode (or null if it threw) */
  output: PartnerBidOutput | null
  /** completed when the partner returned (accepted or skipped); failed when it threw */
  status: 'completed' | 'failed'
  error?: string
  error_type?: 'transient' | 'permanent' | null
  started_at: string
  duration_ms: number
}

export interface BidGroupOutput {
  winner: { partner: string; bid: number; raw_response?: unknown } | null
  all_bids: PartnerBidOutput[]
  excluded: PartnerBidOutput[]
  mode: BidGroupMode
  reason: string
  _route: 'winner' | 'no_winner'
}

interface RunAttemptInput {
  partner_id: string
  attemptIndex: number
}

/**
 * runAttempt is supplied by the engine — it wraps executePartnerBidNode with the
 * synthesized node definition + step logging. The bid-group executor stays free
 * of step-log plumbing and is unit-testable in isolation.
 */
export type RunAttemptFn = (input: RunAttemptInput) => Promise<BidGroupAttempt>

export async function executeBidGroupNode(
  node: NodeDefinition,
  _ctx: ExecutionContext,
  _env: Env,
  _supabase: SupabaseClient,
  runAttempt: RunAttemptFn
): Promise<BidGroupOutput> {
  const config = node.config as unknown as BidGroupConfig
  const mode = config.mode ?? 'highest_bid'

  if (mode === 'tiered') {
    return runTiered(config, runAttempt)
  }

  const partnerIds = config.partner_ids ?? []
  if (partnerIds.length === 0) {
    return noWinner(mode, [], 'no_partners_configured')
  }

  if (mode === 'cascade') {
    return runCascade(partnerIds, config, runAttempt)
  }

  // highest_bid: fan-out concurrently, pick the highest accepted bid.
  return runHighestBid(partnerIds, config, runAttempt)
}

// ── Cascade ───────────────────────────────────────────────────────────────────

async function runCascade(
  partnerIds: string[],
  config: BidGroupConfig,
  runAttempt: RunAttemptFn
): Promise<BidGroupOutput> {
  const totalTimeoutMs = config.cascade_total_timeout_ms ?? 30000
  const startedAt = Date.now()
  const all: PartnerBidOutput[] = []

  for (let i = 0; i < partnerIds.length; i++) {
    if (Date.now() - startedAt > totalTimeoutMs) {
      return noWinner('cascade', all, 'cascade_timeout')
    }
    const attempt = await runAttempt({ partner_id: partnerIds[i], attemptIndex: i })
    if (attempt.output) all.push(attempt.output)

    if (attempt.status === 'completed' && attempt.output && isWinning(attempt.output, config.min_bid_threshold)) {
      return winnerOutput('cascade', all, attempt.output, all)
    }
    // PASS or ERROR -> advance. Errors are logged on the attempt row; we keep going.
  }

  // All partners passed. Try fallback if configured.
  if (config.fallback_partner_id) {
    const attempt = await runAttempt({ partner_id: config.fallback_partner_id, attemptIndex: partnerIds.length })
    if (attempt.output) all.push(attempt.output)
    if (attempt.status === 'completed' && attempt.output && isWinning(attempt.output, config.min_bid_threshold)) {
      return winnerOutput('cascade', all, attempt.output, all, 'fallback_won')
    }
  }

  return noWinner('cascade', all, 'all_partners_passed')
}

// ── Highest bid (parallel fan-out) ────────────────────────────────────────────

async function runHighestBid(
  partnerIds: string[],
  config: BidGroupConfig,
  runAttempt: RunAttemptFn
): Promise<BidGroupOutput> {
  const settled = await Promise.all(
    partnerIds.map((id, idx) =>
      runAttempt({ partner_id: id, attemptIndex: idx })
        .catch((err) => ({
          namespace: `attempt-${idx}`,
          partner_id: id,
          output: null,
          status: 'failed' as const,
          error: err instanceof Error ? err.message : String(err),
          started_at: new Date().toISOString(),
          duration_ms: 0,
        } satisfies BidGroupAttempt))
    )
  )

  const all: PartnerBidOutput[] = []
  for (const a of settled) {
    if (a.output) all.push(a.output)
  }

  const accepted = all.filter((b) => isWinning(b, config.min_bid_threshold))
  if (accepted.length === 0) {
    if (config.fallback_partner_id) {
      const fb = await runAttempt({ partner_id: config.fallback_partner_id, attemptIndex: settled.length })
      if (fb.output) all.push(fb.output)
      if (fb.status === 'completed' && fb.output && isWinning(fb.output, config.min_bid_threshold)) {
        return winnerOutput('highest_bid', all, fb.output, all, 'fallback_won')
      }
    }
    return noWinner('highest_bid', all, 'no_accepted_bids')
  }

  // Highest bid wins; ties broken by first-in (input order).
  const winner = accepted.reduce((best, curr) =>
    (curr.bid ?? 0) > (best.bid ?? 0) ? curr : best
  )
  return winnerOutput('highest_bid', all, winner, all)
}

// ── Tiered (Slice 4b stub) ────────────────────────────────────────────────────

async function runTiered(
  config: BidGroupConfig,
  _runAttempt: RunAttemptFn
): Promise<BidGroupOutput> {
  // Slice 4b will implement tier evaluation + advance gates. For now:
  // emit a no_winner with a clear reason rather than throwing, so a workflow
  // that drops in a tiered group before 4b ships can still execute its
  // no_winner branch.
  const tiers = config.tiers ?? []
  return noWinner('tiered', [], `tiered_mode_not_implemented:${tiers.length}_tiers_configured`)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isWinning(output: PartnerBidOutput, minBid: number | null | undefined): boolean {
  if (output.skipped || !output.accepted) return false
  if (output.bid === null) return false
  if (minBid != null && output.bid < minBid) return false
  return true
}

function winnerOutput(
  mode: BidGroupMode,
  all: PartnerBidOutput[],
  winner: PartnerBidOutput,
  excluded: PartnerBidOutput[],
  reason = 'winner'
): BidGroupOutput {
  return {
    winner: {
      partner: winner.partner,
      bid: winner.bid ?? 0,
      raw_response: winner.raw_response,
    },
    all_bids: all,
    excluded: excluded.filter((b) => b.partner !== winner.partner),
    mode,
    reason,
    _route: 'winner',
  }
}

function noWinner(mode: BidGroupMode, all: PartnerBidOutput[], reason: string): BidGroupOutput {
  return {
    winner: null,
    all_bids: all,
    excluded: all,
    mode,
    reason,
    _route: 'no_winner',
  }
}

// Re-exports so the engine wiring can build synthesized partner-bid attempts.
export { executePartnerBidNode, PartnerApiError }
