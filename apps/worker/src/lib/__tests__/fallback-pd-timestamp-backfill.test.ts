/**
 * The fallback PD timestamp backfill (#2581), against a fake Salesforce that
 * holds Submissions in memory and answers the queries the backfill sends.
 *
 * The fake evaluates the backfill's predicate itself, and refuses any query that
 * does not carry it word for word, so a test that a stamped record is left alone
 * proves the query re-applies the predicate rather than proving the fake is kind.
 */
import { describe, it, expect } from 'vitest'
import {
  FALLBACK_PREDICATE,
  MAX_BATCH,
  applyBackfill,
  candidatesSoql,
  flowTimestamp,
  parseBackfillArgs,
  readCandidates,
  runBackfill,
  salesforceSubmissionStore,
  type QueryPage,
  type SubmissionStore,
  type UpdateResult,
} from '../fallback-pd-timestamp-backfill'

interface FakeSubmission {
  Id: string
  CreatedDate: string
  InternalDebtRouting__c: number | null
  PD_Completed_Timestamp__c: string | null
  XBC_SO__c: string | null
  SSN__c: string
  Email__c: string
}

const idOf = (i: number) => `a04Ui${String(i).padStart(13, '0')}`

function submissions(n: number, from = 0): FakeSubmission[] {
  return Array.from({ length: n }, (_, k) => {
    const i = from + k
    const created = new Date(Date.UTC(2024, 11, 4, 12, 0, 0) + i * 60_000)
    return {
      Id: idOf(i),
      CreatedDate: created.toISOString().replace('Z', '+0000'),
      InternalDebtRouting__c: 20000,
      PD_Completed_Timestamp__c: null,
      XBC_SO__c: '101',
      SSN__c: '123456789',
      Email__c: 'lead@example.com',
    }
  })
}

const matches = (s: FakeSubmission) =>
  s.InternalDebtRouting__c === 20000 && s.PD_Completed_Timestamp__c === null && s.XBC_SO__c !== null

