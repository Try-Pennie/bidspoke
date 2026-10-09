/**
 * The database memory check (#1928).
 *
 * On 2026-10-08 the database had run out of memory and been swapping for at least a week
 * before it stalled at 12:20 UTC, and nothing said so. This check reads Supabase's metrics
 * feed every five minutes and alerts once memory has been thin for 15 minutes on the clock.
 *
 * The feed, the clock, the KV store, the claim and every Slack send are injected, so no test
 * waits, reaches a network, or depends on the wall clock (L524, L2, L130). Feed text is built
 * from the real lines captured on 2026-10-09, with only the values changed (L48).
 */
import { describe, it, expect } from 'vitest'
import {
  parseMemoryMetrics,
  metricsUrl,
  fetchMemoryReading,
  runDatabaseMemoryCheck,
  DATABASE_MEMORY_KEY,
  DATABASE_MEMORY_UNREADABLE_KEY,
  DATABASE_MEMORY_STATE_KEY,
  MEMORY_FREE_FLOOR,
  MEMORY_SHORT_ALERT_AFTER_MS,
  FEED_UNREADABLE_ALERT_AFTER_MS,
  type DatabaseMemoryDeps,
  type FeedAnswer,
} from '../database-memory'
import { readCondition } from '../alert-backoff'
import { RECOVERY_REARM_MINUTES } from '../alert-recovery'
import { SUPABASE_METRICS_MEDIUM_AFTER_RESTART } from './fixtures/supabase-metrics-memory'

const MIN = 60 * 1000
const GB = 1024 ** 3
const TOTAL = 4.009828352e9

/** The captured feed with chosen values put on the db lines, everything else left as captured. */
function feedText(values: Partial<Record<'MemTotal' | 'MemAvailable' | 'SwapTotal' | 'SwapFree' | 'pswpout', number>>): string {
  return SUPABASE_METRICS_MEDIUM_AFTER_RESTART.split('\n').map((line) => {
    for (const [name, value] of Object.entries(values)) {
      const metric = name === 'pswpout' ? 'node_vmstat_pswpout' : `node_memory_${name}_bytes`
      if (line.startsWith(`${metric}{`) && line.includes('service_type="db"')) return line.replace(/\} \S+$/, `} ${value}`)
    }
    return line
  }).join('\n')
}

function fakeKv(clock: { now: number }) {
  const store = new Map<string, { value: string; expiresAt: number | null }>()
  const unreadable = new Set<string>()
  const live = (k: string) => {
    const e = store.get(k)
    if (!e) return null
    if (e.expiresAt !== null && e.expiresAt <= clock.now) { store.delete(k); return null }
    return e
  }
  return {
    store, unreadable,
    get: async (k: string) => {
      if (unreadable.has(k)) throw new Error(`KV read failed for ${k}`)
      return live(k)?.value ?? null
    },
    put: async (k: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(k, { value, expiresAt: opts?.expirationTtl ? clock.now + opts.expirationTtl * 1000 : null })
    },
    delete: async (k: string) => { store.delete(k) },
  }
}

function fakeClaims(clock: { now: number }) {
  const held = new Map<string, number>()
  return {
    claim: async (key: string, ttlSeconds: number) => {
      const until = held.get(key)
      if (until !== undefined && until > clock.now) return false
      held.set(key, clock.now + ttlSeconds * 1000)
      return true
    },
    release: async (key: string) => { held.delete(key) },
  }
}

type Sent = { kind: 'short' | 'unreadable' | 'recovery'; payload: Record<string, unknown> }

