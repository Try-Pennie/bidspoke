/**
 * The ops database client and its one organization scoped read (#1709, plan 0.E).
 *
 * The ops project ("Bidspoke Ops") holds ops run data, and every table in it
 * carries organization_id uuid NOT NULL. The ops Worker connects as service_role,
 * which bypasses RLS, so the organization filter is the code's job: every read
 * goes through readOpsRows, which takes an OrganizationId by type and always
 * filters on it (a scan in apps/web keeps every other `.from(` off the client).
 * The client carries the same local dev write guard as the bidding client (#669).
 */
import { describe, expect, it } from 'vitest'
import {
  OPS_READ_ROW_CAP,
  OPS_STATEMENT_DEADLINE_MS,
  OpsDatabaseConfigError,
  OpsReadError,
  OpsReadTimeoutError,
  createOpsSupabaseClient,
  organizationIdFrom,
  readOpsRows,
  type OpsDbEnv,
  type OrganizationId,
} from '../ops-db'

const OPS_URL = 'https://zwihpjxouklvkvngkvmw.supabase.co'
const LOCAL_URL = 'http://127.0.0.1:54330'
const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const OTHER_ORG = '0a0b0c0d-1111-4222-8333-444455556666'

const envWith = (over: Partial<OpsDbEnv> = {}): OpsDbEnv => ({
  OPS_SUPABASE_URL: OPS_URL,
  OPS_SUPABASE_SECRET_KEY: 'test-ops-service-role-key',
  ...over,
})

/** A fetch that records each request and answers with the rows given (or an error). */
function recordingFetch(answer: { rows?: unknown[]; status?: number; error?: Record<string, unknown> } = {}) {
  const urls: URL[] = []
  const methods: string[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    urls.push(url)
    methods.push(init?.method ?? (input instanceof Request ? input.method : 'GET'))
    if (answer.error) return Response.json(answer.error, { status: answer.status ?? 400 })
    return Response.json(answer.rows ?? [], { status: 200 })
  }) as typeof fetch
  return { f, urls, methods }
}

