import { describe, it, expect, vi } from 'vitest'
import {
  withDbRetry,
  isPermanentDbError,
  isDuplicateError,
  requireRowsAffected,
  isNoRowMatchedError,
  NO_ROW_MATCHED_CODE,
  type DbError,
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
