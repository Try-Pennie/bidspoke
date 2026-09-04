/**
 * The rate a run quotes back to the lead's SOURCE (#354 follow-up).
 *
 * `lead_sighting_bids.bid_cents` means "what a buyer offered us for this lead"
 * on every row that table holds, and all four partners in it are configured as
 * buyers. The rate we quote the source that sent the lead is the opposite
 * direction of money, so it cannot share that column: any sum or average over
 * the bids table would add a cost to revenue with nothing announcing it.
 *
 * It is measurably a different number, not a restatement of the winning bid.
 * Measured on prod 2026-09-04 over 90 minutes: the RML flows quote 3.24 against
 * a 4.99 buyer bid, 1.62 against 2.49, and 1.30 against 2.00, a consistent 65%.
 * So the pair is what gives per-lead margin.
 *
 * The value is produced by the CODE node that builds the response
 * (`build_response_body` on the engine flow, `build_response` on both RML
 * flows), and the `response` node downstream re-emits the same body. Keying on
 * the producer's node TYPE rather than on the shape alone is the same invariant
 * bid-log.ts documents: a shape-only rule fires once per node the object
 * travelled through, not once per quote.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeSightingFinalize,
  buildSightingFinalizeProjection,
  finalizeSighting,
  type FinalizeSightingInput,
} from '../lead-sightings'
import { sightingExportColumns } from '../../lib/sightings-export'
import type { StepOutput, NodeDefinition } from '../../types'

function node(id: string, namespace: string, type: string): NodeDefinition {
  return { id, namespace, type } as NodeDefinition
}

const opts = {
  lastCompletedNamespace: 'offer_response',
  walkStatus: 200,
  executionStatus: 'completed' as const,
  successNamespaces: ['offer_response'],
}

/** The engine flow's build_response_body output for a quoted lead. */
function quotedSteps(rate: unknown): Record<string, StepOutput> {
  return {
    build_response_body: {
      status: 'completed',
      output: {
        isRejected: false,
        body: {
          requestId: 'trace-1',
          offers: [{ name: 'Pennie', rate, product_type: 'installment_loan' }],
        },
      },
    },
    offer_response: { status: 'completed', output: { ok: true } },
  }
}

const quotedNodes = [
  node('n-body', 'build_response_body', 'code'),
  node('n-resp', 'offer_response', 'response'),
]

describe('quoted_rate_cents', () => {
  it('records the rate quoted to the source, in cents', () => {
    const out = computeSightingFinalize(quotedSteps(8), quotedNodes, opts)
    expect(out.quoted_rate_cents).toBe(800)
  })

  it('records a fractional rate to the nearest cent', () => {
    // The RML flows quote 65% of the buyer's bid, so fractional dollars are the
    // normal case rather than an edge one (3.24 against a 4.99 bid on prod).
    const out = computeSightingFinalize(quotedSteps(3.24), quotedNodes, opts)
    expect(out.quoted_rate_cents).toBe(324)
  })

  it('records nothing when the run was rejected and no offer was quoted', () => {
    // build_response_body returns this shape when the rate is zero or the
    // sell-off partner declined. There are no offers, so there is no quote.
    const steps: Record<string, StepOutput> = {
      build_response_body: {
        status: 'completed',
        output: {
          isRejected: true,
          body: { lead_id: 'lead-1', status: 'rejected', reason: 'unqualified_lead' },
        },
      },
    }
    const out = computeSightingFinalize(steps, [node('n-body', 'build_response_body', 'code')], {
      ...opts,
      lastCompletedNamespace: 'build_response_body',
      successNamespaces: [],
    })
    expect(out.quoted_rate_cents).toBeNull()
  })

  it('takes the producer code node, not a response node re-emitting the body', () => {
    // A response node re-emits what it received, so a shape-only rule would read
    // the same quote twice and let whichever came last decide. The differing
    // rates here exist only to prove which node was read.
    const steps: Record<string, StepOutput> = {
      build_response_body: {
        status: 'completed',
        output: { isRejected: false, body: { offers: [{ rate: 8 }] } },
      },
      offer_response: {
        status: 'completed',
        output: { isRejected: false, body: { offers: [{ rate: 99 }] } },
      },
    }
    const out = computeSightingFinalize(steps, quotedNodes, opts)
    expect(out.quoted_rate_cents).toBe(800)
  })

  it('records a quoted zero as zero rather than as no quote', () => {
    // Quoting nothing and never quoting are different facts, and null is
    // already spoken for by the second one.
    const out = computeSightingFinalize(quotedSteps(0), quotedNodes, opts)
    expect(out.quoted_rate_cents).toBe(0)
  })

  it('records nothing when the rate is not a number', () => {
    const out = computeSightingFinalize(quotedSteps('eight dollars'), quotedNodes, opts)
    expect(out.quoted_rate_cents).toBeNull()
  })

  it('carries the same value onto the durable projection', () => {
    // The live finalize and the strand-recovery projection must agree, which is
    // the whole reason the derivation is one shared function.
    const projection = buildSightingFinalizeProjection(
      quotedSteps(8),
      quotedNodes,
      opts,
      { sightingId: 'sight-1', isTest: false },
    )
    expect(projection?.quoted_rate_cents).toBe(800)
  })

  it('is written by the finalize UPDATE', async () => {
    // finalizeSighting builds its update from an explicit column list, so a new
    // field on the computed type is silently dropped unless it is named there
    // too. That drop would leave every test above green.
    const updates: Record<string, unknown[]> = {}
    const client = {
      from(table: string) {
        const chain: Record<string, unknown> = {
          update(payload: unknown) {
            (updates[table] ??= []).push(payload)
            return chain
          },
          eq() { return chain },
          gte() { return chain },
          select() { return Promise.resolve({ data: [{ id: 'r-1' }], error: null }) },
        }
        return chain
      },
    } as unknown as SupabaseClient

    const input: FinalizeSightingInput = {
      sighting_id: 'sight-1',
      execution_id: 'exec-1',
      execution_started_at_utc: new Date('2026-09-04T09:00:00Z'),
      execution_finished_at_et: new Date('2026-09-04T05:00:01-04:00'),
      execution_ended_at_utc: new Date('2026-09-04T09:00:01Z'),
      duration_ms: 1200,
      quoted_rate_cents: 324,
    }
    await finalizeSighting(client, input)

    expect(updates['lead_sightings']?.[0]).toMatchObject({ quoted_rate_cents: 324 })
  })

  it('is shipped to the warehouse, not only written to Postgres', () => {
    // Recording a value the export does not carry makes it invisible to every
    // warehouse query and deletes it at the retention window, which is the
    // failure this column exists to fix. The two halves are separate lists, so
    // nothing but this relates them.
    expect(sightingExportColumns).toContain('quoted_rate_cents')
  })
})

