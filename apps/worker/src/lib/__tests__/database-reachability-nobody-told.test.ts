/**
 * The database owner's "nobody can be told" path pages Better Stack (#2061,
 * found in #2246's phase 3). With the database down and no saved Slack copy to
 * post from, the owner only logged; the one alert that matters most in a full
 * outage reached nobody. It now pages through the same pager the scheduled
 * client's lookups use (nobody-told-page.ts, #2259), reached through the tick's
 * ScheduledSlack, so there is one pager and one per tick memory of who was paged.
 * The page carries the pager's NOBODY_TOLD_LINE, which the Better Stack alert
 * matches on. A pager or KV failure there never stops the owner's other work.
 *
 * Every timer is injected; nothing here waits for real (L524).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../slack', () => ({
  sendDatabaseUnreachableAlert: vi.fn().mockResolvedValue('ts-db'),
  sendDatabaseRecoveredAlert: vi.fn().mockResolvedValue(true),
}))

import { reportDatabaseUnreachable, runDatabaseReachabilityProbe } from '../database-reachability'
import { sendDatabaseUnreachableAlert } from '../slack'
import { createNobodyToldPager, NOBODY_TOLD_LINE, NOBODY_TOLD_KV_PREFIX } from '../nobody-told-page'
import { registerScheduledSlack, type ScheduledSlack } from '../scheduled-slack'
import { encryptSecret } from '../secret-crypto'
import { SLACK_CONNS_LASTGOOD_KEY } from '../slack-copy'
import { fakeTimers, tableClient, OTHER_KEY, TEST_KEY } from './_scheduled-slack-doubles'

const ORG = '55555555-5555-4555-8555-555555555555'
const T0 = Date.parse('2026-10-15T03:00:00Z')
const MIN = 60_000

type Kv = { store: Map<string, string>; get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void>; delete(k: string): Promise<void> }

function fakeKv(seed: Record<string, string> = {}, refuse: (k: string) => boolean = () => false): Kv {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: (k) => (refuse(k) ? Promise.reject(new Error('KV GET failed: 500')) : Promise.resolve(store.get(k) ?? null)),
    put: (k, v) => (refuse(k) ? Promise.reject(new Error('KV PUT failed: 500')) : (store.set(k, v), Promise.resolve())),
    delete: (k) => { store.delete(k); return Promise.resolve() },
  }
}

/** The tick's scheduled Slack with the real pager, its Better Stack requests recorded, its pages kept for the test to await. */
function tick(kv: Kv, betterStack: (init: RequestInit) => Promise<Response> = async () => new Response(null, { status: 202 })) {
  const sent: { message: string; organization_id: string | null; reason: string }[] = []
  const handed: Promise<unknown>[] = []
  const pager = createNobodyToldPager({
    token: 'bs-token',
    url: 'https://in.example.betterstack',
    kv,
    now: () => T0,
    delay: () => new Promise(() => {}),
    fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return betterStack(init ?? {})
    }) as typeof fetch,
  })
  const scheduled = registerScheduledSlack({}, { kv, secretKeys: TEST_KEY, pager, waitUntil: (p) => handed.push(p), sleep: fakeTimers('never').sleep, now: () => T0 })
  const settled = async () => { await Promise.all(handed) }
  return { scheduled, sent, settled }
}

function deps(kv: Kv, scheduled: Pick<ScheduledSlack, 'nobodyCanBeTold'> | undefined, at = T0) {
  return { kv, secretKeys: TEST_KEY, appUrl: 'https://app.example', now: () => at, scheduled }
}

const readFailure = { source: 'volume-cliff' as const, what: 'workflows', error: { message: 'connection refused', code: '08006' } }
const flagFailure = { source: 'scheduled-read' as const, what: 'heartbeat-checks slack organizations', error: 'timeout: no answer in 3000 ms' }
const sourceRecord = (kv: Kv) => JSON.parse(kv.store.get('db-reachability:source:volume-cliff') ?? 'null') as { lastFailed: number } | null

