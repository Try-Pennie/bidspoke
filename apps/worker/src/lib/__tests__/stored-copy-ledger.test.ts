/**
 * The stored copy ledger (#1848): every time a loader serves or refuses a stored
 * copy it is noted in memory, at no cost to the lead, and written to KV after
 * the response, where the per minute check reads it back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEDGER_FLUSH_BUDGET_MS,
  LEDGER_FLUSH_INTERVAL_MS,
  LEDGER_KEY_TTL_SECONDS,
  STORED_COPY_LEDGER_PREFIX,
  flushStoredCopyLedger,
  forgetStoredCopyLedger,
  noteStoredCopy,
  readStoredCopyLedger,
  type LedgerKv,
} from '../stored-copy-ledger'

const T0 = Date.parse('2026-10-07T20:00:10Z')
const MINUTE = 60_000

/** A KV double that keeps metadata and hands it back from list, as Workers KV does. */
function ledgerKv() {
  const store = new Map<string, { value: string; metadata: unknown; ttl?: number }>()
  const puts: string[] = []
  const kv = {
    store,
    puts,
    failPuts: false,
    async put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }) {
      if (kv.failPuts) throw new Error('KV put failed: 429 Too Many Requests')
      puts.push(key)
      store.set(key, { value, metadata: opts?.metadata ?? null, ttl: opts?.expirationTtl })
    },
    async list(opts: { prefix?: string; cursor?: string } = {}) {
      const keys = [...store.entries()]
        .filter(([k]) => k.startsWith(opts.prefix ?? ''))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, e]) => ({ name, metadata: e.metadata }))
      return { keys, list_complete: true as const, cursor: undefined, cacheStatus: null }
    },
  }
  return kv
}

/** A clock the test moves; sleeping advances it and records the wait. */
function testClock(start = T0) {
  let t = start
  const slept: number[] = []
  return {
    slept,
    now: () => t,
    set: (ms: number) => { t = ms },
    sleep: async (ms: number) => { slept.push(ms); t += ms },
  }
}

const asKv = (kv: ReturnType<typeof ledgerKv>) => kv as unknown as LedgerKv

beforeEach(() => {
  forgetStoredCopyLedger()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  forgetStoredCopyLedger()
  vi.restoreAllMocks()
})

describe('noting a stored copy', () => {
  it('costs nothing when nothing was noted: a flush makes no KV call at all', async () => {
    const kv = ledgerKv()
    await flushStoredCopyLedger(asKv(kv), testClock())
    expect(kv.puts).toEqual([])
  })

  it('writes what was noted, per copy and per outcome, with the oldest copy served, keyed by the minute it happened in', async () => {
    const kv = ledgerKv()
    const clock = testClock()
    noteStoredCopy({ copy: 'workflow_definition', outcome: 'served', ageMs: 9 * MINUTE, atMs: T0 })
    noteStoredCopy({ copy: 'workflow_definition', outcome: 'served', ageMs: 4 * MINUTE, atMs: T0 })
    noteStoredCopy({ copy: 'env_vars', outcome: 'copy_too_old', ageMs: 31 * MINUTE, atMs: T0 })
    await flushStoredCopyLedger(asKv(kv), clock)

    expect(kv.puts).toHaveLength(1)
    const [key] = kv.puts
    expect(key.startsWith(`${STORED_COPY_LEDGER_PREFIX}${Math.floor(T0 / MINUTE)}:`)).toBe(true)
    expect(kv.store.get(key)?.ttl).toBe(LEDGER_KEY_TTL_SECONDS)

    const reading = await readStoredCopyLedger(asKv(kv), T0, 5)
    expect(reading.activeMinutes).toBe(1)
    expect(reading.kinds.workflow_definition).toEqual({ served: 2, refused: { no_copy: 0, copy_too_old: 0, copy_age_unknown: 0 }, oldestServedAgeMs: 9 * MINUTE })
    expect(reading.kinds.env_vars).toEqual({ served: 0, refused: { no_copy: 0, copy_too_old: 1, copy_age_unknown: 0 }, oldestServedAgeMs: null })
  })

  it('a later flush in the same minute rewrites that minute with the running totals, never a second count of the first', async () => {
    const kv = ledgerKv()
    const clock = testClock()
    noteStoredCopy({ copy: 'buyer_profiles', outcome: 'served', ageMs: MINUTE, atMs: T0 })
    await flushStoredCopyLedger(asKv(kv), clock)
    noteStoredCopy({ copy: 'buyer_profiles', outcome: 'served', ageMs: MINUTE, atMs: T0 + 1_000 })
    await flushStoredCopyLedger(asKv(kv), clock)

    expect(new Set(kv.puts).size).toBe(1)
    const reading = await readStoredCopyLedger(asKv(kv), clock.now(), 5)
    expect(reading.kinds.buyer_profiles?.served).toBe(2)
  })

  it('writes the same key at most once per flush interval, waiting out the rest of it rather than dropping what was noted', async () => {
    const kv = ledgerKv()
    const clock = testClock()
    noteStoredCopy({ copy: 'partner_config', outcome: 'served', ageMs: 0, atMs: T0 })
    await flushStoredCopyLedger(asKv(kv), clock)
    clock.set(T0 + 1_000)
    noteStoredCopy({ copy: 'partner_config', outcome: 'served', ageMs: 0, atMs: T0 + 1_000 })
    await flushStoredCopyLedger(asKv(kv), clock)

    expect(clock.slept).toEqual([LEDGER_FLUSH_INTERVAL_MS - 1_000])
    expect(kv.puts).toHaveLength(2)
    expect((await readStoredCopyLedger(asKv(kv), clock.now(), 5)).kinds.partner_config?.served).toBe(2)
  })

  it('serves concurrent flushes from one write, so one isolate never writes its key twice in an instant', async () => {
    const kv = ledgerKv()
    const clock = testClock()
    noteStoredCopy({ copy: 'custom_endpoint', outcome: 'served', ageMs: 0, atMs: T0 })
    await Promise.all([flushStoredCopyLedger(asKv(kv), clock), flushStoredCopyLedger(asKv(kv), clock), flushStoredCopyLedger(asKv(kv), clock)])
    expect(kv.puts).toHaveLength(1)
  })

  it('a count noted while a write is in flight joins that flush, which writes it after the interval rather than at once beside the first', async () => {
    const kv = ledgerKv()
    const clock = testClock()
    noteStoredCopy({ copy: 'custom_endpoint', outcome: 'served', ageMs: 0, atMs: T0 })
    const first = flushStoredCopyLedger(asKv(kv), clock)
    noteStoredCopy({ copy: 'custom_endpoint', outcome: 'served', ageMs: 0, atMs: T0 })
    const second = flushStoredCopyLedger(asKv(kv), clock)
    await Promise.all([first, second])

    expect(clock.slept).toEqual([LEDGER_FLUSH_INTERVAL_MS])
    expect(kv.puts).toHaveLength(2)
    expect((await readStoredCopyLedger(asKv(kv), clock.now(), 5)).kinds.custom_endpoint?.served).toBe(2)
  })

  it('stops waiting once its budget is spent, leaving the rest to the next flush', async () => {
    const kv = ledgerKv()
    const clock = testClock()
    const asLedger = asKv(kv)
    // A put that keeps taking time while counts keep arriving.
    const slowPut = kv.put.bind(kv)
    kv.put = async (...args: Parameters<typeof kv.put>) => {
      await slowPut(...args)
      clock.set(clock.now() + 4_000)
      noteStoredCopy({ copy: 'env_vars', outcome: 'served', ageMs: 0, atMs: clock.now() })
    }
    noteStoredCopy({ copy: 'env_vars', outcome: 'served', ageMs: 0, atMs: T0 })
    await flushStoredCopyLedger(asLedger, clock)
    expect(clock.now() - T0).toBeLessThanOrEqual(LEDGER_FLUSH_BUDGET_MS + 4_000)
  })

  it('keeps what KV refused and writes it on the next flush, saying so meanwhile', async () => {
    const kv = ledgerKv()
    const clock = testClock()
    noteStoredCopy({ copy: 'partner_constants', outcome: 'served', ageMs: 0, atMs: T0 })
    kv.failPuts = true
    await flushStoredCopyLedger(asKv(kv), clock)
    expect(kv.puts).toEqual([])
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/stored-copy-ledger.*429/)

    kv.failPuts = false
    clock.set(T0 + LEDGER_FLUSH_INTERVAL_MS)
    await flushStoredCopyLedger(asKv(kv), clock)
    expect((await readStoredCopyLedger(asKv(kv), clock.now(), 5)).kinds.partner_constants?.served).toBe(1)
  })
})

