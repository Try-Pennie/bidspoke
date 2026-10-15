/**
 * A failing reconfirm of the partner constants copy is visible (#2132, L357).
 *
 * The per minute prewarm is the only thing that rewrites the 30 day partner
 * constants copy from the rows, once its last good copy is five minutes old,
 * and that is the bound on how soon bidding sees a change the page did not make
 * (BIDDING_PICKUP). It discarded keepPartnerConstantsConfirmed's 'failed'
 * answer, and returned quietly when its read of the active workflows errored,
 * so on a day when reconfirms failed nothing said the bound had stopped
 * holding. Now each is logged with the org and recorded, and a detector pages
 * once every reconfirm for an org has failed for two reconfirm intervals.
 *
 * Every clock here is set, never waited on (L290): Date is faked and moved a
 * simulated minute at a time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prewarmKvCaches } from '../cache-prewarm'
import {
  PARTNER_CONSTANTS_RECONFIRM_JOB,
  RECONFIRM_ALERT_AFTER_MS,
  RECONFIRM_OBSERVE_FOR_MS,
  RECONFIRM_OBSERVING_SINCE_KEY,
  RECONFIRM_STATE_KEY,
  WORKFLOWS_SUBJECT,
  readReconfirmState,
} from '../partner-constants-reconfirm'
import { STORED_COPY_RECONFIRM_AFTER_MS } from '../stored-copy-age'
import { STORED_COPY_LEDGER_PREFIX } from '../stored-copy-ledger'
import type { Env } from '../../index'

const MINUTE = 60_000
const START = Date.parse('2026-10-15T12:00:00.000Z')

interface Answers {
  workflows?: { data: unknown; error: { message: string } | null }
  partner_configs?: { data: unknown; error: { message: string } | null }
}

function fakeSupabase(answers: Answers) {
  const answer = (table: string) => {
    if (table === 'workflows') return answers.workflows ?? { data: [{ id: 'wf-1', organization_id: 'org-1' }], error: null }
    if (table === 'partner_configs') return answers.partner_configs ?? { data: [{ id: 'p-1', slug: 'tripoint', is_active: true }], error: null }
    if (table === 'partner_uuid_map') return { data: [], error: null }
    if (table === 'buyer_profiles') return { data: [], error: null }
    return { data: null, error: { message: `table ${table} is not part of this test` } }
  }
  return {
    from(table: string) {
      const result = answer(table)
      const builder: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject)
          if (prop === 'single' || prop === 'maybeSingle') return async () => result
          return () => builder
        },
      })
      return builder
    },
    rpc: async () => ({ data: null, error: { message: 'rpc is not part of this test' } }),
  } as never
}

function fakeKv() {
  const store = new Map<string, { value: string; metadata?: unknown }>()
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const hit = store.get(key)
      if (!hit) return null
      return type === 'json' ? JSON.parse(hit.value) : hit.value
    }),
    getWithMetadata: vi.fn(async (key: string) => {
      const hit = store.get(key)
      return { value: hit?.value ?? null, metadata: hit?.metadata ?? null }
    }),
    put: vi.fn(async (key: string, value: string, opts?: { metadata?: unknown }) => { store.set(key, { value, metadata: opts?.metadata }) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
    list: vi.fn(async (opts?: { prefix?: string }) => ({
      keys: [...store.entries()].filter(([k]) => k.startsWith(opts?.prefix ?? '')).map(([name, v]) => ({ name, metadata: v.metadata })),
      list_complete: true,
    })),
  }
  return { kv: kv as unknown as KVNamespace, store }
}

function envOf(cache: KVNamespace, idempotency: KVNamespace): Env {
  return { WORKFLOW_CACHE: cache, IDEMPOTENCY: idempotency, SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } as unknown as Env
}

/** A last good copy confirmed `ageMs` ago, so the next prewarm finds it due or not. */
function holdCopy(store: Map<string, { value: string; metadata?: unknown }>, ageMs: number) {
  const constants = { subAccountIdsMap: {}, sellOff: {}, clickUrls: {}, activeBidding: {}, subAccountMinBids: {}, slugsById: { 'p-1': 'tripoint' } }
  store.set('partner-constants-v2-org-1', { value: JSON.stringify(constants) })
  store.set('partner-constants-v2-org-1-lastgood', { value: JSON.stringify(constants), metadata: { confirmed_at: new Date(Date.now() - ageMs).toISOString() } })
}

