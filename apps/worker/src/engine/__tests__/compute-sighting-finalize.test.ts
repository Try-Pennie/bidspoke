/**
 * #353 Phase 1: the rich sighting-finalize fields (winner/bid/enrichment/
 * reject_reason/outcome) are computed by one pure function so both the live
 * finalize (block 2) and the durable projection onto workflow_executions
 * (block 1) use identical logic.
 */
import { describe, it, expect } from 'vitest'
import { computeSightingFinalize } from '../lead-sightings'
import type { StepOutput, NodeDefinition } from '../../types'

function node(id: string, namespace: string, type: string): NodeDefinition {
  return { id, namespace, type } as NodeDefinition
}

describe('computeSightingFinalize (#353)', () => {
  it('extracts winner, bid cents, enrichment and a successful outcome for a bid_group win', () => {
    const steps: Record<string, StepOutput> = {
      create_prospect: { status: 'completed', output: { body: { id: 'sf-123' } } },
      equifax_credit_report: { status: 'completed', output: { status: 'success', score: 720 } },
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
    expect(out.equifax_status).toBe('success')
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
