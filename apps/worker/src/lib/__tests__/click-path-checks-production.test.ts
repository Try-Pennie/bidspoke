/**
 * The click path checks' production reads (#1546): which workflows make a
 * subject, that the step reads are scoped to the buyer's own workflows and
 * nodes and bounded on started_at (the partition key), and that the Salesforce
 * read is one bounded query that refuses a day past its bound rather than
 * reconciling part of it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'

vi.mock('../salesforce-creds', () => ({
  resolveSalesforceCredsFor: vi.fn(async () => ({ creds: { instanceUrl: 'https://sf.test', clientId: 'id', clientSecret: 'secret' }, missing: [] })),
}))
vi.mock('../../engine/nodes/salesforce', () => ({ getSalesforceToken: vi.fn(async () => 'token') }))

import { RECONCILE_MAX_RECORDS, productionClickPathDeps, subjectsFromWorkflows, type ClickSubject } from '../click-path-checks'

const PARTNER = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'
const ORG = '22222222-2222-4222-8222-222222222222'

afterEach(() => { vi.unstubAllGlobals() })

describe('subjectsFromWorkflows', () => {
  it('groups every live check and send node naming a buyer by organization and buyer, and ignores switched off workflows and unpicked nodes', () => {
    const subjects = subjectsFromWorkflows([
      { id: 'wf-engine', organization_id: ORG, is_active: true, definition: { nodes: [{ type: 'buyer_click_check', namespace: 'buyer_click_check', config: { partner_id: PARTNER } }, { type: 'code', namespace: 'x', config: null }] } },
      { id: 'wf-click', organization_id: ORG, is_active: true, definition: { nodes: [{ type: 'buyer_click_send', namespace: 'click_send', config: { partner_id: ` ${PARTNER} ` } }] } },
      { id: 'wf-off', organization_id: ORG, is_active: false, definition: { nodes: [{ type: 'buyer_click_send', namespace: 'old_send', config: { partner_id: PARTNER } }] } },
      { id: 'wf-draft', organization_id: ORG, is_active: true, definition: { nodes: [{ type: 'buyer_click_check', namespace: 'draft', config: { partner_id: '' } }] } },
    ])
    expect(subjects).toEqual([{
      organization_id: ORG, partner_id: PARTNER,
      check: { workflow_ids: ['wf-engine'], namespaces: ['buyer_click_check'] },
      send: { workflow_ids: ['wf-click'], namespaces: ['click_send'] },
    }])
  })
})

/** A query builder that records every filter, answering one empty page. */
function recordingSupabase() {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = []
  const supabase = {
    from(table: string) {
      const call = { table, ops: [] as Array<[string, unknown[]]> }
      calls.push(call)
      const builder: Record<string, unknown> = {}
      for (const op of ['select', 'in', 'eq', 'gte', 'lt', 'order', 'range', 'is', 'limit']) {
        builder[op] = (...args: unknown[]) => { call.ops.push([op, args]); return builder }
      }
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 })
      return builder
    },
  } as unknown as SupabaseClient
  return { supabase, calls }
}

const env = { IDEMPOTENCY: {}, WORKFLOW_CACHE: {}, DAILY_CAP: {}, APP_URL: 'https://app.test' } as unknown as Env
const SUBJECT: ClickSubject = { organization_id: ORG, partner_id: PARTNER, check: { workflow_ids: ['wf-engine'], namespaces: ['buyer_click_check'] }, send: { workflow_ids: ['wf-click'], namespaces: ['click_send'] } }

describe('the step reads', () => {
  it('read only this buyer\'s check nodes in its own workflows, non test, bounded on started_at', async () => {
    const { supabase, calls } = recordingSupabase()
    await productionClickPathDeps(supabase, env).readCheckRuns(SUBJECT, Date.UTC(2027, 8, 21, 18), Date.UTC(2027, 8, 21, 21))
    const ops = calls[0].ops
    expect(calls[0].table).toBe('execution_steps')
    expect(ops).toContainEqual(['in', ['workflow_id', ['wf-engine']]])
    expect(ops).toContainEqual(['in', ['step_namespace', ['buyer_click_check']]])
    expect(ops).toContainEqual(['eq', ['step_type', 'buyer_click_check']])
    expect(ops).toContainEqual(['eq', ['is_test', false]])
    expect(ops).toContainEqual(['eq', ['output->>partner_id', PARTNER]])
    expect(ops).toContainEqual(['gte', ['started_at', '2027-09-21T18:00:00.000Z']])
    expect(ops).toContainEqual(['lt', ['started_at', '2027-09-21T21:00:00.000Z']])
    expect(ops.some(([op]) => op === 'range')).toBe(true)
  })

  it('the offers read is bounded on the bid table\'s partition key', async () => {
    const { supabase, calls } = recordingSupabase()
    await productionClickPathDeps(supabase, env).readOfferExecutionIds('liberty1', Date.UTC(2027, 8, 21, 18), Date.UTC(2027, 8, 21, 21))
    expect(calls[0].table).toBe('lead_sighting_bids')
    expect(calls[0].ops).toContainEqual(['eq', ['resolver_type', 'click']])
    expect(calls[0].ops).toContainEqual(['gte', ['attempted_at_utc', '2027-09-21T18:00:00.000Z']])
  })
})

