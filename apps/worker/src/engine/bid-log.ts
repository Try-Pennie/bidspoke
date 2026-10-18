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
import type { OutReason } from '@bidspoke/buyer-profile'

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

// A producer node does not always return the payload at its TOP level (#1157).
// Lead Economy's `return_response` wraps Tripoint's response under
// `tripointResult`, beside the body it quotes back to the source, so both
// recognizers below found nothing while the node-type gate above passed it:
// 396 of 2,901 runs in 4 hours carried a Tripoint result and none was recorded.
//
// The wrappers to look inside are an explicit ordered list, never a recursive
// search: a search would also match a copy re-emitted further down the tree,
// which is the double-count the type gate exists to prevent. Callers take the
// FIRST match, so a node satisfying a recognizer at two depths yields one row.
export function payloadCandidates(output: unknown, wrapperKeys: readonly string[]): unknown[] {
  const candidates: unknown[] = [output]
  if (typeof output === 'object' && output !== null) {
    for (const key of wrapperKeys) candidates.push((output as Record<string, unknown>)[key])
  }
  return candidates
}

/**
 * A click sold buyer offered on a known Tripoint no (#1544). The buyer is sold when
 * the lead CLICKS, so at the time of the run it is offered, not contacted: its bid row
 * is marked by this resolver_type, the way buyer_select marks its own rows, so a count
 * of click sales can find them.
 */
export const CLICK_RESOLVER_TYPE = 'click'

export interface ClickOffer {
  partner_slug: string
}

/**
 * The click sold buyer this run offered the lead to, or null. Two facts must agree,
 * each from the node that owns it: a buyer_click_check node routed eligible for a
 * buyer, and a producer (code) node's output made that buyer's click sale on an offer
 * it did not reject (build_response_body's `sale`, sold_on click). Gated on node TYPE
 * for the same reason as every recogniser here: a branch_end after the check re-emits
 * its output, and only the check itself can say eligible.
 */
export function deriveClickOffer(steps: Record<string, StepOutput>, nodes: NodeDefinition[]): ClickOffer | null {
  const typeByNamespace = new Map(nodes.map((n) => [n.namespace, n.type as string]))
  const eligible = new Set<string>()
  for (const [namespace, step] of Object.entries(steps)) {
    if (typeByNamespace.get(namespace) !== 'buyer_click_check' || step?.status !== 'completed') continue
    const out = step.output as { _route?: unknown; partner_slug?: unknown } | null
    if (out && out._route === 'eligible' && typeof out.partner_slug === 'string' && out.partner_slug) eligible.add(out.partner_slug)
  }
  if (eligible.size === 0) return null
  for (const [, step] of bidProducerSteps(steps, nodes)) {
    if (step?.status !== 'completed') continue
    const out = step.output as { isRejected?: unknown; sale?: unknown } | null
    if (!out || out.isRejected !== false) continue
    const sale = out.sale as { accepted?: unknown; sold_on?: unknown; partner_slug?: unknown } | null
    if (!sale || sale.accepted !== true || sale.sold_on !== 'click') continue
    if (typeof sale.partner_slug === 'string' && eligible.has(sale.partner_slug)) return { partner_slug: sale.partner_slug }
  }
  return null
}

/**
 * The run's bid summary with a click sale folded in (#1544): the click buyer is the
 * winner when nothing else won, and it counts as attempted (it has a bid row) but not
 * as responded, because it was offered, never called.
 */
export function withClickOffer(summary: BidSummary, offer: ClickOffer | null): BidSummary {
  if (!offer || summary.winner_slug) return summary
  return { ...summary, winner_slug: offer.partner_slug, winner_bid_cents: null, attempted: (summary.attempted ?? 0) + 1 }
}

export interface DerivedBidMeta {
  sighting_id: string
  trace_id: string
  execution_id: string
  attempted_at_utc: Date
  is_test: boolean
}

/**
 * The refusals a code node's bid row carries by name (#2391): a buyer's own rule
 * deciding a lead out before anyone was asked. tripoint_ping returns these beside
 * its `skipped: true` since version 110 of the Engine flow (2026-10-15), Tripoint's
 * 2,000 loan minimum, in the buyer profile's own vocabulary (OUT_REASONS).
 *
 * A reason not on this list is recorded as plain `skipped`, never by its word,
 * because every reader of lead_sighting_bids that counts attempts counts any
 * skip_reason other than `skipped` as one (the bid_recording_coverage functions).
 * bid_recording_coverage_v4 leaves every one of these out of its attempts, and a
 * web guard holds its list to this one; a reason added here must be added there
 * in a new version, or it would count as an attempt.
 */
