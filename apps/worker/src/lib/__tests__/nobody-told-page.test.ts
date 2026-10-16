/**
 * The page for "nobody can be told" (#2063, Dan's decision of 2026-10-16, option (a)).
 *
 * When the database does not answer and no usable saved Slack copy exists, no
 * Slack alert can be posted, and the worker's own log lines do not reach Better
 * Stack (forwarding was narrowed on 2026-09-09 to keep applicant data out, #1007).
 * So the worker sends ONE fixed line straight to a Better Stack HTTP log source,
 * and a Better Stack alert on that source pages. These tests pin the line, the
 * only fields the payload may carry, the dedupe, the deadline, and that an unset
 * secret sends nothing. Clock, fetch, delay and KV are all injected (L524).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BETTER_STACK_ALERT_NAME,
  createNobodyToldPager,
  NOBODY_TOLD_KV_PREFIX,
  NOBODY_TOLD_LINE,
  NOBODY_TOLD_PAGE_DEADLINE_MS,
  NOBODY_TOLD_TTL_SECONDS,
  type NobodyToldKv,
} from '../nobody-told-page'

const URL_ = 'https://s123.us-east-9.betterstackdata.com'
const TOKEN = 'source-token-for-tests'
const NOW = Date.UTC(2026, 9, 16, 14, 5, 0)

let logs: string[]
beforeEach(() => {
  logs = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
  }
})
afterEach(() => vi.restoreAllMocks())

interface Sent { url: string; init: RequestInit; body: Record<string, unknown> }

/** A fetch that answers `status`, or never answers ('stall'), or throws. */
function fakeFetch(mode: number | 'stall' | 'throw' = 202) {
  const sent: Sent[] = []
  const signals: AbortSignal[] = []
  const fetchFn = ((url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> })
    if (init.signal) signals.push(init.signal)
    if (mode === 'throw') return Promise.reject(new TypeError('fetch failed'))
    if (mode === 'stall') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }
    return Promise.resolve(new Response(null, { status: mode }))
  }) as unknown as typeof fetch
  return { fetchFn, sent, signals }
}

function fakeKv(store: Record<string, string> = {}, mode: 'ok' | 'get-throws' | 'get-stalls' | 'put-throws' = 'ok') {
  const puts: { key: string; value: string; ttl: number | undefined }[] = []
  const kv: NobodyToldKv = {
    get(key: string) {
      if (mode === 'get-throws') return Promise.reject(new Error('kv 500'))
      if (mode === 'get-stalls') return new Promise<string | null>(() => {})
      return Promise.resolve(store[key] ?? null)
    },
    put(key: string, value: string, opts?: { expirationTtl?: number }) {
      if (mode === 'put-throws') return Promise.reject(new Error('kv put 500'))
      puts.push({ key, value, ttl: opts?.expirationTtl })
      store[key] = value
      return Promise.resolve()
    },
  }
  return { kv, puts, store }
}

/** Delays the test controls: each resolves only when the test says, so no test waits for real (L290). */
function controlledDelay() {
  const pending: { ms: number; resolve: () => void }[] = []
  const delay = (ms: number) => new Promise<void>((resolve) => pending.push({ ms, resolve }))
  return { delay, pending, expire: (ms: number) => pending.filter((p) => p.ms === ms).forEach((p) => p.resolve()) }
}

function pager(opts: { token?: string | undefined; url?: string | undefined; fetchMode?: number | 'stall' | 'throw'; kv?: ReturnType<typeof fakeKv>; delay?: (ms: number) => Promise<void> } = {}) {
  const f = fakeFetch(opts.fetchMode ?? 202)
  const k = opts.kv ?? fakeKv()
  const p = createNobodyToldPager({
    token: 'token' in opts ? opts.token : TOKEN,
    url: 'url' in opts ? opts.url : URL_,
    kv: k.kv,
    fetch: f.fetchFn,
    now: () => NOW,
    // A delay that never ends unless a test supplies one: no deadline fires by accident.
    delay: opts.delay ?? (() => new Promise<void>(() => {})),
  })
  return { pager: p, ...f, ...k }
}

describe('the fixed line', () => {
  it('is exactly the text the Better Stack alert "Bidspoke nobody can be told in Slack" matches on', () => {
    // The Better Stack alert matches on this text in the `message` field of the
    // source (docs/reference/observability.md). Change it here and the alert
    // stops matching: change the alert in the same change, never only this.
    expect(BETTER_STACK_ALERT_NAME).toBe('Bidspoke nobody can be told in Slack')
    expect(NOBODY_TOLD_LINE).toBe('bidspoke nobody can be told in Slack: the database did not answer and no saved Slack copy could stand in')
  })
})