describe('createOpsSupabaseClient', () => {
  it('refuses by name when OPS_SUPABASE_URL is unset or blank', () => {
    for (const value of [undefined, '', '   ']) {
      expect(() => createOpsSupabaseClient(envWith({ OPS_SUPABASE_URL: value }))).toThrow(OpsDatabaseConfigError)
      expect(() => createOpsSupabaseClient(envWith({ OPS_SUPABASE_URL: value }))).toThrow(/OPS_SUPABASE_URL is not set/)
    }
  })

  it('refuses by name when OPS_SUPABASE_SECRET_KEY is unset or blank', () => {
    for (const value of [undefined, '', '  ']) {
      expect(() => createOpsSupabaseClient(envWith({ OPS_SUPABASE_SECRET_KEY: value }))).toThrow(/OPS_SUPABASE_SECRET_KEY is not set/)
    }
  })

  it('refuses a URL naming the bidding database, so the ops Worker can never hold a client of it', () => {
    expect(() => createOpsSupabaseClient(envWith({ OPS_SUPABASE_URL: 'https://xvrmivmpfykwwtriqwpg.supabase.co' }))).toThrow(
      /OPS_SUPABASE_URL names the bidding database/,
    )
  })

  it('refuses a URL that does not parse', () => {
    expect(() => createOpsSupabaseClient(envWith({ OPS_SUPABASE_URL: 'not a url' }))).toThrow(/OPS_SUPABASE_URL is not a URL/)
  })

  describe('local dev pointed at the remote ops database, no opt in (#669)', () => {
    const env = envWith({ LOCAL_DEV: 'true' })

    it.each(['insert', 'update', 'upsert'] as const)('refuses %s, naming the table and the opt in', (method) => {
      const db = createOpsSupabaseClient(env)
      const builder = db.from('ops_runs') as unknown as Record<string, (row: unknown) => unknown>
      expect(() => builder[method]({ organization_id: ORG })).toThrow(/Blocked .*\(\) on 'ops_runs'.*ALLOW_PROD_WRITES/)
    })

    it('refuses delete', () => {
      const db = createOpsSupabaseClient(env)
      expect(() => db.from('ops_runs').delete()).toThrow(/ALLOW_PROD_WRITES/)
    })

    it('still allows a read', () => {
      const db = createOpsSupabaseClient(env)
      expect(() => db.from('ops_runs').select('*')).not.toThrow()
    })

    it('refuses a mutating rpc, and an unclassified one naming the ops list (#1948)', () => {
      const db = createOpsSupabaseClient(env)
      expect(() => db.rpc('claim_run_requests' as never, {} as never)).toThrow(/Blocked rpc\('claim_run_requests'\).*on the mutating list.*ALLOW_PROD_WRITES/)
      expect(() => db.rpc('anything' as never, {} as never)).toThrow(/Blocked rpc\('anything'\).*ops-rpcs\.ts/)
    })

    it('allows the read only rpc', () => {
      const db = createOpsSupabaseClient(env)
      expect(() => db.rpc('run_queue_disagreements' as never, { p_limit: 1 } as never)).not.toThrow()
    })
  })

  it('allows writes in local dev when ALLOW_PROD_WRITES opts in', () => {
    const db = createOpsSupabaseClient(envWith({ LOCAL_DEV: 'true', ALLOW_PROD_WRITES: 'true' }))
    expect(() => db.from('ops_runs').insert({ organization_id: ORG })).not.toThrow()
  })

  it('allows writes in local dev against a local ops database', () => {
    const db = createOpsSupabaseClient(envWith({ LOCAL_DEV: 'true', OPS_SUPABASE_URL: LOCAL_URL }))
    expect(() => db.from('ops_runs').insert({ organization_id: ORG })).not.toThrow()
  })

  it('is inert on the deployed Worker, where LOCAL_DEV is unset', () => {
    const db = createOpsSupabaseClient(envWith())
    expect(() => db.from('ops_runs').insert({ organization_id: ORG })).not.toThrow()
    expect(() => db.rpc('anything' as never, {} as never)).not.toThrow()
  })
})

describe('organizationIdFrom', () => {
  it('accepts a uuid', () => {
    const id: OrganizationId = organizationIdFrom(ORG)
    expect(id).toBe(ORG)
  })

  it.each([[''], ['not-a-uuid'], [`${ORG} `], [null], [undefined], [42]])('refuses %j by name', (value) => {
    expect(() => organizationIdFrom(value)).toThrow(/organization id must be a uuid/)
  })
})