/** Salesforce in memory: query locators paged at `pageSize`, sObject Collections updates. */
function fakeSalesforce(rows: FakeSubmission[], opts: { pageSize?: number; failIds?: Set<string>; dropFromPage?: number } = {}) {
  const pageSize = opts.pageSize ?? 2000
  const byId = new Map(rows.map((r) => [r.Id, r]))
  const locators = new Map<string, { rows: FakeSubmission[]; totalSize: number }>()
  const calls = { query: [] as string[], queryMore: [] as string[], update: [] as Array<Array<{ Id: string; value: string }>> }
  let next = 0

  const page = (key: string, offset: number): QueryPage => {
    const loc = locators.get(key)!
    const slice = loc.rows.slice(offset, offset + pageSize)
    const end = offset + slice.length
    const done = end >= loc.rows.length
    const records = slice.map((r) => ({ attributes: { type: 'Submission__c', url: `/x/${r.Id}` }, Id: r.Id, CreatedDate: r.CreatedDate }))
    if (opts.dropFromPage !== undefined && offset > 0) records.splice(0, opts.dropFromPage)
    return { totalSize: loc.totalSize, done, nextRecordsUrl: done ? undefined : `/services/data/v60.0/query/${key}-${end}`, records }
  }

  const store: SubmissionStore = {
    query(soql) {
      calls.query.push(soql)
      if (!soql.includes(`(${FALLBACK_PREDICATE})`)) throw new Error(`fake: query without the predicate: ${soql}`)
      const ids = /Id IN \(([^)]*)\)/.exec(soql)
      let selected = [...byId.values()].filter(matches)
      if (ids) {
        const wanted = new Set(ids[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')))
        selected = selected.filter((r) => wanted.has(r.Id))
      }
      selected.sort((a, b) => (a.CreatedDate < b.CreatedDate ? -1 : a.CreatedDate > b.CreatedDate ? 1 : a.Id < b.Id ? -1 : 1))
      const key = `01g${next++}`
      locators.set(key, { rows: selected, totalSize: selected.length })
      return Promise.resolve(page(key, 0))
    },
    queryMore(url) {
      calls.queryMore.push(url)
      const m = /\/query\/(01g\d+)-(\d+)$/.exec(url)
      if (!m) throw new Error(`fake: bad next page ${url}`)
      return Promise.resolve(page(m[1], Number(m[2])))
    },
    update(batch) {
      calls.update.push(batch.map((r) => ({ ...r })))
      if (batch.length > MAX_BATCH) throw new Error('fake: more than 200 records in one request')
      const out: UpdateResult[] = batch.map((r) => {
        if (opts.failIds?.has(r.Id)) {
          return { id: null, success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', fields: [] }] }
        }
        byId.get(r.Id)!.PD_Completed_Timestamp__c = r.value
        return { id: r.Id, success: true, errors: [] }
      })
      return Promise.resolve(out)
    },
  }
  return { store, calls, byId }
}

describe('the predicate and the value', () => {
  it('matches exactly the fallback Submissions measured on #2581', () => {
    expect(FALLBACK_PREDICATE).toBe('InternalDebtRouting__c = 20000 AND PD_Completed_Timestamp__c = null AND XBC_SO__c != null')
    expect(candidatesSoql()).toBe(`SELECT Id, CreatedDate FROM Submission__c WHERE (${FALLBACK_PREDICATE}) ORDER BY CreatedDate, Id`)
  })

  it("formats CreatedDate the way the flow's completedDate is: UTC, seconds, no zone", () => {
    expect(flowTimestamp('2024-12-04T15:23:45.000+0000')).toBe('2024-12-04T15:23:45')
    expect(flowTimestamp('2024-12-04T15:23:45Z')).toBe('2024-12-04T15:23:45')
    expect(flowTimestamp('2024-12-04T10:23:45.000-0500')).toBe('2024-12-04T15:23:45')
    expect(() => flowTimestamp('2024-12-04')).toThrow()
    expect(() => flowTimestamp('not a date')).toThrow()
  })
})

describe('the dry run', () => {
  it('writes nothing and prints only the count, the date range and five Ids', async () => {
    const sf = fakeSalesforce(submissions(12))
    const lines: string[] = []
    const result = await runBackfill(sf.store, { apply: false, limit: null }, { print: (l) => lines.push(l) })

    expect(sf.calls.update).toEqual([])
    expect([...sf.byId.values()].every((s) => s.PD_Completed_Timestamp__c === null)).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(lines).toEqual([
      'Dry run: nothing was written.',
      'Matching Submissions: 12',
      'Earliest CreatedDate: 2024-12-04T12:00:00.000+0000',
      'Latest CreatedDate: 2024-12-04T12:11:00.000+0000',
      `Sample Ids: ${[0, 1, 2, 3, 4].map(idOf).join(', ')}`,
    ])
    const printed = lines.join('\n')
    expect(printed).not.toContain('123456789')
    expect(printed).not.toContain('lead@example.com')
  })

  it('reads past 2,000 records by following queryMore', async () => {
    const sf = fakeSalesforce(submissions(4500))
    const candidates = await readCandidates(sf.store)
    expect(candidates).toHaveLength(4500)
    expect(sf.calls.queryMore).toHaveLength(2)
    expect(new Set(candidates.map((c) => c.Id)).size).toBe(4500)
  })

  it('refuses a read whose records fall short of the totalSize Salesforce reported', async () => {
    const sf = fakeSalesforce(submissions(4500), { dropFromPage: 1 })
    await expect(readCandidates(sf.store)).rejects.toThrow(/4500/)
  })
})

describe('apply', () => {
  it('writes only matching records, each its own CreatedDate in the flow format', async () => {
    const rows = submissions(5)
    const verified = { ...submissions(1, 100)[0], PD_Completed_Timestamp__c: '2025-01-01T00:00:00' }
    const otherRouting = { ...submissions(1, 101)[0], InternalDebtRouting__c: 15000 }
    const noXbc = { ...submissions(1, 102)[0], XBC_SO__c: null }
    const sf = fakeSalesforce([...rows, verified, otherRouting, noXbc])

    const result = await runBackfill(sf.store, { apply: true, limit: null }, { print: () => {} })

    expect(result.report).toMatchObject({ updated: 5, skipped: 0, failed: 0, unknown: 0, notReached: 0, stopped: null })
    const sent = sf.calls.update.flat()
    expect(sent.map((r) => r.Id)).toEqual(rows.map((r) => r.Id))
    for (const r of sent) expect(r.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
    expect(sf.byId.get(idOf(0))!.PD_Completed_Timestamp__c).toBe('2024-12-04T12:00:00')
    expect(sf.byId.get(idOf(4))!.PD_Completed_Timestamp__c).toBe('2024-12-04T12:04:00')
    expect(sf.byId.get(verified.Id)!.PD_Completed_Timestamp__c).toBe('2025-01-01T00:00:00')
    expect(sf.byId.get(otherRouting.Id)!.PD_Completed_Timestamp__c).toBeNull()
    expect(sf.byId.get(noXbc.Id)!.PD_Completed_Timestamp__c).toBeNull()
  })

  it('never overwrites a record that gained a timestamp after the read, and is safe to run twice', async () => {
    const sf = fakeSalesforce(submissions(300))
    const candidates = await readCandidates(sf.store)
    sf.byId.get(idOf(7))!.PD_Completed_Timestamp__c = '2026-10-21T16:37:00'
    sf.byId.get(idOf(250))!.PD_Completed_Timestamp__c = '2026-10-21T16:38:00'

    const report = await applyBackfill(sf.store, candidates, { limit: null })

    expect(report).toMatchObject({ updated: 298, skipped: 2, failed: 0, stopped: null })
    expect(sf.calls.update.flat().map((r) => r.Id)).not.toContain(idOf(7))
    expect(sf.byId.get(idOf(7))!.PD_Completed_Timestamp__c).toBe('2026-10-21T16:37:00')
    expect(sf.byId.get(idOf(250))!.PD_Completed_Timestamp__c).toBe('2026-10-21T16:38:00')
    for (const q of sf.calls.query.slice(1)) expect(q).toContain(`(${FALLBACK_PREDICATE})`)

    const writesBefore = sf.calls.update.length
    const second = await runBackfill(sf.store, { apply: true, limit: null }, { print: () => {} })
    expect(second.report).toMatchObject({ updated: 0, skipped: 0, failed: 0 })
    expect(sf.calls.update.length).toBe(writesBefore)
  })

  it('sends batches of at most 200 and applies past 2,000 records', async () => {
    const sf = fakeSalesforce(submissions(4500))
    const result = await runBackfill(sf.store, { apply: true, limit: null }, { print: () => {} })
    expect(result.report).toMatchObject({ updated: 4500, failed: 0, notReached: 0 })
    expect(sf.calls.update).toHaveLength(23)
    expect(Math.max(...sf.calls.update.map((b) => b.length))).toBe(200)
    expect([...sf.byId.values()].every((s) => s.PD_Completed_Timestamp__c !== null)).toBe(true)
  })

  it('stops on the first batch where more than 1% fail, and reports the counts', async () => {
    const failIds = new Set([idOf(210), idOf(220), idOf(230)])
    const sf = fakeSalesforce(submissions(1000), { failIds })
    const lines: string[] = []
    const result = await runBackfill(sf.store, { apply: true, limit: null }, { print: (l) => lines.push(l) })

    expect(sf.calls.update).toHaveLength(2)
    expect(result.exitCode).toBe(1)
    expect(result.report).toMatchObject({ updated: 397, failed: 3, skipped: 0, notReached: 600 })
    expect(result.report!.stopped).toMatch(/batch 2.*3 of 200/)
    expect(result.report!.failureCodes).toEqual({ FIELD_CUSTOM_VALIDATION_EXCEPTION: 3 })
    expect(lines).toContain('Updated: 397')
    expect(lines).toContain('Failed: 3')
  })

  it('carries on through a batch at exactly 1%', async () => {
    const sf = fakeSalesforce(submissions(400), { failIds: new Set([idOf(10), idOf(20)]) })
    const report = await applyBackfill(sf.store, await readCandidates(sf.store), { limit: null })
    expect(report).toMatchObject({ updated: 398, failed: 2, stopped: null })
  })

  it('stops when a whole request fails, counting its records as unknown rather than failed', async () => {
    const sf = fakeSalesforce(submissions(450))
    let n = 0
    const store: SubmissionStore = {
      ...sf.store,
      update: (batch) => (++n === 2 ? Promise.reject(new Error('Salesforce composite update failed (503)')) : sf.store.update(batch)),
    }
    const report = await applyBackfill(store, await readCandidates(store), { limit: null })
    expect(report).toMatchObject({ updated: 200, failed: 0, unknown: 200, notReached: 50 })
    expect(report.stopped).toMatch(/503/)
  })

  it('records every per record result', async () => {
    const sf = fakeSalesforce(submissions(5), { failIds: new Set([idOf(3)]) })
    const results: unknown[] = []
    const candidates = await readCandidates(sf.store)
    sf.byId.get(idOf(1))!.PD_Completed_Timestamp__c = '2026-10-21T16:37:00'
    await applyBackfill(sf.store, candidates, { limit: null, onResult: (r) => results.push(r) })
    expect(results).toEqual([
      { id: idOf(1), outcome: 'skipped' },
      { id: idOf(0), outcome: 'updated', value: '2024-12-04T12:00:00' },
      { id: idOf(2), outcome: 'updated', value: '2024-12-04T12:02:00' },
      { id: idOf(3), outcome: 'failed', value: '2024-12-04T12:03:00', statusCodes: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'], fields: [] },
      { id: idOf(4), outcome: 'updated', value: '2024-12-04T12:04:00' },
    ])
  })
})

describe('--limit', () => {
  it('caps how many records are written', async () => {
    const sf = fakeSalesforce(submissions(500))
    const result = await runBackfill(sf.store, { apply: true, limit: 50 }, { print: () => {} })
    expect(sf.calls.update).toHaveLength(1)
    expect(sf.calls.update[0]).toHaveLength(50)
    expect(result.report).toMatchObject({ updated: 50, notReached: 450 })
    expect([...sf.byId.values()].filter((s) => s.PD_Completed_Timestamp__c !== null)).toHaveLength(50)
  })

  it('counts only writes against the cap, not records skipped on the re-check', async () => {
    const sf = fakeSalesforce(submissions(500))
    const candidates = await readCandidates(sf.store)
    for (let i = 0; i < 10; i++) sf.byId.get(idOf(i))!.PD_Completed_Timestamp__c = '2026-10-21T16:37:00'
    const report = await applyBackfill(sf.store, candidates, { limit: 50 })
    expect(report).toMatchObject({ updated: 50, skipped: 10 })
  })

  it('is parsed strictly, and only alongside --apply', () => {
    expect(parseBackfillArgs([])).toEqual({ apply: false, limit: null })
    expect(parseBackfillArgs(['--apply'])).toEqual({ apply: true, limit: null })
    expect(parseBackfillArgs(['--apply', '--limit', '50'])).toEqual({ apply: true, limit: 50 })
    expect(parseBackfillArgs(['--apply', '--limit=50'])).toEqual({ apply: true, limit: 50 })
    for (const bad of [['--limit', '50'], ['--apply', '--limit'], ['--apply', '--limit', '0'], ['--apply', '--limit', '2.5'], ['--apply', '--limit', 'abc'], ['--force']]) {
      expect(parseBackfillArgs(bad), bad.join(' ')).toHaveProperty('error')
    }
  })
})

describe('the Salesforce store', () => {
  type Call = { url: string; method: string; body: unknown; auth: string }
  function fakeFetch(answers: Array<{ status: number; body: unknown }>) {
    const calls: Call[] = []
    const fn = (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.Authorization })
      const a = answers.shift()!
      return Promise.resolve(new Response(a.body === null ? null : JSON.stringify(a.body), { status: a.status }))
    }
    return { fn: fn as typeof fetch, calls }
  }

  it('queries, follows the next page and updates through sObject Collections with only the timestamp', async () => {
    const page = { totalSize: 1, done: true, records: [] }
    const f = fakeFetch([
      { status: 200, body: page },
      { status: 200, body: page },
      { status: 200, body: [{ id: idOf(0), success: true, errors: [] }] },
    ])
    const store = salesforceSubmissionStore({ instanceUrl: 'https://pennie.my.salesforce.com', token: () => Promise.resolve('t1'), evictToken: () => Promise.resolve(), fetch: f.fn })
    await store.query('SELECT Id FROM Submission__c')
    await store.queryMore('/services/data/v60.0/query/01gX-2000')
    const out = await store.update([{ Id: idOf(0), value: '2024-12-04T12:00:00' }])

    expect(f.calls[0].url).toBe('https://pennie.my.salesforce.com/services/data/v60.0/query?q=SELECT%20Id%20FROM%20Submission__c')
    expect(f.calls[1].url).toBe('https://pennie.my.salesforce.com/services/data/v60.0/query/01gX-2000')
    expect(f.calls[2]).toMatchObject({ url: 'https://pennie.my.salesforce.com/services/data/v60.0/composite/sobjects', method: 'PATCH', auth: 'Bearer t1' })
    expect(f.calls[2].body).toEqual({
      allOrNone: false,
      records: [{ attributes: { type: 'Submission__c' }, id: idOf(0), PD_Completed_Timestamp__c: '2024-12-04T12:00:00' }],
    })
    expect(out).toEqual([{ id: idOf(0), success: true, errors: [] }])
  })

  it('refuses a next page on another host', async () => {
    const f = fakeFetch([])
    const store = salesforceSubmissionStore({ instanceUrl: 'https://pennie.my.salesforce.com', token: () => Promise.resolve('t'), evictToken: () => Promise.resolve(), fetch: f.fn })
    await expect(store.queryMore('https://elsewhere.example/services/data/v60.0/query/01g-2000')).rejects.toThrow()
    expect(f.calls).toEqual([])
  })

  it('clears the token and retries once on a 401, then throws on a refusal', async () => {
    const tokens = ['stale', 'fresh']
    let evicted = 0
    const f = fakeFetch([
      { status: 401, body: [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }] },
      { status: 200, body: { totalSize: 0, done: true, records: [] } },
      { status: 400, body: [{ errorCode: 'MALFORMED_QUERY', message: 'bad' }] },
    ])
    const store = salesforceSubmissionStore({
      instanceUrl: 'https://pennie.my.salesforce.com',
      token: () => Promise.resolve(tokens.shift() ?? 'fresh'),
      evictToken: () => { evicted++; return Promise.resolve() },
      fetch: f.fn,
    })
    await store.query('SELECT Id FROM Submission__c')
    expect(evicted).toBe(1)
    expect(f.calls.map((c) => c.auth)).toEqual(['Bearer stale', 'Bearer fresh'])
    await expect(store.query('SELECT Id FROM Submission__c')).rejects.toThrow(/400.*MALFORMED_QUERY/)
  })
})