describe('the Salesforce read', () => {
  const record = (i: number) => ({ Id: `a0X${String(i).padStart(12, '0')}`, ExternalTimestamp__c: '2027-09-20T18:00:00.000+0000' })

  it('asks for Completed prospects with the routing code inside the bounds, and follows the next page', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      const body = urls.length === 1 ? { records: [record(1)], done: false, nextRecordsUrl: '/services/data/v60.0/query/next' } : { records: [record(2)], done: true }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    const { supabase } = recordingSupabase()
    const out = await productionClickPathDeps(supabase, env).readCompletedProspects(ORG, 4, Date.UTC(2027, 8, 20, 6, 45), Date.UTC(2027, 8, 21, 7, 15))
    expect(out.map((p) => p.id)).toEqual([record(1).Id, record(2).Id])
    const soql = decodeURIComponent(urls[0].split('q=')[1])
    expect(soql).toContain('ExternalRoutingCode__c = 4')
    expect(soql).toContain("ExternalExchangeStatus__c = 'Completed'")
    expect(soql).toContain('ExternalTimestamp__c >= 2027-09-20T06:45:00Z')
    expect(soql).toContain('ExternalTimestamp__c < 2027-09-21T07:15:00Z')
    expect(soql).toContain(`LIMIT ${RECONCILE_MAX_RECORDS + 1}`)
    expect(urls[1]).toBe('https://sf.test/services/data/v60.0/query/next')
  })

  it('asks for Completed Liberty1 submissions with NO Prospect, by the submission fields (routing code as text), inside the bounds', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ records: [{ Id: 'a04000000000001', External_Timestamp__c: '2027-09-20T18:00:00.000+0000' }], done: true }), { status: 200 })
    }))
    const { supabase } = recordingSupabase()
    const out = await productionClickPathDeps(supabase, env).readCompletedSubmissionsWithoutProspect(ORG, 4, Date.UTC(2027, 8, 20, 6, 45), Date.UTC(2027, 8, 21, 7, 15))
    expect(out).toEqual([{ id: 'a04000000000001', at: '2027-09-20T18:00:00.000+0000' }])
    const soql = decodeURIComponent(urls[0].split('q=')[1])
    expect(soql).toMatch(/^SELECT Id, External_Timestamp__c FROM Submission__c WHERE /)
    expect(soql).toContain("External_Routing_Code__c = '4'")
    expect(soql).toContain("External_Exchange_Status__c = 'Completed'")
    expect(soql).toContain('Prospect__c = null')
    // SystemModstamp is indexed and a click's write always moves it, so it bounds the
    // scan without losing a record: unfiltered, this read took 80s against the org
    // on 2026-09-29, with it 11s, and Salesforce stops a query at 120s.
    expect(soql).toContain('SystemModstamp >= 2027-09-20T06:45:00Z')
    expect(soql).toContain('External_Timestamp__c >= 2027-09-20T06:45:00Z')
    expect(soql).toContain('External_Timestamp__c < 2027-09-21T07:15:00Z')
    expect(soql).toContain(`LIMIT ${RECONCILE_MAX_RECORDS + 1}`)
  })

  it('a submission row without its stamp is refused by name rather than dropped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ records: [{ Id: 'a04000000000001', External_Timestamp__c: null }], done: true }), { status: 200 })))
    const { supabase } = recordingSupabase()
    await expect(productionClickPathDeps(supabase, env).readCompletedSubmissionsWithoutProspect(ORG, 4, 0, 1)).rejects.toThrow(/unreadable submission/)
  })

  it('refuses a day past its bound rather than reconciling part of it, and a failed query throws with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ records: Array.from({ length: RECONCILE_MAX_RECORDS + 1 }, (_, i) => record(i)), done: true }), { status: 200 })))
    const { supabase } = recordingSupabase()
    const deps = productionClickPathDeps(supabase, env)
    await expect(deps.readCompletedProspects(ORG, 4, 0, 1)).rejects.toThrow(/more than 2000/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[{"errorCode":"REQUEST_LIMIT_EXCEEDED"}]', { status: 403 })))
    await expect(deps.readCompletedProspects(ORG, 4, 0, 1)).rejects.toThrow(/Salesforce query failed \(403\)/)
  })
})