/**
 * #1157: the same depth assumption loses Lead Economy's quote.
 *
 * Its `return_response` code node returns the quoted body one level down, under
 * `response`, beside the Tripoint result: `response.body.offers[0].rate` rather
 * than `body.offers[0].rate`. Measured on prod 2026-09-04, 187 of 396 runs
 * reaching a Tripoint result quoted a real numeric rate, and over 90 minutes
 * the recorded quotes were Engine 455, LendSwift 159, GigFi 178, Lead Economy 0.
 */
describe('quoted_rate_cents: Lead Economy wraps the body (#1157)', () => {
  const leNodes = [node('n-resp', 'return_response', 'code')]
  const leOpts = { ...opts, lastCompletedNamespace: 'return_response', successNamespaces: ['return_response'] }

  function leSteps(body: Record<string, unknown>, isRejected = false): Record<string, StepOutput> {
    return {
      return_response: {
        status: 'completed',
        output: {
          continueExecution: false,
          isRejected,
          response: { status: 200, body },
          tripointResult: { createLead: {}, qualified: !isRejected, resultCode: isRejected ? 1009 : 1001 },
        },
      },
    }
  }

  it('records a rate quoted inside the response envelope', () => {
    const out = computeSightingFinalize(
      leSteps({ requestId: 'trace-1', offers: [{ name: 'Pennie', rate: 3.24, product_type: 'installment_loan' }] }),
      leNodes,
      leOpts,
    )
    expect(out.quoted_rate_cents).toBe(324)
  })

  it('records nothing for the rejected shape, which carries no offers', () => {
    const out = computeSightingFinalize(
      leSteps({ lead_id: 'lead-1', status: 'rejected', reason: 'unqualified_lead' }, true),
      leNodes,
      leOpts,
    )
    expect(out.quoted_rate_cents).toBeNull()
  })

  it('reads a body present at the outer level rather than the wrapped one', () => {
    // One node satisfying the rule at both depths must yield one quote, and the
    // outer level is the one every other flow uses. The differing rates exist
    // only to prove which was read.
    const steps: Record<string, StepOutput> = {
      return_response: {
        status: 'completed',
        output: {
          body: { offers: [{ rate: 8 }] },
          response: { status: 200, body: { offers: [{ rate: 99 }] } },
        },
      },
    }
    expect(computeSightingFinalize(steps, leNodes, leOpts).quoted_rate_cents).toBe(800)
  })

  it('carries the wrapped quote onto the durable projection', () => {
    const projection = buildSightingFinalizeProjection(
      leSteps({ offers: [{ rate: 1.3 }] }),
      leNodes,
      leOpts,
      { sightingId: 'sight-1', isTest: false },
    )
    expect(projection?.quoted_rate_cents).toBe(130)
  })
})
