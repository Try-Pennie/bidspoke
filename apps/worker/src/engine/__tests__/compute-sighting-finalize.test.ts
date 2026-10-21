/**
 * #353 Phase 1: the rich sighting-finalize fields (winner/bid/enrichment/
 * reject_reason/outcome) are computed by one pure function so both the live
 * finalize (block 2) and the durable projection onto workflow_executions
 * (block 1) use identical logic.
 */
import { describe, it, expect } from 'vitest'
import { computeSightingFinalize, buildSightingFinalizeProjection } from '../lead-sightings'
import type { StepOutput, NodeDefinition } from '../../types'

function node(id: string, namespace: string, type: string): NodeDefinition {
  return { id, namespace, type } as NodeDefinition
}

describe('computeSightingFinalize (#353)', () => {
  it('extracts winner, bid cents, enrichment and a successful outcome for a bid_group win', () => {
    const steps: Record<string, StepOutput> = {
      create_prospect: { status: 'completed', output: { body: { id: 'sf-123' } } },
      // The Engine workflow's real output shape (#1379): the score sits inside the report,
      // never at the top level, and the status word is the one the node itself emits.
      equifax_credit_report: {
        status: 'completed',
        output: { status: 'completed', consumers: { equifaxUSConsumerCreditReport: [{ models: [{ score: '720' }] }] } },
      },
      bid_node: {
        status: 'completed',
        output: {
          winner: { partner: 'tripoint', bid: 45 },
          all_bids: [
            { partner: 'tripoint', bid: 45 },
            { partner: 'm1', skipped: true },
          ],
          _route: 'winner',
        },
      },
      respond: { status: 'completed', output: { ok: true } },
    }
    const nodes = [node('n-bid', 'bid_node', 'bid_group'), node('n-resp', 'respond', 'response')]

    const out = computeSightingFinalize(steps, nodes, {
      lastCompletedNamespace: 'respond',
      walkStatus: 200,
      executionStatus: 'completed',
      successNamespaces: ['respond'],
    })

    expect(out.winning_partner_slug).toBe('tripoint')
    expect(out.winning_bid_cents).toBe(4500)
    expect(out.partners_attempted).toBe(2)
    expect(out.partners_responded).toBe(1)
    expect(out.prospect_id).toBe('sf-123')
    expect(out.equifax_status).toBe('completed')
    expect(out.equifax_score).toBe(720)
    expect(out.reject_reason).toBeNull() // a winner means no rejection
    expect(out.outcome).toBe('successful') // passed through a success namespace
    expect(out.response_status_code).toBe(200)
    expect(out.terminal_node_label).toBe('respond')
  })

  it('derives a reject_reason and completed (not successful) outcome for a filter exit', () => {
    const steps: Record<string, StepOutput> = {
      filter_node: { status: 'completed', output: { passed: false } },
    }
    const nodes = [node('n-f', 'filter_node', 'filter')]

    const out = computeSightingFinalize(steps, nodes, {
      lastCompletedNamespace: 'filter_node',
      walkStatus: 200,
      executionStatus: 'completed',
      successNamespaces: [],
    })

    expect(out.winning_partner_slug).toBeNull()
    expect(out.reject_reason).toBe('filter_rejected')
    expect(out.outcome).toBe('completed')
  })

  it('records a lead validation rejection as the run\'s reject_reason (#2589)', () => {
    const steps: Record<string, StepOutput> = {
      constants: { status: 'completed', output: { states: ['TX'] } },
      validate_bidding_and_state: {
        status: 'completed',
        output: { valid: false, check_id: 'state', field: 'trigger.payload.personalInformation.state', reason: 'ineligible state' },
      },
    }
    const nodes = [node('n-c', 'constants', 'constants'), node('n-v', 'validate_bidding_and_state', 'lead_validation')]

    const out = computeSightingFinalize(steps, nodes, {
      lastCompletedNamespace: 'validate_bidding_and_state',
      walkStatus: 200,
      executionStatus: 'completed',
      successNamespaces: [],
    })

    expect(out.reject_reason).toBe('lead_validation:ineligible state')
    expect(out.terminal_node_label).toBe('validate_bidding_and_state')
    expect(out.outcome).toBe('completed')
  })

  it('marks a failed execution outcome regardless of steps', () => {
    const out = computeSightingFinalize({}, [], {
      lastCompletedNamespace: null,
      walkStatus: 500,
      executionStatus: 'failed',
      successNamespaces: [],
    })
    expect(out.outcome).toBe('failed')
  })
})

/**
 * #353 Phase 1/2b: the block-1 projection (what gets written onto
 * workflow_executions.sighting_finalize so the strand drain can recover with
 * full fidelity) is assembled by one gated helper. The gate must match the live
 * finalize exactly — project only for capture-on (sightingId set), non-test runs
 * — and the projection must carry the per-attempt bid rows the strand would
 * otherwise lose (#366).
 */
describe('buildSightingFinalizeProjection (#353)', () => {
  const steps: Record<string, StepOutput> = {
    tripoint_ping: {
      status: 'completed',
      output: { result: 1000, approved: true, partner: 'tripoint', bid: 30 },
    },
    respond: { status: 'completed', output: { ok: true } },
  }
  const nodes = [
    node('n-ping', 'tripoint_ping', 'code'),
    node('n-resp', 'respond', 'response'),
  ]
  const opts = {
    lastCompletedNamespace: 'respond',
    walkStatus: 200,
    executionStatus: 'completed',
    successNamespaces: ['respond'],
  }

  it('returns the rich fields plus bid_attempts when capture is on and it is not a test run', () => {
    const proj = buildSightingFinalizeProjection(steps, nodes, opts, {
      sightingId: 'sighting-1',
      isTest: false,
    })
    expect(proj).toBeDefined()
    // Rich fields come straight from computeSightingFinalize (same logic both paths).
    expect(proj).toMatchObject(computeSightingFinalize(steps, nodes, opts))
    // Per-attempt bid rows must ride along so the drain can re-INSERT them (#366).
    expect(Array.isArray(proj!.bid_attempts)).toBe(true)
  })

  it('returns undefined when there is no sighting (capture off) — never project for non-captured runs', () => {
    expect(
      buildSightingFinalizeProjection(steps, nodes, opts, { sightingId: null, isTest: false }),
    ).toBeUndefined()
    expect(
      buildSightingFinalizeProjection(steps, nodes, opts, { sightingId: undefined, isTest: false }),
    ).toBeUndefined()
  })

  it('returns undefined for test runs — sandbox runs must not pollute the projection', () => {
    expect(
      buildSightingFinalizeProjection(steps, nodes, opts, { sightingId: 'sighting-1', isTest: true }),
    ).toBeUndefined()
  })
})