describe('the prewarm records a failing reconfirm instead of discarding it (#2132)', () => {
  let logs: ReturnType<typeof vi.spyOn>
  let errors: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)
    logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    logs.mockRestore()
    errors.mockRestore()
  })

  it('a workflows read that errors is logged and recorded, never a quiet return', async () => {
    const cache = fakeKv()
    const idem = fakeKv()
    const notify = vi.fn(async (..._args: unknown[]) => undefined)
    const result = await prewarmKvCaches(fakeSupabase({ workflows: { data: null, error: { message: 'connection reset' } } }), envOf(cache.kv, idem.kv), { notify })
    expect(result.workflowsReadError).toBe('connection reset')
    expect(errors.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/could not read the active workflows.*connection reset/)
    const state = await readReconfirmState(idem.kv)
    expect(state[WORKFLOWS_SUBJECT]?.since).toBe(START)
  })

  it('a reconfirm that answers failed is logged with its org and recorded', async () => {
    const cache = fakeKv()
    const idem = fakeKv()
    holdCopy(cache.store, STORED_COPY_RECONFIRM_AFTER_MS)
    const notify = vi.fn(async (..._args: unknown[]) => undefined)
    const result = await prewarmKvCaches(fakeSupabase({ partner_configs: { data: null, error: { message: 'statement timeout' } } }), envOf(cache.kv, idem.kv), { notify })
    expect(result.reconfirms).toEqual({ 'org-1': 'failed' })
    expect(errors.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/reconfirm.*org org-1.*failed/i)
    const state = await readReconfirmState(idem.kv)
    expect(state['org-1']?.since).toBe(START)
  })

  it('no active workflows at all clears the record, since no org bids, so a standing page gets its all clear', async () => {
    const cache = fakeKv()
    const idem = fakeKv()
    idem.store.set(RECONFIRM_STATE_KEY, { value: JSON.stringify({ 'org-1': { since: START - 20 * MINUTE }, [WORKFLOWS_SUBJECT]: { since: START - 20 * MINUTE } }) })
    idem.store.set(RECONFIRM_OBSERVING_SINCE_KEY, { value: String(START - RECONFIRM_OBSERVE_FOR_MS - MINUTE) })
    const notify = vi.fn(async (..._args: unknown[]) => undefined)
    await prewarmKvCaches(fakeSupabase({ workflows: { data: [], error: null } }), envOf(cache.kv, idem.kv), { notify })
    expect(await readReconfirmState(idem.kv)).toEqual({})
    expect(notify.mock.calls.filter((c) => c[1] === PARTNER_CONSTANTS_RECONFIRM_JOB).map((c) => c[2])).toEqual([[]])
  })

  it('a reconfirm that succeeds clears its org from the record', async () => {
    const cache = fakeKv()
    const idem = fakeKv()
    idem.store.set(RECONFIRM_STATE_KEY, { value: JSON.stringify({ 'org-1': { since: START - MINUTE } }) })
    holdCopy(cache.store, STORED_COPY_RECONFIRM_AFTER_MS)
    const result = await prewarmKvCaches(fakeSupabase({}), envOf(cache.kv, idem.kv), { notify: vi.fn(async (..._args: unknown[]) => undefined) })
    expect(result.reconfirms).toEqual({ 'org-1': 'confirmed' })
    expect(await readReconfirmState(idem.kv)).toEqual({})
  })
})

