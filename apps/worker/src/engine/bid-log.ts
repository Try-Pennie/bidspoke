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
import type { NodeDefinition, StepOutput } from '../types'
import { classifyTripointResultCode } from './bid-resolver'

// A pass-through node's output becomes the input of everything downstream, and a
// branch_end re-emits the very object it received (executeBranchEndNode). Every node's
// output lands in ctx.steps, so a derivation keyed purely on output SHAPE fires once per
// node the output travelled through, not once per bid: a ping followed by a convergence
// yields two attempts for one call. Worse, the RML slug comes from the NAMESPACE, so the
// phantom row would be attributed to a partner named after the branch_end.
//
// Same invariant, same fix as achieve-log.ts (#640, after 6c55259): gate on the node TYPE,
// which is what can genuinely produce a bid. Only a `code` node bids in these flows (every
// live producer is one: tripoint_ping, ping_lendswift, ping_gigfi). partner_bid/bid_group
// nodes record natively via recordBidAttempt, so deriving them here would double-count.
// The node NAME stays free-form.
const BID_PRODUCER_TYPES = new Set(['code'])

// The steps a bid may be derived from: only those whose node is a producer type. A
// namespace absent from the definition (a bid_group's synthesized per-partner child) is
// excluded for the same reason: it already records itself.
function bidProducerSteps(
  steps: Record<string, StepOutput>,
  nodes: NodeDefinition[],
): Array<[string, StepOutput]> {
  const typeByNamespace = new Map(nodes.map((n) => [n.namespace, n.type as string]))
  return Object.entries(steps).filter(([namespace]) =>
    BID_PRODUCER_TYPES.has(typeByNamespace.get(namespace) ?? '')
  )
}

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

// RML (LendSwift/GigFi) ping output (#381). The bid is nested two levels deep:
// { data: { data: { status, bid_amount, min_bid_value, rejection_reason, ... } } }.
// `bid_amount` is the actual per-bid dollar figure (present on every ACCEPTED
// bid); `min_bid_value` is a floor, NOT the paid amount, so it is never recorded.
interface RmlBidData {
  status?: unknown
  bid_amount?: unknown
  min_bid_value?: unknown
  rejection_reason?: unknown
}
function isRmlBidOutput(output: unknown): output is { data: { data: RmlBidData } } {
  if (typeof output !== 'object' || output === null) return false
  const data = (output as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return false
  const inner = (data as { data?: unknown }).data
  if (typeof inner !== 'object' || inner === null) return false
  const d = inner as Record<string, unknown>
  // Distinctive: an inner string status plus an RML-specific amount/floor field.
  return typeof d.status === 'string' && ('min_bid_value' in d || 'bid_amount' in d)
}

// The RML output never names its partner, so identity comes from the node
// namespace, which is `ping_<slug>` by convention (ping_lendswift -> lendswift).
function rmlSlugFromNamespace(namespace: string): string {
  return namespace.replace(/^ping_/, '')
}

function rmlBidCents(d: RmlBidData): number | null {
  return typeof d.bid_amount === 'number' && Number.isFinite(d.bid_amount)
    ? Math.round(d.bid_amount * 100)
    : null
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
export function bidAttemptsForProjection(
  steps: Record<string, StepOutput>,
  nodes: NodeDefinition[],
): ProjectedBidAttempt[] {
  return deriveCodeNodeBidAttempts(steps, {
    sighting_id: '', trace_id: '', execution_id: '', attempted_at_utc: PROJECTION_EPOCH, is_test: false,
  }, nodes).map((a) => ({
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
  nodes: NodeDefinition[],
): BidAttemptInsert[] {
  const rows: BidAttemptInsert[] = []
  for (const [namespace, step] of bidProducerSteps(steps, nodes)) {
    const output = step?.output

    const baseRow = (partner_slug: string, bid_cents: number | null) => ({
      sighting_id: meta.sighting_id,
      trace_id: meta.trace_id,
      execution_id: meta.execution_id,
      partner_slug,
      attempted_at_utc: meta.attempted_at_utc,
      attempted_at_et: meta.attempted_at_utc,
      responded_at_utc: null,
      responded_at_et: null,
      http_status: null,
      bid_cents,
      resolver_type: 'api',
      is_test: meta.is_test,
    })

    if (isTripointBidOutput(output)) {
      // Tripoint's response carries no bid amount (see #349/#354), so bid_cents
      // stays null.
      const base = baseRow('tripoint', null)
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
      continue
    }

    if (isRmlBidOutput(output)) {
      // RML (#381): bid_amount IS recorded. ACCEPTED -> accept; anything else
      // (REJECTED) -> decline, carrying the partner's rejection_reason.
      const d = output.data.data
      const base = baseRow(rmlSlugFromNamespace(namespace), rmlBidCents(d))
      if (String(d.status).toUpperCase() === 'ACCEPTED') {
        rows.push({ ...base, classification: 'accept', decline_reason: null, skip_reason: null })
      } else {
        const reason =
          typeof d.rejection_reason === 'string' && d.rejection_reason.trim() ? d.rejection_reason : null
        rows.push({ ...base, classification: 'decline', decline_reason: reason, skip_reason: 'rejected' })
      }
      continue
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
export function deriveCodeNodeBidSummary(
  steps: Record<string, StepOutput>,
  nodes: NodeDefinition[],
): BidSummary {
  let attempted = 0
  let responded = 0
  let winner: string | null = null
  let winnerBidCents: number | null = null
  for (const [namespace, step] of bidProducerSteps(steps, nodes)) {
    const output = step?.output
    if (isTripointBidOutput(output)) {
      if (output.skipped === true) continue
      attempted++
      responded++
      const code = Number(output.resultCode)
      if (Number.isFinite(code) && classifyTripointResultCode(code) === 'Success') winner = 'tripoint'
      continue
    }
    if (isRmlBidOutput(output)) {
      const d = output.data.data
      attempted++
      responded++
      // ACCEPTED == the RML partner won the lead (pending confirmation, see #381),
      // carrying the real bid amount.
      if (String(d.status).toUpperCase() === 'ACCEPTED') {
        winner = rmlSlugFromNamespace(namespace)
        winnerBidCents = rmlBidCents(d)
      }
      continue
    }
  }
  return {
    winner_slug: winner,
    winner_bid_cents: winnerBidCents,
    attempted: attempted || null,
    responded: responded || null,
  }
}
