/**
 * The real store and the real Salesforce port behind the replay tool (#471).
 *
 * The store's predicates are what make a replay send once and stay inside the
 * caller's organization, so the statements are asserted as built. The port is
 * driven through a stubbed fetch, with the token already cached.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'

vi.mock('../env-loader', () => ({ loadEnvVars: vi.fn() }))
import { loadEnvVars } from '../env-loader'
import { supabaseHeldWriteStore, salesforcePortFor } from '../writeback-replay'
import { SALESFORCE_BULKHEAD_KEY } from '../bulkhead-client'
import { fakeBulkheads } from '../../__tests__/helpers/fake-bulkheads'
import { isSalesforceBulkheadShed } from '../../engine/nodes/salesforce'
import { fakePostgrest } from '../../__tests__/helpers/postgrest-fake'

interface Built { table: string; op: string; columns?: string; patch?: unknown; filters: Array<[string, string, unknown]> }

function recordingDb(answer: { data: unknown; error: unknown } = { data: [{ id: 'w-1' }], error: null }) {
  const built: Built[] = []
  const client = {
    from(table: string) {
      const q: Built = { table, op: 'select', filters: [] }
      built.push(q)
      const chain: Record<string, unknown> = {
        select(cols?: string) { if (q.op === 'select') q.columns = cols; return chain },
        update(patch: unknown) { q.op = 'update'; q.patch = patch; return chain },
        eq(c: string, v: unknown) { q.filters.push(['eq', c, v]); return chain },
        order() { return chain },
        range() { return chain },
        limit() { return chain },
        maybeSingle() { return Promise.resolve({ data: { id: 'w-1' }, error: null }) },
        then(res: (v: unknown) => unknown) { return Promise.resolve(answer).then(res) },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, built }
}

const eqs = (b: Built) => Object.fromEntries(b.filters.map(([, c, v]) => [c, v]))

describe('supabaseHeldWriteStore', () => {
  it('reads a row only inside the caller\'s organization', async () => {
    const db = recordingDb()
    await supabaseHeldWriteStore(db.client).get('org-1', 'w-1')
    expect(eqs(db.built[0])).toEqual({ organization_id: 'org-1', id: 'w-1' })
  })

  it('claims only a pending row at the attempt count it read, inside the organization', async () => {
    const db = recordingDb()
    expect(await supabaseHeldWriteStore(db.client).claim('org-1', 'w-1', 2)).toBe(true)
    expect(db.built[0]).toMatchObject({ op: 'update', patch: { attempts: 3 } })
    expect(eqs(db.built[0])).toEqual({ organization_id: 'org-1', id: 'w-1', status: 'pending', attempts: 2 })
  })

  it('reports a lost claim as false, not as an error', async () => {
    const db = recordingDb({ data: [], error: null })
    expect(await supabaseHeldWriteStore(db.client).claim('org-1', 'w-1', 2)).toBe(false)
  })

  it('throws on a real database error rather than reading it as a lost claim', async () => {
    const db = recordingDb({ data: null, error: { code: '57014', message: 'statement timeout' } })
    await expect(supabaseHeldWriteStore(db.client).claim('org-1', 'w-1', 2)).rejects.toThrow(/statement timeout/)
  })

  it('writes an outcome only while the row still holds the claim', async () => {
    const db = recordingDb()
    await supabaseHeldWriteStore(db.client).finish('w-1', 3, { status: 'replayed' })
    expect(eqs(db.built[0])).toEqual({ id: 'w-1', status: 'pending', attempts: 3 })
  })

  it('lists without any encrypted column, inside the organization', async () => {
    const db = recordingDb({ data: [], error: null })
    await supabaseHeldWriteStore(db.client).list('org-1', 'pending')
    expect(db.built[0].columns).not.toMatch(/encrypted/)
    expect(eqs(db.built[0])).toEqual({ organization_id: 'org-1', status: 'pending' })
  })
})

describe('listing held writes past the row cap (#1437)', () => {
  // A dead letter table grows during a Salesforce outage, so the list must reach
  // every row however many there are, through PostgREST's 1,000 row cap. Many
  // rows share one created_at, so only the id tiebreaker keeps the pages whole.
  const rows = Array.from({ length: 2_500 }, (_, i) => ({
    id: `dl-${String(i).padStart(5, '0')}`,
    organization_id: i % 10 === 0 ? 'org-2' : 'org-1',
    workflow_id: 'wf-1', execution_id: `run-${i}`, step_namespace: 'sf', sf_object: 'Prospect__c', sf_record_id: null,
    sf_operation: 'update', error_type: 'transient', replayable: true,
    status: i % 3 === 0 ? 'replayed' : 'pending', attempts: 0,
    created_at: `2026-10-1${i % 7}T00:00:00.000Z`, updated_at: '2026-10-19T00:00:00.000Z', finished_at: null,
  }))

  it('returns every row of the organization, each once, with no status filter', async () => {
    const db = fakePostgrest({ outcome_writeback_deadletters: rows.map((r) => ({ ...r })) }, {}, { rowCap: 1_000 })
    const listed = await supabaseHeldWriteStore(db.client).list('org-1')
    const want = rows.filter((r) => r.organization_id === 'org-1')
    expect(want.length).toBeGreaterThan(1_000)
    expect(new Set(listed.map((r) => r.id)).size).toBe(want.length)
    expect(listed).toHaveLength(want.length)
  })

  it('returns every row of one status, each once', async () => {
    const db = fakePostgrest({ outcome_writeback_deadletters: rows.map((r) => ({ ...r })) }, {}, { rowCap: 1_000 })
    const listed = await supabaseHeldWriteStore(db.client).list('org-1', 'pending')
    const want = rows.filter((r) => r.organization_id === 'org-1' && r.status === 'pending')
    expect(want.length).toBeGreaterThan(1_000)
    expect(listed.map((r) => r.id).sort()).toEqual(want.map((r) => r.id).sort())
  })
})

describe('salesforcePortFor', () => {
  afterEach(() => vi.unstubAllGlobals())

  function kv() {
    const store = new Map<string, string>([['sf-token-org-1', 'cached-token']])
    return {
      store,
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    }
  }

  it('refuses to build without the workflow\'s Salesforce credentials, naming them', async () => {
    vi.mocked(loadEnvVars).mockResolvedValue({ SALESFORCE_INSTANCE_URL: 'https://sf.example' })
    const env = { WORKFLOW_CACHE: kv() } as unknown as Env
    await expect(salesforcePortFor(env, {} as SupabaseClient, 'k', 'org-1', 'wf-1')).rejects.toThrow(/SALESFORCE_CLIENT_ID/)
  })

  it('sends once more with a fresh login when the cached token was revoked', async () => {
    vi.mocked(loadEnvVars).mockResolvedValue({ SALESFORCE_INSTANCE_URL: 'https://sf.example/', SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret' })
    const cache = kv()
    const calls: Array<{ url: string; auth?: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>
      calls.push({ url, auth: headers.Authorization, body: init.body })
      if (url.endsWith('/services/oauth2/token')) return new Response(JSON.stringify({ access_token: 'fresh-token' }), { status: 200 })
      return headers.Authorization === 'Bearer cached-token'
        ? new Response('[{"errorCode":"INVALID_SESSION_ID"}]', { status: 401 })
        : new Response(null, { status: 204 })
    }))
    const port = await salesforcePortFor({ WORKFLOW_CACHE: cache } as unknown as Env, {} as SupabaseClient, 'k', 'org-1', 'wf-1')
    const res = await port.send('PATCH', '/sobjects/Submission__c/a04Ui00000NkhG1IAJ', '{"A__c":1}')
    expect(res.status).toBe(204)
    const sends = calls.filter((c) => c.url.includes('/sobjects/'))
    expect(sends.map((c) => c.auth)).toEqual(['Bearer cached-token', 'Bearer fresh-token'])
    expect(sends[0].url).toBe('https://sf.example/services/data/v60.0/sobjects/Submission__c/a04Ui00000NkhG1IAJ')
    expect(sends[1].body).toBe('{"A__c":1}')
  })

  // #2172: the read-back's one resend of a credit inquiry post goes to the Apex
  // REST path under the instance, not under the data API, as a POST.
  it('posts to an Apex REST path under the instance, with the same fresh login on a revoked token', async () => {
    vi.mocked(loadEnvVars).mockResolvedValue({ SALESFORCE_INSTANCE_URL: 'https://sf.example/', SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret' })
    const calls: Array<{ url: string; method?: string; auth?: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>
      calls.push({ url, method: init.method, auth: headers.Authorization, body: init.body })
      if (url.endsWith('/services/oauth2/token')) return new Response(JSON.stringify({ access_token: 'fresh-token' }), { status: 200 })
      return headers.Authorization === 'Bearer cached-token'
        ? new Response('[{"errorCode":"INVALID_SESSION_ID"}]', { status: 401 })
        : new Response('{"statusCode":"200"}', { status: 200 })
    }))
    const port = await salesforcePortFor({ WORKFLOW_CACHE: kv() } as unknown as Env, {} as SupabaseClient, 'k', 'org-1', 'wf-1')
    const res = await port.postApex('/services/apexrest/credit-inquiries', '{"submissionId":"a"}')
    expect(res.status).toBe(200)
    const sends = calls.filter((c) => c.url.includes('/apexrest/'))
    expect(sends.map((c) => [c.url, c.method, c.auth])).toEqual([
      ['https://sf.example/services/apexrest/credit-inquiries', 'POST', 'Bearer cached-token'],
      ['https://sf.example/services/apexrest/credit-inquiries', 'POST', 'Bearer fresh-token'],
    ])
    expect(sends[1].body).toBe('{"submissionId":"a"}')
  })

  // #2170 part B: the replay and the read-back run on their own schedule, outside
  // any run's post-answer window, so they take the main key only, never the
  // post-answer share; the read-back waits 0 for it (#2172 resends through here).
  it('takes only the main bulkhead key for an Apex post, and a full one sheds it at once with a wait of 0', async () => {
    vi.mocked(loadEnvVars).mockResolvedValue({ SALESFORCE_INSTANCE_URL: 'https://sf.example/', SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret' })
    const fetchMock = vi.fn(async () => new Response('{"statusCode":"200"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const open = fakeBulkheads()
    const port = await salesforcePortFor({ WORKFLOW_CACHE: kv(), SALESFORCE_BULKHEAD: open.namespace } as unknown as Env, {} as SupabaseClient, 'k', 'org-1', 'wf-1', { waitMs: 0 })
    expect((await port.postApex('/services/apexrest/credit-inquiries', '{}')).status).toBe(200)
    expect(open.acquires).toEqual([SALESFORCE_BULKHEAD_KEY])

    const full = fakeBulkheads({ seed: { [SALESFORCE_BULKHEAD_KEY]: 20 } })
    const shedPort = await salesforcePortFor({ WORKFLOW_CACHE: kv(), SALESFORCE_BULKHEAD: full.namespace } as unknown as Env, {} as SupabaseClient, 'k', 'org-1', 'wf-1', { waitMs: 0 })
    await expect(shedPort.postApex('/services/apexrest/credit-inquiries', '{}')).rejects.toThrow(/Salesforce bulkhead: at capacity \(salesforce,/)
    expect(full.acquires).toEqual([SALESFORCE_BULKHEAD_KEY])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // The drain and the replay give an attempt back for a call the bulkhead
  // refused before sending (#468), so the refusal must carry its mark through
  // the port, not only its wording.
  it('marks a send the full bulkhead refused, so the replay can tell it from no answer', async () => {
    vi.mocked(loadEnvVars).mockResolvedValue({ SALESFORCE_INSTANCE_URL: 'https://sf.example/', SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret' })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const full = fakeBulkheads({ seed: { [SALESFORCE_BULKHEAD_KEY]: 20 } })
    const shedPort = await salesforcePortFor({ WORKFLOW_CACHE: kv(), SALESFORCE_BULKHEAD: full.namespace } as unknown as Env, {} as SupabaseClient, 'k', 'org-1', 'wf-1', { waitMs: 0 })
    const caught = await shedPort.send('PATCH', '/sobjects/Lead/00Q000000000001AAA', '{}').then(() => null, (e: unknown) => e)
    expect(isSalesforceBulkheadShed(caught)).toBe(true)
    // The token is cached, so nothing went out: the PATCH never left.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a path that is not a plain Apex REST path, sending nothing', async () => {
    vi.mocked(loadEnvVars).mockResolvedValue({ SALESFORCE_INSTANCE_URL: 'https://sf.example/', SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const port = await salesforcePortFor({ WORKFLOW_CACHE: kv() } as unknown as Env, {} as SupabaseClient, 'k', 'org-1', 'wf-1')
    await expect(port.postApex('/services/data/v60.0/sobjects/Lead', '{}')).rejects.toThrow(/not an Apex REST path/)
    await expect(port.postApex('/services/apexrest/credit-inquiries?x=1', '{}')).rejects.toThrow(/not an Apex REST path/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