describe('the reconfirm detector pages only after two failing intervals, and clears on a success (#2132)', () => {
  let logs: ReturnType<typeof vi.spyOn>
  let errors: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)
    logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    logs.mockRestore()
    errors.mockRestore()
  })

  /** Run the prewarm once a simulated minute for `minutes`, recording what was paged. */
  async function runMinutes(minutes: number, supabase: never, cache: ReturnType<typeof fakeKv>, idem: ReturnType<typeof fakeKv>, notify: ReturnType<typeof vi.fn>) {
    for (let i = 0; i < minutes; i++) {
      await prewarmKvCaches(supabase, envOf(cache.kv, idem.kv), { notify: notify as never })
      vi.setSystemTime(Date.now() + MINUTE)
    }
  }
  const paged = (notify: ReturnType<typeof vi.fn>) => notify.mock.calls.filter((c) => c[1] === PARTNER_CONSTANTS_RECONFIRM_JOB && (c[2] as string[]).length > 0)

  function pastObservation(idem: ReturnType<typeof fakeKv>) {
    idem.store.set(RECONFIRM_OBSERVING_SINCE_KEY, { value: String(START - RECONFIRM_OBSERVE_FOR_MS - MINUTE) })
  }

  it('is quiet through one failing interval and pages once the failures span two', async () => {
    const cache = fakeKv()
    const idem = fakeKv()
    pastObservation(idem)
    holdCopy(cache.store, STORED_COPY_RECONFIRM_AFTER_MS)
    const failing = fakeSupabase({ partner_configs: { data: null, error: { message: 'statement timeout' } } })
    const notify = vi.fn(async (..._args: unknown[]) => undefined)

    await runMinutes(RECONFIRM_ALERT_AFTER_MS / MINUTE, failing, cache, idem, notify)
    expect(paged(notify)).toEqual([])

    await runMinutes(1, failing, cache, idem, notify)
    const pages = paged(notify)
    expect(pages).toHaveLength(1)
    expect((pages[0][2] as string[]).join(' ')).toMatch(/org-1/)
  })

  it('clears on the first reconfirm that succeeds', async () => {
    const cache = fakeKv()
    const idem = fakeKv()
    pastObservation(idem)
    holdCopy(cache.store, STORED_COPY_RECONFIRM_AFTER_MS)
    const notify = vi.fn(async (..._args: unknown[]) => undefined)
    await runMinutes(RECONFIRM_ALERT_AFTER_MS / MINUTE + 1, fakeSupabase({ partner_configs: { data: null, error: { message: 'statement timeout' } } }), cache, idem, notify)
    expect(paged(notify)).toHaveLength(1)

    notify.mockClear()
    await runMinutes(1, fakeSupabase({}), cache, idem, notify)
    expect(paged(notify)).toEqual([])
    // An empty error list is the shared alerter's all-clear.
    expect(notify.mock.calls.filter((c) => c[1] === PARTNER_CONSTANTS_RECONFIRM_JOB).map((c) => c[2])).toEqual([[]])
  })

  it('a workflows read failing for two intervals pages too, because no org was reconfirmed', async () => {
    const cache = fakeKv()
    const idem = fakeKv()
    pastObservation(idem)
    const notify = vi.fn(async (..._args: unknown[]) => undefined)
    await runMinutes(RECONFIRM_ALERT_AFTER_MS / MINUTE + 1, fakeSupabase({ workflows: { data: null, error: { message: 'connection reset' } } }), cache, idem, notify)
    const pages = paged(notify)
    expect(pages).toHaveLength(1)
    expect((pages[0][2] as string[]).join(' ')).toMatch(/active workflows/)
  })

  it('records but never pages during its first week, so its rate is measured before it can cry wolf', async () => {
    const cache = fakeKv()
    const idem = fakeKv()
    holdCopy(cache.store, STORED_COPY_RECONFIRM_AFTER_MS)
    const notify = vi.fn(async (..._args: unknown[]) => undefined)
    await runMinutes(RECONFIRM_ALERT_AFTER_MS / MINUTE + 3, fakeSupabase({ partner_configs: { data: null, error: { message: 'statement timeout' } } }), cache, idem, notify)
    expect(notify.mock.calls.filter((c) => c[1] === PARTNER_CONSTANTS_RECONFIRM_JOB)).toEqual([])
    expect(idem.store.get(RECONFIRM_OBSERVING_SINCE_KEY)?.value).toBe(String(START))
    expect(logs.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/would page.*org-1/)
  })

  it('waits while stored copies are being served, which the serving alert already pages', async () => {
    const cache = fakeKv()
    const idem = fakeKv()
    pastObservation(idem)
    holdCopy(cache.store, STORED_COPY_RECONFIRM_AFTER_MS)
    const notify = vi.fn(async (..._args: unknown[]) => undefined)
    const failing = fakeSupabase({ partner_configs: { data: null, error: { message: 'statement timeout' } } })
    for (let i = 0; i < RECONFIRM_ALERT_AFTER_MS / MINUTE + 2; i++) {
      const minute = Math.floor(Date.now() / MINUTE)
      idem.store.set(`${STORED_COPY_LEDGER_PREFIX}${minute}:test`, { value: '', metadata: { m: minute, k: { partner_constants: { s: 1, r: [], a: 1000 } } } })
      await prewarmKvCaches(failing, envOf(cache.kv, idem.kv), { notify: notify as never })
      vi.setSystemTime(Date.now() + MINUTE)
    }
    expect(notify.mock.calls.filter((c) => c[1] === PARTNER_CONSTANTS_RECONFIRM_JOB)).toEqual([])
  })
})