export const BID_ROW_REFUSAL_REASONS = ['loan_amount_below_min', 'missing_lead_field'] as const satisfies readonly OutReason[]
export type BidRowRefusalReason = (typeof BID_ROW_REFUSAL_REASONS)[number]
const REFUSAL_REASONS: ReadonlySet<string> = new Set(BID_ROW_REFUSAL_REASONS)

/**
 * The written refusals the too few bids monitor counts as RECORDED, beside the
 * attempts (#2391): a deliberate rule that took the place of an attempt.
 *
 * Only the loan minimum. missing_lead_field is written to the row as evidence but
 * counted as neither an attempt nor a recorded refusal, because it is also what a
 * fault looks like: a loan amount path that stops resolving makes every sell off
 * lead read missing_lead_field, and counted as recorded that would keep the ratio
 * steady while Tripoint got nothing (L367). Counted as neither, it collapses the
 * ratio and pages. bid_recording_coverage_v4's refusal_rows counts exactly these,
 * held to this list by the same web guard.
 */
export const RECORDED_REFUSAL_REASONS = ['loan_amount_below_min'] as const satisfies readonly BidRowRefusalReason[]

/** The listed refusal a skipped producer output names, or null for a plain skip. */
export function refusalReasonOf(output: { skip_reason?: unknown }): BidRowRefusalReason | null {
  const r = output.skip_reason
  return typeof r === 'string' && REFUSAL_REASONS.has(r) ? (r as BidRowRefusalReason) : null
}

interface TripointBidOutput {
  /** Why a skipped ping was not sent, named by the script on its own refusals (#2391). */
  skip_reason?: unknown
  skipped?: unknown
  qualified?: unknown
  resultCode?: unknown
  createLead?: unknown
  /** What Tripoint answered, named by the script on every path since #1540. */
  tripoint_answer?: unknown
  /** The older script's two flags for its known 502 answers, read when tripoint_answer is absent. */
  tripointLeadRejected?: unknown
  tripointTransientFault?: unknown
}

/**
 * What Tripoint answered (#1540), in tripoint_ping's own vocabulary. The script
 * names it on every path; an output from an older script (or Lead Economy's
 * wrapped copy) is read from the fields it did carry: its skip, its two 502
 * flags, and its result code. Anything with no code and no flag is `unknown`,
 * because nothing in it says what Tripoint decided.
 */
export type TripointAnswer = 'accepted' | 'declined' | 'in_progress' | 'invalid_data' | 'null_id_fault' | 'skipped' | 'unknown'
const TRIPOINT_ANSWERS: ReadonlySet<string> = new Set<TripointAnswer>(['accepted', 'declined', 'in_progress', 'invalid_data', 'null_id_fault', 'skipped', 'unknown'])

export function tripointAnswerOf(output: TripointBidOutput): TripointAnswer {
  if (typeof output.tripoint_answer === 'string' && TRIPOINT_ANSWERS.has(output.tripoint_answer)) return output.tripoint_answer as TripointAnswer
  // An answer word this reader does not know is not a decline either.
  if (output.tripoint_answer != null) return 'unknown'
  if (output.skipped === true) return 'skipped'
  if (output.tripointLeadRejected === true) return 'invalid_data'
  if (output.tripointTransientFault === true) return 'null_id_fault'
  if (output.resultCode == null) return 'unknown'
  const code = Number(output.resultCode)
  if (!Number.isFinite(code)) return 'unknown'
  if (classifyTripointResultCode(code) === 'Success') return 'accepted'
  return code === 1009 ? 'in_progress' : 'declined'
}

// A Tripoint ping output is an object carrying `resultCode` plus the
// ping-specific `qualified`/`skipped`/`createLead` shape. Distinctive enough to
// avoid coupling to the exact node namespace (which may differ across flows).
function isTripointBidOutput(output: unknown): output is TripointBidOutput {
  if (typeof output !== 'object' || output === null) return false
  const o = output as Record<string, unknown>
  return 'resultCode' in o && ('qualified' in o || 'skipped' in o || 'createLead' in o)
}

