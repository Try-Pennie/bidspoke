/**
 * Filling Tripoint's estimated revenue from Salesforce (#354).
 *
 * Tripoint's response carries no amount, so `bid_cents` is null on every one of
 * its rows outside Main Flow: 2,660 wins a week with no price. Salesforce holds
 * a figure, `Prospect__c.ExternalExchangeRevenue__c`, populated on all 12,052
 * Tripoint prospects created in the three days to 2026-09-04, averaging $35.84.
 *
 * It goes in its OWN column, not in bid_cents. That column means what a buyer
 * OFFERED us on every row it holds, and this is a Salesforce FORMULA field
 * (IsCalculated true), which is our own derivation. Mixing them would make every
 * later sum part measurement and part estimate with nothing announcing it, which
 * is the same reasoning that kept the quoted rate out of that column (#1158).
 */
import { describe, it, expect } from 'vitest'
import { revenueUpdates, type FillCandidate } from '../tripoint-revenue-fill'

const at = '2026-09-04T19:00:00.000Z'
const cand = (bid_id: string, prospect_id: string): FillCandidate => ({ bid_id, prospect_id, attempted_at_utc: at })

describe('revenueUpdates', () => {
  it('converts a dollar figure to cents against the right bid row', () => {
    const out = revenueUpdates([cand('b1', 'p1')], new Map([['p1', 42.27]]))
    expect(out.updates).toEqual([
      { bid_id: 'b1', attempted_at_utc: at, estimated_revenue_cents: 4227 },
    ])
    expect(out.unmatched).toEqual([])
    expect(out.unusable).toEqual([])
  })

  it('rounds a fractional cent rather than truncating it', () => {
    const out = revenueUpdates([cand('b1', 'p1')], new Map([['p1', 35.845]]))
    expect(out.updates[0].estimated_revenue_cents).toBe(3585)
  })

  it('records a real zero as zero', () => {
    // Salesforce returns 0 for leads it prices at nothing (the measured minimum
    // on 2026-09-04 was exactly 0). Quoting nothing and never quoting are
    // different facts, and null already means the second.
    const out = revenueUpdates([cand('b1', 'p1')], new Map([['p1', 0]]))
    expect(out.updates).toEqual([{ bid_id: 'b1', attempted_at_utc: at, estimated_revenue_cents: 0 }])
  })

  it('reports a prospect Salesforce returned no row for, rather than skipping it', () => {
    // An absent row means the prospect was deleted, merged, or never created.
    // Left silent it is indistinguishable from a lead with no revenue.
    const out = revenueUpdates([cand('b1', 'p1'), cand('b2', 'p2')], new Map([['p1', 10]]))
    expect(out.updates.map((u) => u.bid_id)).toEqual(['b1'])
    expect(out.unmatched).toEqual(['p2'])
  })

  it('writes nothing for a prospect whose figure is null', () => {
    // Present in the answer but carrying no value: nothing to record, and it is
    // not an error either, so it is counted separately from both.
    const out = revenueUpdates([cand('b1', 'p1')], new Map([['p1', null]]))
    expect(out.updates).toEqual([])
    expect(out.no_value).toEqual(['p1'])
    expect(out.unmatched).toEqual([])
  })

  it('refuses a negative figure as unusable', () => {
    const out = revenueUpdates([cand('b1', 'p1')], new Map([['p1', -5]]))
    expect(out.updates).toEqual([])
    expect(out.unusable).toEqual(['p1'])
  })

  it('refuses a value that is not a finite number', () => {
    const out = revenueUpdates([cand('b1', 'p1')], new Map([['p1', Number.NaN]]))
    expect(out.updates).toEqual([])
    expect(out.unusable).toEqual(['p1'])
  })

  it('fills every bid row that shares one prospect', () => {
    // One prospect can carry more than one Tripoint attempt (a retry, a resume),
    // and each row needs its own value.
    const out = revenueUpdates([cand('b1', 'p1'), cand('b2', 'p1')], new Map([['p1', 12.5]]))
    expect(out.updates).toEqual([
      { bid_id: 'b1', attempted_at_utc: at, estimated_revenue_cents: 1250 },
      { bid_id: 'b2', attempted_at_utc: at, estimated_revenue_cents: 1250 },
    ])
  })

  it('carries the partition key belonging to each row, not a shared one', () => {
    // The UPDATE must name attempted_at_utc or it scans every monthly partition,
    // so the value travels with the row rather than being recomputed later.
    const out = revenueUpdates(
      [{ bid_id: 'b1', prospect_id: 'p1', attempted_at_utc: at },
       { bid_id: 'b2', prospect_id: 'p1', attempted_at_utc: '2026-10-01T00:00:00.000Z' }],
      new Map([['p1', 1]]),
    )
    expect(out.updates.map((u) => u.attempted_at_utc)).toEqual([at, '2026-10-01T00:00:00.000Z'])
  })

  it('returns nothing at all for no candidates', () => {
    const out = revenueUpdates([], new Map())
    expect(out).toEqual({ updates: [], unmatched: [], unusable: [], no_value: [] })
  })
})