describe('reading the ledger back', () => {
  it('adds up every isolate, and counts each minute with any activity once', async () => {
    const kv = ledgerKv()
    const minute = Math.floor(T0 / MINUTE)
    const entry = (m: number, served: number) => ({ m, k: { workflow_definition: { s: served, r: {}, a: 60_000 } } })
    await kv.put(`${STORED_COPY_LEDGER_PREFIX}${minute}:isolate-a`, '', { metadata: entry(minute, 3) })
    await kv.put(`${STORED_COPY_LEDGER_PREFIX}${minute}:isolate-b`, '', { metadata: entry(minute, 4) })
    await kv.put(`${STORED_COPY_LEDGER_PREFIX}${minute - 2}:isolate-a`, '', { metadata: entry(minute - 2, 1) })

    const reading = await readStoredCopyLedger(asKv(kv), T0, 5)
    expect(reading.activeMinutes).toBe(2)
    expect(reading.kinds.workflow_definition?.served).toBe(8)
  })

  it('leaves out minutes before the window, which the key expiry would remove anyway', async () => {
    const kv = ledgerKv()
    const minute = Math.floor(T0 / MINUTE)
    await kv.put(`${STORED_COPY_LEDGER_PREFIX}${minute - 5}:isolate-a`, '', { metadata: { m: minute - 5, k: { env_vars: { s: 9, r: {}, a: 0 } } } })
    const reading = await readStoredCopyLedger(asKv(kv), T0, 5)
    expect(reading.activeMinutes).toBe(0)
    expect(reading.kinds).toEqual({})
  })

  it('skips an entry it cannot read rather than counting it as anything', async () => {
    const kv = ledgerKv()
    const minute = Math.floor(T0 / MINUTE)
    await kv.put(`${STORED_COPY_LEDGER_PREFIX}${minute}:isolate-a`, '', { metadata: 'garbage' })
    await kv.put(`${STORED_COPY_LEDGER_PREFIX}${minute}:isolate-b`, '', { metadata: { m: minute, k: { nonsense_kind: { s: 4 } } } })
    const reading = await readStoredCopyLedger(asKv(kv), T0, 5)
    expect(reading.activeMinutes).toBe(0)
    expect(reading.kinds).toEqual({})
    expect(reading.unreadable).toBe(2)
  })
})