// The Tripoint payload for a step, at whichever depth this flow returns it:
// the top level (Engine's `tripoint_ping`) or under `tripointResult` (Lead
// Economy's `return_response`). Null when the step is not a Tripoint bid.
const TRIPOINT_WRAPPER_KEYS = ['tripointResult'] as const
function tripointBidOutput(output: unknown): TripointBidOutput | null {
  for (const candidate of payloadCandidates(output, TRIPOINT_WRAPPER_KEYS)) {
    if (isTripointBidOutput(candidate)) return candidate
  }
  return null
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

// The per-attempt rows the live path would have recorded, in projection shape,
// for the strand drain to re-INSERT. It reconstructs ONLY code-node bids (Tripoint,
// RML) and the click sale, the attempts no node records natively: those are derived
// from step output here exactly as deriveCodeNodeBidAttempts does for a live run,
// so the projected set matches what that live derivation writes.
//
// KNOWN LIMITATION #368: it does NOT reconstruct first-class bid nodes
// (partner_bid, bid_group, buyer_select). Those record
// their own attempts during the walk via makeBidLogger, so a non-stranded run
// already has their rows and reconstructing them here would double-count. The
// consequence is that a STRANDED run which bid via one of those nodes loses its
// per-attempt detail: the drain can only re-insert what this array carries. It is
// not purely hypothetical, buyer_select bids on the capture-on Engine flow (at a
// canary share), but the exposure is bounded: winners do not strand (#377, the
// load-bearing invariant), so what is lost is the per-partner detail of a rare
// stranded NON-winning run, while the sighting's own winner and attempt/response
// counts still survive (they ride computeSightingFinalize, not this array).
// Extending this to first-class nodes needs a dedup-key decision first: the native
// write keys attempted_at_utc on the real call time while the drain re-inserts at
// execution_started_at_utc, so a naive projection would DUPLICATE any row that did
// commit in a partial strand. Tracked as #368; pinned by the guard test in
// engine/__tests__/bid-log.test.ts.
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

    const tripoint = tripointBidOutput(output)
    if (tripoint) {
      // Tripoint's response carries no bid amount (see #349/#354), so bid_cents
      // stays null.
      const base = baseRow('tripoint', null)
      if (tripoint.skipped === true) {
        // A refusal by Tripoint's own rule keeps its reason (#2391), so a deliberate
        // eligibility rule can be told apart from a lead that was never a sell off.
        rows.push({ ...base, classification: null, decline_reason: null, skip_reason: refusalReasonOf(tripoint) ?? 'skipped' })
        continue
      }
      // An answer with no result code is recorded by what it was (#1540), never as a
      // decline by code: Number(null) is 0, which read as result_code_0. An unknown
      // answer is its own class, because Tripoint may have bought the lead.
      const answer = tripointAnswerOf(tripoint)
      if (answer === 'unknown') {
        rows.push({ ...base, classification: 'unknown', decline_reason: null, skip_reason: null })
        continue
      }
      if (answer === 'invalid_data') {
        rows.push({ ...base, classification: 'decline', decline_reason: 'invalid_data', skip_reason: 'rejected' })
        continue
      }
      if (answer === 'null_id_fault') {
        rows.push({ ...base, classification: 'transient', decline_reason: 'null_id_fault', skip_reason: null })
        continue
      }
      const code = Number(tripoint.resultCode)
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
  const click = deriveClickOffer(steps, nodes)
  if (click) {
    rows.push({
      sighting_id: meta.sighting_id,
      trace_id: meta.trace_id,
      execution_id: meta.execution_id,
      partner_slug: click.partner_slug,
      attempted_at_utc: meta.attempted_at_utc,
      attempted_at_et: meta.attempted_at_utc,
      responded_at_utc: null,
      responded_at_et: null,
      http_status: null,
      bid_cents: null,
      resolver_type: CLICK_RESOLVER_TYPE,
      is_test: meta.is_test,
      classification: 'accept',
      decline_reason: null,
      skip_reason: null,
    })
  }
  return rows
}

export interface BidSummary {
  winner_slug: string | null
  winner_bid_cents: number | null
  attempted: number | null
  responded: number | null
}

// Choose the first summary that carries any signal (a winner or counted
// attempts), in the caller's order: bid_group, then buyer_select (#1411), then
// the code-node (Tripoint) summary, so the finalize winner flip + bid counts
// work for code-node bidding flows too (#349). The last one is the fallback
// whatever it holds.
export function pickBidSummary(...summaries: [BidSummary, ...BidSummary[]]): BidSummary {
  for (const s of summaries.slice(0, -1)) {
    if (s.winner_slug || s.attempted != null) return s
  }
  return summaries[summaries.length - 1]
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
    const tripoint = tripointBidOutput(output)
    if (tripoint) {
      if (tripoint.skipped === true) continue
      attempted++
      // An unknown answer is one nobody could read (a timeout, a proxy 5xx), so it is not a response (#1540).
      if (tripointAnswerOf(tripoint) === 'unknown') continue
      responded++
      const code = Number(tripoint.resultCode)
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