let errors: string[]
beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.mocked(sendDatabaseUnreachableAlert).mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('the owner pages Better Stack when nobody can be told (#2061)', () => {
  it('pages once, with the pager\'s line, when the database is down and there is no saved copy', async () => {
    const kv = fakeKv()
    const t = tick(kv)
    await reportDatabaseUnreachable(deps(kv, t.scheduled), readFailure)
    await t.settled()
    expect(t.sent).toEqual([{ message: NOBODY_TOLD_LINE, organization_id: null, reason: 'no_copy', dt: new Date(T0).toISOString() }])
    expect(sendDatabaseUnreachableAlert).not.toHaveBeenCalled()
    // The owner's own log line stays, word for word.
    expect(errors.some((e) => e.includes('[database-reachability] workflows read failed and there is no last-good Slack connection in KV, so nobody can be told'))).toBe(true)
  })

  it('names the copy unreadable when the saved copy cannot be decrypted', async () => {
    const kv = fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await encryptSecret(JSON.stringify({ [ORG]: { bot_token: 'x', default_channel: 'C' } }), OTHER_KEY) })
    const t = tick(kv)
    await reportDatabaseUnreachable(deps(kv, t.scheduled), readFailure)
    await t.settled()
    expect(t.sent.map((s) => s.reason)).toEqual(['copy_unreadable'])
  })

  it('pages for an empty copy too: no organization can be posted to', async () => {
    const kv = fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await encryptSecret(JSON.stringify({}), TEST_KEY) })
    const t = tick(kv)
    await reportDatabaseUnreachable(deps(kv, t.scheduled), readFailure)
    await t.settled()
    expect(t.sent.map((s) => s.reason)).toEqual(['no_copy'])
  })

  it('does not page when the copy is there to post from', async () => {
    const kv = fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await encryptSecret(JSON.stringify({ [ORG]: { bot_token: 'x', default_channel: 'C', volume_alerts_enabled: true } }), TEST_KEY) })
    const t = tick(kv)
    await reportDatabaseUnreachable(deps(kv, t.scheduled), readFailure)
    await t.settled()
    expect(t.sent).toEqual([])
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
  })

  it('pages once for two reports in one tick, and not again on the next tick while the page stands', async () => {
    const kv = fakeKv()
    const first = tick(kv)
    await reportDatabaseUnreachable(deps(kv, first.scheduled), readFailure)
    await reportDatabaseUnreachable(deps(kv, first.scheduled), flagFailure)
    await first.settled()
    expect(first.sent).toHaveLength(1)
    const next = tick(kv)
    await reportDatabaseUnreachable(deps(kv, next.scheduled, T0 + MIN), readFailure)
    await next.settled()
    expect(next.sent).toEqual([])
    expect(kv.store.has(`${NOBODY_TOLD_KV_PREFIX}all`)).toBe(true)
  })

  it('pages nothing, and still logs, on a client with no scheduled Slack (a direct caller)', async () => {
    const kv = fakeKv()
    await expect(reportDatabaseUnreachable(deps(kv, undefined), readFailure)).resolves.toEqual({ told: [], failed: [] })
    expect(errors.some((e) => e.includes('so nobody can be told'))).toBe(true)
  })
})

describe('a pager or KV failure never stops the owner\'s other work', () => {
  it('records the failure against its reader when Better Stack refuses and KV refuses the page record', async () => {
    const kv = fakeKv({}, (k) => k.startsWith(NOBODY_TOLD_KV_PREFIX))
    const t = tick(kv, async () => new Response('down', { status: 503 }))
    await expect(reportDatabaseUnreachable(deps(kv, t.scheduled), readFailure)).resolves.toEqual({ told: [], failed: [] })
    await t.settled()
    // The page was tried, and the bookkeeping beside it stands.
    expect(t.sent).toHaveLength(1)
    expect(sourceRecord(kv)?.lastFailed).toBe(T0)
    expect(kv.store.has('db-reachability:failed-minutes')).toBe(true)
  })

  it('resolves when the pager throws inside its send', async () => {
    const kv = fakeKv()
    const t = tick(kv, () => Promise.reject(new TypeError('fetch failed')))
    await expect(reportDatabaseUnreachable(deps(kv, t.scheduled), readFailure)).resolves.toEqual({ told: [], failed: [] })
    await t.settled()
    expect(sourceRecord(kv)?.lastFailed).toBe(T0)
  })

  it('resolves, and says why, when handing the page over throws', async () => {
    const kv = fakeKv()
    const broken = { nobodyCanBeTold: () => { throw new Error('waitUntil is gone') } }
    await expect(reportDatabaseUnreachable(deps(kv, broken), readFailure)).resolves.toEqual({ told: [], failed: [] })
    expect(sourceRecord(kv)?.lastFailed).toBe(T0)
    expect(errors.some((e) => e.includes('[database-reachability]') && e.includes('Better Stack') && e.includes('waitUntil is gone'))).toBe(true)
  })

  it('lets a probe with no copy page, and still stamp its run completed, when the pager fails', async () => {
    const kv = fakeKv({ 'db-reachability:failed-minutes': JSON.stringify([Math.floor(T0 / MIN) - 1]) })
    const t = tick(kv, () => Promise.reject(new TypeError('fetch failed')))
    const completed = vi.fn().mockResolvedValue(undefined)
    const result = await runDatabaseReachabilityProbe({
      ...deps(kv, t.scheduled),
      supabase: tableClient({ service_connections: { error: { message: 'connection refused', code: '08006' } } }).client,
      sleep: fakeTimers('never').sleep,
      stamps: { started: vi.fn().mockResolvedValue(undefined), completed },
    })
    await t.settled()
    expect(result.kind).toBe('failed')
    expect(t.sent.map((s) => s.message)).toEqual([NOBODY_TOLD_LINE])
    expect(completed).toHaveBeenCalledTimes(1)
  })
})
