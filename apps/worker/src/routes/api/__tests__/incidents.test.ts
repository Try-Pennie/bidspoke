/**
 * GET /api/incidents and GET /api/incidents/ongoing (#2101, under #818): the
 * incident record as the dashboard reads it. The ongoing list feeds the line
 * under the page header; the other route feeds the Incidents card, which holds
 * only incidents that have closed, inside the page's 7, 14 or 30 day window.
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
/** One alert_incidents row with every NOT NULL column filled and the constraints met. Closed unless told otherwise. */
function incident(over: Partial<Row>): Row {
  seq += 1
  const scope = (over.scope as string | undefined) ?? 'org'
  const endedReason = 'ended_reason' in over ? (over.ended_reason as string | null) : 'all_clear'
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    signal: 'volume-cliff',
    subject: WF_A,
    subject_label: 'Engine Bidding Workflow',
    scope,
    organization_id: scope === 'org' ? ORG_A : null,
    started_at: minutesAgo(120),
    last_seen_at: minutesAgo(100),
    ended_at: endedReason === null || endedReason === 'lapsed' ? null : minutesAgo(28),
    successor_signal: null,
    pages_sent: 1,
    paged_event_ids: ['evt-1'],
    window_minutes: null,
    failed_runs: null,
    marker_missing_at: null,
    previous_starts: [],
    closed_at: endedReason === null ? null : minutesAgo(20),
    created_at: minutesAgo(120),
    updated_at: minutesAgo(20),
    ...over,
    ended_reason: endedReason,
  }
}
const open = (over: Partial<Row> = {}) => incident({ ...over, ended_reason: null, ended_at: null })

interface FakeOpts {
  /** Fail reads of the open rows (`ended_reason is null`), the closed rows, or the workflows. */
  fail?: Partial<Record<'open' | 'closed' | 'workflows', string>>
  /** Model a database that ignored the route's `or` filter. */
  ignoreOr?: boolean
}

type Pred = (r: Row) => boolean

/**
 * A PostgREST logic tree as the route writes it: `a.eq.x,b.gte.y` or nested
 * `and(...)` and `or(...)`, read as an OR of its items at the top level.
 */
function parseLogic(expr: string): Pred {
  let i = 0
  function list(): Pred[] {
    const items: Pred[] = [item()]
    while (expr[i] === ',') {
      i += 1
      items.push(item())
    }
    return items
  }
  function item(): Pred {
    for (const op of ['and', 'or'] as const) {
      if (expr.startsWith(`${op}(`, i)) {
        i += op.length + 1
        const inner = list()
        if (expr[i] !== ')') throw new Error(`fake: unclosed ${op}( in ${expr}`)
        i += 1
        return op === 'and' ? (r) => inner.every((p) => p(r)) : (r) => inner.some((p) => p(r))
      }
    }
    let j = i
    while (j < expr.length && expr[j] !== ',' && expr[j] !== ')') j += 1
    const leaf = expr.slice(i, j)
    i = j
    const [col, op, ...rest] = leaf.split('.')
    const val = rest.join('.')
    if (op === 'eq') return (r) => String(r[col]) === val
    if (op === 'gte') return (r) => r[col] !== null && Date.parse(String(r[col])) >= Date.parse(val)
    if (op === 'is' && val === 'null') return (r) => r[col] === null
    throw new Error(`fake: ${leaf} unsupported`)
  }
  const top = list()
  if (i !== expr.length) throw new Error(`fake: trailing text in ${expr}`)
  return (r) => top.some((p) => p(r))
}

/**
 * A PostgREST builder over in memory rows that applies what the route sends:
 * eq, is, not is, gte, in, or (with nesting), order, range, limit, and an exact
 * count. A filter the route never sends is never applied, which is the point.
 */
