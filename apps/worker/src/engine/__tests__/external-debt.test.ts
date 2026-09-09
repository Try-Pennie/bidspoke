/**
 * #1169: populate lead_sightings.external_debt.
 *
 * The column was null on every row: measured 2026-09-04 over 24 hours, 110,900
 * sightings, 0 with external_debt, while loan_amount, annual_income and fico_tier
 * were populated on all 110,900. It was read from the TRIGGER PAYLOAD at
 * `financialInformation.externalDebtAmount`, a path no live source sends.
 *
 * The debt is not a payload field, it is COMPUTED by a step, and the number that
 * matters is the one the pricing actually consulted (L620). A bid_group node
 * carries it in its `context` map, which is resolved once at group entry and is
 * what a partner formula reads as `context.finalDebt`. Verified against the real
 * Main Flow definition (apps/web/src/lib/__tests__/fixtures/main-flow.json): its
 * `bid_race` group declares
 *
 *     context: { finalDebt: "{{steps.pennie_or_eligibility.output.final}}" }
 *
 * so the template, not a guessed payload key, is the source. Resolving that same
 * template with the same resolveValue the engine uses keeps ONE definition of
 * where the debt comes from rather than a second one that can drift (L70).
 */
import { describe, it, expect } from 'vitest'
import { extractExternalDebt } from '../lead-sightings'
import type { ExecutionContext, NodeDefinition, StepOutput } from '../../types'

function ctxWith(steps: Record<string, StepOutput>, payload: Record<string, unknown> = {}): ExecutionContext {
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf', org_id: 'org', trace_id: 't' },
    steps,
    env: {},
  } as unknown as ExecutionContext
}

/** The real Main Flow shape: a bid_group naming a step that computed the debt. */
function mainFlowNodes(template = '{{steps.pennie_or_eligibility.output.final}}'): NodeDefinition[] {
  return [
    { id: 'n1', namespace: 'pennie_or_eligibility', type: 'code', config: {} },
    { id: 'n2', namespace: 'bid_race', type: 'bid_group', config: { context: { finalDebt: template } } },
  ] as NodeDefinition[]
}

const debtStep = (final: unknown): Record<string, StepOutput> => ({
  pennie_or_eligibility: { status: 'completed', output: { final } } as StepOutput,
})

describe('extractExternalDebt: the real Main Flow shape (#1169)', () => {
  it('resolves the bid group context template that the pricing itself reads', () => {
    expect(extractExternalDebt(ctxWith(debtStep(24500)), mainFlowNodes())).toBe(24500)
  })

  it('coerces a numeric string, which is how a code node often returns it', () => {
    expect(extractExternalDebt(ctxWith(debtStep('18250')), mainFlowNodes())).toBe(18250)
  })

  it('rounds to a whole number, because the column is an INTEGER', () => {
    expect(extractExternalDebt(ctxWith(debtStep(12499.62)), mainFlowNodes())).toBe(12500)
  })

  it('records a zero debt as 0, not as absent', () => {
    // 0 is a real answer and must not be swallowed by a falsy check: a lead with
    // no debt is exactly the lead Tripoint should not be bid on (#1199).
    expect(extractExternalDebt(ctxWith(debtStep(0)), mainFlowNodes())).toBe(0)
  })
})

describe('extractExternalDebt: nothing to read', () => {
  it('returns null when the workflow has no bid group', () => {
    const nodes = [{ id: 'n1', namespace: 'respond', type: 'response', config: {} }] as NodeDefinition[]
    expect(extractExternalDebt(ctxWith(debtStep(24500)), nodes)).toBeNull()
  })

  it('returns null when the bid group declares no context map', () => {
    const nodes = [{ id: 'n2', namespace: 'bid_race', type: 'bid_group', config: {} }] as NodeDefinition[]
    expect(extractExternalDebt(ctxWith(debtStep(24500)), nodes)).toBeNull()
  })

  it('returns null when the context map names no debt key', () => {
    const nodes = [
      { id: 'n2', namespace: 'bid_race', type: 'bid_group', config: { context: { fico: '{{steps.a.output.score}}' } } },
    ] as NodeDefinition[]
    expect(extractExternalDebt(ctxWith(debtStep(24500)), nodes)).toBeNull()
  })

  it('returns null when the template points at a step that did not run', () => {
    expect(extractExternalDebt(ctxWith({}), mainFlowNodes())).toBeNull()
  })

  it('returns null when the resolved value is not a number', () => {
    expect(extractExternalDebt(ctxWith(debtStep('not a number')), mainFlowNodes())).toBeNull()
  })
})

