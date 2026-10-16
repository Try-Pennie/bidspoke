/**
 * The full outage simulation #2061 asks for (Dan, 2026-10-14: "While the
 * incident is open, every other alert posts as normal with one line naming the
 * outage; a full outage simulation counts the posts").
 *
 * Drives the REAL scheduled handler, minute after minute, with no module
 * mocked. The database is a stall: every request to Supabase is accepted and
 * never answered (the 2026-10-08 shape), so each read ends only at its own
 * deadline. KV and the claim object are in memory, the saved Slack copy is
 * present (written by the probe a minute before the stall), and every request
 * to Slack is recorded. The clock is faked, so the 45 s database deadline, the
 * 50 s minute deadline and the overlap of one minute's abandoned jobs with the
 * next minute's tick all happen without waiting (L524).
 *
 * Production ends an invocation once every promise it handed to waitUntil has
 * settled, at the latest the 50 s minute deadline, and Cloudflare then cuts off
 * whatever a job it stopped waiting for was still doing (index.ts,
 * MINUTE_JOB_DEADLINE_MS). The faked clock would let such a job run on and post
 * minutes later, so each tick runs in its own context here and, once its
 * invocation has ended, every request and KV call it makes never answers, and
 * a Slack post it tries is set aside as cut off rather than counted.
 *
 * The one alert that can still speak without the database here is the cron
 * heartbeat, which reads KV: a job seeded to go stale two and a half minutes
 * into the stall. It is the "consequence" alert the decision is about.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker from '../index'
import type { Env } from '../index'
import { AlertClaimObject } from '../durable-objects/alert-claim'
import { CRON_JOBS, completedKey, heartbeatKey } from '../lib/cron-heartbeat'
import { encryptSecret } from '../lib/secret-crypto'
import { SLACK_CONNS_LASTGOOD_KEY, SLACK_COPY_SAVED_AT_KEY } from '../lib/slack-copy'
import { TEST_KEY } from '../lib/__tests__/_scheduled-slack-doubles'

const ORG = '55555555-5555-4555-8555-555555555555'
const CONN = { bot_token: 'xoxb-t', default_channel: 'C-ALERTS', volume_alerts_enabled: true, config_alerts_enabled: true }
const SEC = 1_000
const MIN = 60 * SEC
// 9:00 PM EDT on 2026-10-14: the stall starts with the first tick.
const T0 = Date.parse('2026-10-15T01:00:00Z')
const STALE_JOB = CRON_JOBS.find((j) => j.id === 'sightings-export')!

/** Which tick a call comes from, and whether that tick's invocation has ended. */
const tickOf = new AsyncLocalStorage<{ startedAt: number; ended: boolean }>()
const cutOff = () => tickOf.getStore()?.ended === true
const never = <T>() => new Promise<T>(() => {})

/** A KV namespace in a Map, with the calls the minute jobs make. A call from an ended tick never answers. */
function memoryKv() {
  const store = new Map<string, string>()
  const read = (k: string, type?: unknown) => {
    if (cutOff()) return never()
    const v = store.get(k) ?? null
    const asJson = type === 'json' || (typeof type === 'object' && type !== null && (type as { type?: unknown }).type === 'json')
    return Promise.resolve(v !== null && asJson ? JSON.parse(v) : v)
  }
  return {
    store,
    get: read,
    getWithMetadata: async (k: string, type?: unknown) => ({ value: await read(k, type), metadata: null }),
    put: (k: string, v: string) => { if (cutOff()) return never(); store.set(k, String(v)); return Promise.resolve() },
    delete: (k: string) => { if (cutOff()) return never(); store.delete(k); return Promise.resolve() },
    list: ({ prefix = '' }: { prefix?: string } = {}) =>
      cutOff() ? never() : Promise.resolve({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true, cursor: '' }),
  }
}

/** The claim namespace with the real claim object behind each key, its storage in memory. */
function claimNamespace(): DurableObjectNamespace {
  const objects = new Map<string, AlertClaimObject>()
  const state = () => {
    const store = new Map<string, unknown>()
    return {
      storage: {
        get: async (k: string) => store.get(k),
        put: async (k: string, v: unknown) => { store.set(k, v) },
        delete: async (k: string) => store.delete(k),
        deleteAll: async () => { store.clear() },
        setAlarm: async () => undefined,
      },
    } as unknown as DurableObjectState
  }
  return {
    idFromName: (n: string) => n,
    get: (n: string) => ({
      fetch: (url: string, init?: RequestInit) => {
        if (cutOff()) return never()
        if (!objects.has(n)) objects.set(n, new AlertClaimObject(state()))
        return objects.get(n)!.fetch(new Request(url, init))
      },
    }),
  } as unknown as DurableObjectNamespace
}

