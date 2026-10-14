/**
 * GET /api/incidents (#2101, under #818): the incident record as the dashboard
 * reads it.
 *
 * The table is service role only with no RLS policy, so the route is the only
 * thing keeping one organization's incidents from another. These tests run the
 * route against an in memory table that APPLIES the filters the route sends, so
 * a scope the route forgets to send returns the other organization's row, and a
 * test fails (the mutation check: drop the organization filter).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase } from './_supabase-mock'

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const WF_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const WF_A_DELETED = 'aaaaaaaa-0000-4000-8000-000000000002'
const WF_B = 'bbbbbbbb-0000-4000-8000-000000000001'

const testUser = { id: 'user-1', organization_id: ORG_A, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }

const NOW = Date.parse('2026-10-14T20:00:00.000Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
const daysAgo = (d: number) => minutesAgo(d * 1440)

type Row = Record<string, unknown>

let seq = 0
/** One alert_incidents row with every NOT NULL column filled and the constraints met. */
function incident(over: Partial<Row>): Row {
  seq += 1
  const scope = (over.scope as string | undefined) ?? 'org'
  const endedReason = (over.ended_reason as string | null | undefined) ?? null
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    signal: 'volume-cliff',
    subject: WF_A,
    subject_label: 'Engine Bidding Workflow',
    scope,
    organization_id: scope === 'org' ? ORG_A : null,
    started_at: minutesAgo(120),
    last_seen_at: minutesAgo(100),
    ended_at: null,
    ended_reason: endedReason,
    successor_signal: null,
    pages_sent: 1,
    paged_event_ids: ['evt-1'],
    window_minutes: null,
    failed_runs: null,
    marker_missing_at: null,
    previous_starts: [],
    closed_at: endedReason === null ? null : minutesAgo(90),
    created_at: minutesAgo(120),
    updated_at: minutesAgo(90),
    ...over,
  }
}

interface FakeOpts {
  /** Fail reads of the open rows (`ended_reason is null`), the closed rows, or the workflows. */
  fail?: Partial<Record<'open' | 'closed' | 'workflows', string>>
  /** Model a database that returned rows the route's scope should have excluded. */
  ignoreOr?: boolean
}

/**
 * A PostgREST builder over in memory rows that applies what the route sends:
 * eq, is, not is, gte, in, or (`col.eq.v,col.eq.v`), order, range, limit, and an
 * exact count. A filter the route never sends is never applied, which is the
 * point.
 */
function fakeTables(tables: Record<string, Row[]>, opts: FakeOpts = {}) {
  const sent: Array<{ table: string; calls: Array<[string, unknown[]]> }> = []
  function from(table: string) {
    const calls: Array<[string, unknown[]]> = []
    sent.push({ table, calls })
    const filters: Array<(r: Row) => boolean> = []
    const orders: Array<{ col: string; asc: boolean }> = []
    let start = 0
    let end = Number.POSITIVE_INFINITY
    let wantCount = false
    let kind: 'open' | 'closed' | 'workflows' | null = table === 'workflows' ? 'workflows' : null
    const b: Record<string, unknown> = {}
    const chain = (name: string, fn: (...a: never[]) => void) => {
      b[name] = (...args: never[]) => {
        calls.push([name, args])
        fn(...args)
        return b
      }
    }
    chain('select', (_cols: string, o?: { count?: string }) => { wantCount = o?.count === 'exact' })
    chain('eq', (col: string, v: unknown) => filters.push((r) => r[col] === v))
    chain('is', (col: string, v: null) => {
      filters.push((r) => r[col] === v)
      if (col === 'ended_reason') kind = 'open'
    })
    chain('not', (col: string, op: string, v: null) => {
      if (op !== 'is') throw new Error(`fake: not.${op} unsupported`)
      filters.push((r) => r[col] !== v)
      if (col === 'ended_reason') kind = 'closed'
    })
    chain('gte', (col: string, v: string) => filters.push((r) => Date.parse(String(r[col])) >= Date.parse(v)))
    chain('in', (col: string, vals: unknown[]) => filters.push((r) => vals.includes(r[col])))
    chain('or', (expr: string) => {
      if (opts.ignoreOr) return
      const parts = expr.split(',').map((p) => {
        const [col, op, ...rest] = p.split('.')
        const val = rest.join('.')
        if (op !== 'eq') throw new Error(`fake: or ${op} unsupported`)
        return (r: Row) => String(r[col]) === val
      })
      filters.push((r) => parts.some((f) => f(r)))
    })
    chain('order', (col: string, o?: { ascending?: boolean }) => orders.push({ col, asc: o?.ascending ?? true }))
    chain('range', (a: number, z: number) => { start = a; end = z })
    chain('limit', (n: number) => { end = start + n - 1 })
    b.then = (resolve: (v: unknown) => unknown) => {
      const failure = kind ? opts.fail?.[kind] : undefined
      if (failure) return Promise.resolve({ data: null, error: { message: failure, code: '57014' }, count: null }).then(resolve)
      const matched = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      matched.sort((x, y) => {
        for (const o of orders) {
          const a = String(x[o.col])
          const z = String(y[o.col])
          if (a !== z) return (a < z ? -1 : 1) * (o.asc ? 1 : -1)
        }
        return 0
      })
      const page = matched.slice(start, end + 1)
      return Promise.resolve({ data: page, error: null, count: wantCount ? matched.length : null }).then(resolve)
    }
    return b
  }
  return { from, sent }
}

