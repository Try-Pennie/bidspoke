/**
 * #1518: the walker resolves a Bid Group's `outbound_fields` map at group entry, the
 * same way it resolves `context`, and every partner attempt in the group sees the
 * resolved values on ctx.bidGroupOutboundFields (the API resolver merges them into
 * the request body). After the group settles the values are cleared, so a later
 * step or a second group never inherits them.
 *
 * Why a walk test and not only a resolver test: the resolver merges whatever is on
 * the context, and the context is only set by this walker block. Built is not wired
 * (L3): a green resolver test says nothing about whether the Main Flow's Bid Race
 * would actually carry the debt to Tripoint.
 *
 * The partner executor is mocked and RECORDS the context it was handed at call time,
 * because the walker clears the map afterwards and a reference captured then would
 * read as undefined.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { NodeDefinition, EdgeDefinition, ExecutionContext } from '../../types'
import type { StepLogEntry } from '../step-logger'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/partner-bid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nodes/partner-bid')>()
  return { ...actual, executePartnerBidNode: vi.fn() }
})
vi.mock('../nodes/index', () => ({
  // The one ordinary step in the graph computes the verified debt, as
  // pennie_or_eligibility does in the Main Flow.
  executeNode: vi.fn(async (node: NodeDefinition) =>
    node.namespace === 'pennie_or_eligibility'
      ? { output: { final: 24500, debt_source: 'engine_debt' } }
      : { output: { reached: node.namespace } }),
}))

import { walkGraph } from '../index'
import { buildContext } from '../context'
import { executePartnerBidNode } from '../nodes/partner-bid'

const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const GROUP_ID = '0192a4f0-0000-7000-8000-00000000b1d0'
const TRIPOINT_ID = '1b9cbd8f-1d23-496c-b046-b11d64edae29'
const AMONE_ID = '58d50fe7-3e86-4d71-85c7-4533ab08acb0'

// The slug preload is the only database read the walker makes for a bid group.
const supabase = {
  from: () => ({
    select: () => ({
      in: async () => ({ data: [{ id: TRIPOINT_ID, slug: 'tripoint' }, { id: AMONE_ID, slug: 'amone' }], error: null }),
    }),
  }),
} as unknown as SupabaseClient

const debtStep: NodeDefinition = { id: 'n-debt', namespace: 'pennie_or_eligibility', type: 'code', config: {} }
const afterWin: NodeDefinition = { id: 'n-win', namespace: 'after_winner', type: 'code', config: {} }
const afterLoss: NodeDefinition = { id: 'n-loss', namespace: 'after_no_winner', type: 'code', config: {} }

function definition(groupConfig: Record<string, unknown>) {
  const group: NodeDefinition = { id: GROUP_ID, namespace: 'bid_race', type: 'bid_group', config: { mode: 'highest_bid', partner_ids: [TRIPOINT_ID, AMONE_ID], ...groupConfig } }
  const edges: EdgeDefinition[] = [
    { id: 'e-0', source: debtStep.id, target: GROUP_ID },
    { id: 'e-win', source: GROUP_ID, target: afterWin.id, source_handle: 'winner' },
    { id: 'e-loss', source: GROUP_ID, target: afterLoss.id, source_handle: 'no_winner' },
  ]
  return { nodes: [debtStep, group, afterWin, afterLoss], edges }
}

/** What each partner attempt SAW on the context at the moment it was called. */
let seen: Array<{ partner_id: string; outbound: Record<string, unknown> | undefined; context: Record<string, unknown> | undefined }>

beforeEach(() => {
  seen = []
  vi.mocked(executePartnerBidNode).mockReset()
  vi.mocked(executePartnerBidNode).mockImplementation(async (node: NodeDefinition, ctx: ExecutionContext) => {
    const partner_id = node.config.partner_id as string
    seen.push({ partner_id, outbound: ctx.bidGroupOutboundFields ? { ...ctx.bidGroupOutboundFields } : undefined, context: ctx.bidGroupContext ? { ...ctx.bidGroupContext } : undefined })
    const slug = partner_id === TRIPOINT_ID ? 'tripoint' : 'amone'
    return { output: { partner: slug, bid: slug === 'tripoint' ? 22.05 : 10, accepted: true, skipped: false } }
  })
})