function fakeTables(tables: Record<string, Row[]>, opts: FakeOpts = {}) {
  const sent: Array<{ table: string; calls: Array<[string, unknown[]]> }> = []
  function from(table: string) {
    const calls: Array<[string, unknown[]]> = []
    sent.push({ table, calls })
    const filters: Pred[] = []
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
      if (!opts.ignoreOr) filters.push(parseLogic(expr))
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

async function get(path: string, headers: Record<string, string> = { Authorization: 'Bearer tok' }) {
  const { default: api } = await import('../index')
  return api.request(path, { method: 'GET', headers }, env, mockCtx)
}

interface Closed {
  id: string
  signal: string
  signal_label: string
  signal_known: boolean
  subject_name: string
  scope: string
  started_at: string
  ended_at: string | null
  state: 'ended' | 'end_not_recorded'
  duration: string | null
  pages_sent: number
}
interface Ongoing {
  id: string
  signal: string
  signal_label: string
  signal_known: boolean
  subject_name: string
  scope: string
  started_at: string
  so_far: string | null
  pages_sent: number
}
interface ClosedPage { incidents: Closed[]; has_more: boolean; next_offset: number | null }
interface OngoingList { incidents: Ongoing[]; has_more: boolean }

async function closedPage(query = ''): Promise<ClosedPage> {
  const res = await get(`/incidents${query}`)
  expect(res.status).toBe(200)
  return (await res.json()) as ClosedPage
}
async function ongoingList(): Promise<OngoingList> {
  const res = await get('/incidents/ongoing')
  expect(res.status).toBe(200)
  return (await res.json()) as OngoingList
}

describe('the incident routes', () => {
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
    expect((await get('/incidents', {})).status).toBe(401)
    expect((await get('/incidents/ongoing', {})).status).toBe(401)
  })

  describe('scope', () => {
    function seedTwoOrgs() {
      const mine = incident({ subject: WF_A })
      const mineOpen = open({ subject: WF_A })
      const platform = incident({ signal: 'pg-cron-watch', scope: 'platform', subject: 'purge-alert-incidents', subject_label: 'purge-alert-incidents' })
      const platformOpen = open({ signal: 'partner-reachability', scope: 'platform', subject: 'api.tripoint.com', subject_label: 'api.tripoint.com' })
      const theirs = incident({ subject: WF_B, organization_id: ORG_B, subject_label: 'Other org flow' })
      const theirsOpen = open({ subject: WF_B, organization_id: ORG_B, subject_label: 'Other org flow' })
      return { mine, mineOpen, platform, platformOpen, theirs, theirsOpen, all: [mine, mineOpen, platform, platformOpen, theirs, theirsOpen] }
    }

    it("lists the caller's organization's closed incidents and the platform's, never another organization's", async () => {
      const s = seedTwoOrgs()
      install(s.all)
      const ids = (await closedPage()).incidents.map((i) => i.id)
      expect(ids.sort()).toEqual([s.mine.id, s.platform.id].sort())
    })

    it("lists the caller's organization's ongoing incidents and the platform's, never another organization's", async () => {
      const s = seedTwoOrgs()
      install(s.all)
      const ids = (await ongoingList()).incidents.map((i) => i.id)
      expect(ids.sort()).toEqual([s.mineOpen.id, s.platformOpen.id].sort())
    })

    it('refuses with an error, rather than returning it, a row of another organization the database handed back', async () => {
      // Belt and braces: a scope lost on the way to the database must not reach
      // the browser either.
      const s = seedTwoOrgs()
      install(s.all, { ignoreOr: true })
      for (const path of ['/incidents', '/incidents/ongoing']) {
        const res = await get(path)
        expect(res.status, path).toBe(500)
        const body = (await res.json()) as Record<string, unknown>
        expect(body.incidents, path).toBeUndefined()
        expect(JSON.stringify(body), path).not.toContain('Other org flow')
      }
    })
  })

  describe('the card: closed incidents in the window', () => {
    it('holds no ongoing incident: those are the line under the header', async () => {
      install([open({}), incident({})])
      const body = await closedPage()
      expect(body.incidents).toHaveLength(1)
      expect(body.incidents[0].state).toBe('ended')
    })

    it('includes an incident that started in the window, or ended in it, and nothing else', async () => {
      const startedInside = incident({ started_at: daysAgo(6), ended_at: daysAgo(6) })
      const endedInside = incident({ started_at: daysAgo(9), ended_at: daysAgo(6) })
      const lapsedInside = incident({ started_at: daysAgo(3), ended_reason: 'lapsed' })
      const before = incident({ started_at: daysAgo(10), ended_at: daysAgo(8) })
      const lapsedBefore = incident({ started_at: daysAgo(10), ended_reason: 'lapsed' })
      install([startedInside, endedInside, lapsedInside, before, lapsedBefore])
      const ids = (await closedPage('?days=7')).incidents.map((i) => i.id)
      expect(ids).toEqual([lapsedInside.id, startedInside.id, endedInside.id])
    })

    it('follows the page window: 7, 14 or 30 days, 7 when none is given', async () => {
      const twentyDays = incident({ started_at: daysAgo(20), ended_at: daysAgo(20) })
      const tenDays = incident({ started_at: daysAgo(10), ended_at: daysAgo(10) })
      install([twentyDays, tenDays])
      expect((await closedPage()).incidents).toHaveLength(0)
      expect((await closedPage('?days=14')).incidents.map((i) => i.id)).toEqual([tenDays.id])
      expect((await closedPage('?days=30')).incidents.map((i) => i.id)).toEqual([tenDays.id, twentyDays.id])
    })

    it('400s on a window that is not 7, 14 or 30 days', async () => {
      install([])
      for (const q of ['?days=90', '?days=0', '?days=abc', '?days=7.5']) {
        expect((await get(`/incidents${q}`)).status, q).toBe(400)
      }
    })

    function seedForPaging() {
      const rows = [10, 20, 40, 60, 80].map((m) => incident({ started_at: minutesAgo(m), ended_at: minutesAgo(m - 5) }))
      // Two rows with the same start: the id breaks the tie, so the order is total.
      const tieA = incident({ started_at: minutesAgo(90), ended_reason: 'lapsed' })
      const tieB = incident({ started_at: minutesAgo(90), ended_reason: 'lapsed' })
      return { rows, tieA, tieB, all: [tieA, ...rows, tieB] }
    }

    it('orders by the newest start, then the id', async () => {
      const s = seedForPaging()
      install(s.all)
      const body = await closedPage()
      expect(body.incidents.map((i) => i.id)).toEqual([...s.rows.map((r) => r.id), s.tieB.id, s.tieA.id])
      expect(body.has_more).toBe(false)
      expect(body.next_offset).toBeNull()
    })

    it('pages without a gap or a repeat', async () => {
      const s = seedForPaging()
      install(s.all)
      const seen: string[] = []
      let offset: number | null = 0
      let pages = 0
      while (offset !== null) {
        const body = await closedPage(`?limit=3&offset=${offset}`)
        expect(body.incidents.length).toBeLessThanOrEqual(3)
        seen.push(...body.incidents.map((i) => i.id))
        expect(body.has_more).toBe(body.next_offset !== null)
        offset = body.next_offset
        pages += 1
        expect(pages).toBeLessThan(10)
      }
      expect(pages).toBe(3)
      expect(seen).toEqual((await closedPage()).incidents.map((i) => i.id))
      expect(new Set(seen).size).toBe(7)
    })

    it('returns 50 by default and never more than 100', async () => {
      const rows = Array.from({ length: 120 }, (_, i) => incident({ started_at: minutesAgo(i + 1), ended_at: minutesAgo(i) }))
      install(rows)
      const first = await closedPage()
      expect(first.incidents).toHaveLength(50)
      expect(first.has_more).toBe(true)
      expect(first.next_offset).toBe(50)
      const capped = await closedPage('?limit=500')
      expect(capped.incidents).toHaveLength(100)
      expect(capped.has_more).toBe(true)
    })

    it('400s on a limit or offset that is not a whole number', async () => {
      install([])
      expect((await get('/incidents?limit=abc')).status).toBe(400)
      expect((await get('/incidents?limit=0')).status).toBe(400)
      expect((await get('/incidents?offset=-1')).status).toBe(400)
      expect((await get('/incidents?offset=1.5')).status).toBe(400)
    })

    it('returns what the card needs and none of the bookkeeping', async () => {
      install([incident({ started_at: minutesAgo(120), ended_at: minutesAgo(28), pages_sent: 3 })])
      const [row] = (await closedPage()).incidents
      expect(Object.keys(row).sort()).toEqual([
        'duration', 'ended_at', 'id', 'pages_sent', 'scope', 'signal', 'signal_known', 'signal_label', 'started_at', 'state', 'subject_name',
      ])
      expect(row).toMatchObject({
        signal: 'volume-cliff',
        signal_label: 'Volume cliff',
        signal_known: true,
        subject_name: 'Engine Bidding Workflow',
        state: 'ended',
        ended_at: minutesAgo(28),
        duration: '1 hour 32 minutes',
        pages_sent: 3,
      })
    })

    it('reads a lapsed incident as end not recorded, with no duration', async () => {
      install([incident({ ended_reason: 'lapsed' })])
      expect((await closedPage()).incidents[0]).toMatchObject({ state: 'end_not_recorded', ended_at: null, duration: null })
    })

    it('reports the window for an incident shorter than the window its check judges', async () => {
      install([incident({ started_at: minutesAgo(60), ended_at: minutesAgo(58), window_minutes: 4 })])
      expect((await closedPage()).incidents[0].duration).toBe('Within one 4 minute window')
    })

    it('measures an incident longer than its window', async () => {
      install([incident({ started_at: minutesAgo(60), ended_at: minutesAgo(10), window_minutes: 4 })])
      expect((await closedPage()).incidents[0].duration).toBe('50 minutes')
    })

    it('reads the production row whose end was recorded before its start as under a minute', async () => {
      install([incident({ signal: 'db-unreachable', subject: ORG_A, subject_label: 'Bidspoke', started_at: '2026-10-14T21:48:37.000Z', ended_at: '2026-10-14T21:48:01.000Z' })])
      vi.setSystemTime(Date.parse('2026-10-14T23:00:00.000Z'))
      expect((await closedPage()).incidents[0].duration).toBe('under a minute')
    })
  })

  describe('the ongoing line', () => {
    it('lists every open incident, newest start first, with how long it has run so far', async () => {
      const older = open({ started_at: minutesAgo(80), signal: 'partner-reachability', scope: 'platform', subject: 'api.tripoint.com', subject_label: 'api.tripoint.com', pages_sent: 1 })
      const newer = open({ started_at: minutesAgo(30), pages_sent: 2 })
      const ancient = open({ started_at: daysAgo(120) })
      install([older, newer, ancient, incident({})])
      const body = await ongoingList()
      expect(body.incidents.map((i) => i.id)).toEqual([newer.id, older.id, ancient.id])
      expect(body.has_more).toBe(false)
      expect(body.incidents[1]).toEqual({
        id: older.id,
        signal: 'partner-reachability',
        signal_label: 'Partner reachability',
        signal_known: true,
        subject_name: 'api.tripoint.com',
        scope: 'platform',
        started_at: minutesAgo(80),
        so_far: '1 hour 20 minutes so far',
        pages_sent: 1,
      })
    })

    it('names the window while an open incident is inside its first one', async () => {
      install([open({ started_at: minutesAgo(2), window_minutes: 5 })])
      expect((await ongoingList()).incidents[0].so_far).toBe('within its first 5 minute window')
    })
  })

  describe('the subject by name', () => {
    it('uses the label the check recorded', async () => {
      install([incident({ signal: 'failure-rate', subject: `${WF_A}:ACRO_GATEWAY`, subject_label: 'Engine Bidding Workflow: "ACRO_GATEWAY"' })])
      expect((await closedPage()).incidents[0].subject_name).toBe('Engine Bidding Workflow: "ACRO_GATEWAY"')
    })

    it("reads a workflow keyed subject's name from the workflow when no label was recorded", async () => {
      install([
        incident({ signal: 'slow-spike', subject: WF_A, subject_label: null }),
        incident({ signal: 'field-presence-drought', subject: `${WF_A} steps.lead.output.id`, subject_label: null, started_at: minutesAgo(200) }),
      ])
      const names = (await closedPage()).incidents.map((i) => i.subject_name)
      expect(names).toEqual(['Engine Bidding Workflow', 'Engine Bidding Workflow steps.lead.output.id'])
    })

    it('marks a deleted workflow as deleted, on the card and on the ongoing line', async () => {
      install([
        incident({ subject: WF_A_DELETED, subject_label: 'Old Main Flow' }),
        incident({ signal: 'slow-spike', subject: WF_A_DELETED, subject_label: null, started_at: minutesAgo(300) }),
        open({ subject: WF_A_DELETED, subject_label: 'Old Main Flow' }),
      ])
      expect((await closedPage()).incidents.map((i) => i.subject_name)).toEqual(['Old Main Flow (deleted)', 'Old Main Flow (deleted)'])
      expect((await ongoingList()).incidents.map((i) => i.subject_name)).toEqual(['Old Main Flow (deleted)'])
    })

    it("never shows a raw id: not for a workflow no longer on record, nor another organization's workflow", async () => {
      install([
        incident({ subject: 'aaaaaaaa-0000-4000-8000-00000000dead', subject_label: null }),
        incident({ subject: WF_B, subject_label: null, started_at: minutesAgo(300) }),
        incident({ signal: 'db-unreachable', subject: ORG_A, subject_label: null, started_at: minutesAgo(400) }),
        incident({ signal: 'stored-copy-serving', scope: 'platform', subject: '3f2c9a10-1111-4111-8111-000000000000', subject_label: null, started_at: minutesAgo(500) }),
      ])
      const names = (await closedPage()).incidents.map((i) => i.subject_name)
      for (const n of names) expect(n).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
      expect(names).toEqual(['A workflow no longer on record', 'A workflow no longer on record', 'This organization', 'Unnamed subject'])
    })

    it('names an unrecognised signal as such and keeps its raw key', async () => {
      install([incident({ signal: 'retired-check', scope: 'platform', subject: 'some-job', subject_label: null })])
      const [row] = (await closedPage()).incidents
      expect(row).toMatchObject({ signal: 'retired-check', signal_label: 'Unrecognised signal', signal_known: false, subject_name: 'some-job' })
    })

    it('looks workflows up inside the caller organization only', async () => {
      const fake = install([incident({ signal: 'slow-spike', subject: WF_A, subject_label: null })])
      await closedPage()
      const wf = fake.sent.find((s) => s.table === 'workflows')
      expect(wf?.calls).toContainEqual(['eq', ['organization_id', ORG_A]])
    })

    it('reads no workflows when no row is keyed on one', async () => {
      const fake = install([incident({ signal: 'pg-cron-watch', scope: 'platform', subject: 'purge', subject_label: 'purge' })])
      await closedPage()
      expect(fake.sent.some((s) => s.table === 'workflows')).toBe(false)
    })
  })

  describe('a failed read is an error, never an empty list', () => {
    const rows = () => [incident({ signal: 'slow-spike', subject_label: null }), open({ signal: 'slow-spike', subject_label: null })]
    for (const [path, which] of [['/incidents', 'closed'], ['/incidents', 'workflows'], ['/incidents/ongoing', 'open'], ['/incidents/ongoing', 'workflows']] as const) {
      it(`${path} 500s with a message when the ${which} read fails`, async () => {
        install(rows(), { fail: { [which]: 'canceling statement due to statement timeout' } })
        const res = await get(path)
        expect(res.status).toBe(500)
        const body = (await res.json()) as Record<string, unknown>
        expect(typeof body.error).toBe('string')
        expect((body.error as string).length).toBeGreaterThan(0)
        expect(body.incidents).toBeUndefined()
      })
    }
  })
})