describe('what is sent', () => {
  it('posts one JSON event to the source URL with the source token as a bearer header', async () => {
    const { pager: p, sent } = pager()
    await p.page('org-1', 'no_copy')
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(URL_)
    expect(sent[0].init.method).toBe('POST')
    const headers = new Headers(sent[0].init.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('carries ONLY the organization id, the reason, the fixed line and a timestamp (L482)', async () => {
    const { pager: p, sent } = pager()
    await p.page('org-1', 'copy_unreadable')
    // Pinned as the whole object, so any field added later (a lead, a payload,
    // an error detail that could quote one) fails here rather than shipping.
    expect(sent[0].body).toStrictEqual({
      message: NOBODY_TOLD_LINE,
      organization_id: 'org-1',
      reason: 'copy_unreadable',
      dt: '2026-10-16T14:05:00.000Z',
    })
  })

  it('names no organization when the lookup was for every organization at once', async () => {
    const { pager: p, sent } = pager()
    await p.page(null, 'no_copy')
    expect(sent[0].body).toStrictEqual({ message: NOBODY_TOLD_LINE, organization_id: null, reason: 'no_copy', dt: '2026-10-16T14:05:00.000Z' })
  })
})

describe('at most once per organization per incident', () => {
  it('sends once per organization in a tick, however many lookups fail, even at the same moment', async () => {
    // Started together, as a tick's jobs do: none has written its KV record when
    // the others look, so only the tick's own memory can hold the repeats back.
    const { pager: p, sent } = pager()
    await Promise.all([
      p.page('org-1', 'no_copy'),
      p.page('org-1', 'no_copy'),
      p.page('org-1', 'org_not_in_copy'),
      p.page('org-2', 'org_not_in_copy'),
    ])
    expect(sent.map((s) => s.body.organization_id)).toEqual(['org-1', 'org-2'])
  })

  it('sends once per organization in a tick when KV cannot record it', async () => {
    const { pager: p, sent } = pager({ kv: fakeKv({}, 'put-throws') })
    await p.page('org-1', 'no_copy')
    await p.page('org-1', 'no_copy')
    expect(sent).toHaveLength(1)
  })

  it('records a sent page in KV for an hour, so the next tick of the same outage sends nothing', async () => {
    const k = fakeKv()
    const first = pager({ kv: k })
    await first.pager.page('org-1', 'no_copy')
    expect(k.puts).toEqual([{ key: `${NOBODY_TOLD_KV_PREFIX}org-1`, value: String(NOW), ttl: NOBODY_TOLD_TTL_SECONDS }])
    expect(NOBODY_TOLD_TTL_SECONDS).toBe(3_600)
    // The next minute's tick builds a new pager over the same KV.
    const next = pager({ kv: k })
    await next.pager.page('org-1', 'no_copy')
    expect(next.sent).toHaveLength(0)
  })

  it('keys the every-organization page apart from any one organization', async () => {
    const k = fakeKv()
    await pager({ kv: k }).pager.page(null, 'no_copy')
    expect(k.puts[0].key).toBe(`${NOBODY_TOLD_KV_PREFIX}all`)
  })

  it('writes no KV record when Better Stack refuses, so the next tick tries again', async () => {
    const k = fakeKv()
    const { pager: p } = pager({ kv: k, fetchMode: 403 })
    await p.page('org-1', 'no_copy')
    expect(k.puts).toEqual([])
    expect(logs.some((l) => l.includes('[nobody-told-page]') && l.includes('403'))).toBe(true)
  })

  it('still sends when KV cannot be read, since paging matters more than a repeat', async () => {
    const { pager: p, sent } = pager({ kv: fakeKv({}, 'get-throws') })
    await p.page('org-1', 'no_copy')
    expect(sent).toHaveLength(1)
  })

  it('still sends when the KV read never answers, after its own short wait', async () => {
    const d = controlledDelay()
    const { pager: p, sent } = pager({ kv: fakeKv({}, 'get-stalls'), delay: d.delay })
    const done = p.page('org-1', 'no_copy')
    await vi.waitFor(() => expect(d.pending.some((x) => x.ms === 1_000)).toBe(true))
    d.expire(1_000)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    d.expire(NOBODY_TOLD_PAGE_DEADLINE_MS)
    await done
  })

  it('says so when the page was sent but could not be recorded', async () => {
    const { pager: p, sent } = pager({ kv: fakeKv({}, 'put-throws') })
    await p.page('org-1', 'no_copy')
    expect(sent).toHaveLength(1)
    expect(logs.some((l) => l.includes('[nobody-told-page]') && l.includes('could not be recorded'))).toBe(true)
  })
})

describe('bounded and never failing its caller', () => {
  it('gives up on a send that never answers at its deadline, aborts it, and resolves', async () => {
    const d = controlledDelay()
    const { pager: p, signals, puts } = pager({ fetchMode: 'stall', delay: d.delay })
    const done = p.page('org-1', 'no_copy')
    await vi.waitFor(() => expect(d.pending.some((x) => x.ms === NOBODY_TOLD_PAGE_DEADLINE_MS)).toBe(true))
    d.expire(NOBODY_TOLD_PAGE_DEADLINE_MS)
    await expect(done).resolves.toBeUndefined()
    expect(NOBODY_TOLD_PAGE_DEADLINE_MS).toBe(5_000)
    expect(signals[0].aborted).toBe(true)
    expect(puts).toEqual([])
    expect(logs.some((l) => l.includes('[nobody-told-page]') && l.includes('5000 ms'))).toBe(true)
  })

  it('resolves, never rejects, when the send throws, and logs the failure', async () => {
    const { pager: p } = pager({ fetchMode: 'throw' })
    await expect(p.page('org-1', 'no_copy')).resolves.toBeUndefined()
    expect(logs.some((l) => l.includes('[nobody-told-page]') && l.includes('fetch failed'))).toBe(true)
  })
})

describe('inert until the secrets are set', () => {
  it.each([
    ['the token', { token: undefined }],
    ['the URL', { url: undefined }],
    ['a blank token', { token: '  ' }],
  ])('sends nothing without %s, and says so once per tick', async (_label, opts) => {
    const { pager: p, sent } = pager(opts)
    await p.page('org-1', 'no_copy')
    await p.page('org-2', 'no_copy')
    expect(sent).toHaveLength(0)
    const said = logs.filter((l) => l.includes('BETTERSTACK_OUTAGE_TOKEN'))
    expect(said).toHaveLength(1)
  })
})
