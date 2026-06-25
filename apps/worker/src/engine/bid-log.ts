// Code-node bid-attempt derivation (#349).
//
// The live bidding flows bid via CODE nodes, not partner_bid/bid_group nodes, so
// recordBidAttempt (only reached from those node executors) never fires and
// lead_sighting_bids stays empty. This reconstructs the bid ATTEMPT from the
// existing code-node output with NO canvas changes.
//
// Tripoint first: the Engine Bidding Workflow's `tripoint_ping` node returns
// Tripoint's raw createLead response. That response carries the attempt + result
// (skipped / qualified / resultCode) but NO bid amount, so bid_cents stays null.
// The winner flip still lives in finalize (matched on execution_id+partner_slug);
// this only records the attempt.

import type { BidAttemptInsert } from './lead-sightings'
import type { StepOutput } from '../types'
import { classifyTripointResultCode } from './bid-resolver'

export interface DerivedBidMeta {
  sighting_id: string
  trace_id: string
  execution_id: string
  attempted_at_utc: Date
  is_test: boolean
}

interface TripointBidOutput {
  skipped?: unknown
  qualified?: unknown
  resultCode?: unknown
  createLead?: unknown
}

// A Tripoint ping output is an object carrying `resultCode` plus the
// ping-specific `qualified`/`skipped`/`createLead` shape. Distinctive enough to
// avoid coupling to the exact node namespace (which may differ across flows).
function isTripointBidOutput(output: unknown): output is TripointBidOutput {
  if (typeof output !== 'object' || output === null) return false
  const o = output as Record<string, unknown>
  return 'resultCode' in o && ('qualified' in o || 'skipped' in o || 'createLead' in o)
}

// Slim, serializable per-attempt shape projected onto workflow_executions
// .sighting_finalize so the strand drain can re-INSERT the bid rows a stranded
// lead lost (#366 Phase 2b). Excludes ids/timestamps/is_test — the drain refills
// those from the sighting row (attempted_at_utc = sighting.execution_started_at_utc).
export interface ProjectedBidAttempt {
  partner_slug: string
  classification: string | null
  decline_reason: string | null
  skip_reason: string | null
  resolver_type: string | null
  bid_cents: number | null
  http_status: number | null
}

// The per-attempt rows the live path would have recorded, in projection shape.
// Reuses deriveCodeNodeBidAttempts (capture-on flows bid via code nodes), so the
// projected set matches what recordBidAttempt writes for non-stranded runs.
const PROJECTION_EPOCH = new Date(0)
export function bidAttemptsForProjection(steps: Record<string, StepOutput>): ProjectedBidAttempt[] {
  return deriveCodeNodeBidAttempts(steps, {
    sighting_id: '', trace_id: '', execution_id: '', attempted_at_utc: PROJECTION_EPOCH, is_test: false,
  }).map((a) => ({
    partner_slug: a.partner_slug,
    classification: a.classification ?? null,
    decline_reason: a.decline_reason ?? null,
    skip_reason: a.skip_reason ?? null,
    resolver_type: a.resolver_type ?? null,
    bid_cents: a.bid_cents ?? null,
    http_status: a.http_status ?? null,
  }))
}

export function deriveCodeNodeBidAttempts(
  steps: Record<string, StepOutput>,
  meta: DerivedBidMeta,
): BidAttemptInsert[] {
  const rows: BidAttemptInsert[] = []
  for (const step of Object.values(steps)) {
    const output = step?.output
    if (!isTripointBidOutput(output)) continue

    const base = {
      sighting_id: meta.sighting_id,
      trace_id: meta.trace_id,
      execution_id: meta.execution_id,
      partner_slug: 'tripoint',
      attempted_at_utc: meta.attempted_at_utc,
      attempted_at_et: meta.attempted_at_utc,
      responded_at_utc: null,
      responded_at_et: null,
      http_status: null,
      // Tripoint's response carries no bid amount; left null until a source for
      // it is decided (see #349).
      bid_cents: null,
      resolver_type: 'api',
      is_test: meta.is_test,
    }

    if (output.skipped === true) {
      rows.push({ ...base, classification: null, decline_reason: null, skip_reason: 'skipped' })
      continue
    }

    const code = Number(output.resultCode)
    const result = Number.isFinite(code) ? classifyTripointResultCode(code) : 'Fail'
    const declineReason = Number.isFinite(code) ? `result_code_${code}` : null

    if (result === 'Success') {
      rows.push({ ...base, classification: 'accept', decline_reason: null, skip_reason: null })
    } else if (result === 'Duplicate') {
      rows.push({ ...base, classification: 'decline', decline_reason: declineReason, skip_reason: 'duplicate' })
    } else {
      rows.push({ ...base, classification: 'decline', decline_reason: declineReason, skip_reason: 'rejected' })
    }
  }
  return rows
}

export interface BidSummary {
  winner_slug: string | null
  winner_bid_cents: number | null
  attempted: number | null
  responded: number | null
}

// Choose the bid_group summary when it carries any signal (a winner or counted
// attempts); otherwise fall back to the code-node (Tripoint) summary so the
// finalize winner flip + bid counts work for code-node bidding flows too (#349).
export function pickBidSummary(bidGroup: BidSummary, codeNode: BidSummary): BidSummary {
  return bidGroup.winner_slug || bidGroup.attempted != null ? bidGroup : codeNode
}

// Code-node equivalent of extractBidGroupSummary, so the finalize winner UPDATE
// (which flips lead_sighting_bids.is_winner on the winning partner_slug) fires
// for Tripoint bids that came through a code node. An approved (Success) Tripoint
// ping makes tripoint the winner; the bid amount is not in Tripoint's response so
// winner_bid_cents stays null. Same shape as extractBidGroupSummary so the engine
// can fall back to it when no bid_group winner is present (#349).
export function deriveCodeNodeBidSummary(steps: Record<string, StepOutput>): BidSummary {
  let attempted = 0
  let responded = 0
  let winner: string | null = null
  for (const step of Object.values(steps)) {
    const output = step?.output
    if (!isTripointBidOutput(output)) continue
    if (output.skipped === true) continue
    attempted++
    responded++
    const code = Number(output.resultCode)
    if (Number.isFinite(code) && classifyTripointResultCode(code) === 'Success') winner = 'tripoint'
  }
  return {
    winner_slug: winner,
    winner_bid_cents: null,
    attempted: attempted || null,
    responded: responded || null,
  }
}
