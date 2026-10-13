/**
 * A queryable home for the database-memory readings (#2010).
 *
 * The check logs `event=database_memory` every five minutes, but those logs are not
 * reachable (Logpush drops console messages, the observability tool rejects cron events),
 * so the 600/500 MB swap thresholds cannot be calibrated against real readings. Each run now
 * also records its figures into a bounded KV ring buffer that an admin route reads back.
 *
 * The clock and the KV store are injected, so no test waits or depends on the wall clock
 * (L524, L290). The reader must be real: a writer with no reader is a defect (L46).
 */
import { describe, it, expect } from 'vitest'
import {
  parseStoredReadings,
  recordMemoryReading,
  readMemoryReadings,
  DATABASE_MEMORY_READINGS_KEY,
  READINGS_WINDOW_MS,
  type StoredMemoryReading,
} from '../database-memory-readings'

const MIN = 60 * 1000
const T0 = Date.parse('2026-10-09T13:00:00Z')

function fakeKv() {
  const store = new Map<string, string>()
  const thrownOn = { get: false, put: false }
  return {
    store,
    thrownOn,
    get: async (k: string) => {
      if (thrownOn.get) throw new Error('KV read failed')
      return store.get(k) ?? null
    },
    put: async (k: string, v: string) => {
      if (thrownOn.put) throw new Error('KV write failed')
      store.set(k, v)
    },
  }
}

const reading = (at: number, over = false): StoredMemoryReading => ({
  at,
  freePct: over ? 12.0 : 60.0,
  availableMb: over ? 500 : 2400,
  totalMb: 4010,
  swapUsedMb: over ? 700 : 260,
  swapHigh: over,
})

describe('parsing the stored ring buffer', () => {
  it('reads nothing as an empty list, never a throw', () => {
    expect(parseStoredReadings(null)).toEqual([])
    expect(parseStoredReadings('not json')).toEqual([])
    expect(parseStoredReadings('{"not":"an array"}')).toEqual([])
  })

  it('keeps only entries shaped like a reading, dropping any an older or corrupt writer left', () => {
    const good = reading(T0)
    const raw = JSON.stringify([
      good,
      { at: 'nope', freePct: 1, availableMb: 1, totalMb: 1, swapUsedMb: 1, swapHigh: false },
      { at: T0 + MIN, freePct: 1 },
      42,
    ])
    expect(parseStoredReadings(raw)).toEqual([good])
  })
})