// ── The scheduled job ────────────────────────────────────────────────────────
//
// The pure function above says nothing about whether a value ever lands. These
// cover the parts that decide that: what the job selects, that the UPDATE names
// the partition key, that a write matching nothing is not counted as filled, and
// what happens when either side fails. Salesforce is injected, so no test here
// can reach a partner (LESSONS L2).

import { vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runTripointRevenueFill, resolveTripointOrg, revenueSoql, indexRevenueRecords, chunk, LOOKBACK_MINUTES } from '../tripoint-revenue-fill'

interface DbResponses {
  bids?: { data?: unknown[] | null; error?: { message: string } | null }
  sightings?: { data?: unknown[] | null; error?: { message: string } | null }
  update?: (bidId: string) => { data: unknown[] | null; error: { message: string } | null }
  residual?: { count?: number; error?: { message: string } | null }
}

/**
 * PostgREST double. Every builder method returns the builder and awaiting it
 * resolves by table plus what was called on it, so the filters the job applies
 * are recorded and can be asserted.
 */
function makeDb(responses: DbResponses) {
  const calls: Array<{ table: string; filters: Record<string, unknown>; update?: unknown; head?: boolean }> = []

  const client = {
    from(table: string) {
      const call: { table: string; filters: Record<string, unknown>; update?: unknown; head?: boolean } = {
        table, filters: {},
      }
      calls.push(call)
      const builder: Record<string, unknown> = {
        select(_cols: string, opts?: { head?: boolean }) { if (opts?.head) call.head = true; return builder },
        update(payload: unknown) { call.update = payload; return builder },
        eq(col: string, val: unknown) { call.filters[`eq.${col}`] = val; return builder },
        is(col: string, val: unknown) { call.filters[`is.${col}`] = val; return builder },
        not(col: string, op: string, val: unknown) { call.filters[`not.${col}.${op}`] = val; return builder },
        gte(col: string, val: unknown) { call.filters[`gte.${col}`] = val; return builder },
        in(col: string, vals: unknown[]) { call.filters[`in.${col}`] = vals; return builder },
        limit(n: number) { call.filters.limit = n; return builder },
        then(resolve: (v: unknown) => unknown) {
          let out: unknown
          if (call.update) {
            const id = call.filters['eq.id'] as string
            out = responses.update ? responses.update(id) : { data: [{ id }], error: null }
          } else if (call.head) {
            out = { count: responses.residual?.count ?? 0, error: responses.residual?.error ?? null, data: null }
          } else if (table === 'lead_sighting_bids') {
            out = { data: responses.bids?.data ?? [], error: responses.bids?.error ?? null }
          } else {
            out = { data: responses.sightings?.data ?? [], error: responses.sightings?.error ?? null }
          }
          return Promise.resolve(out).then(resolve)
        },
      }
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

const NOW = new Date('2026-09-04T20:00:00.000Z')
const BID_AT = '2026-09-04T19:50:00.000Z'
const bidRow = (id: string, sighting_id: string) => ({ id, sighting_id, attempted_at_utc: BID_AT })

describe('runTripointRevenueFill', () => {
  it('fills the estimate and reports what it did', async () => {
    const db = makeDb({
      bids: { data: [bidRow('b1', 's1')] },
      sightings: { data: [{ id: 's1', prospect_id: 'a0Ab000000000001' }] },
    })
    const fetchRevenue = vi.fn(async () => [{ Id: 'a0Ab000000000001', ExternalExchangeRevenue__c: 42.27 }])
    const out = await runTripointRevenueFill({ supabase: db.client, fetchRevenue, now: () => NOW })

    expect(out).toMatchObject({ scanned: 1, filled: 1, unmatched: 0, unusable: 0, no_value: 0, errors: [] })
    const update = db.calls.find((c) => c.update)
    expect(update?.update).toEqual({ estimated_revenue_cents: 4227 })
  })

  it('names the partition key on the UPDATE, not just the row id', async () => {
    // Without the partition key the statement scans every monthly partition of
    // a table the bidding engine is writing to.
    const db = makeDb({
      bids: { data: [bidRow('b1', 's1')] },
      sightings: { data: [{ id: 's1', prospect_id: 'a0Ab000000000001' }] },
    })
    await runTripointRevenueFill({
      supabase: db.client,
      fetchRevenue: async () => [{ Id: 'a0Ab000000000001', ExternalExchangeRevenue__c: 1 }],
      now: () => NOW,
    })
    const update = db.calls.find((c) => c.update)
    expect(update?.filters['eq.attempted_at_utc']).toBe(BID_AT)
    expect(update?.filters['eq.id']).toBe('b1')
  })

  it('asks only for unpriced, unexported Tripoint winners inside the window', async () => {
    const db = makeDb({ bids: { data: [] } })
    await runTripointRevenueFill({ supabase: db.client, fetchRevenue: async () => [], now: () => NOW })
    const read = db.calls[0]
    expect(read.filters).toMatchObject({
      'eq.partner_slug': 'tripoint',
      'eq.is_winner': true,
      'is.estimated_revenue_cents': null,
      'is.exported_at': null,
    })
    const ageMinutes = (NOW.getTime() - Date.parse(read.filters['gte.attempted_at_utc'] as string)) / 60000
    expect(ageMinutes).toBe(LOOKBACK_MINUTES)
  })

  it('bounds the sighting lookup by its own partition key', async () => {
    // An id-only filter on a partitioned table fans out across every partition.
    const db = makeDb({
      bids: { data: [bidRow('b1', 's1')] },
      sightings: { data: [{ id: 's1', prospect_id: 'a0Ab000000000001' }] },
    })
    await runTripointRevenueFill({
      supabase: db.client,
      fetchRevenue: async () => [{ Id: 'a0Ab000000000001', ExternalExchangeRevenue__c: 1 }],
      now: () => NOW,
    })
    const sightingRead = db.calls.find((c) => c.table === 'lead_sightings')
    expect(sightingRead?.filters['gte.execution_started_at_utc']).toBeTruthy()
  })

  it('reports the rows that reached the warehouse with no estimate', async () => {
    // The job's own residual: rows bid just before an export are gone before any
    // run can reach them, and a stopped schedule shows up as this number rising.
    const db = makeDb({ bids: { data: [] }, residual: { count: 7 } })
    const out = await runTripointRevenueFill({ supabase: db.client, fetchRevenue: async () => [], now: () => NOW })
    expect(out.exported_unpriced).toBe(7)
  })

  it('counts a sighting with no prospect id rather than looking it up', async () => {
    const db = makeDb({
      bids: { data: [bidRow('b1', 's1'), bidRow('b2', 's2')] },
      sightings: { data: [{ id: 's1', prospect_id: 'a0Ab000000000001' }, { id: 's2', prospect_id: null }] },
    })
    const fetchRevenue = vi.fn(async (_ids: string[]) => [
      { Id: 'a0Ab000000000001', ExternalExchangeRevenue__c: 5 },
    ])
    const out = await runTripointRevenueFill({ supabase: db.client, fetchRevenue, now: () => NOW })
    expect(out.filled).toBe(1)
    expect(out.errors.some((e) => e.startsWith('no_prospect_id'))).toBe(true)
    // Only the prospect we actually hold is asked about.
    expect(fetchRevenue.mock.calls[0][0]).toEqual(['a0Ab000000000001'])
  })

  describe('failure paths', () => {
    it('writes nothing and says so when the bid read fails', async () => {
      const db = makeDb({ bids: { data: null, error: { message: 'statement timeout' } } })
      const fetchRevenue = vi.fn()
      const out = await runTripointRevenueFill({ supabase: db.client, fetchRevenue, now: () => NOW })
      expect(out.filled).toBe(0)
      expect(out.errors[0]).toContain('bids_query_failed')
      expect(fetchRevenue).not.toHaveBeenCalled()
    })

    it('writes nothing and says so when the sighting read fails', async () => {
      const db = makeDb({
        bids: { data: [bidRow('b1', 's1')] },
        sightings: { data: null, error: { message: 'connection reset' } },
      })
      const out = await runTripointRevenueFill({ supabase: db.client, fetchRevenue: async () => [], now: () => NOW })
      expect(out.filled).toBe(0)
      expect(out.errors[0]).toContain('sightings_query_failed')
    })

    it('does not report a failed Salesforce chunk as prospects Salesforce does not have', async () => {
      // Those are different facts: one is our request failing, the other is a
      // prospect that is gone. Folding them would send someone hunting records
      // that are fine.
      const db = makeDb({
        bids: { data: [bidRow('b1', 's1')] },
        sightings: { data: [{ id: 's1', prospect_id: 'a0Ab000000000001' }] },
      })
      const out = await runTripointRevenueFill({
        supabase: db.client,
        fetchRevenue: async () => { throw new Error('SF 503') },
        now: () => NOW,
      })
      expect(out.filled).toBe(0)
      expect(out.unmatched).toBe(0)
      expect(out.errors.some((e) => e.includes('salesforce_query_failed'))).toBe(true)
    })

    it('does not count a write that matched nothing as filled', async () => {
      // PostgREST answers an UPDATE that matched no row with error:null, so a
      // caller reading only the error counts a write that never happened (#487).
      const db = makeDb({
        bids: { data: [bidRow('b1', 's1')] },
        sightings: { data: [{ id: 's1', prospect_id: 'a0Ab000000000001' }] },
        update: () => ({ data: [], error: null }),
      })
      const out = await runTripointRevenueFill({
        supabase: db.client,
        fetchRevenue: async () => [{ Id: 'a0Ab000000000001', ExternalExchangeRevenue__c: 9 }],
        now: () => NOW,
      })
      expect(out.filled).toBe(0)
      expect(out.errors.some((e) => e.startsWith('update_failed'))).toBe(true)
    })

    it('keeps filling the other rows when one write fails', async () => {
      const db = makeDb({
        bids: { data: [bidRow('b1', 's1'), bidRow('b2', 's2')] },
        sightings: { data: [{ id: 's1', prospect_id: 'a0Ab000000000001' }, { id: 's2', prospect_id: 'a0Ab000000000002' }] },
        update: (id) => (id === 'b1' ? { data: null, error: { message: 'deadlock' } } : { data: [{ id }], error: null }),
      })
      const out = await runTripointRevenueFill({
        supabase: db.client,
        fetchRevenue: async () => [
          { Id: 'a0Ab000000000001', ExternalExchangeRevenue__c: 1 },
          { Id: 'a0Ab000000000002', ExternalExchangeRevenue__c: 2 },
        ],
        now: () => NOW,
      })
      expect(out.filled).toBe(1)
      expect(out.errors.some((e) => e.startsWith('update_failed b1'))).toBe(true)
    })

    it('reports a residual count that could not be read rather than calling it zero', async () => {
      const db = makeDb({ bids: { data: [] }, residual: { error: { message: 'timeout' } } })
      const out = await runTripointRevenueFill({ supabase: db.client, fetchRevenue: async () => [], now: () => NOW })
      expect(out.errors.some((e) => e.includes('residual_count_failed'))).toBe(true)
    })
  })
})

describe('revenueSoql', () => {
  it('asks for the estimate keyed by prospect id', () => {
    const q = revenueSoql(['a0Ab000000000001', 'a0Ab000000000002'])
    expect(q).toContain('SELECT Id, ExternalExchangeRevenue__c FROM Prospect__c')
    expect(q).toContain("Id IN ('a0Ab000000000001','a0Ab000000000002')")
  })

  it('drops anything that is not a Salesforce id instead of quoting it into the query', () => {
    // The ids come from our own database, but a value that is not an id can only
    // ever be junk in the query, and building SOQL by concatenation is not the
    // place to find that out.
    const q = revenueSoql(["a0Ab000000000001", "x' OR Name != null --"])
    expect(q).toContain("Id IN ('a0Ab000000000001')")
    expect(q).not.toContain('OR Name')
  })
})

describe('indexRevenueRecords', () => {
  it('reads a numeric figure', () => {
    expect(indexRevenueRecords([{ Id: 'p1', ExternalExchangeRevenue__c: 35.84 }]).get('p1')).toBe(35.84)
  })

  it('keeps a present-but-null figure as null, distinct from an absent record', () => {
    const m = indexRevenueRecords([{ Id: 'p1', ExternalExchangeRevenue__c: null }])
    expect(m.has('p1')).toBe(true)
    expect(m.get('p1')).toBeNull()
  })

  it('parses a currency returned as a string', () => {
    expect(indexRevenueRecords([{ Id: 'p1', ExternalExchangeRevenue__c: '12.50' }]).get('p1')).toBe(12.5)
  })

  it('ignores a record with no id', () => {
    expect(indexRevenueRecords([{ ExternalExchangeRevenue__c: 5 }]).size).toBe(0)
  })
})

describe('chunk', () => {
  it('splits into batches of the given size, keeping the remainder', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns nothing for an empty list', () => {
    expect(chunk([], 10)).toEqual([])
  })
})

import { bidExportColumns } from '../sightings-export'

describe('the estimate reaches the warehouse', () => {
  it('is named in the bid export column list', () => {
    // A value the export does not carry is invisible to every warehouse query
    // and is then deleted by the purge at retention, which is the whole reason
    // this column exists. The export list and the column are separate lists, so
    // nothing but this relates them (LESSONS L46).
    expect(bidExportColumns).toContain('estimated_revenue_cents')
  })
})

describe('resolveTripointOrg', () => {
  it('names the organization that owns the Tripoint partner config', async () => {
    // The Salesforce token is cached per organization, so this reads the right
    // one rather than taking whichever row comes back first from somewhere else.
    const db = makeDb({})
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ limit: async () => ({ data: [{ organization_id: 'org-7' }], error: null }) }) }),
      }),
    } as unknown as SupabaseClient
    void db
    await expect(resolveTripointOrg(client)).resolves.toEqual({ orgId: 'org-7', error: null })
  })

  it('reports a lookup failure rather than carrying on without an organization', async () => {
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: 'timeout' } }) }) }),
      }),
    } as unknown as SupabaseClient
    const out = await resolveTripointOrg(client)
    expect(out.orgId).toBeNull()
    expect(out.error).toContain('org_lookup_failed')
  })

  it('reports a missing Tripoint config as its own outcome, not as a failure to read', async () => {
    // No config and an unreadable table are different facts, and only one of
    // them means somebody should go and look at the partner settings.
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }),
      }),
    } as unknown as SupabaseClient
    const out = await resolveTripointOrg(client)
    expect(out.orgId).toBeNull()
    expect(out.error).toBe('no_tripoint_partner_config')
  })
})