function harness(opts: { slack?: Array<{ bot_token: string; default_channel: string }>; slackRefuses?: boolean; env?: Record<string, string> } = {}) {
  const clock = { now: Date.parse('2026-10-09T13:00:00Z') }
  const kv = fakeKv(clock)
  const sent: Sent[] = []
  const logs: string[] = []
  let next: FeedAnswer = { kind: 'read', reading: { totalBytes: TOTAL, availableBytes: 3 * GB, swapTotalBytes: GB, swapFreeBytes: GB, swapOutPages: 0 } }
  const answer = (send: Sent['kind']) => (_s: unknown, _c: string, payload: Record<string, unknown>) => {
    sent.push({ kind: send, payload })
    if (opts.slackRefuses) return Promise.resolve(send === 'recovery' ? false : null)
    return Promise.resolve(send === 'recovery' ? true : 'ts')
  }
  const deps: DatabaseMemoryDeps = {
    kv,
    claims: fakeClaims(clock),
    env: opts.env ?? {},
    read: async () => next,
    resolveSlack: async () => opts.slack ?? [{ bot_token: 't', default_channel: '#ops' }],
    senders: {
      short: answer('short') as unknown as DatabaseMemoryDeps['senders']['short'],
      unreadable: answer('unreadable') as unknown as DatabaseMemoryDeps['senders']['unreadable'],
      recovery: answer('recovery') as unknown as DatabaseMemoryDeps['senders']['recovery'],
    },
    now: () => clock.now,
    log: (l) => logs.push(l),
  }
  const setFeed = (a: FeedAnswer) => { next = a }
  const reading = (availableBytes: number, swapOutPages = 0, swapFreeBytes = GB): FeedAnswer =>
    ({ kind: 'read', reading: { totalBytes: TOTAL, availableBytes, swapTotalBytes: GB, swapFreeBytes, swapOutPages } })
  /** Run once now, then every five minutes until `minutes` have passed on the clock. */
  const runFor = async (minutes: number, feed?: (i: number) => FeedAnswer) => {
    const summaries = []
    for (let i = 0; i * 5 <= minutes; i++) {
      if (i > 0) clock.now += 5 * MIN
      if (feed) setFeed(feed(i))
      summaries.push(await runDatabaseMemoryCheck(deps))
    }
    return summaries
  }
  return { clock, kv, sent, logs, deps, setFeed, reading, runFor }
}

const LOW = Math.floor(TOTAL * (MEMORY_FREE_FLOOR - 0.05))
const PLENTY = Math.floor(TOTAL * 0.6)

describe('reading the feed', () => {
  it('reads the db service figures from the real captured feed', () => {
    const answer = parseMemoryMetrics(SUPABASE_METRICS_MEDIUM_AFTER_RESTART)
    expect(answer).toEqual({
      kind: 'read',
      reading: { totalBytes: 4.009828352e9, availableBytes: 3.505897472e9, swapTotalBytes: 1.073737728e9, swapFreeBytes: 1.073737728e9, swapOutPages: 0 },
    })
  })

  it('refuses by name when a figure it needs is missing', () => {
    const text = SUPABASE_METRICS_MEDIUM_AFTER_RESTART.split('\n').filter((l) => !l.startsWith('node_memory_MemAvailable_bytes{')).join('\n')
    expect(parseMemoryMetrics(text)).toEqual({ kind: 'failed', reason: 'the feed carried no node_memory_MemAvailable_bytes for the db service' })
  })

  it('refuses when one figure appears twice for the db service, rather than picking one', () => {
    const line = SUPABASE_METRICS_MEDIUM_AFTER_RESTART.split('\n').find((l) => l.startsWith('node_memory_MemTotal_bytes{'))!
    const answer = parseMemoryMetrics(`${SUPABASE_METRICS_MEDIUM_AFTER_RESTART}\n${line.replace('} 4.009828352e+09', '} 1')}`)
    expect(answer).toEqual({ kind: 'failed', reason: 'the feed carried 2 node_memory_MemTotal_bytes lines for the db service' })
  })

  it('refuses a total of zero, which would make every share meaningless', () => {
    expect(parseMemoryMetrics(feedText({ MemTotal: 0 }))).toEqual({ kind: 'failed', reason: 'node_memory_MemTotal_bytes was 0' })
  })

  it('ignores the same figure reported by another service', () => {
    const other = SUPABASE_METRICS_MEDIUM_AFTER_RESTART.split('\n').find((l) => l.startsWith('node_memory_MemAvailable_bytes{'))!
      .replace('service_type="db"', 'service_type="postgresql"').replace(/\} \S+$/, '} 5')
    const answer = parseMemoryMetrics(`${SUPABASE_METRICS_MEDIUM_AFTER_RESTART}\n${other}`)
    expect(answer.kind === 'read' && answer.reading.availableBytes).toBe(3.505897472e9)
  })

  it('builds the feed address from the project URL, and refuses one it cannot read', () => {
    expect(metricsUrl('https://xvrmivmpfykwwtriqwpg.supabase.co')).toBe('https://xvrmivmpfykwwtriqwpg.supabase.co/customer/v1/privileged/metrics')
    expect(metricsUrl('https://xvrmivmpfykwwtriqwpg.supabase.co/')).toBe('https://xvrmivmpfykwwtriqwpg.supabase.co/customer/v1/privileged/metrics')
    expect(metricsUrl(undefined)).toBeNull()
    expect(metricsUrl('not a url')).toBeNull()
  })

  it('reports a refused fetch by its status, and never throws', async () => {
    const refused = (async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch
    expect(await fetchMemoryReading({ url: 'https://x.supabase.co/customer/v1/privileged/metrics', secretKey: 'k', fetchImpl: refused }))
      .toEqual({ kind: 'failed', reason: 'the metrics feed answered HTTP 401' })
    const thrown = (async () => { throw new Error('connect ECONNRESET') }) as unknown as typeof fetch
    const answer = await fetchMemoryReading({ url: 'https://x.supabase.co/customer/v1/privileged/metrics', secretKey: 'k', fetchImpl: thrown })
    expect(answer.kind).toBe('failed')
    expect(answer.kind === 'failed' && answer.reason).toMatch(/ECONNRESET/)
  })

  it('sends the secret key as Basic auth for the service_role user', async () => {
    let auth: string | null = null
    const ok = (async (_u: string, init: RequestInit) => {
      auth = new Headers(init.headers).get('authorization')
      return new Response(SUPABASE_METRICS_MEDIUM_AFTER_RESTART, { status: 200 })
    }) as unknown as typeof fetch
    const answer = await fetchMemoryReading({ url: 'https://x.supabase.co/customer/v1/privileged/metrics', secretKey: 'sb_secret_abc', fetchImpl: ok })
    expect(answer.kind).toBe('read')
    expect(auth).toBe(`Basic ${btoa('service_role:sb_secret_abc')}`)
  })
})