const WORKFLOWS: Row[] = [
  { id: WF_A, organization_id: ORG_A, name: 'Engine Bidding Workflow', deleted_at: null },
  { id: WF_A_DELETED, organization_id: ORG_A, name: 'Old Main Flow', deleted_at: daysAgo(2) },
  { id: WF_B, organization_id: ORG_B, name: 'Other org flow', deleted_at: null },
]

function install(rows: Row[], opts: FakeOpts = {}) {
  const auth = makeSupabase({ users: { single: testUser } })
  const fake = fakeTables({ alert_incidents: rows, workflows: WORKFLOWS }, opts)
  vi.mocked(createSupabaseClient).mockReturnValue({ rpc: auth.rpc, from: fake.from } as unknown as ReturnType<typeof createSupabaseClient>)
  return fake
}

const env = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

async function get(query = '', headers: Record<string, string> = { Authorization: 'Bearer tok' }) {
  const { default: api } = await import('../index')
  return api.request(`/incidents${query}`, { method: 'GET', headers }, env, mockCtx)
}

interface View {
  id: string
  signal: string
  signal_label: string
  signal_known: boolean
  subject_name: string
  scope: string
  started_at: string
  ended_at: string | null
  state: 'ongoing' | 'ended' | 'end_not_recorded'
  duration: string | null
  pages_sent: number
}
interface Page { incidents: View[]; has_more: boolean; next_offset: number | null }

async function page(query = ''): Promise<Page> {
  const res = await get(query)
  expect(res.status).toBe(200)
  return (await res.json()) as Page
}