describe('recording a reading', () => {
  it('logs, rather than silently wiping, when the stored buffer is present but not a JSON array (L11)', async () => {
    const kv = fakeKv()
    kv.store.set(DATABASE_MEMORY_READINGS_KEY, '{"corrupt":true}') // valid JSON, not an array
    const lines: string[] = []
    await recordMemoryReading(kv, reading(T0), { log: (l) => lines.push(l) })
    // The unusable buffer could not be appended to, so it is replaced, but the loss is announced.
    expect(lines.some((l) => l.includes('not a JSON array'))).toBe(true)
    expect(parseStoredReadings(kv.store.get(DATABASE_MEMORY_READINGS_KEY)!)).toEqual([reading(T0)])
  })

  it('does NOT log a discard when the buffer is a valid array (good entries are kept, not lost)', async () => {
    const kv = fakeKv()
    kv.store.set(DATABASE_MEMORY_READINGS_KEY, JSON.stringify([reading(T0)]))
    const lines: string[] = []
    await recordMemoryReading(kv, reading(T0 + MIN), { log: (l) => lines.push(l) })
    expect(lines).toEqual([])
    expect(parseStoredReadings(kv.store.get(DATABASE_MEMORY_READINGS_KEY)!)).toEqual([reading(T0), reading(T0 + MIN)])
  })

  it('appends to an empty buffer', async () => {
    const kv = fakeKv()
    await recordMemoryReading(kv, reading(T0))
    expect(parseStoredReadings(kv.store.get(DATABASE_MEMORY_READINGS_KEY)!)).toEqual([reading(T0)])
  })

  it('appends in arrival order, oldest first', async () => {
    const kv = fakeKv()
    await recordMemoryReading(kv, reading(T0))
    await recordMemoryReading(kv, reading(T0 + 5 * MIN))
    const stored = parseStoredReadings(kv.store.get(DATABASE_MEMORY_READINGS_KEY)!)
    expect(stored.map((r) => r.at)).toEqual([T0, T0 + 5 * MIN])
  })

  it('drops entries older than the window so the buffer cannot grow without bound', async () => {
    const kv = fakeKv()
    const old = reading(T0)
    kv.store.set(DATABASE_MEMORY_READINGS_KEY, JSON.stringify([old]))
    // A reading one tick past the window from the old one evicts it.
    const now = T0 + READINGS_WINDOW_MS + MIN
    await recordMemoryReading(kv, reading(now))
    const stored = parseStoredReadings(kv.store.get(DATABASE_MEMORY_READINGS_KEY)!)
    expect(stored.map((r) => r.at)).toEqual([now])
  })

  it('keeps entries still inside the window', async () => {
    const kv = fakeKv()
    const recent = reading(T0 + MIN)
    kv.store.set(DATABASE_MEMORY_READINGS_KEY, JSON.stringify([recent]))
    const now = T0 + READINGS_WINDOW_MS // recent is one minute inside the window
    await recordMemoryReading(kv, reading(now))
    expect(parseStoredReadings(kv.store.get(DATABASE_MEMORY_READINGS_KEY)!).map((r) => r.at)).toEqual([recent.at, now])
  })

  it('caps the entry count, keeping the newest, however short the cadence', async () => {
    const kv = fakeKv()
    const max = 5
    for (let i = 0; i < 20; i++) await recordMemoryReading(kv, reading(T0 + i * MIN), { max })
    const stored = parseStoredReadings(kv.store.get(DATABASE_MEMORY_READINGS_KEY)!)
    expect(stored.length).toBe(max)
    expect(stored.map((r) => r.at)).toEqual([15, 16, 17, 18, 19].map((i) => T0 + i * MIN))
  })

  it('does not overwrite history when the buffer cannot be read', async () => {
    const kv = fakeKv()
    kv.store.set(DATABASE_MEMORY_READINGS_KEY, JSON.stringify([reading(T0)]))
    kv.thrownOn.get = true
    await expect(recordMemoryReading(kv, reading(T0 + MIN))).rejects.toThrow()
    kv.thrownOn.get = false
    // The earlier history is intact: the failed run wrote nothing.
    expect(parseStoredReadings(kv.store.get(DATABASE_MEMORY_READINGS_KEY)!).map((r) => r.at)).toEqual([T0])
  })
})

describe('reading the buffer back', () => {
  it('returns the stored readings with no error', async () => {
    const kv = fakeKv()
    await recordMemoryReading(kv, reading(T0))
    await recordMemoryReading(kv, reading(T0 + 5 * MIN, true))
    const { readings, error } = await readMemoryReadings(kv)
    expect(error).toBeNull()
    expect(readings.map((r) => r.swapUsedMb)).toEqual([260, 700])
  })

  it('returns an empty list before anything has been recorded', async () => {
    const { readings, error } = await readMemoryReadings(fakeKv())
    expect(readings).toEqual([])
    expect(error).toBeNull()
  })

  it('reports a storage outage as its own state, never an empty-but-fine list (L11)', async () => {
    const kv = fakeKv()
    kv.thrownOn.get = true
    const { readings, error } = await readMemoryReadings(kv)
    expect(readings).toEqual([])
    expect(error).toContain('KV read failed')
  })

  it('reports a corrupt (non-array) buffer as an error, not a cheerful empty list (L10)', async () => {
    const kv = fakeKv()
    kv.store.set(DATABASE_MEMORY_READINGS_KEY, 'not json at all')
    const { readings, error } = await readMemoryReadings(kv)
    expect(readings).toEqual([])
    expect(error).toContain('corrupt')
  })

  it('reports an array whose entries are all an unrecognised shape as an error, not empty', async () => {
    const kv = fakeKv()
    kv.store.set(DATABASE_MEMORY_READINGS_KEY, JSON.stringify([{ old: 'shape' }, 7]))
    const { readings, error } = await readMemoryReadings(kv)
    expect(readings).toEqual([])
    expect(error).toContain('corrupt')
  })

  it('returns the good readings (no error) when only SOME entries are an unrecognised shape', async () => {
    const kv = fakeKv()
    kv.store.set(DATABASE_MEMORY_READINGS_KEY, JSON.stringify([reading(T0), { old: 'shape' }]))
    const { readings, error } = await readMemoryReadings(kv)
    expect(error).toBeNull()
    expect(readings).toEqual([reading(T0)])
  })
})