describe('memory running thin', () => {
  it('says nothing while memory has been under the floor for 10 minutes', async () => {
    const h = harness()
    await h.runFor(10, () => h.reading(LOW))
    expect(h.sent).toEqual([])
  })

  it('alerts once memory has been under the floor for 15 minutes on the clock', async () => {
    const h = harness()
    const summaries = await h.runFor(15, () => h.reading(LOW))
    expect(h.sent.map((s) => s.kind)).toEqual(['short'])
    expect(summaries.at(-1)!.alerts).toEqual(['short'])
    const p = h.sent[0].payload
    expect(p.totalBytes).toBe(TOTAL)
    expect(p.freeFloor).toBe(MEMORY_FREE_FLOOR)
    expect(p.lowestAvailableBytes).toBe(LOW)
    expect(p.lowFree).toBe(true)
    expect(p.swapping).toBe(false)
    expect(p.since).toBe('2026-10-09T13:00:00.000Z')
  })

  it('judges the 15 minutes on the clock, not on a count of readings', async () => {
    const h = harness()
    h.setFeed(h.reading(LOW))
    await runDatabaseMemoryCheck(h.deps)
    h.clock.now += MEMORY_SHORT_ALERT_AFTER_MS - 1
    await runDatabaseMemoryCheck(h.deps)
    expect(h.sent).toEqual([])
    h.clock.now += 1
    await runDatabaseMemoryCheck(h.deps)
    expect(h.sent.map((s) => s.kind)).toEqual(['short'])
  })

  it('starts the 15 minutes again after one healthy reading in between', async () => {
    const h = harness()
    await h.runFor(25, (i) => (i === 2 ? h.reading(PLENTY) : h.reading(LOW)))
    // Thin at 0 and 5, healthy at 10, thin again from 15: 25 minutes is only 10 into the new stretch.
    expect(h.sent).toEqual([])
  })

  it('alerts on swapping that goes on for 15 minutes even with plenty of memory free', async () => {
    const h = harness()
    // The first reading has no earlier counter, so the stretch starts at the second, five minutes in.
    await h.runFor(20, (i) => h.reading(PLENTY, 1000 + i * 500, GB / 2))
    expect(h.sent.map((s) => s.kind)).toEqual(['short'])
    const p = h.sent[0].payload
    expect(p.swapping).toBe(true)
    expect(p.lowFree).toBe(false)
    expect(p.swapUsedBytes).toBe(GB / 2)
  })

  it('does not count the first reading, which has no earlier counter to compare, as swapping', async () => {
    const h = harness()
    h.setFeed(h.reading(PLENTY, 5_000_000))
    const s = await runDatabaseMemoryCheck(h.deps)
    expect(s.state).toBe('ok')
  })

  it('reads a counter that went backwards as a restart, not as swapping and not as healthy evidence of swap', async () => {
    const h = harness()
    await h.runFor(10, (i) => h.reading(PLENTY, 9000 + i * 100))
    // The counter rose twice, so the database was swapping; then it restarted and reset.
    h.clock.now += 5 * MIN
    h.setFeed(h.reading(PLENTY, 12))
    const s = await runDatabaseMemoryCheck(h.deps)
    expect(s.state).toBe('ok')
    expect(h.logs.some((l) => l.includes('counter_reset=true'))).toBe(true)
  })

  it('does not post again inside the reminder gap, and reminds once the six hours are up', async () => {
    const h = harness()
    await h.runFor(15, () => h.reading(LOW))
    expect(h.sent.length).toBe(1)
    await h.runFor(60 * 6 - 10, () => h.reading(LOW))
    expect(h.sent.length).toBe(1)
    await h.runFor(10, () => h.reading(LOW))
    expect(h.sent.length).toBe(2)
    expect(h.sent[1].payload.repeat).toMatch(/reminder 2/)
    expect((await readCondition(h.kv, DATABASE_MEMORY_KEY))?.alerts).toBe(2)
  })

  it('does not post again as each new low deepens, because a lower figure is the same problem', async () => {
    const h = harness()
    await h.runFor(15, () => h.reading(LOW))
    await h.runFor(60, (i) => h.reading(LOW - (i + 1) * 10_000_000))
    expect(h.sent.map((s) => s.kind)).toEqual(['short'])
  })

  it('keeps the lowest free figure across the stretch, not the latest one', async () => {
    const h = harness()
    const lows = [LOW, LOW - 100_000_000, LOW]
    await h.runFor(15, (i) => h.reading(lows[Math.min(i, 2)]))
    expect(h.sent[0].payload.lowestAvailableBytes).toBe(LOW - 100_000_000)
  })
})