const walk = (def: ReturnType<typeof definition>, queue: StepLogEntry[] = []) =>
  walkGraph(buildContext({ Submission__c: 'S-1', BegDebtRange: '$10,000 - $14,999' }, 'web', 'wf-1', 'trace-1', {}, 'org-1', 'exec-1'), def, 'exec-1', '2027-09-23T15:30:00.000Z', supabase, env, 'money', 'v1', queue)

describe('bid_group outbound_fields in the walker (#1518)', () => {
  it('resolves every outbound field from the step that computed it and hands the map to EVERY partner attempt', async () => {
    const result = await walk(definition({
      context: { finalDebt: '{{steps.pennie_or_eligibility.output.final}}' },
      outbound_fields: {
        unsecuredDebt: '{{steps.pennie_or_eligibility.output.final}}',
        maxUnsecuredDebt: '{{steps.pennie_or_eligibility.output.final}}',
      },
    }))

    expect(result.body).toEqual({ reached: 'after_winner' })
    expect(seen).toHaveLength(2)
    for (const attempt of seen) {
      expect(attempt.outbound).toEqual({ unsecuredDebt: 24500, maxUnsecuredDebt: 24500 })
    }
    // The pricing context is untouched by the new map: two maps, two jobs.
    expect(seen[0].context).toEqual({ finalDebt: 24500 })
  })

  it('clears the map once the group has settled, so nothing after the group inherits it', async () => {
    const ctx = buildContext({}, 'web', 'wf-1', 'trace-1', {}, 'org-1', 'exec-1')
    await walkGraph(ctx, definition({ outbound_fields: { unsecuredDebt: '{{steps.pennie_or_eligibility.output.final}}' } }), 'exec-1', '2027-09-23T15:30:00.000Z', supabase, env, 'money', 'v1', [])
    expect(ctx.bidGroupOutboundFields).toBeUndefined()
  })

  it('records the template and the resolved values on the bid_group step, so the Results panel shows what was added', async () => {
    const queue: StepLogEntry[] = []
    await walk(definition({ outbound_fields: { unsecuredDebt: '{{steps.pennie_or_eligibility.output.final}}' } }), queue)

    const groupRow = queue.find((r) => r.step_type === 'bid_group')!
    const input = groupRow.input as { template: Record<string, unknown>; resolved: Record<string, unknown> }
    expect(input.template.outbound_fields).toEqual({ unsecuredDebt: '{{steps.pennie_or_eligibility.output.final}}' })
    expect(input.resolved.outbound_fields).toEqual({ unsecuredDebt: 24500 })
  })

  it('names a field whose template resolved to nothing, on the step row and in a warning, instead of letting it vanish', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const queue: StepLogEntry[] = []
    await walk(definition({ outbound_fields: { unsecuredDebt: '{{steps.pennie_or_eligibility.output.final}}', maxUnsecuredDebt: '{{steps.never_ran.output.max}}' } }), queue)

    const groupRow = queue.find((r) => r.step_type === 'bid_group')!
    const input = groupRow.input as { resolved: Record<string, unknown> }
    expect(input.resolved.unresolved_outbound_fields).toEqual(['maxUnsecuredDebt'])
    // The partner still gets the key, as null, never a dropped key.
    expect(seen[0].outbound).toEqual({ unsecuredDebt: 24500, maxUnsecuredDebt: null })
    const events = warn.mock.calls.map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown> } catch { return null } })
    expect(events.some((e) => e?.event === 'bid_group_outbound_field_unresolved' && (e.fields as string[]).includes('maxUnsecuredDebt'))).toBe(true)
    warn.mockRestore()
  })

  it('a group with no outbound_fields sets nothing, so every existing bid group behaves exactly as before', async () => {
    const queue: StepLogEntry[] = []
    await walk(definition({ context: { finalDebt: '{{steps.pennie_or_eligibility.output.final}}' } }), queue)
    expect(seen.every((a) => a.outbound === undefined)).toBe(true)
    const groupRow = queue.find((r) => r.step_type === 'bid_group')!
    const input = groupRow.input as { template: Record<string, unknown>; resolved: Record<string, unknown> }
    expect(input.template.outbound_fields).toBeUndefined()
    expect(input.resolved.outbound_fields).toBeUndefined()
    expect(input.resolved.unresolved_outbound_fields).toBeUndefined()
  })
})