describe('readOpsRows', () => {
  const orgId = organizationIdFrom(ORG)

  it('reads one table filtered on the organization, with the columns and the limit asked for', async () => {
    const { f, urls, methods } = recordingFetch({ rows: [{ id: 'r1', organization_id: ORG }] })
    const db = createOpsSupabaseClient(envWith(), { fetch: f })

    const result = await readOpsRows<{ id: string }>(db, orgId, { table: 'ops_runs', columns: 'id,organization_id', limit: 50 })

    expect(result).toEqual({ rows: [{ id: 'r1', organization_id: ORG }], reachedLimit: false })
    expect(methods).toEqual(['GET'])
    expect(urls[0].origin + urls[0].pathname).toBe(`${OPS_URL}/rest/v1/ops_runs`)
    expect(urls[0].searchParams.get('organization_id')).toBe(`eq.${ORG}`)
    expect(urls[0].searchParams.get('select')).toBe('id,organization_id')
    expect(urls[0].searchParams.get('limit')).toBe('50')
  })

  it('adds organization_id to the columns when the caller left it out, so every row can be checked', async () => {
    const { f, urls } = recordingFetch({ rows: [{ id: 'r1', organization_id: ORG }] })
    const db = createOpsSupabaseClient(envWith(), { fetch: f })
    await readOpsRows(db, orgId, { table: 'ops_runs', columns: 'id,status', limit: 10 })
    expect(urls[0].searchParams.get('select')).toBe('id,status,organization_id')
  })

  it('adds organization_id when only an embedded resource names it, since that is not the row\'s own column', async () => {
    const { f, urls } = recordingFetch({ rows: [{ id: 'r1', organization_id: ORG, steps: [] }] })
    const db = createOpsSupabaseClient(envWith(), { fetch: f })
    await readOpsRows(db, orgId, { table: 'ops_runs', columns: 'id,steps(id,organization_id,status)', limit: 10 })
    expect(urls[0].searchParams.get('select')).toBe('id,steps(id,organization_id,status),organization_id')
  })

  it('does not add organization_id again when the row\'s own columns name it beside an embedded resource', async () => {
    const { f, urls } = recordingFetch({ rows: [{ id: 'r1', organization_id: ORG, steps: [] }] })
    const db = createOpsSupabaseClient(envWith(), { fetch: f })
    await readOpsRows(db, orgId, { table: 'ops_runs', columns: 'steps(id), organization_id ,id', limit: 10 })
    expect(urls[0].searchParams.get('select')).toBe('steps(id),organization_id,id')
  })

  it('applies the caller\'s filters after the organization filter, which they cannot remove', async () => {
    const { f, urls } = recordingFetch({ rows: [] })
    const db = createOpsSupabaseClient(envWith(), { fetch: f })
    await readOpsRows(db, orgId, {
      table: 'ops_runs',
      columns: '*',
      limit: 10,
      refine: (q) => q.eq('status', 'failed').order('started_at', { ascending: false }),
    })
    expect(urls[0].searchParams.get('organization_id')).toBe(`eq.${ORG}`)
    expect(urls[0].searchParams.get('status')).toBe('eq.failed')
    expect(urls[0].searchParams.get('order')).toBe('started_at.desc')
  })

  it('refuses an organization id that is not a uuid even when the type was forced, before any request', async () => {
    const { f, urls } = recordingFetch()
    const db = createOpsSupabaseClient(envWith(), { fetch: f })
    await expect(readOpsRows(db, '' as OrganizationId, { table: 'ops_runs', columns: '*', limit: 10 })).rejects.toThrow(/organization id must be a uuid/)
    expect(urls).toEqual([])
  })

  it.each([0, -1, 1.5, OPS_READ_ROW_CAP + 1])('refuses a limit of %s, because the platform caps a read at 1000 rows', async (limit) => {
    const { f, urls } = recordingFetch()
    const db = createOpsSupabaseClient(envWith(), { fetch: f })
    await expect(readOpsRows(db, orgId, { table: 'ops_runs', columns: '*', limit })).rejects.toThrow(/limit must be a whole number from 1 to 1000/)
    expect(urls).toEqual([])
  })

  it('says when the read stopped at its limit, so a caller cannot take a capped read for all of it', async () => {
    const rows = [{ organization_id: ORG }, { organization_id: ORG }]
    const { f } = recordingFetch({ rows })
    const db = createOpsSupabaseClient(envWith(), { fetch: f })
    expect((await readOpsRows(db, orgId, { table: 'ops_runs', columns: '*', limit: 2 })).reachedLimit).toBe(true)
  })

  it('throws on a database error, naming the table and the code, rather than answering no rows', async () => {
    const { f } = recordingFetch({ status: 404, error: { code: '42P01', message: 'relation "public.ops_nope" does not exist', details: null, hint: null } })
    const db = createOpsSupabaseClient(envWith(), { fetch: f })
    const read = readOpsRows(db, orgId, { table: 'ops_nope', columns: '*', limit: 10 })
    await expect(read).rejects.toThrow(OpsReadError)
    await expect(readOpsRows(db, orgId, { table: 'ops_nope', columns: '*', limit: 10 })).rejects.toThrow(/ops_nope.*42P01/)
  })

  it('throws when a row of another organization comes back, and returns none of them', async () => {
    const { f } = recordingFetch({ rows: [{ id: 'mine', organization_id: ORG }, { id: 'theirs', organization_id: OTHER_ORG }] })
    const db = createOpsSupabaseClient(envWith(), { fetch: f })
    await expect(readOpsRows(db, orgId, { table: 'ops_runs', columns: '*', limit: 10 })).rejects.toThrow(/ops_runs returned a row of another organization/)
  })

  it('refuses a blank table or column list by name', async () => {
    const { f } = recordingFetch()
    const db = createOpsSupabaseClient(envWith(), { fetch: f })
    await expect(readOpsRows(db, orgId, { table: ' ', columns: '*', limit: 1 })).rejects.toThrow(/table is required/)
    await expect(readOpsRows(db, orgId, { table: 'ops_runs', columns: '', limit: 1 })).rejects.toThrow(/columns are required/)
  })

  describe('its deadline (#2505, L110)', () => {
    /** A fetch that never answers until its request is aborted, counting the requests still open. */
    function hangingFetch() {
      let sent = 0
      let open = 0
      const f = ((_input: string | URL | Request, init?: RequestInit) => {
        sent++
        open++
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            open--
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
      }) as typeof fetch
      return { f, sent: () => sent, open: () => open }
    }

    /** The one wait the deadline asks for, ended only when the test says so (L524). */
    function heldDelay() {
      const asked: number[] = []
      let end: () => void = () => { throw new Error('the deadline was never asked for') }
      const delay = (ms: number) => {
        asked.push(ms)
        return new Promise<void>((resolve) => { end = resolve })
      }
      return { delay, asked, end: () => end() }
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

    it('refuses a hung read by name once its deadline passes, and leaves no request running', async () => {
      const hung = hangingFetch()
      const timer = heldDelay()
      const db = createOpsSupabaseClient(envWith(), { fetch: hung.f })

      const pending = readOpsRows(db, orgId, { table: 'ops_runs', columns: '*', limit: 10 }, { delay: timer.delay })
      // Handler attached before the deadline is ended, so the rejection is never unhandled (L749).
      let outcome: unknown = 'pending'
      void pending.then(() => { outcome = 'resolved' }, (err: unknown) => { outcome = err })
      await settle()
      expect(outcome).toBe('pending')
      expect(hung.open()).toBe(1)
      expect(timer.asked).toEqual([OPS_STATEMENT_DEADLINE_MS])

      timer.end()
      // One turn of the event loop: a read the deadline does not abort is still pending here.
      await settle()
      expect(outcome).toBeInstanceOf(OpsReadTimeoutError)
      expect(outcome).toBeInstanceOf(OpsReadError)
      expect(String(outcome)).toMatch(/OpsReadTimeoutError: An ops read of ops_runs passed its 9000 ms deadline/)
      expect(hung.sent()).toBe(1)
      expect(hung.open()).toBe(0)
    })

    it('answers a read that comes back in time, and a deadline ending later changes nothing', async () => {
      const { f } = recordingFetch({ rows: [{ id: 'r1', organization_id: ORG }] })
      const timer = heldDelay()
      const db = createOpsSupabaseClient(envWith(), { fetch: f })
      const result = await readOpsRows(db, orgId, { table: 'ops_runs', columns: '*', limit: 10 }, { delay: timer.delay })
      timer.end()
      await settle()
      expect(result.rows).toEqual([{ id: 'r1', organization_id: ORG }])
    })

    it('takes the deadline a caller names', async () => {
      const hung = hangingFetch()
      const timer = heldDelay()
      const db = createOpsSupabaseClient(envWith(), { fetch: hung.f })
      const pending = readOpsRows(db, orgId, { table: 'ops_runs', columns: '*', limit: 10 }, { deadlineMs: 250, delay: timer.delay })
      let outcome: unknown = 'pending'
      void pending.then(() => { outcome = 'resolved' }, (err: unknown) => { outcome = err })
      await settle()
      expect(timer.asked).toEqual([250])
      timer.end()
      await settle()
      expect(String(outcome)).toMatch(/passed its 250 ms deadline/)
    })

    it('sets its deadline past the ops project\'s 8 s statement timeout, so the database gives up first', () => {
      expect(OPS_STATEMENT_DEADLINE_MS).toBeGreaterThan(8_000)
      expect(OPS_STATEMENT_DEADLINE_MS).toBeLessThan(60_000)
    })
  })
})