describe('the all-clear', () => {
  it('posts once memory has stayed healthy for the re-arm window, and not before', async () => {
    const h = harness()
    await h.runFor(15, () => h.reading(LOW))
    expect(h.sent.map((s) => s.kind)).toEqual(['short'])
    await h.runFor(RECOVERY_REARM_MINUTES - 5, () => h.reading(PLENTY))
    expect(h.sent.map((s) => s.kind)).toEqual(['short'])
    await h.runFor(10, () => h.reading(PLENTY))
    expect(h.sent.map((s) => s.kind)).toEqual(['short', 'recovery'])
    expect(await readCondition(h.kv, DATABASE_MEMORY_KEY)).toBeNull()
  })

  it('pages again at once on the next genuine stretch after the all-clear', async () => {
    const h = harness()
    await h.runFor(15, () => h.reading(LOW))
    await h.runFor(RECOVERY_REARM_MINUTES + 5, () => h.reading(PLENTY))
    await h.runFor(15, () => h.reading(LOW))
    expect(h.sent.map((s) => s.kind)).toEqual(['short', 'recovery', 'short'])
  })

  it('posts no all-clear when nothing was ever alerted', async () => {
    const h = harness()
    await h.runFor(60, () => h.reading(PLENTY))
    expect(h.sent).toEqual([])
  })
})

