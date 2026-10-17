import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../test-setup/wait-until'
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
const createSupabaseClient = vi.fn(() => ({ from: () => ({ select: () => ({}) }) }))
vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
  createSupabaseClient: () => createSupabaseClient(),
}))
const flushStoredCopyLedger = vi.fn().mockResolvedValue(undefined)
vi.mock('../lib/stored-copy-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stored-copy-ledger')>()),
  flushStoredCopyLedger: (...a: unknown[]) => flushStoredCopyLedger(...a),
}))

// The guard recorder's backoff takes no real time here: src/test-setup/guard-recorder.ts.
const worker = (await import('../index')).default
const { countCronGuardEvents } = await import('../lib/cron-guard-watch')

function claimNamespace(): DurableObjectNamespace {
  const objects = new Map<string, AlertClaimObject>()
  const state = () => {
    const store = new Map<string, unknown>()
    return {
      storage: {
        get: async (k: string) => store.get(k),
        put: async (k: string, v: unknown) => { store.set(k, v) },
        deleteAll: async () => { store.clear() },
      delete: async (key: string) => store.delete(key),
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

/** The IDEMPOTENCY namespace held in a Map, whose writes fail while `down`, listing as KV does. */
function idempotencyKv() {
  const store = new Map<string, string>()
  const kv = {
    down: false,
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: vi.fn(async (k: string, v: string) => {
      if (kv.down) throw new Error('KV PUT failed: 500 Internal Server Error')
      store.set(k, v)
    }),
    delete: async (k: string) => { store.delete(k) },
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })),
      list_complete: true,
    }),
  }
  return kv
}

function envWith(ns: DurableObjectNamespace, idempotency?: ReturnType<typeof idempotencyKv>): Env {
  return {
    IDEMPOTENCY: idempotency ?? { get: async () => null, put: async () => undefined, delete: async () => undefined },
    WORKFLOW_CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) },
    ALERT_CLAIM: ns,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'k',
  } as unknown as Env
}

/** Fires one delivery and returns how the handler itself settled. */
async function fire(env: Env, cron: string, scheduledTime: number): Promise<PromiseSettledResult<unknown>> {
  const ctx = recordingContext()
  const handled = Promise.resolve().then(() => worker.scheduled({ cron, scheduledTime } as ScheduledEvent, env, ctx))
  const [settled] = await Promise.allSettled([handled])
  await ctx.settle()
  return settled
}

beforeEach(() => {
  prewarmKvCaches.mockClear()
  createSupabaseClient.mockClear()
  flushStoredCopyLedger.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // The real jobs run, and the five minute tick's partner reachability probe
  // fetched oauth.prd.ffngcp.com, fdrapis-gateway.prd.fdrgcp.com and
  // api.freedomfinancialnet.com for real: 3.7 to 10 s a run against a 5 s test
  // timeout. This file proves the claim, not the jobs, so nothing leaves the
  // machine (L291).
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })))
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

  it('fails the invocation and releases the tick when the jobs cannot even start, so the retry runs them', async () => {
    const env = envWith(claimNamespace())
    createSupabaseClient.mockImplementationOnce(() => { throw new Error('supabase client could not be built') })
    const first = await fire(env, '* * * * *', minute + 1_000)
    expect(first.status).toBe('rejected')
    expect(prewarmKvCaches).not.toHaveBeenCalled()
    const retry = await fire(env, '* * * * *', minute + 1_000)
    expect(retry.status).toBe('fulfilled')
    expect(prewarmKvCaches).toHaveBeenCalledTimes(1)
  })

  it('a failed stored copy count is logged and does not rerun jobs that already ran', async () => {
    const env = envWith(claimNamespace())
    flushStoredCopyLedger.mockRejectedValueOnce(new Error('kv write failed'))
    const first = await fire(env, '* * * * *', minute + 1_000)
    expect(first.status).toBe('fulfilled')
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/kv write failed/)
    await fire(env, '* * * * *', minute + 37_000)
    expect(prewarmKvCaches).toHaveBeenCalledTimes(1)
  })
})

// #2166: on 2026-10-14 the KV write counting each fail-open failed in the same
// blip that made the guard fail open, so the hourly check read zero.
describe('a fail-open whose record fails in the same tick is still counted (#2166)', () => {
  const minute = Date.parse('2026-10-14T21:34:00.000Z')

  it('holds the record it could not write, says why, and writes it at its own time on the next tick that reaches the store', async () => {
    const kv = idempotencyKv()
    kv.down = true
    // Earlier cases in this file fail open too; read only this case's lines.
    vi.mocked(console.error).mockClear()
    const before = Date.now()
    // No claim binding, so the guard fails open, and KV is down in the same tick.
    await fire(envWith(undefined as unknown as DurableObjectNamespace, kv), '* * * * *', minute)
    const after = Date.now()
    expect(prewarmKvCaches).toHaveBeenCalledTimes(1)
    expect(await countCronGuardEvents(kv, 'failed_open', Date.now())).toEqual({ count: 0, capped: false })
    const errors = vi.mocked(console.error).mock.calls.flat().map(String).join('\n')
    const id = /FAILED OPEN event=(\S+)/.exec(errors)?.[1]
    expect(id).toBeTruthy()
    expect(errors).toMatch(new RegExp(`could not record failed_open event=${id} after 3 attempts: .*KV PUT failed: 500 Internal Server Error`))

    // The store answers again by the next tick: the held record is written then.
    kv.down = false
    await fire(envWith(claimNamespace(), kv), '* * * * *', minute + 60_000)
    expect(await countCronGuardEvents(kv, 'failed_open', Date.now())).toEqual({ count: 1, capped: false })
    // At the fail-open's own time, so it is counted in the window it belongs to.
    const key = [...kv.store.keys()].find((k) => k.startsWith('cron-guard:event:failed_open:'))!
    const at = 9_999_999_999_999 - Number(key.split(':')[3])
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(after)
    expect(key.endsWith(`:${id}`)).toBe(true)
  })
})
