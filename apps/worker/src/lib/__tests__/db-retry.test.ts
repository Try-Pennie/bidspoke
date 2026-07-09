import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  withDbRetry,
  isPermanentDbError,
  isDuplicateError,
  requireRowsAffected,
  isNoRowMatchedError,
  NO_ROW_MATCHED_CODE,
  type DbError,
  toThrowable,
} from '../db-retry'

describe('withDbRetry', () => {
  it('returns immediately when the op succeeds (no retry)', async () => {
    const op = vi.fn().mockResolvedValue({ error: null })
    const { error } = await withDbRetry(op, [0, 0])
    expect(error).toBeNull()
    expect(op).toHaveBeenCalledOnce()
  })

  it('retries a transient error and returns success on a later attempt', async () => {
    const transient: DbError = { code: 'PGRST002', message: 'Could not query the database for the schema cache.' }
    const op = vi
      .fn()
      .mockResolvedValueOnce({ error: transient })
      .mockResolvedValueOnce({ error: transient })
      .mockResolvedValueOnce({ error: null })
    const { error } = await withDbRetry(op, [0, 0])
    expect(error).toBeNull()
    expect(op).toHaveBeenCalledTimes(3)
  })

  it('fails fast on a permanent error without retrying', async () => {
    const permanent: DbError = { code: '23502', message: 'null value in column violates not-null constraint' }
    const op = vi.fn().mockResolvedValue({ error: permanent })
    const { error } = await withDbRetry(op, [0, 0])
    expect(error).toEqual(permanent)
    expect(op).toHaveBeenCalledOnce()
  })

  it('returns the last error after exhausting retries on a persistent transient error', async () => {
    const transient: DbError = { code: 'PGRST002', message: 'schema cache' }
    const op = vi.fn().mockResolvedValue({ error: transient })
    const { error } = await withDbRetry(op, [0, 0])
    expect(error).toEqual(transient)
    // 1 initial attempt + 2 retries (delays length)
    expect(op).toHaveBeenCalledTimes(3)
  })
})

describe('isPermanentDbError', () => {
  it('is true for known permanent SQLSTATE / PostgREST codes', () => {
    expect(isPermanentDbError({ code: '23502', message: '' })).toBe(true)
    expect(isPermanentDbError({ code: '42703', message: '' })).toBe(true)
    expect(isPermanentDbError({ code: 'PGRST204', message: '' })).toBe(true)
  })

  it('is false for transient errors (schema-cache reload, lock contention) and null', () => {
    expect(isPermanentDbError({ code: 'PGRST002', message: '' })).toBe(false)
    expect(isPermanentDbError({ message: 'connection reset' })).toBe(false)
    expect(isPermanentDbError(null)).toBe(false)
  })
})

describe('isDuplicateError', () => {
  it('is true only for unique_violation (23505)', () => {
    expect(isDuplicateError({ code: '23505', message: '' })).toBe(true)
    expect(isDuplicateError({ code: '23502', message: '' })).toBe(false)
    expect(isDuplicateError(null)).toBe(false)
  })
})

// #583: PostgREST returns `error: null` when a well-formed UPDATE or DELETE
// matches zero rows. That is a statement that succeeded and changed nothing,
// so destructuring `error` is not enough for a write whose target row must
// exist. #487 fixed the first instance (the execution finalize); this promotes
// the sentinel to the shared classifier so every must-hit write can use it and
// so withDbRetry stops burning the ladder on a row that will never appear.
// Spies on console outlive a test unless restored, so an assertion that a later
// test logged nothing would otherwise see an earlier test's calls.
afterEach(() => vi.restoreAllMocks())

