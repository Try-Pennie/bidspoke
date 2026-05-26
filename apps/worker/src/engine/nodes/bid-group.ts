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

import type { NodeDefinition, ExecutionContext, ConditionGroup } from '../../types'
import type { PartnerBidOutput } from './partner-bid'
import { executePartnerBidNode } from './partner-bid'
import { PartnerApiError } from '../partner-bid-error'
import { evaluateConditionGroups } from '../graph'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

export type BidGroupMode = 'cascade' | 'highest_bid' | 'tiered'

export interface BidGroupConfig {
  mode: BidGroupMode
  partner_ids?: string[]
  min_bid_threshold?: number | null
  fallback_partner_id?: string | null
  /**
   * What happens when the group emits `_route: 'no_winner'`.
   *
   *   'route' (default; legacy alias: 'fail')
   *     The workflow takes the `no_winner` outgoing edge wired in the canvas.
   *     Continue normal execution. Does NOT throw or mark the step failed.
   *
   *   'exit'
   *     Short-circuit the workflow with the group output as the HTTP response
   *     (status 200). No edge routing.
   *
   * The historical value `'fail'` is preserved at read time for back-compat —
   * it has always meant "fall through to edge routing", never "throw". The
   * runtime treats `'fail'` identically to `'route'`.
   */
  no_winner_behavior?: 'route' | 'exit' | 'fail'
  cascade_total_timeout_ms?: number
  /**
   * Race deadline for highest_bid mode (and any tier evaluating in highest_bid).
   * Each partner is raced against this deadline; partners that don't settle in
   * time are recorded as failed (the underlying fetch keeps running to
   * completion — see reference_parallel_node_no_abort.md). When unset, no
   * deadline is enforced and the group waits for every partner to finish.
   *
   * Pipedream main flow uses 5000 (BID_DEADLINE_MS) for parity.
   */
  timeout_ms?: number
  /**
   * Map of name → template string. Resolved once at BidGroup entry against the
   * current execution context (via resolveValue), then attached to
   * ctx.bidGroupContext for the duration of the group's partner attempts.
   * Partner formulas can reference these as `context.<name>` to stay
   * workflow-agnostic.
   *
   * Example: `{ finalDebt: "{{steps.eligibility.output.final}}" }` — partner
   * formulas use `context.finalDebt` regardless of which workflow's step name
   * provides eligibility data.
   */
  context?: Record<string, unknown>
  // tiered (4b):
  tiers?: BidGroupTier[]
}

export interface BidGroupTier {
  id: string
  label?: string
  mode: 'cascade' | 'highest_bid'
  partner_ids: string[]
  /**
   * Optional gate evaluated before running this tier. Reuses the existing rule-builder
   * shape from branch/filter. Empty/absent = always run this tier if no winner yet.
   * If the gate is false, the tier is skipped (its id appears in tiers_skipped).
   */
  advance_condition?: { groups: ConditionGroup[]; logic: 'AND' | 'OR' }
}

/**
 * Per-partner outcome stamped onto each entry in BidGroupOutput.all_bids /
 * .excluded so the JSON is self-describing — the table doesn't have to
 * cross-reference `winner.partner` to know who lost on amount vs. who declined.
 *
 *   won      — picked as the bid group's winner
 *   outbid   — partner returned a usable bid (accepted=true) but lost on amount
 *   declined — partner rejected the lead (skip_reason in 'rejected'/'bid_below_min')
 *   skipped  — partner not contacted (skip_reason in 'partner_inactive'/'circuit_open'/'cap_exceeded'/'duplicate')
 *   error    — attempt failed (output null at the BidGroup level). Not currently
 *              attached to all_bids entries since failed attempts don't add a
 *              PartnerBidOutput row, but kept here for completeness.
 */
export type BidGroupAttemptOutcome = 'won' | 'outbid' | 'declined' | 'skipped' | 'error'