describe('when the feed cannot be read', () => {
  it('says nothing for under 30 minutes, then alerts that memory cannot be read', async () => {
    const h = harness()
    await h.runFor(25, () => ({ kind: 'failed', reason: 'the metrics feed answered HTTP 401' }))
    expect(h.sent).toEqual([])
    h.clock.now += FEED_UNREADABLE_ALERT_AFTER_MS - 25 * MIN
    await runDatabaseMemoryCheck(h.deps)
    expect(h.sent.map((s) => s.kind)).toEqual(['unreadable'])
    expect(h.sent[0].payload.reason).toBe('the metrics feed answered HTTP 401')
  })

  it('never reads an unreadable feed as healthy memory, so a standing memory alert gets no all-clear', async () => {
    const h = harness()
    await h.runFor(15, () => h.reading(LOW))
    await h.runFor(60, () => ({ kind: 'failed', reason: 'timeout' }))
    expect(h.sent.map((s) => s.kind)).toEqual(['short', 'unreadable'])
  })

  it('counts an unreadable stretch as unmeasured, so the memory all-clear still waits for 30 healthy minutes', async () => {
    const h = harness()
    await h.runFor(15, () => h.reading(LOW))
    await h.runFor(60, () => ({ kind: 'failed', reason: 'timeout' }))
    await h.runFor(RECOVERY_REARM_MINUTES - 5, () => h.reading(PLENTY))
    expect(h.sent.map((s) => s.kind)).toEqual(['short', 'unreadable'])
    await h.runFor(10, () => h.reading(PLENTY))
    expect(h.sent.map((s) => s.kind).sort()).toEqual(['recovery', 'recovery', 'short', 'unreadable'])
  })

  it('posts an all-clear for the feed once readings have worked for the re-arm window', async () => {
    const h = harness()
    await h.runFor(30, () => ({ kind: 'failed', reason: 'timeout' }))
    expect(h.sent.map((s) => s.kind)).toEqual(['unreadable'])
    await h.runFor(RECOVERY_REARM_MINUTES + 5, () => h.reading(PLENTY))
    expect(h.sent.map((s) => s.kind)).toEqual(['unreadable', 'recovery'])
    expect(await readCondition(h.kv, DATABASE_MEMORY_UNREADABLE_KEY)).toBeNull()
  })
})

describe('when the alert cannot be delivered', () => {
  it('retries on the next reading when Slack refuses, rather than recording it as sent', async () => {
    const h = harness({ slackRefuses: true })
    await h.runFor(20, () => h.reading(LOW))
    expect(h.sent.filter((s) => s.kind === 'short').length).toBe(2)
    expect(await readCondition(h.kv, DATABASE_MEMORY_KEY)).toBeNull()
  })

  it('logs and records nothing as sent when there is no Slack connection', async () => {
    const h = harness({ slack: [] })
    await h.runFor(15, () => h.reading(LOW))
    expect(h.sent).toEqual([])
    expect(h.logs.some((l) => l.includes('no Slack connection'))).toBe(true)
    expect(await readCondition(h.kv, DATABASE_MEMORY_KEY)).toBeNull()
  })

  it('reports a state it cannot read as an error and alerts on nothing, rather than starting over', async () => {
    const h = harness()
    h.kv.unreadable.add(DATABASE_MEMORY_STATE_KEY)
    h.setFeed(h.reading(LOW))
    const s = await runDatabaseMemoryCheck(h.deps)
    expect(s.state).toBe('error')
    expect(s.errors.join(' ')).toMatch(/state unreadable/)
    expect(h.sent).toEqual([])
  })
})

describe('local development', () => {
  it('reads and logs, but never posts', async () => {
    const h = harness({ env: { LOCAL_DEV: 'true' } })
    const summaries = await h.runFor(30, () => h.reading(LOW))
    expect(h.sent).toEqual([])
    expect(summaries.at(-1)!.mode).toBe('silent')
  })
})

describe('every reading is logged', () => {
  it('logs the free share, the swap in use and the counter on every run, for calibrating the floor', async () => {
    const h = harness()
    // A quarter of the 1 GB swap in use: three quarters free.
    h.setFeed(h.reading(PLENTY, 42, (GB * 3) / 4))
    await runDatabaseMemoryCheck(h.deps)
    const line = h.logs.find((l) => l.includes('event=database_memory'))!
    expect(line).toMatch(/free_pct=60\.0/)
    expect(line).toMatch(/swap_used_mb=256/)
    expect(line).toMatch(/swap_out_pages=42/)
    expect(line).toMatch(/state=ok/)
  })
})
