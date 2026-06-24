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