describe('GET /api/incidents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seq = 0
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('401s without an Authorization header', async () => {
    install([])
    const res = await get('', {})
    expect(res.status).toBe(401)
  })

  describe('scope', () => {
    it("returns the caller's organization's rows and the platform's, never another organization's", async () => {
      const mine = incident({ subject: WF_A })
      const platform = incident({ signal: 'pg-cron-watch', scope: 'platform', subject: 'purge-alert-incidents', subject_label: 'purge-alert-incidents' })
      const theirs = incident({ subject: WF_B, organization_id: ORG_B, subject_label: 'Other org flow' })
      const theirsClosed = incident({ subject: WF_B, organization_id: ORG_B, subject_label: 'Other org flow', ended_reason: 'all_clear', ended_at: minutesAgo(30) })
      install([mine, platform, theirs, theirsClosed])

      const body = await page()
      const ids = body.incidents.map((i) => i.id)
      expect(ids).toContain(mine.id)
      expect(ids).toContain(platform.id)
      expect(ids).not.toContain(theirs.id)
      expect(ids).not.toContain(theirsClosed.id)
      expect(body.incidents).toHaveLength(2)
    })

    it("refuses with an error, rather than returning it, a row of another organization the database handed back", async () => {
      // Belt and braces: a scope lost on the way to the database must not reach
      // the browser either.
      install([incident({ subject: WF_A }), incident({ subject: WF_B, organization_id: ORG_B })], { ignoreOr: true })
      const res = await get()
      expect(res.status).toBe(500)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.incidents).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain('Other org flow')
    })
  })

  describe('order and paging', () => {
    function seedForPaging() {
      const open1 = incident({ started_at: minutesAgo(30) })
      const open2 = incident({ started_at: minutesAgo(500) })
      const closed = [10, 20, 40, 60, 80].map((m) =>
        incident({ started_at: minutesAgo(m), ended_reason: 'all_clear', ended_at: minutesAgo(m - 5) }),
      )
      // Two closed rows with the same start: the id breaks the tie, so the order is total.
      const tieA = incident({ started_at: minutesAgo(90), ended_reason: 'lapsed' })
      const tieB = incident({ started_at: minutesAgo(90), ended_reason: 'lapsed' })
      return { open1, open2, closed, tieA, tieB, all: [...closed, tieA, open2, tieB, open1] }
    }

    it('puts ongoing incidents first, then the newest start, then the id', async () => {
      const s = seedForPaging()
      install(s.all)
      const body = await page()
      expect(body.incidents.map((i) => i.id)).toEqual([
        s.open1.id,
        s.open2.id,
        ...s.closed.map((r) => r.id),
        // Descending id within the same start.
        s.tieB.id,
        s.tieA.id,
      ])
      expect(body.has_more).toBe(false)
      expect(body.next_offset).toBeNull()
    })

    it('pages across the ongoing and closed rows without a gap or a repeat', async () => {
      const s = seedForPaging()
      install(s.all)
      const seen: string[] = []
      let offset: number | null = 0
      let pages = 0
      while (offset !== null) {
        const body = await page(`?limit=3&offset=${offset}`)
        expect(body.incidents.length).toBeLessThanOrEqual(3)
        seen.push(...body.incidents.map((i) => i.id))
        expect(body.has_more).toBe(body.next_offset !== null)
        offset = body.next_offset
        pages += 1
        expect(pages).toBeLessThan(10)
      }
      expect(pages).toBe(3)
      expect(seen).toEqual((await page()).incidents.map((i) => i.id))
      expect(new Set(seen).size).toBe(9)
    })

    it('reports more when exactly one page of ongoing rows is followed by closed ones', async () => {
      const s = seedForPaging()
      install(s.all)
      const body = await page('?limit=2')
      expect(body.incidents.map((i) => i.id)).toEqual([s.open1.id, s.open2.id])
      expect(body.has_more).toBe(true)
      expect(body.next_offset).toBe(2)
    })

    it('returns 50 by default and never more than 100', async () => {
      const rows = Array.from({ length: 120 }, (_, i) => incident({ started_at: minutesAgo(i + 1), ended_reason: 'all_clear', ended_at: minutesAgo(i) }))
      install(rows)
      const first = await page()
      expect(first.incidents).toHaveLength(50)
      expect(first.has_more).toBe(true)
      const capped = await page('?limit=500')
      expect(capped.incidents).toHaveLength(100)
      expect(capped.has_more).toBe(true)
    })

    it('400s on a limit or offset that is not a whole number', async () => {
      install([])
      expect((await get('?limit=abc')).status).toBe(400)
      expect((await get('?limit=0')).status).toBe(400)
      expect((await get('?offset=-1')).status).toBe(400)
      expect((await get('?offset=1.5')).status).toBe(400)
    })

    it('keeps 90 days of closed incidents, and every ongoing one however old', async () => {
      const oldOpen = incident({ started_at: daysAgo(120) })
      const recentClosed = incident({ started_at: daysAgo(89), ended_reason: 'all_clear', ended_at: daysAgo(88) })
      const oldClosed = incident({ started_at: daysAgo(91), ended_reason: 'all_clear', ended_at: daysAgo(1) })
      install([oldOpen, recentClosed, oldClosed])
      const ids = (await page()).incidents.map((i) => i.id)
      expect(ids).toEqual([oldOpen.id, recentClosed.id])
    })
  })

  describe('the fields a reader sees', () => {
    it('returns what the page needs and none of the bookkeeping', async () => {
      install([incident({ ended_reason: 'all_clear', started_at: minutesAgo(120), ended_at: minutesAgo(28), pages_sent: 3 })])
      const [row] = (await page()).incidents
      expect(Object.keys(row).sort()).toEqual([
        'duration', 'ended_at', 'id', 'pages_sent', 'scope', 'signal', 'signal_known', 'signal_label', 'started_at', 'state', 'subject_name',
      ])
      expect(row).toMatchObject({
        signal: 'volume-cliff',
        signal_label: 'Volume cliff',
        signal_known: true,
        subject_name: 'Engine Bidding Workflow',
        state: 'ended',
        duration: '1 hour 32 minutes',
        pages_sent: 3,
      })
    })

    it('names an unrecognised signal as such and keeps its raw key', async () => {
      install([incident({ signal: 'retired-check', scope: 'platform', subject: 'some-job', subject_label: null })])
      const [row] = (await page()).incidents
      expect(row.signal).toBe('retired-check')
      expect(row.signal_label).toBe('Unrecognised signal')
      expect(row.signal_known).toBe(false)
      expect(row.subject_name).toBe('some-job')
    })

    describe('subject by name', () => {
      it('uses the label the check recorded', async () => {
        install([incident({ signal: 'failure-rate', subject: `${WF_A}:ACRO_GATEWAY`, subject_label: 'Engine Bidding Workflow: "ACRO_GATEWAY"' })])
        expect((await page()).incidents[0].subject_name).toBe('Engine Bidding Workflow: "ACRO_GATEWAY"')
      })

      it("reads a workflow keyed subject's name from the workflow when no label was recorded", async () => {
        install([
          incident({ signal: 'slow-spike', subject: WF_A, subject_label: null }),
          incident({ signal: 'field-presence-drought', subject: `${WF_A} steps.lead.output.id`, subject_label: null, started_at: minutesAgo(200) }),
        ])
        const names = (await page()).incidents.map((i) => i.subject_name)
        expect(names).toEqual(['Engine Bidding Workflow', 'Engine Bidding Workflow steps.lead.output.id'])
      })

      it('marks a deleted workflow as deleted', async () => {
        install([
          incident({ subject: WF_A_DELETED, subject_label: 'Old Main Flow' }),
          incident({ signal: 'slow-spike', subject: WF_A_DELETED, subject_label: null, started_at: minutesAgo(300) }),
        ])
        const names = (await page()).incidents.map((i) => i.subject_name)
        expect(names).toEqual(['Old Main Flow (deleted)', 'Old Main Flow (deleted)'])
      })

      it("never shows a raw id: not for a workflow no longer on record, nor another organization's workflow", async () => {
        install([
          incident({ subject: 'aaaaaaaa-0000-4000-8000-00000000dead', subject_label: null }),
          incident({ subject: WF_B, subject_label: null, started_at: minutesAgo(300) }),
          incident({ signal: 'db-unreachable', subject: ORG_A, subject_label: null, started_at: minutesAgo(400) }),
          incident({ signal: 'stored-copy-serving', scope: 'platform', subject: '3f2c9a10-1111-4111-8111-000000000000', subject_label: null, started_at: minutesAgo(500) }),
        ])
        const names = (await page()).incidents.map((i) => i.subject_name)
        for (const n of names) expect(n).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
        expect(names).toEqual(['A workflow no longer on record', 'A workflow no longer on record', 'This organization', 'Unnamed subject'])
      })

      it('looks workflows up inside the caller organization only', async () => {
        const fake = install([incident({ signal: 'slow-spike', subject: WF_A, subject_label: null })])
        await page()
        const wf = fake.sent.find((s) => s.table === 'workflows')
        expect(wf?.calls).toContainEqual(['eq', ['organization_id', ORG_A]])
      })

      it('reads no workflows when no row is keyed on one', async () => {
        const fake = install([incident({ signal: 'pg-cron-watch', scope: 'platform', subject: 'purge', subject_label: 'purge' })])
        await page()
        expect(fake.sent.some((s) => s.table === 'workflows')).toBe(false)
      })
    })

    describe('end and duration, from the span rule the all-clear uses', () => {
      it('reads an open incident as ongoing, with no duration', async () => {
        install([incident({})])
        expect((await page()).incidents[0]).toMatchObject({ state: 'ongoing', ended_at: null, duration: null })
      })

      it('reads a lapsed incident as end not recorded, with no duration', async () => {
        install([incident({ ended_reason: 'lapsed', ended_at: null })])
        expect((await page()).incidents[0]).toMatchObject({ state: 'end_not_recorded', ended_at: null, duration: null })
      })

      it('reports the window for an incident shorter than the window its check judges', async () => {
        install([incident({ ended_reason: 'all_clear', started_at: minutesAgo(60), ended_at: minutesAgo(58), window_minutes: 4 })])
        expect((await page()).incidents[0].duration).toBe('Within one 4 minute window')
      })

      it('measures an incident longer than its window', async () => {
        install([incident({ ended_reason: 'all_clear', started_at: minutesAgo(60), ended_at: minutesAgo(10), window_minutes: 4 })])
        expect((await page()).incidents[0].duration).toBe('50 minutes')
      })
    })
  })

  describe('a failed read is an error, never an empty list', () => {
    for (const which of ['open', 'closed', 'workflows'] as const) {
      it(`500s with a message when the ${which} read fails`, async () => {
        install([incident({ signal: 'slow-spike', subject_label: null }), incident({ ended_reason: 'all_clear', ended_at: minutesAgo(10) })], {
          fail: { [which]: 'canceling statement due to statement timeout' },
        })
        const res = await get()
        expect(res.status).toBe(500)
        const body = (await res.json()) as Record<string, unknown>
        expect(typeof body.error).toBe('string')
        expect((body.error as string).length).toBeGreaterThan(0)
        expect(body.incidents).toBeUndefined()
      })
    }
  })
})