interface Post { channel: string; text: string; blocks: { type: string; elements?: { text: string }[] }[]; at: number }

let posts: Post[]
/** Posts an abandoned job tried after its invocation ended: production never makes them. */
let cutPosts: Post[]
let supabaseRequests: number
let idempotency: ReturnType<typeof memoryKv>

/**
 * Every request: Supabase is accepted and never answered (it ends only when its
 * caller's deadline aborts it, as a stalled connection does), Slack is recorded
 * and answers ok, anything else is refused, so nothing leaves the machine.
 */
function stubNetwork() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (cutOff()) {
      if (url === 'https://slack.com/api/chat.postMessage') {
        cutPosts.push({ ...(JSON.parse(String(init?.body)) as Omit<Post, 'at'>), at: Date.now() })
        if (process.env.SIM_DEBUG) process.stdout.write(`CUT ${new Date(Date.now()).toISOString()} ${cutPosts[cutPosts.length - 1].text}\n`)
      }
      return never()
    }
    if (url.includes('.supabase.co')) {
      supabaseRequests++
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
      })
    }
    if (url === 'https://slack.com/api/chat.postMessage') {
      const body = JSON.parse(String(init?.body)) as Omit<Post, 'at'>
      posts.push({ ...body, at: Date.now() })
      if (process.env.SIM_DEBUG) process.stdout.write(`POST ${new Date(Date.now()).toISOString()} ${body.text} ${JSON.stringify(body.blocks).slice(0, 300)}\n`)
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ts: String(posts.length) }), { status: 200 }))
    }
    return Promise.resolve(new Response('refused by the simulation', { status: 503 }))
  })
}

/** Healthy heartbeats for every job, and STALE_JOB's last run timed to go stale at `staleAtMs`. */
function seedHeartbeats(kv: ReturnType<typeof memoryKv>, staleAtMs: number) {
  for (const job of CRON_JOBS) {
    const started = job.id === STALE_JOB.id ? staleAtMs - STALE_JOB.staleMs : T0 - 30 * SEC
    kv.store.set(heartbeatKey(job.id), new Date(started).toISOString())
    kv.store.set(completedKey(job.id), new Date(started + SEC).toISOString())
  }
}

async function seedCopy(kv: ReturnType<typeof memoryKv>) {
  const copy = { [ORG]: CONN, [SLACK_COPY_SAVED_AT_KEY]: new Date(T0 - MIN).toISOString() }
  kv.store.set(SLACK_CONNS_LASTGOOD_KEY, await encryptSecret(JSON.stringify(copy), TEST_KEY))
}

function env(): Env {
  return {
    IDEMPOTENCY: idempotency,
    WORKFLOW_CACHE: memoryKv(),
    ALERT_CLAIM: claimNamespace(),
    SUPABASE_URL: 'https://stalled.supabase.co',
    SUPABASE_SECRET_KEY: 'service-key',
    SECRET_ENCRYPTION_KEY: TEST_KEY,
    APP_URL: 'https://app.example',
  } as unknown as Env
}

/**
 * Fires the minute tick now, in its own context, and marks it ended once the
 * invocation would end: when the handler and everything it handed to waitUntil
 * have settled. Every promise gets a handler at once (L749).
 */
function fireMinute(tickEnv: Env, scheduledTime: number = Date.now()) {
  const tick = { startedAt: Date.now(), ended: false }
  tickOf.run(tick, () => {
    const handed: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => { handed.push(p.catch(() => undefined)) }, passThroughOnException: () => undefined } as unknown as ExecutionContext
    const run = worker.scheduled({ cron: '* * * * *', scheduledTime, type: 'scheduled' } as unknown as ScheduledEvent, tickEnv, ctx).catch(() => undefined)
    void run.then(async () => {
      // A promise handed over while others settle is waited for too.
      for (let seen = -1; seen !== handed.length;) {
        seen = handed.length
        await Promise.all(handed)
      }
      tick.ended = true
    })
  })
}

/** `minutes` stalled minute ticks, one a minute, then time for the last one's abandoned jobs to end. */
async function runStalledMinutes(tickEnv: Env, minutes: number) {
  for (let i = 0; i < minutes; i++) {
    fireMinute(tickEnv)
    await vi.advanceTimersByTimeAsync(MIN)
  }
  await vi.advanceTimersByTimeAsync(5 * MIN)
}