describe('requireRowsAffected (#583)', () => {
  it('passes the error straight through when the write itself failed', async () => {
    const dbErr = { code: '23503', message: 'foreign key violation' }
    const { error } = await requireRowsAffected('t.row', () =>
      Promise.resolve({ data: null, error: dbErr })
    )
    expect(error).toEqual(dbErr)
  })

  it('succeeds when at least one row was touched', async () => {
    const { error } = await requireRowsAffected('t.row', () =>
      Promise.resolve({ data: [{ id: 'a' }], error: null })
    )
    expect(error).toBeNull()
  })

  it('reports a zero-row write as an error naming the target', async () => {
    const { error } = await requireRowsAffected('lead_sighting_bids.winner', () =>
      Promise.resolve({ data: [], error: null })
    )
    expect(error?.code).toBe(NO_ROW_MATCHED_CODE)
    expect(error?.message).toContain('lead_sighting_bids.winner')
  })

  it('treats a null data payload as zero rows, not as success', async () => {
    const { error } = await requireRowsAffected('t.row', () =>
      Promise.resolve({ data: null, error: null })
    )
    expect(error?.code).toBe(NO_ROW_MATCHED_CODE)
  })

  // #590: six sites hand-rolled this same check because each wanted a different
  // reaction to a miss. The reaction is now a parameter, so there is one
  // implementation and one place a new write site can look.
  // The rows themselves, not just a count: a caller that just deleted a row often
  // needs its id (e.g. to write the audit entry for what it removed).
  it('hands back the rows the write touched, so a caller can gate a side effect on them', async () => {
    const hit = await requireRowsAffected('t.row', () => Promise.resolve({ data: [{ id: 'a' }, { id: 'b' }], error: null }))
    expect(hit.rows).toEqual([{ id: 'a' }, { id: 'b' }])
    const miss = await requireRowsAffected('t.row', () => Promise.resolve({ data: [], error: null }))
    expect(miss.rows).toEqual([])
  })

  it('accepts a thenable so a supabase query builder can be passed directly', async () => {
    const builder = { then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: 'a' }], error: null }).then(r) }
    const { rows, error } = await requireRowsAffected('t.row', () => builder as PromiseLike<{ data: unknown[] | null; error: null }>)
    expect(rows).toHaveLength(1)
    expect(error).toBeNull()
  })

  describe('onMiss policy', () => {
    const miss = () => Promise.resolve({ data: [], error: null })

    it("defaults to silent: no log, so today's callers keep their own reaction", async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { error } = await requireRowsAffected('t.row', miss)
      expect(error?.code).toBe(NO_ROW_MATCHED_CODE)
      expect(err).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    })

    it("logs one structured error line and returns, on onMiss 'error'", async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { error } = await requireRowsAffected('t.row', miss, { onMiss: 'error', context: { id: 'x1' } })
      expect(error?.code).toBe(NO_ROW_MATCHED_CODE)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(spy.mock.calls[0][0] as string)).toMatchObject({
        event: 'zero_row_write',
        target: 't.row',
        id: 'x1',
      })
    })

    it("logs one structured warn line, on onMiss 'warn'", async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await requireRowsAffected('t.row', miss, { onMiss: 'warn' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(spy.mock.calls[0][0] as string)).toMatchObject({ event: 'zero_row_write', target: 't.row' })
    })

    it("throws, naming the target, on onMiss 'throw'", async () => {
      await expect(requireRowsAffected('sightings.mark', miss, { onMiss: 'throw' })).rejects.toThrow(/sightings.mark/)
    })

    // The policy describes a MISSING ROW. A real database failure is a different
    // thing and must never be logged, thrown, or counted as one: it flows back
    // untouched so the caller can retry or surface a 500 (#303).
    it('never applies the policy to a real database error', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const dbErr = { code: '42P01', message: 'relation missing' }
      const op = () => Promise.resolve({ data: null, error: dbErr })

      for (const onMiss of ['error', 'warn', 'throw'] as const) {
        const { rows, error } = await requireRowsAffected('t.row', op, { onMiss })
        expect(error).toEqual(dbErr)
        expect(rows).toEqual([])
      }
      expect(err).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    })

    it('never applies the policy when the write did touch a row', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { rows, error } = await requireRowsAffected('t.row', () => Promise.resolve({ data: [{ id: 'a' }], error: null }), { onMiss: 'error' })
      expect(rows).toEqual([{ id: 'a' }])
      expect(error).toBeNull()
      expect(spy).not.toHaveBeenCalled()
    })
  })
})

describe('isNoRowMatchedError (#583)', () => {
  it('identifies the sentinel and nothing else', () => {
    expect(isNoRowMatchedError({ code: NO_ROW_MATCHED_CODE, message: 'x' })).toBe(true)
    expect(isNoRowMatchedError({ code: '23503', message: 'x' })).toBe(false)
    expect(isNoRowMatchedError(null)).toBe(false)
  })
})

describe('withDbRetry + zero-row writes (#583)', () => {
  it('fails fast on a zero-row write: waiting cannot make the row appear', async () => {
    const op = vi.fn().mockResolvedValue({
      error: { code: NO_ROW_MATCHED_CODE, message: 'no rows matched t.row' },
    })
    const { error } = await withDbRetry(op, [0, 0, 0])
    expect(error?.code).toBe(NO_ROW_MATCHED_CODE)
    expect(op).toHaveBeenCalledOnce()
  })

  it('classifies the sentinel as permanent so writeOutcome dead-letters instead of retrying', () => {
    expect(isPermanentDbError({ code: NO_ROW_MATCHED_CODE, message: 'x' })).toBe(true)
  })
})

// A DbError is a plain object. `throw dbErr` throws a non-Error, which loses the
// stack and trips the only-throw-error lint rule, so the sites that rethrow a
// database failure wrap it first (#590).
describe('toThrowable', () => {
  it('produces a real Error carrying the original message', () => {
    const err = toThrowable({ code: '42P01', message: 'relation missing' })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('relation missing')
  })

  it('keeps the SQLSTATE on the thrown value so a catch can still classify it', () => {
    const err = toThrowable({ code: '42P01', message: 'relation missing' })
    expect((err as Error & { code?: string }).code).toBe('42P01')
    expect(isPermanentDbError({ code: (err as Error & { code?: string }).code, message: err.message })).toBe(true)
  })

  it('survives an error with no code', () => {
    const err = toThrowable({ message: 'db down' })
    expect(err).toBeInstanceOf(Error)
    expect((err as Error & { code?: string }).code).toBeUndefined()
  })
})
