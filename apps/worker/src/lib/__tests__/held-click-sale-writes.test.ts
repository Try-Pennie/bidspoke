/**
 * A held click marked sent writes the click's Salesforce updates (#1659).
 *
 * The three bodies are the ones the live click writes on `sent`, built by the
 * one builder, for the records the held run's own record step named, with the
 * lead id the person entered, the time the click was held, and the held run's
 * Bidspoke link. Each write's outcome is reported on its own, so one refusal
 * never hides the other two, and anything that stops the writes before they
 * start (no record ids, no terms) is reported as not attempted rather than
 * as nothing to do.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import { KEPT_LIBERTY1_CLICK_SCRIPTS, LIBERTY1_CLICK_WORKFLOW_ID } from '../engine-script-drift'
import { writeHeldClickSale, type HeldClickSaleDeps } from '../held-click-sale-writes'
import { SalesforceUpdateError } from '../salesforce-write'

const WORKFLOW = LIBERTY1_CLICK_WORKFLOW_ID!
const PROSPECT = 'a06Ui00002qCeSaIAK'
const SUBMISSION = 'a0CUi00000abcdeFAA'
const LEAD = '00QUi00000lead1AAA'
const HELD_AT = '2026-09-30T14:03:02.123+00:00'
const BUYER_LEAD = 'L1F-778'
const env = { APP_URL: 'https://bidspoke.trypennie.dev' } as Env
const supabase = {} as SupabaseClient

const row = { partner_id: 'p-1', prospect_id: PROSPECT, workflow_id: WORKFLOW, execution_id: 'exec-1', held_at: HELD_AT }
const pickStep = (ids: { prospect_id: string | null; submission_id: string | null; lead_id: string | null }, saleKey = PROSPECT) => ({
  step_namespace: 'pick_record',
  output: { verdict: 'open', sale_key: saleKey, ...ids },
})
const allThree = pickStep({ prospect_id: PROSPECT, submission_id: SUBMISSION, lead_id: LEAD })

function deps(over: Partial<HeldClickSaleDeps> = {}) {
  const update = vi.fn(async () => undefined)
  const d: HeldClickSaleDeps = {
    loadPartner: vi.fn(async () => ({ ok: true as const, partner: { name: 'Liberty1', external_routing_code: 4 } })),
    loadSteps: vi.fn(async () => ({ ok: true as const, steps: [{ step_namespace: 'resolve_input', output: {} }, allThree] })),
    readArchive: vi.fn(async () => ({ kind: 'not-found' as const })),
    update,
    ...over,
  }
  return d
}

const run = (d: HeldClickSaleDeps) => writeHeldClickSale(env, supabase, { orgId: 'org-1', userId: 'u-1', row, buyerLeadId: BUYER_LEAD }, d)

describe('writeHeldClickSale', () => {
  it('writes the Completed Prospect, Submission and Lead bodies the live click writes, to the records the held run named', async () => {
    const d = deps()
    const out = await run(d)
    expect(out).toEqual({
      complete: true,
      records_from: 'step_log',
      writes: [
        { record: 'prospect', object: 'Prospect__c', id: PROSPECT, outcome: 'written' },
        { record: 'submission', object: 'Submission__c', id: SUBMISSION, outcome: 'written' },
        { record: 'lead', object: 'Lead', id: LEAD, outcome: 'written' },
      ],
      buyer_lead_id: BUYER_LEAD,
    })
    const calls = vi.mocked(d.update).mock.calls
    expect(calls.map((c) => [c[3], c[4]])).toEqual([['Prospect__c', PROSPECT], ['Submission__c', SUBMISSION], ['Lead', LEAD]])
    const prospect = calls[0][5] as Record<string, unknown>
    expect(prospect).toMatchObject({
      ExternalExchangeStatus__c: 'Completed',
      ExternalPartnerLeadId__c: BUYER_LEAD,
      ExternalPartnerName__c: 'Liberty1',
      ExternalRoutingCode__c: 4,
      // The time the click was held, which is when the buyer received it, not now.
      ExternalTimestamp__c: '2026-09-30T14:03:02.123Z',
      PDFlow_3__c: `https://bidspoke.trypennie.dev/workflows/${WORKFLOW}?execution=exec-1`,
      LeadSaleType__c: 'Form',
    })
    expect(String(prospect.TCPA_Consent__c)).toMatch(/^By clicking "Connect with Liberty1 Financial"/)
    expect(calls[1][5]).toMatchObject({ External_Partner_Lead_Id__c: BUYER_LEAD, External_Routing_Code__c: '4', External_Timestamp__c: '2026-09-30T14:03:02.123Z' })
    expect(calls[2][5]).toMatchObject({ ExternalPartnerLeadId__c: BUYER_LEAD, External_Exchange_Status__c: 'Completed' })
    expect(calls[2][5]).not.toHaveProperty('PDFlow_3__c')
  })

  it('with no lead id (PM-7), marks the sale Completed on every record and writes no lead id field, and says it carried none (#2139)', async () => {
    const d = deps()
    const out = await writeHeldClickSale(env, supabase, { orgId: 'org-1', userId: 'u-1', row, buyerLeadId: null }, d)
    expect(out).toMatchObject({ complete: true, buyer_lead_id: null })
    const calls = vi.mocked(d.update).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[0][5]).toMatchObject({ ExternalExchangeStatus__c: 'Completed', ExternalPartnerName__c: 'Liberty1' })
    expect(calls[1][5]).toMatchObject({ External_Exchange_Status__c: 'Completed' })
    expect(calls[2][5]).toMatchObject({ External_Exchange_Status__c: 'Completed' })
    // Left out, never blanked: a field Salesforce already holds is not overwritten with nothing.
    expect(calls[0][5]).not.toHaveProperty('ExternalPartnerLeadId__c')
    expect(calls[1][5]).not.toHaveProperty('External_Partner_Lead_Id__c')
    expect(calls[2][5]).not.toHaveProperty('ExternalPartnerLeadId__c')
  })

  it('an attempt that writes nothing still says which lead id it was for, so the list can tell it from a written one', async () => {
    const out = await run(deps({ loadSteps: vi.fn(async () => ({ ok: false as const, message: 'timeout' })) }))
    expect(out).toMatchObject({ complete: false, buyer_lead_id: BUYER_LEAD })
  })

  it('one write of three failing is reported on that record alone, and the other two still land', async () => {
    const d = deps({
      update: vi.fn(async (_e: Env, _s: SupabaseClient, _o: string, object: string) => {
        if (object === 'Submission__c') throw new SalesforceUpdateError('Salesforce refused the Submission__c update (400): FIELD_CUSTOM_VALIDATION_EXCEPTION', 400)
      }),
    })
    const out = await run(d)
    expect(out.complete).toBe(false)
    expect(out.writes).toEqual([
      { record: 'prospect', object: 'Prospect__c', id: PROSPECT, outcome: 'written' },
      { record: 'submission', object: 'Submission__c', id: SUBMISSION, outcome: 'failed', message: expect.stringMatching(/FIELD_CUSTOM_VALIDATION_EXCEPTION/) },
      { record: 'lead', object: 'Lead', id: LEAD, outcome: 'written' },
    ])
  })

  it('Salesforce down fails every write by name, and none reads as written', async () => {
    const out = await run(deps({ update: vi.fn(async () => { throw new Error('Salesforce token fetch failed (503): unavailable') }) }))
    expect(out.complete).toBe(false)
    expect(out.writes.map((w) => w.outcome)).toEqual(['failed', 'failed', 'failed'])
    expect(out.writes.every((w) => w.outcome === 'failed' && /503/.test(w.message))).toBe(true)
  })

  it('a record the click did not name is not written, as the live flow skips it, and does not count as a failure', async () => {
    const d = deps({ loadSteps: vi.fn(async () => ({ ok: true as const, steps: [pickStep({ prospect_id: PROSPECT, submission_id: null, lead_id: null })] })) })
    const out = await run(d)
    expect(out.complete).toBe(true)
    expect(out.writes.map((w) => [w.record, w.outcome])).toEqual([['prospect', 'written'], ['submission', 'not_named'], ['lead', 'not_named']])
    expect(d.update).toHaveBeenCalledTimes(1)
  })

  it('past the step log\'s seven days, the record ids come from the execution archive', async () => {
    const d = deps({
      loadSteps: vi.fn(async () => ({ ok: true as const, steps: [] })),
      readArchive: vi.fn(async () => ({ kind: 'found' as const, execution: {}, steps: [allThree], archiveDay: '2026-09-30', archivedIncomplete: false })),
    })
    const out = await run(d)
    expect(out.records_from).toBe('archive')
    expect(out.complete).toBe(true)
    expect(d.readArchive).toHaveBeenCalledWith(env, supabase, { executionId: 'exec-1', orgId: 'org-1', readBy: 'u-1' })
  })

  it('record ids unavailable: an archive that does not answer writes nothing and says so on every record', async () => {
    const d = deps({
      loadSteps: vi.fn(async () => ({ ok: true as const, steps: [] })),
      readArchive: vi.fn(async () => ({ kind: 'unavailable' as const, waitingFor: 'the execution archive', detail: 'the archive did not answer within 20 seconds' })),
    })
    const out = await run(d)
    expect(out.complete).toBe(false)
    expect(out.records_from).toBeNull()
    expect(out.writes).toEqual(['prospect', 'submission', 'lead'].map((record) => expect.objectContaining({ record, id: null, outcome: 'not_attempted', message: expect.stringMatching(/did not answer within 20 seconds/) })))
    expect(d.update).not.toHaveBeenCalled()
  })

  it('record ids unavailable: a run in neither the step log nor the archive, or a step log read that fails, writes nothing', async () => {
    const gone = await run(deps({ loadSteps: vi.fn(async () => ({ ok: true as const, steps: [] })) }))
    expect(gone.writes.every((w) => w.outcome === 'not_attempted' && /neither/.test(w.message))).toBe(true)

    const failed = deps({ loadSteps: vi.fn(async () => ({ ok: false as const, message: 'canceling statement due to statement timeout' })) })
    const out = await run(failed)
    expect(out.writes.every((w) => w.outcome === 'not_attempted' && /statement timeout/.test(w.message))).toBe(true)
    // A failed read is not a missing run, so the archive is not asked in its place.
    expect(failed.readArchive).not.toHaveBeenCalled()
    expect(failed.update).not.toHaveBeenCalled()
  })

  it('a run whose record step names a different prospect is not written from: the ids must be for this claim (L237)', async () => {
    const out = await run(deps({ loadSteps: vi.fn(async () => ({ ok: true as const, steps: [pickStep({ prospect_id: 'a06Ui0000OTHERAAA', submission_id: SUBMISSION, lead_id: LEAD }, 'a06Ui0000OTHERAAA')] })) }))
    expect(out.writes.every((w) => w.outcome === 'not_attempted' && /names no records for/.test(w.message))).toBe(true)
  })

  it('a buyer with no routing code on its partner record writes nothing, rather than a sale with no code', async () => {
    const d = deps({ loadPartner: vi.fn(async () => ({ ok: true as const, partner: { name: 'Liberty1', external_routing_code: null } })) })
    const out = await run(d)
    expect(out.writes.every((w) => w.outcome === 'not_attempted' && /routing code/.test(w.message))).toBe(true)
    expect(d.update).not.toHaveBeenCalled()
  })

  it('a click from a workflow Bidspoke keeps no click script for writes nothing: its consent text is not known', async () => {
    const d = deps()
    const out = await writeHeldClickSale(env, supabase, { orgId: 'org-1', userId: 'u-1', row: { ...row, workflow_id: '00000000-0000-4000-8000-000000000000' }, buyerLeadId: BUYER_LEAD }, d)
    expect(out.writes.every((w) => w.outcome === 'not_attempted' && /consent/.test(w.message))).toBe(true)
    expect(d.update).not.toHaveBeenCalled()
  })

  it('runs twice to the same result: the updates are the same bodies, so a retry is safe', async () => {
    const d = deps()
    await run(d)
    await run(d)
    const calls = vi.mocked(d.update).mock.calls
    expect(calls).toHaveLength(6)
    expect(JSON.stringify(calls.slice(0, 3).map((c) => c.slice(3)))).toBe(JSON.stringify(calls.slice(3).map((c) => c.slice(3))))
  })

  it('the kept Liberty1 click script is the one it reads (guards the fixture above)', () => {
    expect(KEPT_LIBERTY1_CLICK_SCRIPTS.some((s) => s.namespace === 'click_patch')).toBe(true)
  })
})