export interface BidGroupAttempt {
  /** Synthesized step namespace (`${groupNamespace}.${partner_slug}`) */
  namespace: string
  /** Partner UUID this attempt targeted */
  partner_id: string
  /** Partner slug — set by the engine on real attempts, also filled in for
   *  race-timeout fallbacks via the slugLookup arg. Used to synthesize
   *  PartnerBidOutput rows for failed attempts so they remain visible in
   *  all_bids instead of vanishing. */
  partner_slug?: string
  /** Output from executePartnerBidNode (or null if it threw) */
  output: PartnerBidOutput | null
  /** completed when the partner returned (accepted or skipped); failed when it threw */
  status: 'completed' | 'failed'
  error?: string
  error_type?: 'transient' | 'permanent' | null
  started_at: string
  duration_ms: number
}

/** PartnerBidOutput plus the group-level outcome stamp + human-readable reason. */
export type PartnerBidOutputWithOutcome = PartnerBidOutput & {
  outcome?: BidGroupAttemptOutcome
  /**
   * One-line explanation of why this attempt got the outcome it did. Generated
   * by stampOutcome from the attempt's state + the group's winner + mode.
   * Examples:
   *   "Highest bid in race"           (won, highest_bid)
   *   "First partner to accept"       (won, cascade)
   *   "Won as fallback"               (won, reason='fallback_won')
   *   "Outbid by tripoint ($19.82 vs $12)"  (outbid)
   *   "Partner declined"              (declined, skip_reason='rejected')
   *   "Daily cap (250)"               (skipped, skip_reason='cap_exceeded')
   *   "Partner did not respond within 5000ms"  (error)
   */
  outcome_reason?: string
}

