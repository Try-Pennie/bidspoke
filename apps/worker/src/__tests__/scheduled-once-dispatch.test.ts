import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../index'
import { AlertClaimObject } from '../durable-objects/alert-claim'

/**
 * #1899: the real scheduled handler claims the tick before any job starts, so
 * a second delivery of the same tick starts nothing, while a different
 * expression in the same minute still runs. Invokes the handler rather than
 * reading its source, so the claim is proven to sit in front of the jobs.
 */
const prewarmKvCaches = vi.fn().mockResolvedValue(undefined)
vi.mock('../lib/cache-prewarm', () => ({ prewarmKvCaches: (...a: unknown[]) => prewarmKvCaches(...a) }))
vi.mock('../lib/stored-copy-sweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stored-copy-sweep')>()),
  sweepStoredCopies: vi.fn().mockResolvedValue({ checked: 0, repaired: [], reconfirmed: [], failed: [] }),
}))
vi.mock('../lib/cron-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cron-heartbeat')>()),
  writeHeartbeat: vi.fn().mockResolvedValue(undefined),
  writeHeartbeatCompleted: vi.fn().mockResolvedValue(undefined),
  runHeartbeatChecks: vi.fn().mockResolvedValue([]),
}))
vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
  createSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
}))

const worker = (await import('../index')).default

function claimNamespace(): DurableObjectNamespace {
  const objects = new Map<string, AlertClaimObject>()
  const state = () => {
    const store = new Map<string, unknown>()
    return {
      storage: {
        get: async (k: string) => store.get(k),
        put: async (k: string, v: unknown) => { store.set(k, v) },
        deleteAll: async () => { store.clear() },
        setAlarm: async () => undefined,
      },
    } as unknown as DurableObjectState
  }
  return {
    idFromName: (n: string) => n,
    get: (n: string) => ({
      fetch: (url: string, init?: RequestInit) => {
        if (!objects.has(n)) objects.set(n, new AlertClaimObject(state()))
        return objects.get(n)!.fetch(new Request(url, init))
      },
    }),
  } as unknown as DurableObjectNamespace
}

function envWith(ns: DurableObjectNamespace): Env {
  return {
    IDEMPOTENCY: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    WORKFLOW_CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) },
    ALERT_CLAIM: ns,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'k',
  } as unknown as Env
}

async function fire(env: Env, cron: string, scheduledTime: number) {
  const waited: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext
  worker.scheduled({ cron, scheduledTime } as ScheduledEvent, env, ctx)
  await Promise.allSettled(waited)
}

beforeEach(() => {
  prewarmKvCaches.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('the scheduled handler runs each tick once (#1899)', () => {
  const minute = Date.parse('2026-10-08T14:37:00.000Z')

  it('starts no job for the second delivery of the same tick', async () => {
    const env = envWith(claimNamespace())
    await fire(env, '* * * * *', minute + 1_000)
    await fire(env, '* * * * *', minute + 37_000)
    expect(prewarmKvCaches).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toMatch(/skipped duplicate cron="\* \* \* \* \*"/)
  })

  it('runs the next minute, and the same minute of another expression is its own claim', async () => {
    const env = envWith(claimNamespace())
    await fire(env, '* * * * *', minute + 1_000)
    await fire(env, '*/5 * * * *', minute + 1_000)
    await fire(env, '* * * * *', minute + 61_000)
    expect(prewarmKvCaches).toHaveBeenCalledTimes(2)
  })

  it('still runs the jobs when there is no claim binding, and says it failed open', async () => {
    await fire(envWith(undefined as unknown as DurableObjectNamespace), '* * * * *', minute)
    expect(prewarmKvCaches).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/FAILED OPEN/)
  })
})
