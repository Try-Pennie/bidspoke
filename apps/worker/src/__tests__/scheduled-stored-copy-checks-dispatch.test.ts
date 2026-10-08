import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Env } from '../index'
import { STORED_COPY_LEDGER_PREFIX, forgetStoredCopyLedger, noteStoredCopy } from '../lib/stored-copy-ledger'

/**
 * #1848: the stored copy alerts run every minute right after the sweep, on what
 * it reported, and the count of copies served is written after every request
 * and after every cron's work. Invokes the real handlers rather than reading the
 * source, so the wiring itself is what is proven.
 */
const sweepStoredCopies = vi.fn()
const runStoredCopyChecks = vi.fn()

vi.mock('../lib/stored-copy-sweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stored-copy-sweep')>()),
  sweepStoredCopies: (...args: unknown[]) => sweepStoredCopies(...args),
}))
vi.mock('../lib/stored-copy-signals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stored-copy-signals')>()),
  runStoredCopyChecks: (...args: unknown[]) => runStoredCopyChecks(...args),
}))
vi.mock('../lib/cache-prewarm', () => ({ prewarmKvCaches: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/cron-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cron-heartbeat')>()),
  writeHeartbeat: vi.fn().mockResolvedValue(undefined),
  writeHeartbeatCompleted: vi.fn().mockResolvedValue(undefined),
  runHeartbeatChecks: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
  createSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
}))

const worker = (await import('../index')).default

function makeEnv() {
  const puts: string[] = []
  const IDEMPOTENCY = {
    puts,
    get: async () => null,
    put: async (key: string) => { puts.push(key) },
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true }),
  }
  const WORKFLOW_CACHE = { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) }
  const env = {
    IDEMPOTENCY,
    WORKFLOW_CACHE,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'k',
    SECRET_ENCRYPTION_KEY: btoa('0'.repeat(32)),
    APP_URL: 'https://app.test',
  } as unknown as Env
  return { env, IDEMPOTENCY, WORKFLOW_CACHE }
}

function makeCtx() {
  const waited: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => waited.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
  // Settles everything handed to waitUntil, including what is handed to it while settling.
  const settle = async () => {
    for (let seen = 0; seen < waited.length;) {
      const batch = waited.slice(seen)
      seen = waited.length
      await Promise.allSettled(batch)
    }
  }
  return { ctx, settle }
}

async function fire(cron: string, env: Env) {
  const { ctx, settle } = makeCtx()
  void worker.scheduled({ cron } as ScheduledEvent, env, ctx)
  await settle()
}

beforeEach(() => {
  forgetStoredCopyLedger()
  sweepStoredCopies.mockReset().mockResolvedValue({ checked: 2, repaired: [], reconfirmed: [], failed: [] })
  runStoredCopyChecks.mockReset().mockResolvedValue({ serving: 'quiet', activeMinutes: 0, suppressed: false, stale: 0, sweepFailingSince: null })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  forgetStoredCopyLedger()
  vi.restoreAllMocks()
})

describe('the stored copy alerts dispatch (#1848)', () => {
  it('runs every minute after the sweep, on what the sweep reported, against both namespaces', async () => {
    const { env, IDEMPOTENCY, WORKFLOW_CACHE } = makeEnv()
    const sweep = { checked: 5, repaired: [], reconfirmed: [], failed: ['partner copies: down'] }
    sweepStoredCopies.mockResolvedValueOnce(sweep)
    await fire('* * * * *', env)
    expect(runStoredCopyChecks).toHaveBeenCalledTimes(1)
    const deps = runStoredCopyChecks.mock.calls[0][0] as { kv: unknown; copies: unknown; sweep: unknown }
    expect(deps.kv).toBe(IDEMPOTENCY)
    expect(deps.copies).toBe(WORKFLOW_CACHE)
    expect(deps.sweep).toEqual(sweep)
  })

  it('still runs when the sweep itself throws, and judges that run as failing', async () => {
    const { env } = makeEnv()
    sweepStoredCopies.mockRejectedValueOnce(new Error('KV list failed'))
    await fire('* * * * *', env)
    const deps = runStoredCopyChecks.mock.calls[0][0] as { sweep: { failed: string[] } }
    expect(deps.sweep.failed).toEqual(['every copy: KV list failed'])
  })

  it('logs what it found when there is something to say', async () => {
    const { env } = makeEnv()
    runStoredCopyChecks.mockResolvedValueOnce({ serving: 'posted', activeMinutes: 4, suppressed: true, stale: 0, sweepFailingSince: null })
    await fire('* * * * *', env)
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).toMatch(/stored-copy-checks.*serving=posted.*active_minutes=4/)
  })

  it('runs from no other cron', async () => {
    for (const cron of ['0 9 * * *', '0 13 * * *', '0 * * * *']) {
      runStoredCopyChecks.mockClear()
      await fire(cron, makeEnv().env)
      expect(runStoredCopyChecks, `${cron} ran the checks`).not.toHaveBeenCalled()
    }
  })
})

describe('the stored copy count is written after the work that noted it (#1848)', () => {
  it('after a cron, once every job it started has settled', async () => {
    const { env, IDEMPOTENCY } = makeEnv()
    sweepStoredCopies.mockImplementationOnce(async () => {
      // Noted after the handler returned and every queued microtask ran, as a
      // loader reached after real I/O would. An ordering, not a wait on the clock.
      await new Promise((resolve) => setTimeout(resolve, 0))
      noteStoredCopy({ copy: 'partner_config', outcome: 'served', ageMs: 60_000 })
      return { checked: 1, repaired: [], reconfirmed: [], failed: [] }
    })
    await fire('* * * * *', env)
    expect(IDEMPOTENCY.puts.filter((k) => k.startsWith(STORED_COPY_LEDGER_PREFIX))).toHaveLength(1)
  })

  it('after a request, through waitUntil, and not before the response', async () => {
    const { env, IDEMPOTENCY } = makeEnv()
    noteStoredCopy({ copy: 'custom_endpoint', outcome: 'served', ageMs: 60_000 })
    const { ctx, settle } = makeCtx()
    const res = await worker.fetch(new Request('https://bidspoke-worker.test/'), env, ctx)
    expect(res.status).toBe(200)
    await settle()
    expect(IDEMPOTENCY.puts.filter((k) => k.startsWith(STORED_COPY_LEDGER_PREFIX))).toHaveLength(1)
  })

  it('makes no KV call after a request that noted nothing', async () => {
    const { env, IDEMPOTENCY } = makeEnv()
    const { ctx, settle } = makeCtx()
    await worker.fetch(new Request('https://bidspoke-worker.test/'), env, ctx)
    await settle()
    expect(IDEMPOTENCY.puts).toEqual([])
  })
})