export interface BidGroupOutput {
  winner: {
    partner: string
    bid: number
    raw_response?: unknown
    /** Partner-specific values from PartnerBidOutput.extra (clickUrl, leadId, etc.). */
    extra?: Record<string, unknown>
  } | null
  all_bids: PartnerBidOutputWithOutcome[]
  excluded: PartnerBidOutputWithOutcome[]
  mode: BidGroupMode
  reason: string
  _route: 'winner' | 'no_winner'
  /** Tiered mode only: ids of tiers whose advance_condition evaluated false. */
  tiers_skipped?: string[]
  /** Tiered mode only: id of the tier that produced the winner. */
  tier_winner?: string
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

/**
 * Optional partner-id → slug lookup so the race-timeout fallback (which is
 * synthesized inside bid-group, not via runAttempt) can populate partner_slug
 * on the synthetic BidGroupAttempt. When omitted, failed-attempt synthesis
 * falls back to using partner_id as the display slug.
 */
export type SlugLookup = (partnerId: string) => string | undefined

export async function executeBidGroupNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  _env: Env,
  _supabase: SupabaseClient,
  runAttempt: RunAttemptFn,
  slugLookup?: SlugLookup
): Promise<BidGroupOutput> {
  const config = node.config as unknown as BidGroupConfig
  const mode = config.mode ?? 'highest_bid'

  if (mode === 'tiered') {
    return runTiered(config, ctx, runAttempt, slugLookup)
  }

  const partnerIds = config.partner_ids ?? []
  if (partnerIds.length === 0) {
    return noWinner(mode, [], 'no_partners_configured')
  }

  if (mode === 'cascade') {
    return runCascade(partnerIds, config, runAttempt)
  }

  // highest_bid: fan-out concurrently, pick the highest accepted bid.
  return runHighestBid(partnerIds, config, runAttempt, slugLookup)
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
    else all.push(synthFailedOutput(attempt))

    if (attempt.status === 'completed' && attempt.output && isWinning(attempt.output, config.min_bid_threshold)) {
      return winnerOutput('cascade', all, attempt.output, all)
    }
    // PASS or ERROR -> advance. Errors are logged on the attempt row; we keep going.
  }

  // All partners passed. Try fallback if configured.
  if (config.fallback_partner_id) {
    const attempt = await runAttempt({ partner_id: config.fallback_partner_id, attemptIndex: partnerIds.length })
    if (attempt.output) all.push(attempt.output)
    else all.push(synthFailedOutput(attempt))
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
  runAttempt: RunAttemptFn,
  slugLookup?: SlugLookup
): Promise<BidGroupOutput> {
  const timeoutMs = config.timeout_ms
  const startedAt = Date.now()

  const tasks = partnerIds.map((id, idx) =>
    runAttempt({ partner_id: id, attemptIndex: idx })
      .catch((err) => ({
        namespace: `attempt-${idx}`,
        partner_id: id,
        partner_slug: slugLookup?.(id),
        output: null,
        status: 'failed' as const,
        error: err instanceof Error ? err.message : String(err),
        started_at: new Date().toISOString(),
        duration_ms: 0,
      } satisfies BidGroupAttempt))
  )

  // Race each partner against the deadline when timeout_ms is set. Partners
  // that exceed the deadline are recorded as failed-by-timeout; the BidGroup
  // returns within the deadline. Underlying fetches keep running (the
  // AbortSignal-propagation gap is separate — see parallel.ts).
  let settled: BidGroupAttempt[]
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    settled = await Promise.all(
      tasks.map((p, idx) =>
        Promise.race<BidGroupAttempt>([
          p,
          new Promise<BidGroupAttempt>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  namespace: `attempt-${idx}`,
                  partner_id: partnerIds[idx],
                  partner_slug: slugLookup?.(partnerIds[idx]),
                  output: null,
                  status: 'failed',
                  error: `Partner did not respond within ${timeoutMs}ms`,
                  error_type: 'transient',
                  started_at: new Date(startedAt).toISOString(),
                  duration_ms: timeoutMs,
                }),
              timeoutMs
            )
          ),
        ])
      )
    )
  } else {
    settled = await Promise.all(tasks)
  }

  // Include both successful and failed attempts in `all` so the JSON makes
  // the full set of partners visible. Failed attempts get a synthesized
  // PartnerBidOutput (stamped as outcome:'error' downstream) carrying the
  // partner slug + error info — without this they vanish from all_bids/
  // excluded and the bid_group output looks like the partner was never tried.
  const all: PartnerBidOutput[] = []
  for (const a of settled) {
    if (a.output) all.push(a.output)
    else all.push(synthFailedOutput(a))
  }

  const accepted = all.filter((b) => isWinning(b, config.min_bid_threshold))
  if (accepted.length === 0) {
    if (config.fallback_partner_id) {
      const fb = await runAttempt({ partner_id: config.fallback_partner_id, attemptIndex: settled.length })
      if (fb.output) all.push(fb.output)
      else all.push(synthFailedOutput(fb))
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

// ── Tiered ────────────────────────────────────────────────────────────────────

async function runTiered(
  config: BidGroupConfig,
  ctx: ExecutionContext,
  runAttempt: RunAttemptFn,
  slugLookup?: SlugLookup
): Promise<BidGroupOutput> {
  const tiers = config.tiers ?? []
  if (tiers.length === 0) {
    return noWinner('tiered', [], 'no_tiers_configured')
  }

  const allBids: PartnerBidOutput[] = []
  const tiersSkipped: string[] = []
  let attemptIndex = 0

  // Wrap runAttempt so each tier-attempt gets a unique global index even though
  // each tier passes its own 0..N internally. The engine maps attemptIndex to a
  // step_order slot, so collisions would trash the ordering in the test panel.
  const globalRun: RunAttemptFn = async ({ partner_id }) => {
    const idx = attemptIndex++
    return runAttempt({ partner_id, attemptIndex: idx })
  }

  for (const tier of tiers) {
    if (tier.advance_condition && !evaluateConditionGroups(
      tier.advance_condition.groups,
      tier.advance_condition.logic ?? 'AND',
      ctx
    )) {
      tiersSkipped.push(tier.id)
      continue
    }

    const tierConfig: BidGroupConfig = {
      mode: tier.mode,
      partner_ids: tier.partner_ids,
      min_bid_threshold: config.min_bid_threshold,
      // Tiers don't have their own fallback — fallback fires once at the group
      // level, after all tiers exhaust without a winner.
    }

    const tierResult = tier.mode === 'cascade'
      ? await runCascade(tier.partner_ids, tierConfig, globalRun)
      : await runHighestBid(tier.partner_ids, tierConfig, globalRun, slugLookup)

    for (const b of tierResult.all_bids) allBids.push(b)

    if (tierResult.winner) {
      const winnerOutput = allBids.find((b) => b.partner === tierResult.winner!.partner) ?? null
      const reason = tierResult.reason === 'fallback_won' ? 'fallback_won' : 'tier_winner'
      const stampCtx: StampContext = { winner: winnerOutput, mode: 'tiered', groupReason: reason }
      return {
        winner: tierResult.winner,
        all_bids: allBids.map((b) => stampOutcome(b, stampCtx)),
        excluded: allBids.filter((b) => b.partner !== tierResult.winner!.partner).map((b) => stampOutcome(b, stampCtx)),
        mode: 'tiered',
        reason,
        _route: 'winner',
        tiers_skipped: tiersSkipped.length > 0 ? tiersSkipped : undefined,
        tier_winner: tier.id,
      }
    }
  }

  // All tiers exhausted. Group-level fallback gets a last shot.
  if (config.fallback_partner_id) {
    const fbAttempt = await globalRun({ partner_id: config.fallback_partner_id, attemptIndex: 0 })
    if (fbAttempt.output) allBids.push(fbAttempt.output)
    else allBids.push(synthFailedOutput(fbAttempt))
    if (fbAttempt.status === 'completed' && fbAttempt.output && isWinning(fbAttempt.output, config.min_bid_threshold)) {
      const winnerOut = fbAttempt.output
      const stampCtx: StampContext = { winner: winnerOut, mode: 'tiered', groupReason: 'fallback_won' }
      return {
        winner: {
          partner: winnerOut.partner,
          bid: winnerOut.bid ?? 0,
          raw_response: winnerOut.raw_response,
          ...(winnerOut.extra ? { extra: winnerOut.extra } : {}),
        },
        all_bids: allBids.map((b) => stampOutcome(b, stampCtx)),
        excluded: allBids.filter((b) => b.partner !== winnerOut.partner).map((b) => stampOutcome(b, stampCtx)),
        mode: 'tiered',
        reason: 'fallback_won',
        _route: 'winner',
        tiers_skipped: tiersSkipped.length > 0 ? tiersSkipped : undefined,
      }
    }
  }

  const noWinReason = tiersSkipped.length === tiers.length ? 'all_tiers_skipped' : 'all_tiers_exhausted'
  const stampCtx: StampContext = { winner: null, mode: 'tiered', groupReason: noWinReason }
  const stamped = allBids.map((b) => stampOutcome(b, stampCtx))
  return {
    winner: null,
    all_bids: stamped,
    excluded: stamped,
    mode: 'tiered',
    reason: noWinReason,
    _route: 'no_winner',
    tiers_skipped: tiersSkipped.length > 0 ? tiersSkipped : undefined,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isWinning(output: PartnerBidOutput, minBid: number | null | undefined): boolean {
  if (output.skipped || !output.accepted) return false
  if (output.bid === null) return false
  if (minBid != null && output.bid < minBid) return false
  return true
}

const DECLINED_REASONS = new Set(['rejected', 'bid_below_min'])

/**
 * Build a PartnerBidOutput stand-in for a failed/timed-out attempt so the
 * bid_group's all_bids array stays complete. `error`+`error_type` ride along
 * so the UI can show "Errored" with the reason. Partner display name falls
 * back to partner_id when slug lookup misses (still better than the row
 * silently disappearing).
 */
function synthFailedOutput(attempt: BidGroupAttempt): PartnerBidOutput {
  return {
    partner: attempt.partner_slug ?? attempt.partner_id,
    bid: null,
    accepted: false,
    skipped: false,
    error: attempt.error,
    error_type: attempt.error_type ?? null,
  }
}

interface StampContext {
  winner: PartnerBidOutput | null
  mode: BidGroupMode
  /** Group-level reason ('winner' | 'fallback_won' | 'tier_winner' | etc.). */
  groupReason: string
}

function reasonForWon(mode: BidGroupMode, groupReason: string): string {
  if (groupReason === 'fallback_won') return 'Won as fallback'
  if (mode === 'cascade') return 'First partner to accept'
  if (mode === 'tiered') return 'Winner of tier'
  return 'Highest bid in race'
}

function reasonForOutbid(self: PartnerBidOutput, winner: PartnerBidOutput | null): string {
  if (!winner) return 'Lost on amount'
  if (winner.bid !== null && self.bid !== null) {
    return `Outbid by ${winner.partner} ($${winner.bid} vs $${self.bid})`
  }
  return `Outbid by ${winner.partner}`
}

function reasonForSkipped(bid: PartnerBidOutput): string {
  switch (bid.skip_reason) {
    case 'duplicate': return 'Dedup match'
    case 'cap_exceeded': return `Daily cap${bid.cap_count !== undefined ? ` (${bid.cap_count})` : ''}`
    case 'circuit_open': return 'Circuit breaker open'
    case 'partner_inactive': return 'Partner inactive'
    case 'bid_below_min': return `Bid${bid.bid !== null ? ` $${bid.bid}` : ''} below partner min`
    case 'rejected': return 'Partner declined'
    default: return bid.skip_reason ?? 'Skipped'
  }
}

function reasonForNullBid(bid: PartnerBidOutput): string {
  const m = bid.matrix?.reason
  if (m === 'no_matching_cell') return 'No matrix row matched the lead'
  if (m && m.startsWith('missing_payload_field:')) return `Missing payload field: ${m.split(':')[1]}`
  if (m === 'config_inactive') return 'Matrix config inactive'
  return m ?? 'Resolver returned null'
}

function stampOutcome(
  bid: PartnerBidOutput,
  ctx: StampContext
): PartnerBidOutputWithOutcome {
  const winnerPartner = ctx.winner?.partner ?? null
  if (winnerPartner !== null && bid.partner === winnerPartner) {
    return { ...bid, outcome: 'won', outcome_reason: reasonForWon(ctx.mode, ctx.groupReason) }
  }
  // Synthesized failed-attempt rows carry an error string — flag them as
  // outcome:'error' so the UI distinguishes "partner threw" from "partner
  // declined the lead". Real PartnerBidOutput rows never set bid.error.
  if (bid.error !== undefined) {
    return { ...bid, outcome: 'error', outcome_reason: bid.error }
  }
  if (bid.skipped) {
    const outcome = bid.skip_reason && DECLINED_REASONS.has(bid.skip_reason) ? 'declined' : 'skipped'
    return { ...bid, outcome, outcome_reason: reasonForSkipped(bid) }
  }
  if (bid.accepted) {
    return { ...bid, outcome: 'outbid', outcome_reason: reasonForOutbid(bid, ctx.winner) }
  }
  // accepted=false but not skipped — partner returned but bid was null (e.g. matrix
  // produced no row, formula evaluated to null). Treat as declined.
  return { ...bid, outcome: 'declined', outcome_reason: reasonForNullBid(bid) }
}

function winnerOutput(
  mode: BidGroupMode,
  all: PartnerBidOutput[],
  winner: PartnerBidOutput,
  excluded: PartnerBidOutput[],
  reason = 'winner'
): BidGroupOutput {
  const stampCtx: StampContext = { winner, mode, groupReason: reason }
  const stampedAll = all.map((b) => stampOutcome(b, stampCtx))
  return {
    winner: {
      partner: winner.partner,
      bid: winner.bid ?? 0,
      raw_response: winner.raw_response,
      ...(winner.extra ? { extra: winner.extra } : {}),
    },
    all_bids: stampedAll,
    excluded: excluded.filter((b) => b.partner !== winner.partner).map((b) => stampOutcome(b, stampCtx)),
    mode,
    reason,
    _route: 'winner',
  }
}

function noWinner(mode: BidGroupMode, all: PartnerBidOutput[], reason: string): BidGroupOutput {
  const stampCtx: StampContext = { winner: null, mode, groupReason: reason }
  const stamped = all.map((b) => stampOutcome(b, stampCtx))
  return {
    winner: null,
    all_bids: stamped,
    excluded: stamped,
    mode,
    reason,
    _route: 'no_winner',
  }
}

// Re-exports so the engine wiring can build synthesized partner-bid attempts.
export { executePartnerBidNode, PartnerApiError }