const outageLines = (p: Post) => p.blocks.filter((b) => b.type === 'context' && b.elements?.some((e) => e.text.includes('database outage')))
const isDatabasePage = (p: Post) => p.text === 'Bidspoke cannot read its database'
const isHeartbeat = (p: Post) => p.text.includes(STALE_JOB.label)

beforeEach(async () => {
  vi.useFakeTimers({ now: T0 })
  // The database client's 45 s request deadline is an AbortSignal.timeout,
  // which fake timers do not reach; this one runs on the faked clock instead.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const c = new AbortController()
    setTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms)
    return c.signal
  })
  posts = []
  cutPosts = []
  supabaseRequests = 0
  idempotency = memoryKv()
  await seedCopy(idempotency)
  stubNetwork()
  const keep = (...a: unknown[]) => { if (process.env.SIM_DEBUG) process.stdout.write(`${new Date(Date.now()).toISOString()} ${a.map(String).join(' ')}\n`) }
  vi.spyOn(console, 'error').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'log').mockImplementation(keep)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a stalled database through the real scheduled handler (#2061)', () => {
  it('counts the posts: the database page once, the heartbeat alert once with the outage line, nothing from the checks that need the database', async () => {
    // The job goes stale two and a half minutes in, after the page has gone out.
    seedHeartbeats(idempotency, T0 + 150 * SEC)
    await runStalledMinutes(env(), 6)

    // The stall was real: the database was asked and never answered.
    expect(supabaseRequests).toBeGreaterThan(20)

    expect(posts.map((p) => p.text), 'every Slack post the six stalled minutes made').toHaveLength(2)
    const [page, heartbeat] = [posts.filter(isDatabasePage), posts.filter(isHeartbeat)]
    expect(page).toHaveLength(1)
    expect(heartbeat).toHaveLength(1)
    expect(page[0].at).toBeLessThan(heartbeat[0].at)

    // The owner's page names nothing extra; the consequence carries the line once.
    expect(outageLines(page[0])).toEqual([])
    expect(outageLines(heartbeat[0])).toHaveLength(1)
    expect(outageLines(heartbeat[0])[0].elements![0].text).toMatch(
      /^Sent during the database outage reported at Oct 14, 9:01 PM EDT \(database reads last failed at Oct 14, 9:0\d PM EDT\), so this alert may be a consequence of it\. It was posted using Slack settings saved \d+ minutes ago\.$/,
    )
    // Both went to the channel in the saved copy, the only place the token lives in an outage.
    expect(posts.every((p) => p.channel === CONN.default_channel)).toBe(true)
  })

  // The deliveries a stalled night really gets: Cloudflare has delivered every
  // tick twice since 2026-10-08 (#1899), and a late tick overlaps the next
  // minute's. Ticks 40 s apart, each scheduled for its own minute, so every tick
  // still runs while the next starts, and each delivered a second time 1 s later.
  it('posts each once when ticks overlap and every tick is delivered twice', async () => {
    seedHeartbeats(idempotency, T0 + 150 * SEC)
    const tickEnv = env()
    for (let i = 0; i < 9; i++) {
      const scheduledTime = T0 + i * MIN
      fireMinute(tickEnv, scheduledTime)
      await vi.advanceTimersByTimeAsync(SEC)
      fireMinute(tickEnv, scheduledTime)
      await vi.advanceTimersByTimeAsync(39 * SEC)
    }
    await vi.advanceTimersByTimeAsync(5 * MIN)

    expect(posts).toHaveLength(2)
    expect(posts.filter(isDatabasePage)).toHaveLength(1)
    const heartbeat = posts.filter(isHeartbeat)
    expect(heartbeat).toHaveLength(1)
    expect(outageLines(heartbeat[0])).toHaveLength(1)
  })

  // Control in the same fixture: an alert posted before the outage was reported
  // carries no line, so the line comes from the open incident, not the tick.
  it('posts a heartbeat alert from before the outage was reported without the line', async () => {
    seedHeartbeats(idempotency, T0 - 10 * SEC)
    await runStalledMinutes(env(), 3)

    const heartbeat = posts.filter(isHeartbeat)
    expect(heartbeat).toHaveLength(1)
    expect(outageLines(heartbeat[0])).toEqual([])
    expect(posts.filter(isDatabasePage)).toHaveLength(1)
    expect(posts).toHaveLength(2)
  })
})