describe('extractExternalDebt: more than one bid group', () => {
  it('takes the first group that resolves a debt', () => {
    const nodes = [
      { id: 'n1', namespace: 'early', type: 'bid_group', config: { context: { finalDebt: '{{steps.missing.output.final}}' } } },
      { id: 'n2', namespace: 'bid_race', type: 'bid_group', config: { context: { finalDebt: '{{steps.pennie_or_eligibility.output.final}}' } } },
    ] as NodeDefinition[]
    expect(extractExternalDebt(ctxWith(debtStep(31000)), nodes)).toBe(31000)
  })
})

describe('extractExternalDebt: a template pointing at the trigger', () => {
  it('resolves against the trigger payload too, not only steps', () => {
    // The context map is free-form, so a workflow may name a payload field. This
    // is why the real execution context is passed rather than steps alone.
    const nodes = mainFlowNodes('{{trigger.payload.debt_amount}}')
    expect(extractExternalDebt(ctxWith({}, { debt_amount: 9000 }), nodes)).toBe(9000)
  })
})

/**
 * Reaching the column, and not destroying what is already in it.
 *
 * The finalize UPDATE lists its columns explicitly, so a field added only to the
 * computed type is dropped on the way to the database while every derivation
 * test stays green (L510). And the debt may already have been written at insert
 * time from the payload, so finalize must not blank it: the key is omitted, not
 * set to null, when nothing resolved.
 */
import { finalizeSighting, type FinalizeSightingInput } from '../lead-sightings'
import { sightingExportColumns } from '../../lib/sightings-export'
import type { SupabaseClient } from '@supabase/supabase-js'

function recordingClient(updates: Record<string, unknown[]>): SupabaseClient {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {
        update(payload: unknown) { (updates[table] ??= []).push(payload); return chain },
        eq() { return chain },
        gte() { return chain },
        select() { return Promise.resolve({ data: [{ id: 'r-1' }], error: null }) },
      }
      return chain
    },
  } as unknown as SupabaseClient
}

const baseInput: FinalizeSightingInput = {
  sighting_id: 'sight-1',
  execution_id: 'exec-1',
  execution_started_at_utc: new Date('2026-09-04T09:00:00Z'),
  execution_finished_at_et: new Date('2026-09-04T05:00:01-04:00'),
  execution_ended_at_utc: new Date('2026-09-04T09:00:01Z'),
  duration_ms: 1200,
}

describe('external_debt reaches the database (#1169)', () => {
  it('writes the debt when the run resolved one', async () => {
    const updates: Record<string, unknown[]> = {}
    await finalizeSighting(recordingClient(updates), { ...baseInput, external_debt: 24500 })
    expect(updates.lead_sightings[0]).toMatchObject({ external_debt: 24500 })
  })

  it('writes a zero debt rather than treating it as nothing', async () => {
    const updates: Record<string, unknown[]> = {}
    await finalizeSighting(recordingClient(updates), { ...baseInput, external_debt: 0 })
    expect(updates.lead_sightings[0]).toMatchObject({ external_debt: 0 })
  })

  it('omits the column entirely when nothing resolved, so an insert-time value survives', async () => {
    const updates: Record<string, unknown[]> = {}
    await finalizeSighting(recordingClient(updates), baseInput)
    expect(updates.lead_sightings[0]).not.toHaveProperty('external_debt')
  })

  it('is shipped to the warehouse, not only written to Postgres', () => {
    expect(sightingExportColumns).toContain('external_debt')
  })
})
