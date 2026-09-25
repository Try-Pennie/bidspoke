import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../salesforce-creds', () => ({
  resolveSalesforceCredentialOrg: () => Promise.resolve({ orgId: 'org-1', error: null }),
  requireSalesforceCreds: () =>
    Promise.resolve({ instanceUrl: 'https://sf.example', clientId: 'id', clientSecret: 'secret' }),
}))
vi.mock('../../engine/nodes/salesforce', () => ({ getSalesforceToken: () => Promise.resolve('token') }))

import { backfillEnrollmentView } from '../achieve-export'

// #1599: the enrichment used to re-select the same first 100 unfilled rows on every loop. With
// 100 or more rows that can never be filled at the front, it re-asked Salesforce about them until
// the budget ran out, never reached the fillable rows behind them, and then reported every
// unfilled row as skipped. These drive it against an in memory table that honours the filters,
// the order and the limit, so the paging is exercised rather than assumed.

interface Row {
  id: string
  requested_at_utc: string
  request_payload: { partner_lead_id?: string } | null
  is_test: boolean
  exported_at: string | null
  enrollment_view: unknown
}

// uuid shaped, zero padded so text order is numeric order, as Postgres orders a uuid bytewise.
const rowId = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`
// 18 character Salesforce ids, so buildSubmissionViewSoql accepts them.
const submissionId = (n: number) => `a04Ui${n.toString().padStart(13, '0')}`

function makeRow(n: number, partnerLeadId: string | undefined): Row {
  return {
    id: rowId(n),
    requested_at_utc: '2026-09-25T10:00:00Z',
    request_payload: partnerLeadId === undefined ? {} : { partner_lead_id: partnerLeadId },
    is_test: false,
    exported_at: null,
    enrollment_view: null,
  }
}

function fakeSupabase(table: Row[]) {
  const selects: number[] = []
  const from = () => {
    const filters: Array<(r: Row) => boolean> = []
    let limit = Infinity
    let ordered = false
    let head = false
    let updateValues: Partial<Row> | null = null
    const b: Record<string, unknown> = {}
    b.select = (_cols: string, opts?: { head?: boolean }) => {
      head = opts?.head === true
      return b
    }
    b.eq = (col: keyof Row, val: unknown) => {
      filters.push((r) => r[col] === val)
      return b
    }
    b.is = (col: keyof Row, val: null) => {
      filters.push((r) => r[col] === val)
      return b
    }
    b.gt = (col: keyof Row, val: string) => {
      filters.push((r) => String(r[col]) > val)
      return b
    }
    b.order = () => {
      ordered = true
      return b
    }
    b.limit = (n: number) => {
      limit = n
      return b
    }
    b.update = (values: Partial<Row>) => {
      updateValues = values
      return b
    }
    b.then = (resolve: (r: unknown) => unknown) => {
      const matched = table.filter((r) => filters.every((f) => f(r)))
      if (updateValues) {
        for (const r of matched) Object.assign(r, updateValues)
        return resolve({ data: matched.map((r) => ({ id: r.id })), error: null })
      }
      if (head) return resolve({ data: null, error: null, count: matched.length })
      const sorted = ordered ? [...matched].sort((a, c) => (a.id < c.id ? -1 : 1)) : matched
      const page = sorted.slice(0, limit)
      selects.push(page.length)
      return resolve({ data: page.map((r) => ({ ...r })), error: null })
    }
    return b
  }
  return { supabase: { from: vi.fn(from) }, selects }
}

// Salesforce answers only for the submissions in `known`.
function stubSalesforce(known: Set<string>) {
  const asked: string[][] = []
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const soql = decodeURIComponent(String(url).split('q=')[1])
    const ids = [...soql.matchAll(/'([a-zA-Z0-9]+)'/g)].map((m) => m[1])
    asked.push(ids)
    const records = ids.filter((id) => known.has(id)).map((id) => ({
      attributes: { type: 'Submission__c' },
      Id: id,
      RevolvingTotalBalance__c: 100,
    }))
    return Promise.resolve(new Response(JSON.stringify({ records }), { status: 200 }))
  }))
  return asked
}

// A clock that moves one tick per reading, so a loop that never ends still stops.
function tickingClock() {
  let t = 0
  return () => t++
}

describe('the enrollment view pages through the unfilled rows once per run (#1599)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reaches fillable rows behind 100 or more that Salesforce has nothing for', async () => {
    const table: Row[] = []
    for (let n = 1; n <= 150; n++) table.push(makeRow(n, submissionId(n))) // Salesforce returns nothing
    for (let n = 151; n <= 170; n++) table.push(makeRow(n, submissionId(n))) // fillable
    const { supabase } = fakeSupabase(table)
    const known = new Set(Array.from({ length: 20 }, (_, i) => submissionId(151 + i)))
    const asked = stubSalesforce(known)

    const result = await backfillEnrollmentView(supabase as never, {} as never, 1_000, tickingClock())

    expect(result).toEqual({ filled: 20, skipped: 0 })
    // Each row is asked about once: two pages, 100 then 70, and never the first page again.
    expect(asked.map((ids) => ids.length)).toEqual([100, 70])
    expect(new Set(asked.flat()).size).toBe(170)
  })

  it('pages past a whole batch of rows with no submission id', async () => {
    const table: Row[] = []
    for (let n = 1; n <= 100; n++) table.push(makeRow(n, undefined))
    for (let n = 101; n <= 105; n++) table.push(makeRow(n, submissionId(n)))
    const { supabase } = fakeSupabase(table)
    stubSalesforce(new Set(Array.from({ length: 5 }, (_, i) => submissionId(101 + i))))

    const result = await backfillEnrollmentView(supabase as never, {} as never, 1_000, tickingClock())

    expect(result).toEqual({ filled: 5, skipped: 0 })
  })

  // Skipped means NOT REACHED. Rows already tried this run and left empty because Salesforce had
  // nothing are not a budget shortfall, and counting them made the #1363 alert overstate it.
  it('counts as skipped only the rows beyond where the deadline stopped it', async () => {
    const table: Row[] = []
    for (let n = 1; n <= 170; n++) table.push(makeRow(n, submissionId(n)))
    const { supabase } = fakeSupabase(table)
    stubSalesforce(new Set()) // nothing fills
    // Before the deadline for the first page, past it from the second reading on.
    let readings = 0
    const now = () => (readings++ === 0 ? 0 : 2_000)

    const result = await backfillEnrollmentView(supabase as never, {} as never, 1_000, now)

    expect(result).toEqual({ filled: 0, skipped: 70 })
  })

  // A shortfall count that could not be read is not a zero. Reporting zero would clear the
  // #1363 alert on exactly the run it exists for, so the failure is raised instead, and the
  // export records it and leaves the count unmeasured.
  it('refuses rather than reporting zero when the shortfall cannot be counted', async () => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'gt', 'order', 'limit']) b[m] = () => b
    b.then = (resolve: (r: unknown) => unknown) =>
      resolve({ data: null, error: { message: 'canceling statement due to statement timeout' }, count: null })
    const supabase = { from: () => b }

    await expect(
      backfillEnrollmentView(supabase as never, {} as never, 1_000, () => 2_000),
    ).rejects.toMatchObject({ message: 'canceling statement due to statement timeout' })
  })
})
